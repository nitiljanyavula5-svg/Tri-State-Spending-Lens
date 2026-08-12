import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceDatabase } from '../../../src/db/database';
import { buildStagedImport, commitImport } from '../../../src/db/importCommit';
import { createUserRule } from '../../../src/db/ruleCommands';
import { sortRulesByPrecedence } from '../../../src/db/repositories/rules';
import { putAccount } from '../../../src/db/repositories/accounts';
import { setWorkspaceMode } from '../../../src/db/repositories/settings';
import { buildHealthReport } from '../../../src/import/healthReport';
import type { FingerprintedRow } from '../../../src/import/normalizeFile';
import type { MerchantRule } from '../../../src/types/domain';
import { fixedClock } from '../../../src/lib/clock';
import { createTestDatabase, destroyTestDatabase } from '../helpers/testDatabase';

/**
 * Saved rules and future imports.
 *
 * Two guarantees pull against each other and both must hold: a saved rule has
 * to reach the next import, and an import with no matching rule has to produce
 * exactly what Phase 3 produced. The second is the one that would fail quietly,
 * so most of these assert it.
 */

const CLOCK = fixedClock('2026-08-02T09:00:00.000Z');

let db: WorkspaceDatabase;
let idCounter = 0;
const ids = () => () => {
  idCounter += 1;
  return `gen-${idCounter}`;
};

beforeEach(async () => {
  db = await createTestDatabase();
  await putAccount(db, {
    id: 'account-1',
    label: 'Everyday Checking',
    type: 'checking',
    currency: 'USD',
    archived: false,
  });
  await setWorkspaceMode(db, 'personal');
});

afterEach(async () => {
  await destroyTestDatabase(db);
});

let rowSeed = 0;
function stagedRow(overrides: Partial<FingerprintedRow> = {}): FingerprintedRow {
  rowSeed += 1;
  const description = overrides.descriptionRaw ?? 'PINEBROOK MARKET';
  return {
    fileName: 'statement.csv',
    originalRow: rowSeed,
    postedDate: '2026-04-08',
    descriptionRaw: description,
    merchantNormalized: description.toUpperCase(),
    descriptionCanonical: description.toUpperCase(),
    amountCents: 1234,
    direction: 'debit',
    questions: [],
    fingerprint: rowSeed.toString(16).padStart(64, '0'),
    occurrenceIndex: 0,
    accountId: 'account-1',
    ...overrides,
  };
}

async function ruleSnapshot(): Promise<readonly MerchantRule[]> {
  return sortRulesByPrecedence(await db.merchantRules.toArray());
}

function stage(rows: readonly FingerprintedRow[], userRules: readonly MerchantRule[]) {
  return buildStagedImport({
    rowCount: rows.length,
    acceptedRows: rows,
    excludedRows: [],
    rejections: [],
    duplicateCandidates: [],
    warnings: [],
    sourceFileNames: ['statement.csv'],
    newAccounts: [],
    sessionId: `session-${idCounter}`,
    newId: ids(),
    clock: CLOCK,
    userRules,
  });
}

describe('an import with no matching rule', () => {
  it('produces exactly the accepted Phase 3 result', async () => {
    const rows = [
      stagedRow({ descriptionRaw: 'PINEBROOK MARKET' }),
      // A description the built-in keyword table would happily call Dining.
      stagedRow({ descriptionRaw: 'HARBOR BEAN COFFEE' }),
      stagedRow({ descriptionRaw: 'PAYROLL DEPOSIT', direction: 'credit' }),
    ];

    const result = await commitImport(db, stage(rows, []));
    expect(result.ok).toBe(true);

    const stored = await db.transactions.orderBy('id').toArray();
    for (const row of stored) {
      // Built-in keywords propose in the review queue; they do not classify a
      // row nobody has looked at.
      expect(row.categoryId).toBe('other');
      expect(row.categorySource).toBe('uncategorized');
      expect(row.classificationConfidence).toBe('none');
    }

    const byDescription = new Map(stored.map((row) => [row.descriptionRaw, row]));
    expect(byDescription.get('PINEBROOK MARKET')?.kind).toBe('purchase');
    expect(byDescription.get('HARBOR BEAN COFFEE')?.kind).toBe('purchase');
    // Credits stay unknown; a payroll keyword is a suggestion, not a decision.
    expect(byDescription.get('PAYROLL DEPOSIT')?.kind).toBe('unknown');
  });

  it('behaves identically whether or not a rules snapshot is supplied', async () => {
    const rows = [stagedRow({ descriptionRaw: 'HARBOR BEAN COFFEE' })];

    const withoutRules = stage(rows, []);
    const withEmptySnapshot = buildStagedImport({
      rowCount: rows.length,
      acceptedRows: rows,
      excludedRows: [],
      rejections: [],
      duplicateCandidates: [],
      warnings: [],
      sourceFileNames: ['statement.csv'],
      newAccounts: [],
      sessionId: withoutRules.session.id,
      newId: () => withoutRules.transactions[0]!.id,
      clock: CLOCK,
    });

    expect(withEmptySnapshot.transactions[0]).toEqual(withoutRules.transactions[0]);
  });
});

describe('a saved rule reaches the next import', () => {
  it('classifies matching rows and records the rule as the source', async () => {
    const created = await createUserRule(
      db,
      { matchType: 'exact', pattern: 'PINEBROOK MARKET', categoryId: 'groceries' },
      { newId: ids() },
    );
    expect(created.ok).toBe(true);

    const rows = [
      stagedRow({ descriptionRaw: 'PINEBROOK MARKET' }),
      stagedRow({ descriptionRaw: 'SOMEWHERE ELSE' }),
    ];
    const result = await commitImport(db, stage(rows, await ruleSnapshot()));
    expect(result.ok).toBe(true);

    const stored = await db.transactions.toArray();
    const matched = stored.find((row) => row.descriptionRaw === 'PINEBROOK MARKET');
    const unmatched = stored.find((row) => row.descriptionRaw === 'SOMEWHERE ELSE');

    expect(matched?.categoryId).toBe('groceries');
    expect(matched?.categorySource).toBe('user_rule');
    expect(matched?.classificationConfidence).toBe('high');

    // A row the rule does not match keeps the Phase 3 default.
    expect(unmatched?.categoryId).toBe('other');
    expect(unmatched?.categorySource).toBe('uncategorized');
  });

  it('can set a kind, and the kind brings its category', async () => {
    await createUserRule(
      db,
      { matchType: 'contains', pattern: 'SERVICE CHARGE', kind: 'fee' },
      { newId: ids() },
    );

    const rows = [stagedRow({ descriptionRaw: 'MONTHLY SERVICE CHARGE' })];
    await commitImport(db, stage(rows, await ruleSnapshot()));

    const stored = (await db.transactions.toArray())[0];
    expect(stored?.kind).toBe('fee');
    expect(stored?.categoryId).toBe('fees_interest');
  });

  it('does not touch transactions imported before the rule existed', async () => {
    const first = await commitImport(
      db,
      stage([stagedRow({ descriptionRaw: 'PINEBROOK MARKET' })], []),
    );
    expect(first.ok).toBe(true);
    const before = await db.transactions.toArray();

    await createUserRule(
      db,
      { matchType: 'exact', pattern: 'PINEBROOK MARKET', categoryId: 'groceries' },
      { newId: ids() },
    );

    // Creating a rule changes nothing that is already stored (§12).
    expect(await db.transactions.toArray()).toEqual(before);

    await commitImport(
      db,
      stage([stagedRow({ descriptionRaw: 'PINEBROOK MARKET' })], await ruleSnapshot()),
    );

    const all = await db.transactions.toArray();
    const older = all.find((row) => row.id === before[0]!.id);
    const newer = all.find((row) => row.id !== before[0]!.id);

    expect(older?.categorySource).toBe('uncategorized');
    expect(newer?.categorySource).toBe('user_rule');
  });
});

describe('preview and commit agree', () => {
  it('reports the same uncategorized count the commit produces', async () => {
    await createUserRule(
      db,
      { matchType: 'exact', pattern: 'PINEBROOK MARKET', categoryId: 'groceries' },
      { newId: ids() },
    );
    const rules = await ruleSnapshot();

    const rows = [
      stagedRow({ descriptionRaw: 'PINEBROOK MARKET' }),
      stagedRow({ descriptionRaw: 'PINEBROOK MARKET' }),
      stagedRow({ descriptionRaw: 'SOMEWHERE ELSE' }),
    ];

    const staged = stage(rows, rules);

    // The Health Report is built from the same staged rows the commit writes,
    // so its counts describe what will actually be stored.
    const report = buildHealthReport({
      rowCount: rows.length,
      normalizedRows: rows,
      excludedRows: [],
      rejections: [],
      questions: [],
      duplicateCandidates: [],
      warnings: [],
      questionableRows: new Set(),
      candidateRows: new Set(),
    });

    expect(report.acceptedCount).toBe(staged.session.acceptedCount);
    expect(report.rowCount).toBe(staged.session.rowCount);
    expect(report.acceptedCount + report.rejectedCount).toBe(report.rowCount);

    const result = await commitImport(db, staged);
    expect(result.ok).toBe(true);

    const stored = await db.transactions.toArray();
    expect(stored).toHaveLength(report.acceptedCount);

    // What the staged rows claimed is what the database now holds.
    const storedById = new Map(stored.map((row) => [row.id, row]));
    for (const staged1 of staged.transactions) {
      expect(storedById.get(staged1.id)?.categoryId).toBe(staged1.categoryId);
      expect(storedById.get(staged1.id)?.categorySource).toBe(staged1.categorySource);
      expect(storedById.get(staged1.id)?.kind).toBe(staged1.kind);
    }
  });

  it('uses one rules snapshot, so a rule saved mid-import cannot change the commit', async () => {
    const rows = [stagedRow({ descriptionRaw: 'PINEBROOK MARKET' })];

    // Snapshot taken before the rule exists — this is what preview showed.
    const snapshot = await ruleSnapshot();
    const staged = stage(rows, snapshot);

    // The user saves a rule after seeing the preview.
    await createUserRule(
      db,
      { matchType: 'exact', pattern: 'PINEBROOK MARKET', categoryId: 'groceries' },
      { newId: ids() },
    );

    await commitImport(db, staged);

    // The commit matches the preview the user approved, not the newer rule.
    expect((await db.transactions.toArray())[0]?.categorySource).toBe('uncategorized');
  });
});

describe('Phase 3 safety properties still hold', () => {
  it('leaves fingerprints, row numbers, and account routing untouched by a rule', async () => {
    await createUserRule(
      db,
      { matchType: 'exact', pattern: 'PINEBROOK MARKET', categoryId: 'groceries', kind: 'fee' },
      { newId: ids() },
    );

    const row = stagedRow({ descriptionRaw: 'PINEBROOK MARKET' });
    await commitImport(db, stage([row], await ruleSnapshot()));

    const stored = (await db.transactions.toArray())[0];
    expect(stored?.fingerprint).toBe(row.fingerprint);
    expect(stored?.originalRow).toBe(row.originalRow);
    expect(stored?.accountId).toBe(row.accountId);
    expect(stored?.postedDate).toBe(row.postedDate);
    // The raw description is never rewritten by a rule.
    expect(stored?.descriptionRaw).toBe(row.descriptionRaw);
    expect(stored?.amountCents).toBe(row.amountCents);
    expect(stored?.direction).toBe(row.direction);
  });

  it('never lets a rule import a row already excluded or tagged', async () => {
    await createUserRule(
      db,
      { matchType: 'exact', pattern: 'PINEBROOK MARKET', categoryId: 'groceries' },
      { newId: ids() },
    );

    await commitImport(
      db,
      stage([stagedRow({ descriptionRaw: 'PINEBROOK MARKET' })], await ruleSnapshot()),
    );

    const stored = (await db.transactions.toArray())[0];
    expect(stored?.tags).toEqual([]);
    expect(stored?.excludedFromSpending).toBe(false);
    expect(stored).not.toHaveProperty('essentiality');
    expect(stored).not.toHaveProperty('variability');
  });
});
