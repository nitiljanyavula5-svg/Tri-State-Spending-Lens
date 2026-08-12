import type { WorkspaceDatabase } from './database';
import { accountSchema, importSessionSchema, MAX_ROWS, transactionSchema } from './backupSchema';
import { getWorkspaceMode, setWorkspaceMode } from './repositories/settings';
import { TABLE_NAMES } from './schema';
import { workspaceTables } from './workspace';
import { UNCATEGORIZED_CATEGORY_ID } from '../domain/categories';
import type {
  Account,
  Direction,
  ImportSession,
  IsoDate,
  Transaction,
  TransactionKind,
} from '../types/domain';
import type { DuplicateCandidate } from '../import/duplicates';
import type { RowRejection } from '../import/errors';
import { sanitizeSourceFileName } from '../import/fileValidation';
import { isValidFingerprint } from '../import/fingerprint';
import { MAX_FILES_PER_SESSION, MAX_SESSION_ROWS, MAX_WARNINGS } from '../import/limits';
import { MAPPING_PRESET_VERSION } from '../import/mapping';
import type { FingerprintedRow } from '../import/normalizeFile';
import { systemClock, type Clock } from '../lib/clock';
import { newId } from '../lib/ids';

/**
 * Committing a staged import to IndexedDB.
 *
 * data-methodology.md §2.2: parsing, normalization, and duplicate analysis all
 * finish **before** anything is written, and the write itself is one IndexedDB
 * transaction that either completes or leaves the workspace untouched. A
 * partially written import is a defect, not an acceptable outcome.
 *
 * The module is split deliberately:
 *
 *  - `buildStagedImport` is pure. It turns normalized rows into the exact
 *    records that will be stored, with injectable id and clock sources, so the
 *    shape of a commit can be asserted without a database.
 *  - `validateStagedImport` is pure. Everything it can prove without reading
 *    the workspace is proven before a transaction is opened.
 *  - `commitImport` reads what only the workspace knows, then writes.
 *
 * No React component may call the Dexie tables directly; this is the boundary.
 */

/* ------------------------------------------------------------- defaults - */

/**
 * The `kind` a freshly imported row starts with.
 *
 * data-methodology.md §3.5 is explicit and reasoned: **debits default to
 * `purchase`** because that is the ordinary case and it is what makes net
 * spending meaningful immediately after import, while **credits default to
 * `unknown`** because a credit may be income, a refund, a transfer in, or a
 * card payment and the product must not guess.
 *
 * This is a normalization default, not classification. It consults no rule, no
 * merchant, and no keyword — Phase 4 owns all of those. Reducing it to a blanket
 * `unknown` would be the more conservative-looking choice and the wrong one:
 * calculation-contract.md §3.3 excludes `unknown` debits from net spending, so
 * every freshly imported workspace would report zero spending until the user
 * reviewed every row by hand.
 */
export function defaultKindForDirection(direction: Direction): TransactionKind {
  return direction === 'debit' ? 'purchase' : 'unknown';
}

/* --------------------------------------------------------------- shapes - */

/** Everything one commit will write, fully formed and ready to validate. */
export interface StagedImport {
  readonly session: ImportSession;
  readonly transactions: readonly Transaction[];
  /** Accounts that do not exist yet and are created by this same commit. */
  readonly newAccounts: readonly Account[];
}

export interface BuildStagedImportInput {
  /** Logical data rows encountered across every file, before any decision. */
  readonly rowCount: number;
  /** Rows that will be committed — normalization survivors, minus exclusions. */
  readonly acceptedRows: readonly FingerprintedRow[];
  /** Duplicate candidates the user explicitly chose to exclude. */
  readonly excludedRows: readonly FingerprintedRow[];
  readonly rejections: readonly RowRejection[];
  readonly duplicateCandidates: readonly DuplicateCandidate[];
  readonly warnings: readonly string[];
  readonly sourceFileNames: readonly string[];
  readonly newAccounts: readonly Account[];
  readonly statementRangeStart?: IsoDate;
  readonly statementRangeEnd?: IsoDate;
  /** Injectable so a test can assert against a fixed id instead of randomness. */
  readonly sessionId?: string;
  readonly newId?: () => string;
  readonly clock?: Clock;
}

/**
 * Builds the records a commit will write.
 *
 * Pure and total: it reads no database, and it never rejects. Whether the
 * result is *committable* is `validateStagedImport`'s question, which keeps
 * "what would be written" and "may it be written" separately testable.
 */
export function buildStagedImport(input: BuildStagedImportInput): StagedImport {
  const clock = input.clock ?? systemClock;
  const generateId = input.newId ?? newId;

  const importedAt = clock();
  const sessionId = input.sessionId ?? generateId();

  const transactions: Transaction[] = input.acceptedRows.map((row) => ({
    id: generateId(),
    fingerprint: row.fingerprint,
    importSessionId: sessionId,
    originalRow: row.originalRow,
    accountId: row.accountId,
    postedDate: row.postedDate,
    descriptionRaw: row.descriptionRaw,
    merchantNormalized: row.merchantNormalized,
    amountCents: row.amountCents,
    direction: row.direction,
    kind: defaultKindForDirection(row.direction),
    // Phase 3 assigns no categories at all; every accepted row is uncategorized
    // by construction and Phase 4's rule engine is what changes that.
    categoryId: UNCATEGORIZED_CATEGORY_ID,
    categorySource: 'uncategorized',
    classificationConfidence: 'none',
    // `essentiality`, `variability`, `note`, and `exclusionReason` are omitted
    // rather than set to an empty value. They are optional in the domain type,
    // and an absent field states "not decided" where `''` would state "decided,
    // and the answer is nothing".
    tags: [],
    excludedFromSpending: false,
    createdAt: importedAt,
    updatedAt: importedAt,
  }));

  // Accounts this session touched: every account its rows landed in, plus every
  // account it created — a new account whose every row was rejected still
  // belongs to the session that created it.
  const accountIds = [
    ...new Set([
      ...input.acceptedRows.map((row) => row.accountId),
      ...input.newAccounts.map((account) => account.id),
    ]),
  ].sort((a, b) => a.localeCompare(b));

  const session: ImportSession = {
    id: sessionId,
    importedAt,
    // Names are neutralized before storage, not on the way out, so no path
    // separator or control byte is ever written (threat-model.md §10).
    sourceFileNames: [
      ...new Set(input.sourceFileNames.map((name) => sanitizeSourceFileName(name))),
    ].slice(0, MAX_FILES_PER_SESSION),
    accountIds,
    mappingVersion: MAPPING_PRESET_VERSION,
    rowCount: input.rowCount,
    acceptedCount: transactions.length,
    // A duplicate candidate becomes a rejection only when the user excludes it.
    // Flagging alone never rejects anything (data-methodology.md §4.1).
    rejectedCount: input.rejections.length + input.excludedRows.length,
    duplicateCandidateCount: input.duplicateCandidates.length,
    warnings: [...new Set(input.warnings)].slice(0, MAX_WARNINGS),
    ...(input.statementRangeStart === undefined
      ? {}
      : { statementRangeStart: input.statementRangeStart }),
    ...(input.statementRangeEnd === undefined
      ? {}
      : { statementRangeEnd: input.statementRangeEnd }),
  };

  return { session, transactions, newAccounts: [...input.newAccounts] };
}

/* ------------------------------------------------------------ rejection - */

export type ImportCommitRejectionReason =
  | 'invalid-shape'
  | 'count-mismatch'
  | 'too-many-rows'
  | 'duplicate-id-in-request'
  | 'id-already-exists'
  | 'unknown-account-reference'
  | 'session-reference-mismatch'
  | 'invalid-fingerprint'
  | 'invalid-statement-range'
  | 'unsupported-currency'
  | 'unexpected-import-defaults'
  | 'demo-replacement-not-confirmed'
  | 'workspace-write-failed';

export interface ImportCommitRejection {
  readonly ok: false;
  readonly reason: ImportCommitRejectionReason;
  /** Safe to display: never contains a field value (threat-model.md §8). */
  readonly message: string;
  /** Field paths that failed. Paths and counts only — never row content. */
  readonly problemPaths: readonly string[];
}

export interface ImportCommitSuccess {
  readonly ok: true;
  readonly sessionId: string;
  readonly committedTransactionCount: number;
  readonly createdAccountIds: readonly string[];
  /** True when this commit replaced the demo workspace with real data. */
  readonly replacedDemoWorkspace: boolean;
  readonly workspaceMode: 'personal';
}

export type ImportCommitResult = ImportCommitSuccess | ImportCommitRejection;

const REJECTION_MESSAGES: Record<ImportCommitRejectionReason, string> = {
  'invalid-shape':
    'This import could not be saved because some of its records are missing required information or hold values of the wrong type. Nothing was changed.',
  'count-mismatch':
    'This import’s summary counts do not match the rows it contains, so it was not trusted. Nothing was changed.',
  'too-many-rows': `An import can hold at most ${MAX_SESSION_ROWS.toLocaleString('en-US')} rows. Nothing was changed.`,
  'duplicate-id-in-request':
    'This import contains two records sharing one identifier, which would make them impossible to tell apart. Nothing was changed.',
  'id-already-exists':
    'This import reuses an identifier that already exists in your workspace, which would overwrite data you already have. Nothing was changed.',
  'unknown-account-reference':
    'This import refers to an account that does not exist and is not being created, so it was not saved. Nothing was changed.',
  'session-reference-mismatch':
    'This import contains transactions that belong to a different import session. Nothing was changed.',
  'invalid-fingerprint':
    'This import contains a transaction whose content fingerprint is not in the expected form. Nothing was changed.',
  'invalid-statement-range':
    'The statement period ends before it begins, so this import was not saved. Nothing was changed.',
  'unsupported-currency':
    'This version works in US dollars only, and this import names another currency. Nothing was changed.',
  'unexpected-import-defaults':
    'This import contains transactions that already carry review decisions, which a fresh import cannot. Nothing was changed.',
  'demo-replacement-not-confirmed':
    'This workspace currently holds the sample data. Importing your own statements replaces it, and that has to be confirmed first. Nothing was changed.',
  'workspace-write-failed':
    'The import could not be written to local storage. Nothing was changed — your workspace is exactly as it was.',
};

function reject(
  reason: ImportCommitRejectionReason,
  problemPaths: readonly string[] = [],
): ImportCommitRejection {
  return { ok: false, reason, message: REJECTION_MESSAGES[reason], problemPaths };
}

interface ValidationIssue {
  readonly path: readonly PropertyKey[];
  readonly code: string;
}

/** Path-and-code only. Zod's own messages can quote the value they rejected. */
function safeProblemPaths(prefix: string, issues: readonly ValidationIssue[]): string[] {
  const paths = new Set<string>();
  for (const issue of issues.slice(0, 25)) {
    const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)';
    paths.add(`${prefix}.${path} — ${issue.code}`);
  }
  return [...paths];
}

function firstDuplicate(values: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return null;
}

/**
 * Everything provable without reading the workspace.
 *
 * Returns `null` when the staged import is structurally sound. Ordering is
 * chosen so the most specific explanation wins: a row that fails its schema is
 * reported as a shape problem rather than surfacing later as a confusing
 * count mismatch.
 */
export function validateStagedImport(staged: StagedImport): ImportCommitRejection | null {
  const { session, transactions, newAccounts } = staged;

  /* ---------------------------------------------------------- shapes - */

  const sessionParse = importSessionSchema.safeParse(session);
  if (!sessionParse.success) {
    return reject('invalid-shape', safeProblemPaths('session', sessionParse.error.issues));
  }

  for (let index = 0; index < newAccounts.length; index += 1) {
    const parsed = accountSchema.safeParse(newAccounts[index]);
    if (!parsed.success) {
      return reject('invalid-shape', safeProblemPaths(`newAccounts.${index}`, parsed.error.issues));
    }
  }

  for (let index = 0; index < transactions.length; index += 1) {
    const parsed = transactionSchema.safeParse(transactions[index]);
    if (!parsed.success) {
      return reject(
        'invalid-shape',
        safeProblemPaths(`transactions.${index}`, parsed.error.issues),
      );
    }
  }

  /* ----------------------------------------------------------- limits - */

  if (transactions.length > MAX_SESSION_ROWS || transactions.length > MAX_ROWS.transactions) {
    return reject('too-many-rows', [`transactions — ${transactions.length}`]);
  }

  /* ------------------------------------------------------- currency - */

  // `accountSchema` already pins `currency` to the USD literal. Checking again
  // buys a specific reason code instead of a generic shape rejection, which is
  // the difference between "we only do dollars" and "something is malformed".
  for (let index = 0; index < newAccounts.length; index += 1) {
    if (newAccounts[index]!.currency !== 'USD') {
      return reject('unsupported-currency', [`newAccounts.${index}.currency`]);
    }
  }

  /* ---------------------------------------------------- unique ids - */

  const duplicateTransactionId = firstDuplicate(transactions.map((row) => row.id));
  if (duplicateTransactionId !== null) {
    return reject('duplicate-id-in-request', ['transactions.id']);
  }

  const duplicateAccountId = firstDuplicate(newAccounts.map((account) => account.id));
  if (duplicateAccountId !== null) {
    return reject('duplicate-id-in-request', ['newAccounts.id']);
  }

  /* -------------------------------------------------- session refs - */

  for (let index = 0; index < transactions.length; index += 1) {
    if (transactions[index]!.importSessionId !== session.id) {
      return reject('session-reference-mismatch', [`transactions.${index}.importSessionId`]);
    }
  }

  /* --------------------------------------------------- fingerprints - */

  // Format only. The fingerprint *version* is one of the seven fields hashed
  // into the digest (see `fingerprintCanonicalString`), so it is pinned at the
  // point of computation and is not recoverable from the digest afterwards —
  // there is no separate stored field here to check it against.
  for (let index = 0; index < transactions.length; index += 1) {
    if (!isValidFingerprint(transactions[index]!.fingerprint)) {
      return reject('invalid-fingerprint', [`transactions.${index}.fingerprint`]);
    }
  }

  /* ------------------------------------------------ import defaults - */

  // A freshly imported row carries no review decision. Anything already
  // categorized, tagged, excluded, or marked essential did not come out of the
  // normalization pipeline, and storing it would make the Health Report's
  // "uncategorized" count a lie. Phase 4 relaxes this deliberately.
  for (let index = 0; index < transactions.length; index += 1) {
    const row = transactions[index]!;
    const problem =
      row.categorySource !== 'uncategorized'
        ? 'categorySource'
        : row.classificationConfidence !== 'none'
          ? 'classificationConfidence'
          : row.tags.length > 0
            ? 'tags'
            : row.excludedFromSpending
              ? 'excludedFromSpending'
              : row.essentiality !== undefined
                ? 'essentiality'
                : row.variability !== undefined
                  ? 'variability'
                  : null;

    if (problem !== null) {
      return reject('unexpected-import-defaults', [`transactions.${index}.${problem}`]);
    }
  }

  /* -------------------------------------------------------- counts - */

  if (session.acceptedCount !== transactions.length) {
    return reject('count-mismatch', ['session.acceptedCount']);
  }

  // The invariant the Health Report reconciles against. Questionable,
  // uncategorized, and duplicate-candidate counts overlap accepted rows and are
  // deliberately not part of this split (data-methodology.md §3.7).
  if (session.rowCount !== session.acceptedCount + session.rejectedCount) {
    return reject('count-mismatch', ['session.rowCount']);
  }

  if (session.duplicateCandidateCount > session.rowCount) {
    return reject('count-mismatch', ['session.duplicateCandidateCount']);
  }

  /* ----------------------------------------------- statement range - */

  const { statementRangeStart: start, statementRangeEnd: end } = session;
  if (start !== undefined && end !== undefined && start > end) {
    return reject('invalid-statement-range', ['session.statementRangeStart']);
  }

  /* ------------------------------------------------- account refs - */

  const newAccountIds = new Set(newAccounts.map((account) => account.id));
  const declared = new Set(session.accountIds);

  for (let index = 0; index < transactions.length; index += 1) {
    if (!declared.has(transactions[index]!.accountId)) {
      return reject('session-reference-mismatch', [`transactions.${index}.accountId`]);
    }
  }

  for (const accountId of newAccountIds) {
    if (!declared.has(accountId)) {
      return reject('session-reference-mismatch', ['session.accountIds']);
    }
  }

  return null;
}

/* --------------------------------------------------------------- commit - */

/**
 * Tables that survive a demo-to-personal replacement.
 *
 * What is being removed is the *fictional dataset*, and the demo ships no
 * mapping presets — every preset in the workspace was authored by the user to
 * describe their own bank's export format. It holds no demo content and no
 * transaction content, so clearing it would destroy the user's own work in the
 * name of removing invented data. Everything else goes.
 */
const DEMO_REPLACEMENT_PRESERVES: ReadonlySet<string> = new Set<string>(['mappingPresets']);

export interface CommitImportOptions {
  /**
   * Required to overwrite a demo workspace with real data.
   *
   * Enforced here rather than in the wizard, so bypassing the interface cannot
   * bypass the confirmation. The flag is the caller's assertion that the user
   * was asked and said yes.
   */
  readonly confirmDemoReplacement?: boolean;
  readonly clock?: Clock;
}

/**
 * Writes a staged import atomically.
 *
 * The order is: prove everything provable without the database, then read what
 * only the database knows, then write once. The final write uses `add` and
 * `bulkAdd` rather than `put`, so an identifier that somehow survived the
 * collision checks still aborts the whole transaction on a constraint error
 * instead of silently overwriting a record — which is also what makes a
 * double-submitted commit safe: the second attempt fails on the session's own
 * primary key and writes nothing.
 */
export async function commitImport(
  db: WorkspaceDatabase,
  staged: StagedImport,
  options: CommitImportOptions = {},
): Promise<ImportCommitResult> {
  const structural = validateStagedImport(staged);
  if (structural) return structural;

  const { session, transactions, newAccounts } = staged;
  const clock = options.clock ?? systemClock;

  try {
    const modeBefore = await getWorkspaceMode(db);
    const replacingDemo = modeBefore === 'demo';

    if (replacingDemo && options.confirmDemoReplacement !== true) {
      return reject('demo-replacement-not-confirmed', ['workspaceMode']);
    }

    /* ------------------------------------------------- workspace checks - */

    // Skipped when replacing the demo: those rows are cleared inside the same
    // transaction, so colliding with one is not a collision with anything that
    // will still exist.
    if (!replacingDemo) {
      if (await db.importSessions.get(session.id)) {
        return reject('id-already-exists', ['session.id']);
      }

      for (const account of newAccounts) {
        if (await db.accounts.get(account.id)) {
          return reject('id-already-exists', ['newAccounts.id']);
        }
      }

      // One indexed query per referenced account, rather than one per row: a
      // 100,000-row import references a handful of accounts, and checking each
      // row individually would turn a bounded check into a linear one.
      const newAccountIds = new Set(newAccounts.map((account) => account.id));
      for (const accountId of session.accountIds) {
        if (newAccountIds.has(accountId)) continue;
        if (!(await db.accounts.get(accountId))) {
          return reject('unknown-account-reference', ['session.accountIds']);
        }
      }

      const existingIds = await db.transactions
        .where('id')
        .anyOf(transactions.map((row) => row.id))
        .primaryKeys();
      if (existingIds.length > 0) {
        return reject('id-already-exists', ['transactions.id']);
      }
    }

    /* -------------------------------------------------------- the write - */

    await db.transaction('rw', workspaceTables(db), async () => {
      // Re-read inside the transaction. If the mode changed between the check
      // above and this write, the confirmation the caller obtained was about a
      // different workspace, so the commit aborts rather than acting on a
      // decision the user did not make.
      if ((await getWorkspaceMode(db)) !== modeBefore) {
        throw new Error('The workspace changed while the import was being saved.');
      }

      // Demo replacement happens *inside* the same transaction as the import.
      // Clearing in one transaction and importing in another would leave an
      // empty workspace if the second half failed — the exact outcome
      // data-methodology.md §2.2 forbids.
      if (replacingDemo) {
        for (const name of TABLE_NAMES) {
          if (DEMO_REPLACEMENT_PRESERVES.has(name)) continue;
          await db.table(name).clear();
        }
      }

      if (newAccounts.length > 0) await db.accounts.bulkAdd([...newAccounts]);
      await db.importSessions.add(session);
      if (transactions.length > 0) await db.transactions.bulkAdd([...transactions]);

      await setWorkspaceMode(db, 'personal', clock);
    });

    return {
      ok: true,
      sessionId: session.id,
      committedTransactionCount: transactions.length,
      createdAccountIds: newAccounts.map((account) => account.id),
      replacedDemoWorkspace: replacingDemo,
      workspaceMode: 'personal',
    };
  } catch {
    // The cause is deliberately not surfaced. A Dexie error can name a key, and
    // a key here can be a transaction id (threat-model.md §8).
    return reject('workspace-write-failed');
  }
}
