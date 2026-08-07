import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceDatabase } from '../../../src/db/database';
import {
  exportWorkspace,
  parseBackup,
  restoreBackup,
  serializeBackup,
} from '../../../src/db/backup';
import {
  countMappingPresets,
  saveMappingPreset,
} from '../../../src/db/repositories/mappingPresets';
import { deleteAllData, readSnapshot, replaceWorkspace } from '../../../src/db/workspace';
import { SCHEMA_VERSION } from '../../../src/db/schema';
import { buildDemoWorkspace } from '../../../src/data/demo/dataset';
import { resetDemoWorkspace } from '../../../src/data/demo/seed';
import { MAX_PRESETS } from '../../../src/import/limits';
import { buildPreset } from '../../../src/import/mapping';
import { fixedClock } from '../../../src/lib/clock';
import { createTestDatabase, destroyTestDatabase } from '../helpers/testDatabase';
import { presetDraft } from './helpers/importFixtures';

const CREATED_AT = '2026-08-01T12:00:00.000Z';
const CLOCK = fixedClock(CREATED_AT);

let db: WorkspaceDatabase;

beforeEach(async () => {
  db = await createTestDatabase();
});

afterEach(async () => {
  await destroyTestDatabase(db);
});

type BackupJson = {
  schemaVersion: number;
  counts: Record<string, number | undefined>;
  data: Record<string, unknown[]>;
};

async function currentBackupText(): Promise<string> {
  return serializeBackup(await exportWorkspace(db, CLOCK));
}

/**
 * A backup exactly as a Phase 2 build would have written it.
 *
 * Phase 2 had no `mappingPresets` table, so neither the data nor the counts
 * carry the key at all — this is not the same document with an empty array,
 * and the difference is the whole point of the compatibility test.
 */
function asPhase2Backup(text: string): string {
  const doc = JSON.parse(text) as BackupJson;
  delete doc.data.mappingPresets;
  delete doc.counts.mappingPresets;
  doc.schemaVersion = 1;
  return JSON.stringify(doc);
}

describe('backups written by a Phase 2 build', () => {
  it('are still accepted, and restore into a version 2 workspace', async () => {
    await replaceWorkspace(db, buildDemoWorkspace());
    const phase2 = asPhase2Backup(await currentBackupText());

    const parsed = parseBackup(phase2);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.requiresMigration).toBe(true);

    await deleteAllData(db);
    const outcome = await restoreBackup(db, parsed.document);

    expect(outcome.restored).toBe(true);
    expect(outcome.migratedFrom).toBe(1);
    expect(await db.transactions.count()).toBe(buildDemoWorkspace().transactions.length);
    // The absent table becomes an empty one rather than an error.
    expect(await countMappingPresets(db)).toBe(0);
  });

  it('do not have a missing preset count read as a truncated document', async () => {
    await replaceWorkspace(db, buildDemoWorkspace());
    const parsed = parseBackup(asPhase2Backup(await currentBackupText()));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) expect(parsed.reason).not.toBe('count-mismatch');
  });

  it('still refuse a genuinely missing count for a table Phase 2 did have', async () => {
    // Optionality was granted to exactly one key. A Phase 2 table whose count
    // is missing is still a truncated document.
    await replaceWorkspace(db, buildDemoWorkspace());
    const doc = JSON.parse(asPhase2Backup(await currentBackupText())) as BackupJson;
    delete doc.counts.transactions;

    const parsed = parseBackup(JSON.stringify(doc));

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe('invalid-shape');
  });
});

describe('backups containing presets', () => {
  it('round-trip through export and restore unchanged', async () => {
    await replaceWorkspace(db, buildDemoWorkspace());
    await saveMappingPreset(db, presetDraft({ name: 'Everyday checking' }), {
      id: 'preset-1',
      clock: CLOCK,
    });
    await saveMappingPreset(db, presetDraft({ name: 'Rewards card' }), {
      id: 'preset-2',
      clock: CLOCK,
    });

    const before = await readSnapshot(db);
    const text = await currentBackupText();

    const parsed = parseBackup(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.document.schemaVersion).toBe(SCHEMA_VERSION);
    expect(parsed.document.counts.mappingPresets).toBe(2);
    expect(parsed.requiresMigration).toBe(false);

    await deleteAllData(db);
    await restoreBackup(db, parsed.document);

    const after = await readSnapshot(db);
    expect(after.mappingPresets).toEqual(before.mappingPresets);
    expect(after.mappingPresets).toHaveLength(2);
  });

  it('carry no transaction content in the preset records', async () => {
    await replaceWorkspace(db, buildDemoWorkspace());
    await saveMappingPreset(db, presetDraft(), { id: 'preset-1', clock: CLOCK });

    const doc = JSON.parse(await currentBackupText()) as BackupJson;
    const presets = JSON.stringify(doc.data.mappingPresets);

    // Every value a demo transaction carries must be absent from the presets.
    const demo = buildDemoWorkspace().transactions[0]!;
    expect(presets).not.toContain(demo.descriptionRaw);
    expect(presets).not.toContain(demo.merchantNormalized);
    expect(presets).not.toContain(demo.postedDate);
    expect(presets).not.toContain(String(demo.amountCents));
    expect(presets).not.toContain(demo.accountId);
    expect(presets).not.toContain(demo.fingerprint);
  });
});

describe('a backup carrying an unacceptable preset', () => {
  const corruptions: ReadonlyArray<{ name: string; corrupt: (doc: BackupJson) => void }> = [
    {
      name: 'an unknown property smuggled into a preset',
      corrupt: (doc) => {
        (doc.data.mappingPresets[0] as Record<string, unknown>).descriptionRaw = 'PINEBROOK MARKET';
      },
    },
    {
      name: 'a preset count that does not match the presets',
      corrupt: (doc) => {
        doc.counts.mappingPresets = 99;
      },
    },
    {
      name: 'two presets sharing a primary key',
      corrupt: (doc) => {
        doc.data.mappingPresets.push({ ...(doc.data.mappingPresets[0] as object) });
        doc.counts.mappingPresets = doc.data.mappingPresets.length;
      },
    },
    {
      name: 'more presets than a workspace may hold',
      corrupt: (doc) => {
        const first = doc.data.mappingPresets[0] as Record<string, unknown>;
        doc.data.mappingPresets = Array.from({ length: MAX_PRESETS + 1 }, (_, index) => ({
          ...first,
          id: `preset-${index}`,
        }));
        doc.counts.mappingPresets = doc.data.mappingPresets.length;
      },
    },
    {
      name: 'a preset mapping two required fields to one column',
      corrupt: (doc) => {
        (doc.data.mappingPresets[0] as Record<string, unknown>).descriptionColumn = 0;
      },
    },
    {
      name: 'a preset mapping past the columns it recorded',
      corrupt: (doc) => {
        (doc.data.mappingPresets[0] as Record<string, unknown>).dateColumn = 50;
      },
    },
    {
      name: 'a preset from a future preset version',
      corrupt: (doc) => {
        (doc.data.mappingPresets[0] as Record<string, unknown>).presetVersion = 2;
      },
    },
  ];

  it.each(corruptions)('refuses $name and leaves the workspace unchanged', async ({ corrupt }) => {
    await replaceWorkspace(db, buildDemoWorkspace());
    await saveMappingPreset(db, presetDraft(), { id: 'preset-1', clock: CLOCK });

    const before = await readSnapshot(db);
    const doc = JSON.parse(await currentBackupText()) as BackupJson;
    corrupt(doc);

    const parsed = parseBackup(JSON.stringify(doc));
    expect(parsed.ok).toBe(false);

    // Restore is never reached on a rejection, and the workspace is identical.
    if (parsed.ok) await restoreBackup(db, parsed.document);
    expect(await readSnapshot(db)).toEqual(before);
  });
});

describe('clearing and reseeding a workspace that holds presets', () => {
  it('delete-all removes presets along with everything else', async () => {
    await replaceWorkspace(db, buildDemoWorkspace());
    await saveMappingPreset(db, presetDraft(), { id: 'preset-1', clock: CLOCK });
    expect(await countMappingPresets(db)).toBe(1);

    await deleteAllData(db);

    // privacy-model.md §5.3: delete-all clears the workspace. A preset is user
    // configuration stored locally like any other row, so it goes too.
    expect(await countMappingPresets(db)).toBe(0);
    expect(await readSnapshot(db)).toEqual({
      accounts: [],
      importSessions: [],
      transactions: [],
      merchantRules: [],
      budgetPlans: [],
      budgetCategoryTargets: [],
      recurringSeries: [],
      userEdits: [],
      appSettings: [],
      mappingPresets: [],
    });
  });

  it('resetting the demo replaces presets with the demo’s own empty set', async () => {
    await replaceWorkspace(db, buildDemoWorkspace());
    await saveMappingPreset(db, presetDraft(), { id: 'preset-1', clock: CLOCK });

    await resetDemoWorkspace(db);

    // Reset is a full replacement with the deterministic dataset, which ships
    // no presets. This is the documented behaviour of `replaceWorkspace`, and
    // it differs from an import's demo replacement, which preserves them.
    expect(await countMappingPresets(db)).toBe(0);
  });
});

describe('the preset schema a backup is validated against', () => {
  it('accepts the preset shape the builder produces', () => {
    const preset = buildPreset(presetDraft(), 'preset-1', CREATED_AT);

    // Guards against the builder and the stored schema drifting apart: they are
    // the same schema, so a field added to one without the other fails here.
    expect(Object.keys(preset).sort()).toEqual(
      [
        'amount',
        'columnNames',
        'createdAt',
        'dateColumn',
        'dateFormat',
        'delimiter',
        'descriptionColumn',
        'encoding',
        'headerLineIndex',
        'id',
        'name',
        'presetVersion',
      ].sort(),
    );
  });
});
