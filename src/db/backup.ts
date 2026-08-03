import { systemClock, type Clock } from '../lib/clock';
import type { WorkspaceDatabase } from './database';
import { SCHEMA_VERSION, TABLE_NAMES } from './schema';
import { readSnapshot, replaceWorkspace, type WorkspaceSnapshot } from './workspace';
import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  backupDocumentSchema,
  EDITABLE_FIELDS,
  MAX_BACKUP_BYTES,
  type BackupDocument,
} from './backupSchema';

/* ------------------------------------------------------------------ build - */

export function buildBackupDocument(
  snapshot: WorkspaceSnapshot,
  clock: Clock = systemClock,
): BackupDocument {
  const counts = Object.fromEntries(
    Object.entries(snapshot).map(([table, rows]) => [table, rows.length]),
  );

  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: clock(),
    counts,
    data: snapshot,
  } as BackupDocument;
}

export async function exportWorkspace(
  db: WorkspaceDatabase,
  clock: Clock = systemClock,
): Promise<BackupDocument> {
  return buildBackupDocument(await readSnapshot(db), clock);
}

export function serializeBackup(document: BackupDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/* --------------------------------------------------------------- filename - */

/** Windows reserved device names; a file called `CON.json` is a hazard. */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Neutralizes a download filename (threat-model.md §10).
 *
 * Strips path separators, control characters, and reserved device names so a
 * suggested filename can never traverse directories or collide dangerously.
 */
export function sanitizeFilename(candidate: string, fallback = 'workspace-backup'): string {
  const withoutPaths = candidate.replace(/[/\\]/g, '-');
  // Matching control characters is the entire point here: a filename carrying
  // them is exactly what must be neutralized. Written as escapes so the intent
  // survives editing.
  // oxlint-disable-next-line no-control-regex
  const withoutControl = withoutPaths.replace(/[\u0000-\u001F\u007F]/g, '');
  const cleaned = withoutControl
    .replace(/[<>:"|?*]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.-]+/, '')
    .replace(/[.\s]+$/, '')
    .slice(0, 120);

  const base = cleaned.replace(/\.json$/i, '');
  if (base.length === 0 || RESERVED_NAMES.test(base)) return `${fallback}.json`;
  return `${base}.json`;
}

/** `tri-state-spending-lens-backup-2026-08-01.json` */
export function backupFilename(exportedAt: string): string {
  const day = exportedAt.slice(0, 10);
  const datePart = /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : 'export';
  return sanitizeFilename(`tri-state-spending-lens-backup-${datePart}`);
}

/* ----------------------------------------------------------------- parse - */

export type BackupRejectionReason =
  | 'file-too-large'
  | 'not-json'
  | 'unrecognized-format'
  | 'future-format-version'
  | 'future-schema-version'
  | 'invalid-shape'
  | 'count-mismatch'
  | 'inconsistent-references';

export interface BackupRejection {
  ok: false;
  reason: BackupRejectionReason;
  /** Safe to display: never contains a field value (threat-model.md §8). */
  message: string;
  /** Field paths that failed validation. Paths only — never received values. */
  problemPaths: string[];
}

export interface BackupAcceptance {
  ok: true;
  document: BackupDocument;
  /** True when the backup came from an older, still-supported schema version. */
  requiresMigration: boolean;
}

export type BackupParseResult = BackupAcceptance | BackupRejection;

const MAX_BACKUP_MB = Math.round(MAX_BACKUP_BYTES / (1024 * 1024));

const REJECTION_MESSAGES: Record<BackupRejectionReason, string> = {
  'file-too-large': `That file is larger than the ${MAX_BACKUP_MB} MB limit for a workspace backup, so it was not opened. Nothing was changed.`,
  'not-json':
    'That file is not valid JSON, so it cannot be a workspace backup. Nothing was changed.',
  'unrecognized-format':
    'That file is not a Tri-State Spending Lens workspace backup. Nothing was changed.',
  'future-format-version':
    'This backup uses a newer backup format than this version understands. Rather than guess at it, nothing was changed. Open the newer version of the app to restore it.',
  'future-schema-version':
    'This backup came from a newer version of Tri-State Spending Lens. Rather than guess how to convert it, nothing was changed. Open the newer version to restore it.',
  'invalid-shape':
    'This backup is missing required information or contains values of the wrong type, so it was not trusted. Nothing was changed.',
  'count-mismatch':
    'This backup’s contents do not match the record counts it declares, which suggests it was truncated or edited. Nothing was changed.',
  'inconsistent-references':
    'This backup contains records that refer to other records it does not include, or values that contradict each other, so it was not trusted. Nothing was changed.',
};

interface ValidationIssue {
  readonly path: readonly PropertyKey[];
  readonly code: string;
}

/**
 * Builds a display-safe description of what failed.
 *
 * Deliberately uses only the issue path and code. Zod's own messages can embed
 * the rejected value (an invalid enum message quotes what it received), and
 * threat-model.md §15 item 4 requires error text to carry field names, never
 * field values.
 */
function safeProblemPaths(issues: readonly ValidationIssue[]): string[] {
  const paths = new Set<string>();
  for (const issue of issues.slice(0, 25)) {
    const path =
      issue.path.length > 0 ? issue.path.map((part) => String(part)).join('.') : '(document root)';
    paths.add(`${path} — ${issue.code}`);
  }
  return [...paths];
}

function reject(reason: BackupRejectionReason, problemPaths: string[] = []): BackupRejection {
  return { ok: false, reason, message: REJECTION_MESSAGES[reason], problemPaths };
}

/**
 * Cross-record checks the per-row schema cannot express.
 *
 * A document can be perfectly well-typed and still be incoherent: a transaction
 * pointing at an account that is not in the file, two rows sharing a primary
 * key, a recurring series whose minimum exceeds its maximum. Catching these
 * here means the restore transaction never starts, rather than failing partway
 * through on a constraint error.
 */
export function findConsistencyProblems(document: BackupDocument): string[] {
  const problems: string[] = [];
  const data = document.data;

  const requireUnique = (table: string, values: readonly string[]) => {
    const seen = new Set<string>();
    for (const value of values) {
      if (seen.has(value)) {
        problems.push(`data.${table} — duplicate primary key`);
        return;
      }
      seen.add(value);
    }
  };

  requireUnique(
    'accounts',
    data.accounts.map((row) => row.id),
  );
  requireUnique(
    'importSessions',
    data.importSessions.map((row) => row.id),
  );
  requireUnique(
    'transactions',
    data.transactions.map((row) => row.id),
  );
  requireUnique(
    'merchantRules',
    data.merchantRules.map((row) => row.id),
  );
  requireUnique(
    'budgetPlans',
    data.budgetPlans.map((row) => row.id),
  );
  requireUnique(
    'budgetCategoryTargets',
    data.budgetCategoryTargets.map((row) => row.id),
  );
  requireUnique(
    'recurringSeries',
    data.recurringSeries.map((row) => row.id),
  );
  requireUnique(
    'userEdits',
    data.userEdits.map((row) => row.id),
  );
  requireUnique(
    'appSettings',
    data.appSettings.map((row) => row.key),
  );

  // `budgetPlans.month` carries a unique index, so a duplicate month would
  // abort the restore transaction rather than being caught by row validation.
  requireUnique(
    'budgetPlans.month',
    data.budgetPlans.map((row) => row.month),
  );

  const accountIds = new Set(data.accounts.map((row) => row.id));
  const sessionIds = new Set(data.importSessions.map((row) => row.id));
  const transactionIds = new Set(data.transactions.map((row) => row.id));
  const planIds = new Set(data.budgetPlans.map((row) => row.id));
  const recurringSeriesIds = new Set(data.recurringSeries.map((row) => row.id));

  data.transactions.forEach((row, index) => {
    if (!accountIds.has(row.accountId)) {
      problems.push(`data.transactions.${index}.accountId — unknown account`);
    }
    if (!sessionIds.has(row.importSessionId)) {
      problems.push(`data.transactions.${index}.importSessionId — unknown import session`);
    }
  });

  data.budgetCategoryTargets.forEach((row, index) => {
    if (!planIds.has(row.budgetPlanId)) {
      problems.push(`data.budgetCategoryTargets.${index}.budgetPlanId — unknown budget plan`);
    }
  });

  data.recurringSeries.forEach((row, index) => {
    for (const referenced of row.transactionIds) {
      if (!transactionIds.has(referenced)) {
        problems.push(`data.recurringSeries.${index}.transactionIds — unknown transaction`);
        break;
      }
    }

    // A series whose typical amount sits outside its own observed range would
    // make every derived figure in Phase 6 incoherent.
    if (row.amountMinCents > row.amountMaxCents) {
      problems.push(`data.recurringSeries.${index}.amountMinCents — exceeds amountMaxCents`);
    }
    if (row.typicalAmountCents < row.amountMinCents) {
      problems.push(`data.recurringSeries.${index}.typicalAmountCents — below amountMinCents`);
    }
    if (row.typicalAmountCents > row.amountMaxCents) {
      problems.push(`data.recurringSeries.${index}.typicalAmountCents — above amountMaxCents`);
    }
  });

  data.userEdits.forEach((row, index) => {
    const allowed: readonly string[] = EDITABLE_FIELDS[row.entityType];
    if (!allowed.includes(row.field)) {
      problems.push(`data.userEdits.${index}.field — not an editable field for this entity type`);
    }

    // An edit is a decision *about* a record. One pointing at a record the
    // backup does not contain is unreplayable, and would silently resurrect as
    // a dangling row in the restored workspace.
    const known = row.entityType === 'transaction' ? transactionIds : recurringSeriesIds;
    if (!known.has(row.entityId)) {
      problems.push(`data.userEdits.${index}.entityId — unknown ${row.entityType}`);
    }
  });

  data.importSessions.forEach((row, index) => {
    const { statementRangeStart: start, statementRangeEnd: end } = row;
    if (start !== undefined && end !== undefined && start > end) {
      problems.push(`data.importSessions.${index}.statementRangeStart — after statementRangeEnd`);
    }

    // The session records which accounts it wrote to; every one of them has to
    // be in the file, or rollback and per-account filtering would target
    // accounts that do not exist.
    for (const referenced of row.accountIds) {
      if (!accountIds.has(referenced)) {
        problems.push(`data.importSessions.${index}.accountIds — unknown account`);
        break;
      }
    }
  });

  return problems.slice(0, 25);
}

/**
 * Refuses an oversized file before its bytes are read.
 *
 * Checking `File.size` costs nothing; calling `file.text()` on a multi-gigabyte
 * file would pull it all into memory first (threat-model.md §6 — limits are
 * checked before doing the expensive work).
 */
export function checkBackupFileSize(sizeInBytes: number): BackupRejection | null {
  return sizeInBytes > MAX_BACKUP_BYTES ? reject('file-too-large') : null;
}

/**
 * Validates backup text without touching the workspace.
 *
 * Order matters: version checks run before full shape validation so a backup
 * from a newer build is refused with an accurate explanation rather than a
 * misleading list of "invalid" fields it simply does not know about yet.
 */
export function parseBackup(text: string): BackupParseResult {
  const oversized = checkBackupFileSize(text.length);
  if (oversized) return oversized;

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return reject('not-json');
  }

  if (typeof raw !== 'object' || raw === null) return reject('unrecognized-format');

  const envelope = raw as Record<string, unknown>;
  if (envelope.format !== BACKUP_FORMAT) return reject('unrecognized-format');

  const formatVersion = envelope.formatVersion;
  if (typeof formatVersion !== 'number' || !Number.isInteger(formatVersion)) {
    return reject('invalid-shape', ['formatVersion — invalid_type']);
  }
  if (formatVersion > BACKUP_FORMAT_VERSION) return reject('future-format-version');

  const schemaVersion = envelope.schemaVersion;
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion)) {
    return reject('invalid-shape', ['schemaVersion — invalid_type']);
  }
  // A future schema version is refused outright, never guessed at
  // (threat-model.md §10).
  if (schemaVersion > SCHEMA_VERSION) return reject('future-schema-version');

  const parsed = backupDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    return reject('invalid-shape', safeProblemPaths(parsed.error.issues));
  }

  const document = parsed.data;

  // Every table must declare a count, and it must be the truth. The schema
  // guarantees the keys exist; this checks they agree with the data.
  const mismatched: string[] = [];
  for (const table of TABLE_NAMES) {
    if (document.counts[table] !== document.data[table].length) {
      mismatched.push(`counts.${table}`);
    }
  }
  if (mismatched.length > 0) return reject('count-mismatch', mismatched);

  const inconsistencies = findConsistencyProblems(document);
  if (inconsistencies.length > 0) return reject('inconsistent-references', inconsistencies);

  return {
    ok: true,
    document,
    requiresMigration: document.schemaVersion < SCHEMA_VERSION,
  };
}

/* --------------------------------------------------------------- restore - */

export interface RestoreOutcome {
  restored: boolean;
  migratedFrom?: number;
  counts: Record<string, number>;
}

/**
 * Replaces the workspace with a validated backup.
 *
 * Only ever called with a document that `parseBackup` accepted, and it stores
 * the *parsed* snapshot, so unknown keys stripped during validation can never
 * reach IndexedDB. The write itself is atomic (see `replaceWorkspace`).
 */
export async function restoreBackup(
  db: WorkspaceDatabase,
  document: BackupDocument,
): Promise<RestoreOutcome> {
  await replaceWorkspace(db, document.data as WorkspaceSnapshot);

  return {
    restored: true,
    migratedFrom: document.schemaVersion < SCHEMA_VERSION ? document.schemaVersion : undefined,
    counts: Object.fromEntries(
      Object.entries(document.data).map(([table, rows]) => [table, rows.length]),
    ),
  };
}
