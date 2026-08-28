import { useCallback, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { WorkspaceDatabase } from '../db/database';
import { listAccounts } from '../db/repositories/accounts';
import { listTransactions, listImportSessions } from '../db/repositories/transactions';
import { getSetting, SETTING_KEYS } from '../db/repositories/settings';
import {
  copyBudgetPlanToMonth,
  deleteBudgetPlanWithTargets,
  listAllCategoryTargets,
  listBudgetPlans,
  saveValidatedBudgetPlan,
  type CopyPlanOutcome,
} from '../db/repositories/budgets';
import { newId } from '../lib/ids';
import type { Account, BudgetCategoryTarget, BudgetPlan, IsoDate, IsoMonth } from '../types/domain';
import {
  incomeCompletenessFrom,
  monthOf,
  monthPositionOf,
  nextMonth,
  previousMonth,
  selectBudgetProgress,
  type AccountScope,
  type BudgetCategoryTargetInput,
  type BudgetSelection,
  type MonthPosition,
  type SelectableTransaction,
  type StatementRange,
} from '../calculations';
import { systemToday, type TodayProvider } from './dashboardPeriod';

/**
 * The one place the budget page meets the database.
 *
 * Built to the same shape as `useDashboard`, and for the same reason: the page
 * reads one `selection` computed by the shared calculation layer, and never
 * calls Dexie, a repository, or arithmetic of its own.
 *
 * Reads are gathered in a single `useLiveQuery` so a plan and the transactions
 * it is measured against are always from one moment. Dexie re-runs the query on
 * every relevant write, which is what makes an edit on this page — or an
 * archived account, or a changed income setting — appear without a refresh.
 */

export type BudgetStatusKind = 'loading' | 'ready' | 'empty' | 'failed';

/** Dollar strings as typed, before parsing. Blank means unset, never zero. */
export interface BudgetFormValues {
  readonly overallLimit: string;
  readonly incomeTarget: string;
  readonly savingsTarget: string;
  readonly categoryLimits: Readonly<Record<string, string>>;
}

export type SaveState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'saved'; readonly message: string }
  | { readonly kind: 'invalid'; readonly message: string }
  | { readonly kind: 'failed'; readonly message: string };

export interface BudgetApi {
  readonly status: BudgetStatusKind;
  /** Fixed, sanitized text. Never carries a field value or a database message. */
  readonly errorMessage: string | null;
  readonly month: IsoMonth;
  readonly monthPosition: MonthPosition;
  readonly selection: BudgetSelection | null;
  readonly plan: BudgetPlan | null;
  readonly form: BudgetFormValues;
  readonly saveState: SaveState;
  readonly previousMonthHasPlan: boolean;
  readonly accountLabels: ReadonlyMap<string, string>;
  readonly activeAccountCount: number;

  setMonth(month: IsoMonth): void;
  goToPreviousMonth(): void;
  goToNextMonth(): void;
  setOverallLimit(value: string): void;
  setIncomeTarget(value: string): void;
  setSavingsTarget(value: string): void;
  setCategoryLimit(categoryId: string, value: string): void;
  resetForm(): void;
  save(): Promise<void>;
  deletePlan(): Promise<void>;
  copyPreviousMonth(overwrite: boolean): Promise<CopyPlanOutcome>;
  retry(): void;
}

export interface UseBudgetOptions {
  readonly db: WorkspaceDatabase | null;
  readonly month?: IsoMonth;
  readonly today?: TodayProvider;
}

interface WorkspaceRead {
  readonly ok: true;
  readonly transactions: readonly SelectableTransaction[];
  readonly accounts: readonly Account[];
  readonly coverage: readonly StatementRange[];
  readonly plans: readonly BudgetPlan[];
  readonly targets: readonly BudgetCategoryTarget[];
  readonly incomeSetting: boolean | undefined;
}

interface WorkspaceReadFailure {
  readonly ok: false;
}

type WorkspaceReadResult = WorkspaceRead | WorkspaceReadFailure;

const EMPTY_FORM: BudgetFormValues = {
  overallLimit: '',
  incomeTarget: '',
  savingsTarget: '',
  categoryLimits: {},
};

/**
 * Dollars typed by a person, as exact integer cents.
 *
 * Deliberately strict, and deliberately not `parseFloat`. `parseFloat('12abc')`
 * is `12`, `Number('1e3')` is `1000`, and `Math.round(19.99 * 100)` is a
 * floating-point multiplication whose result is only usually right. Cents are
 * assembled from the digit strings instead, so `19.99` is `1999` because those
 * are the characters, not because a float happened to land there (§1 rule 4).
 */
export function parseDollarsToCents(
  raw: string,
): { ok: true; cents: number | undefined } | { ok: false; reason: string } {
  const text = raw.trim();
  if (text === '') return { ok: true, cents: undefined };
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    if (/^-/.test(text)) return { ok: false, reason: 'Enter an amount of zero or more.' };
    if (/e/i.test(text)) return { ok: false, reason: 'Enter a plain amount, such as 1200.00.' };
    if (/\.\d{3,}$/.test(text)) return { ok: false, reason: 'Use at most two decimal places.' };
    return { ok: false, reason: 'Enter an amount in dollars, such as 1200.00.' };
  }
  const [whole, fraction = ''] = text.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) return { ok: false, reason: 'That amount is too large.' };
  return { ok: true, cents };
}

/** Integer cents back to an editable dollar string. Presentation only. */
export function centsToDollarInput(cents: number | undefined): string {
  if (cents === undefined) return '';
  return (cents / 100).toFixed(2);
}

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

const READ_FAILED = 'This workspace could not be read. No figures are shown.';
const WRITE_FAILED = 'This plan could not be saved. Nothing was changed.';
const DELETE_FAILED = 'This plan could not be deleted. Nothing was changed.';
const COPY_FAILED = 'The previous month could not be copied. Nothing was changed.';

export function useBudget(options: UseBudgetOptions): BudgetApi {
  const { db, today = systemToday } = options;

  const initialMonth = options.month ?? monthOf(today());
  const [month, setMonthState] = useState<IsoMonth>(initialMonth);
  const [retryToken, setRetryToken] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
  /** Null while the form mirrors the stored plan; set once the user edits. */
  const [draft, setDraft] = useState<BudgetFormValues | null>(null);

  const result = useLiveQuery<WorkspaceReadResult | undefined>(async () => {
    if (!db?.isOpen()) return undefined;
    try {
      // `allSettled`, not `all`: a rejection inside `Promise.all` tears down the
      // Dexie zone before the successful reads resolve, and the live query then
      // never emits — the page would sit on "loading" rather than saying it
      // could not be read.
      const settled = await Promise.allSettled([
        listTransactions(db),
        listAccounts(db),
        listImportSessions(db),
        listBudgetPlans(db),
        listAllCategoryTargets(db),
        getSetting<boolean>(db, SETTING_KEYS.incomeDataComplete),
      ]);
      if (settled.some((outcome) => outcome.status === 'rejected')) return { ok: false as const };

      const value = <T>(index: number) => (settled[index] as PromiseFulfilledResult<T>).value;
      const sessions = value<Awaited<ReturnType<typeof listImportSessions>>>(2);

      return {
        ok: true as const,
        transactions: value<Awaited<ReturnType<typeof listTransactions>>>(0).map(toSelectable),
        accounts: value<Awaited<ReturnType<typeof listAccounts>>>(1),
        coverage: sessions.map((session) => ({
          ...(session.statementRangeStart === undefined
            ? {}
            : { start: session.statementRangeStart }),
          ...(session.statementRangeEnd === undefined ? {} : { end: session.statementRangeEnd }),
          accountIds: session.accountIds,
        })),
        plans: value<Awaited<ReturnType<typeof listBudgetPlans>>>(3),
        targets: value<Awaited<ReturnType<typeof listAllCategoryTargets>>>(4),
        incomeSetting: value<boolean | undefined>(5),
      };
    } catch {
      // Sanitized at the boundary: the caller learns the read failed, never why.
      // The underlying message is not captured at all, so it cannot leak later.
      return { ok: false as const };
    }
  }, [db, retryToken]);

  const data = result?.ok === true ? result : undefined;
  const failed = result?.ok === false;

  const accounts = useMemo(() => data?.accounts ?? [], [data]);
  const transactions = useMemo(() => data?.transactions ?? [], [data]);
  const coverage = useMemo(() => data?.coverage ?? [], [data]);
  const plans = useMemo(() => data?.plans ?? [], [data]);
  const allTargets = useMemo(() => data?.targets ?? [], [data]);

  const plan = useMemo(
    () => plans.find((candidate) => candidate.month === month) ?? null,
    [plans, month],
  );

  const targets = useMemo<readonly BudgetCategoryTarget[]>(
    () => (plan === null ? [] : allTargets.filter((target) => target.budgetPlanId === plan.id)),
    [allTargets, plan],
  );

  const accountLabels = useMemo(
    () => new Map(accounts.map((account) => [account.id, account.label])),
    [accounts],
  );

  const todayDate: IsoDate = today();

  const selection = useMemo<BudgetSelection | null>(() => {
    if (!data) return null;
    return selectBudgetProgress({
      month,
      plan:
        plan === null
          ? null
          : {
              month: plan.month,
              ...(plan.overallLimitCents === undefined
                ? {}
                : { overallLimitCents: plan.overallLimitCents }),
              ...(plan.incomeTargetCents === undefined
                ? {}
                : { incomeTargetCents: plan.incomeTargetCents }),
              ...(plan.savingsTargetCents === undefined
                ? {}
                : { savingsTargetCents: plan.savingsTargetCents }),
            },
      categoryTargets: targets.map((target): BudgetCategoryTargetInput => ({
        categoryId: target.categoryId,
        limitCents: target.limitCents,
      })),
      transactions,
      accounts: accounts.map(({ id, archived }): AccountScope => ({ id, archived })),
      coverage,
      incomeCompleteness: incomeCompletenessFrom(data.incomeSetting),
      today: todayDate,
    });
  }, [data, month, plan, targets, transactions, accounts, coverage, todayDate]);

  /**
   * The form, derived from the stored plan until the user types.
   *
   * Deriving rather than syncing through an effect means there is no moment
   * where the inputs show one month's numbers under another month's heading —
   * changing month clears the draft and the stored values reappear immediately.
   */
  const storedForm = useMemo<BudgetFormValues>(() => {
    if (plan === null) return EMPTY_FORM;
    const categoryLimits: Record<string, string> = {};
    for (const target of targets) {
      categoryLimits[target.categoryId] = centsToDollarInput(target.limitCents);
    }
    return {
      overallLimit: centsToDollarInput(plan.overallLimitCents),
      incomeTarget: centsToDollarInput(plan.incomeTargetCents),
      savingsTarget: centsToDollarInput(plan.savingsTargetCents),
      categoryLimits,
    };
  }, [plan, targets]);

  const form = draft ?? storedForm;

  const previousMonthHasPlan = useMemo(
    () => plans.some((candidate) => candidate.month === previousMonth(month)),
    [plans, month],
  );

  const status: BudgetStatusKind = failed
    ? 'failed'
    : !db || result === undefined
      ? 'loading'
      : transactions.length === 0 && accounts.length === 0 && plans.length === 0
        ? 'empty'
        : 'ready';

  const edit = useCallback((update: Partial<BudgetFormValues>) => {
    setSaveState({ kind: 'idle' });
    setDraft((current) => ({ ...(current ?? EMPTY_FORM), ...update }));
  }, []);

  /* The draft is keyed to a month, so moving month must drop it. */
  const setMonth = useCallback((next: IsoMonth) => {
    setMonthState(next);
    setDraft(null);
    setSaveState({ kind: 'idle' });
  }, []);

  const buildRecords = useCallback(():
    | { ok: true; plan: BudgetPlan; targets: BudgetCategoryTarget[] }
    | { ok: false; message: string } => {
    const overall = parseDollarsToCents(form.overallLimit);
    if (!overall.ok) return { ok: false, message: `Monthly spending limit: ${overall.reason}` };
    const income = parseDollarsToCents(form.incomeTarget);
    if (!income.ok) return { ok: false, message: `Expected monthly income: ${income.reason}` };
    const savings = parseDollarsToCents(form.savingsTarget);
    if (!savings.ok) return { ok: false, message: `Monthly savings target: ${savings.reason}` };

    const planId = plan?.id ?? newId();
    const nextTargets: BudgetCategoryTarget[] = [];
    for (const [categoryId, raw] of Object.entries(form.categoryLimits)) {
      const parsed = parseDollarsToCents(raw);
      if (!parsed.ok) return { ok: false, message: `Category limit: ${parsed.reason}` };
      if (parsed.cents === undefined) continue;
      const existing = targets.find((target) => target.categoryId === categoryId);
      nextTargets.push({
        id: existing?.id ?? newId(),
        budgetPlanId: planId,
        categoryId,
        limitCents: parsed.cents,
      });
    }

    return {
      ok: true,
      plan: {
        id: planId,
        month,
        ...(overall.cents === undefined ? {} : { overallLimitCents: overall.cents }),
        ...(income.cents === undefined ? {} : { incomeTargetCents: income.cents }),
        ...(savings.cents === undefined ? {} : { savingsTargetCents: savings.cents }),
        ...(plan?.copiedFromMonth === undefined ? {} : { copiedFromMonth: plan.copiedFromMonth }),
        rolloverEnabled: false,
      },
      targets: nextTargets,
    };
  }, [form, month, plan, targets]);

  const save = useCallback(async () => {
    if (!db) return;
    const built = buildRecords();
    if (!built.ok) {
      setSaveState({ kind: 'invalid', message: built.message });
      return;
    }
    setSaveState({ kind: 'saving' });
    try {
      const outcome = await saveValidatedBudgetPlan(db, built.plan, built.targets);
      setDraft(null);
      setSaveState({
        kind: 'saved',
        message:
          outcome === 'deleted-empty'
            ? 'That plan had nothing in it, so no plan is stored for this month.'
            : 'Plan saved.',
      });
    } catch {
      setSaveState({ kind: 'failed', message: WRITE_FAILED });
    }
  }, [db, buildRecords]);

  const deletePlan = useCallback(async () => {
    if (!db || plan === null) return;
    setSaveState({ kind: 'saving' });
    try {
      await deleteBudgetPlanWithTargets(db, plan.id);
      setDraft(null);
      setSaveState({ kind: 'saved', message: 'Plan deleted.' });
    } catch {
      setSaveState({ kind: 'failed', message: DELETE_FAILED });
    }
  }, [db, plan]);

  const copyPreviousMonth = useCallback(
    async (overwrite: boolean): Promise<CopyPlanOutcome> => {
      if (!db) return 'no-source';
      setSaveState({ kind: 'saving' });
      try {
        const outcome = await copyBudgetPlanToMonth(db, {
          fromMonth: previousMonth(month),
          toMonth: month,
          newPlanId: newId(),
          newTargetId: () => newId(),
          overwrite,
        });
        setDraft(null);
        setSaveState(
          outcome === 'copied'
            ? { kind: 'saved', message: 'Copied last month’s plan into this month.' }
            : outcome === 'no-source'
              ? { kind: 'invalid', message: 'There is no plan for last month to copy.' }
              : { kind: 'idle' },
        );
        return outcome;
      } catch {
        setSaveState({ kind: 'failed', message: COPY_FAILED });
        return 'no-source';
      }
    },
    [db, month],
  );

  return {
    status,
    errorMessage: failed ? READ_FAILED : null,
    month,
    monthPosition: monthPositionOf(month, todayDate),
    selection: status === 'ready' ? selection : null,
    plan,
    form,
    saveState,
    previousMonthHasPlan,
    accountLabels,
    activeAccountCount: accounts.filter((account) => !account.archived).length,

    setMonth,
    goToPreviousMonth: () => setMonth(previousMonth(month)),
    goToNextMonth: () => setMonth(nextMonth(month)),
    setOverallLimit: (value) => edit({ overallLimit: value }),
    setIncomeTarget: (value) => edit({ incomeTarget: value }),
    setSavingsTarget: (value) => edit({ savingsTarget: value }),
    setCategoryLimit: (categoryId, value) =>
      edit({ categoryLimits: { ...form.categoryLimits, [categoryId]: value } }),
    resetForm: () => {
      setDraft(null);
      setSaveState({ kind: 'idle' });
    },
    save,
    deletePlan,
    copyPreviousMonth,
    // A counter, so two rapid retries are two distinct dependency values.
    retry: () => setRetryToken((token) => token + 1),
  };
}
