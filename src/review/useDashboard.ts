import { useCallback, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { WorkspaceDatabase } from '../db/database';
import { listAccounts } from '../db/repositories/accounts';
import { listTransactions, listImportSessions } from '../db/repositories/transactions';
import { getSetting, SETTING_KEYS } from '../db/repositories/settings';
import { CATEGORIES } from '../domain/categories';
import type { Account, IsoMonth } from '../types/domain';
import {
  accountsInScope,
  buildAccountCoverage,
  completeMonthsForScope,
  incomeCompletenessFrom,
  normalizeDashboardFilters,
  selectDashboard,
  type AccountScope,
  type BucketGranularity,
  type DashboardFilters,
  type DashboardSelection,
  type SelectableTransaction,
  type StatementRange,
} from '../calculations';
import {
  resolvePreset,
  systemToday,
  transactionDateDomain,
  validateCustomRange,
  type CustomRangeError,
  type PeriodPreset,
  type TodayProvider,
} from './dashboardPeriod';

/**
 * The one place the dashboard meets the database.
 *
 * calculation-contract.md §1 rule 1 requires a single shared calculation layer;
 * this hook is the single *boundary* to it. Components never call Dexie, never
 * call a repository, and never do arithmetic on `amountCents` — they read
 * `selection`, which is one `selectDashboard` result computed from one
 * population.
 *
 * Reactivity is `useLiveQuery`, the convention `WorkspaceProvider` and the
 * import wizard already use. It also solves staleness for free: Dexie re-runs
 * the query on every relevant write and hands back only the newest result, so
 * there is no request-id race of the kind `useTransactionReview` has to manage
 * for its paged, user-typed queries. No polling, no manual refresh.
 */

export type DashboardStatus = 'loading' | 'ready' | 'empty' | 'failed';

export interface FilterChoice {
  readonly id: string;
  readonly label: string;
}

export interface DashboardApi {
  readonly status: DashboardStatus;
  /** Fixed, sanitized text. Never carries a field value or a database message. */
  readonly errorMessage: string | null;
  readonly preset: PeriodPreset;
  readonly filters: DashboardFilters;
  /** Inclusive custom bounds as typed, before validation. */
  readonly customStart: string;
  readonly customEnd: string;
  readonly customError: CustomRangeError;
  readonly accountChoices: readonly FilterChoice[];
  readonly categoryChoices: readonly FilterChoice[];
  /** Null until the workspace is ready — never a zeroed stand-in. */
  readonly selection: DashboardSelection | null;
  readonly domain: { start: string; end: string } | null;
  readonly completeMonths: ReadonlySet<IsoMonth>;
  readonly latestCompleteMonthAvailable: boolean;
  readonly accountLabels: ReadonlyMap<string, string>;

  setPreset(preset: PeriodPreset): void;
  setCustomStart(value: string): void;
  setCustomEnd(value: string): void;
  toggleAccount(id: string): void;
  toggleCategory(id: string): void;
  clearAccounts(): void;
  clearCategories(): void;
  resetAll(): void;
  /** Re-runs the whole read after a failure. Fails closed while it runs. */
  retry(): void;
}

export interface UseDashboardOptions {
  readonly db: WorkspaceDatabase | null;
  readonly granularity?: BucketGranularity;
  /** Injected so tests can freeze the effective current date. */
  readonly today?: TodayProvider;
}

interface WorkspaceRead {
  readonly ok: true;
  readonly transactions: readonly SelectableTransaction[];
  readonly accounts: readonly Account[];
  readonly coverage: readonly StatementRange[];
  readonly incomeSetting: boolean | undefined;
}

/**
 * A failed read, carried as a value.
 *
 * Returned from the query rather than pushed into state by a side effect inside
 * the callback: a `setState` there depends on when the querier happens to run,
 * and a state that only sometimes arrives is worse than one that is derived.
 */
interface WorkspaceReadFailure {
  readonly ok: false;
}

type WorkspaceReadResult = WorkspaceRead | WorkspaceReadFailure;

/** The transaction fields the calculation contract depends on, and nothing more. */
function toSelectable(row: {
  id: string;
  accountId: string;
  postedDate: string;
  amountCents: number;
  direction: 'debit' | 'credit';
  kind: SelectableTransaction['kind'];
  categoryId: string;
  merchantNormalized: string;
  excludedFromSpending: boolean;
}): SelectableTransaction {
  return {
    id: row.id,
    accountId: row.accountId,
    postedDate: row.postedDate,
    amountCents: row.amountCents,
    direction: row.direction,
    kind: row.kind,
    categoryId: row.categoryId,
    merchantNormalized: row.merchantNormalized,
    excludedFromSpending: row.excludedFromSpending,
  };
}

export function useDashboard(options: UseDashboardOptions): DashboardApi {
  const { db, granularity = 'month', today = systemToday } = options;

  const [preset, setPresetState] = useState<PeriodPreset>('all-data');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [accountIds, setAccountIds] = useState<readonly string[]>([]);
  const [categoryIds, setCategoryIds] = useState<readonly string[]>([]);

  /**
   * Bumped by `retry`, and part of the live query's dependencies.
   *
   * A failed read leaves `liveQuery` subscribed only to whatever tables it
   * managed to touch, so there may be nothing left that a write could change to
   * re-trigger it. Changing a dependency re-runs the querier outright, which is
   * the one thing that reliably works without a remount.
   *
   * A counter rather than a boolean: two rapid retries must produce two distinct
   * dependency values, or the second would be a no-op.
   */
  const [retryToken, setRetryToken] = useState(0);

  /**
   * Everything the selector needs, read in one live query.
   *
   * One query rather than four so the four reads are consistent with each other:
   * separate subscriptions can resolve at different moments and briefly pair new
   * transactions with a stale account list, which would change which accounts
   * the coverage rule requires.
   */
  const result = useLiveQuery<WorkspaceReadResult | undefined>(async () => {
    if (!db?.isOpen()) return undefined;
    try {
      // `allSettled`, not `all`: a rejection inside `Promise.all` tears down the
      // surrounding Dexie zone before the reads that *did* succeed resolve, and
      // the live query then never emits at all — the page would sit on "loading"
      // forever instead of saying it could not read the workspace.
      const settled = await Promise.allSettled([
        listTransactions(db),
        listAccounts(db),
        listImportSessions(db),
        getSetting<boolean>(db, SETTING_KEYS.incomeDataComplete),
      ]);
      if (settled.some((outcome) => outcome.status === 'rejected')) {
        return { ok: false as const };
      }
      const [transactions, accounts, sessions, incomeSetting] = [
        (settled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof listTransactions>>>).value,
        (settled[1] as PromiseFulfilledResult<Awaited<ReturnType<typeof listAccounts>>>).value,
        (settled[2] as PromiseFulfilledResult<Awaited<ReturnType<typeof listImportSessions>>>)
          .value,
        (settled[3] as PromiseFulfilledResult<boolean | undefined>).value,
      ];
      return {
        ok: true as const,
        transactions: transactions.map(toSelectable),
        accounts,
        // `accountIds` is passed through exactly as stored. A multi-account
        // session is *not* split into per-account ranges here: whether such a
        // range can establish coverage is the selector's decision (§14.11), and
        // splitting it would fabricate the per-account evidence the schema
        // does not hold.
        coverage: sessions.map((session) => ({
          ...(session.statementRangeStart === undefined
            ? {}
            : { start: session.statementRangeStart }),
          ...(session.statementRangeEnd === undefined ? {} : { end: session.statementRangeEnd }),
          accountIds: session.accountIds,
        })),
        incomeSetting,
      };
    } catch {
      // Sanitized: the caller learns the read failed, never why or with what
      // data. The underlying message is deliberately not captured at all, so it
      // cannot leak into an error string later.
      return { ok: false as const };
    }
    // `retryToken` is a dependency, not a value the querier reads: changing it
    // is what forces a fresh run after a failure.
  }, [db, retryToken]);

  const data = result?.ok === true ? result : undefined;
  const failed = result?.ok === false;

  const accounts = useMemo(() => data?.accounts ?? [], [data]);
  const transactions = useMemo(() => data?.transactions ?? [], [data]);
  const coverage = useMemo(() => data?.coverage ?? [], [data]);

  const accountLabels = useMemo(
    () => new Map(accounts.map((account) => [account.id, account.label])),
    [accounts],
  );

  const accountChoices = useMemo<readonly FilterChoice[]>(
    () => accounts.map((account) => ({ id: account.id, label: account.label })),
    [accounts],
  );

  const categoryChoices = useMemo<readonly FilterChoice[]>(
    () => CATEGORIES.map((category) => ({ id: category.id, label: category.label })),
    [],
  );

  /**
   * Selections narrowed to what still exists.
   *
   * A deleted account must not keep filtering the dashboard, but a *valid*
   * selection has to survive every reactive update — so only the ids that no
   * longer resolve are dropped, never the whole selection.
   */
  const liveAccountIds = useMemo(
    () => accountIds.filter((id) => accountLabels.has(id)),
    [accountIds, accountLabels],
  );
  const liveCategoryIds = useMemo(
    () => categoryIds.filter((id) => categoryChoices.some((choice) => choice.id === id)),
    [categoryIds, categoryChoices],
  );

  const domain = useMemo(() => transactionDateDomain(transactions), [transactions]);

  /**
   * Complete months for the current account scope.
   *
   * Computed with the same exported selector functions the dashboard uses, so
   * "latest complete month" is selector-produced completeness — never inferred
   * from the earliest and latest transaction dates (§14.2).
   */
  const completeMonths = useMemo<ReadonlySet<IsoMonth>>(() => {
    const scopeFilters: DashboardFilters = {
      range: { start: '0000-01-01', end: '9999-12-31' },
      ...(liveAccountIds.length > 0 ? { accountIds: liveAccountIds } : {}),
    };
    const scope = accountsInScope(
      accounts.map(({ id, archived }): AccountScope => ({ id, archived })),
      scopeFilters,
    );
    return completeMonthsForScope(buildAccountCoverage(coverage), scope);
  }, [accounts, coverage, liveAccountIds]);

  /**
   * The preset actually in force.
   *
   * `latest-complete-month` can stop being answerable while it is selected — an
   * account filter can widen the scope, or a session can be deleted — and the
   * stored choice would then label All-data bounds as "latest complete month".
   * Deriving the fallback rather than storing it means there is no moment where
   * the label and the dates disagree, and no effect that has to fire to repair
   * state after the fact.
   */
  const effectivePreset: PeriodPreset =
    preset === 'latest-complete-month' && completeMonths.size === 0 ? 'all-data' : preset;

  const customError = useMemo<CustomRangeError>(
    () => (effectivePreset === 'custom' ? validateCustomRange(customStart, customEnd) : null),
    [effectivePreset, customStart, customEnd],
  );

  const presetRange = useMemo(
    () => resolvePreset(effectivePreset, { today: today(), domain, completeMonths }),
    [effectivePreset, today, domain, completeMonths],
  );

  const range = useMemo(() => {
    if (effectivePreset === 'custom') {
      return customError === null ? { start: customStart, end: customEnd } : null;
    }
    return presetRange;
  }, [effectivePreset, customError, customStart, customEnd, presetRange]);

  /** Falls back to the whole domain when a preset cannot resolve, never to a guess. */
  const effectiveRange = useMemo(
    () => range ?? resolvePreset('all-data', { today: today(), domain, completeMonths }),
    [range, today, domain, completeMonths],
  );

  const filters = useMemo<DashboardFilters>(
    () =>
      normalizeDashboardFilters({
        range: effectiveRange ?? { start: '0000-01-01', end: '9999-12-31' },
        ...(liveAccountIds.length > 0 ? { accountIds: liveAccountIds } : {}),
        ...(liveCategoryIds.length > 0 ? { categoryIds: liveCategoryIds } : {}),
      }),
    [effectiveRange, liveAccountIds, liveCategoryIds],
  );

  const selection = useMemo<DashboardSelection | null>(() => {
    if (!data) return null;
    return selectDashboard({
      transactions,
      filters,
      incomeCompleteness: incomeCompletenessFrom(data.incomeSetting),
      coverage,
      accounts: accounts.map(({ id, archived }): AccountScope => ({ id, archived })),
      granularity,
    });
  }, [data, transactions, filters, coverage, accounts, granularity]);

  const status: DashboardStatus = failed
    ? 'failed'
    : !db || result === undefined
      ? 'loading'
      : transactions.length === 0 && accounts.length === 0
        ? 'empty'
        : 'ready';

  const toggle = useCallback(
    (setter: (updater: (current: readonly string[]) => readonly string[]) => void, id: string) => {
      setter((current) =>
        current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
      );
    },
    [],
  );

  const resetAll = useCallback(() => {
    setPresetState('all-data');
    setCustomStart('');
    setCustomEnd('');
    setAccountIds([]);
    setCategoryIds([]);
  }, []);

  return {
    status,
    errorMessage: failed ? 'This workspace could not be read. No figures are shown.' : null,
    preset: effectivePreset,
    filters,
    customStart,
    customEnd,
    customError,
    accountChoices,
    categoryChoices,
    selection: status === 'ready' ? selection : null,
    domain,
    completeMonths,
    latestCompleteMonthAvailable: completeMonths.size > 0,
    accountLabels,
    setPreset: setPresetState,
    setCustomStart,
    setCustomEnd,
    toggleAccount: (id) => toggle(setAccountIds, id),
    toggleCategory: (id) => toggle(setCategoryIds, id),
    clearAccounts: () => setAccountIds([]),
    clearCategories: () => setCategoryIds([]),
    resetAll,
    // Each activation is a distinct token, so rapid presses queue rather than
    // collapse — and only the newest run's result is ever published, because
    // `useLiveQuery` discards superseded results.
    retry: () => setRetryToken((token) => token + 1),
  };
}
