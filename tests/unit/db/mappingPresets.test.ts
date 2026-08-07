import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceDatabase } from '../../../src/db/database';
import {
  countMappingPresets,
  deleteMappingPreset,
  getMappingPreset,
  listMappingPresets,
  putMappingPreset,
  saveMappingPreset,
  validateMappingPreset,
} from '../../../src/db/repositories/mappingPresets';
import { MAX_PRESETS, MAX_PRESET_NAME_LENGTH, MAX_COLUMNS } from '../../../src/import/limits';
import { buildPreset, MAPPING_PRESET_VERSION } from '../../../src/import/mapping';
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

/** Deterministic id source, so a stored preset can be compared to a literal. */
function sequentialIds(prefix = 'preset') {
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}-${n}`;
  };
}

describe('saving a mapping preset', () => {
  it('stores exactly the structural choices, and nothing from any file', async () => {
    const result = await saveMappingPreset(db, presetDraft(), {
      newId: sequentialIds(),
      clock: CLOCK,
    });

    expect(result.ok).toBe(true);

    const stored = await getMappingPreset(db, 'preset-1');

    // Compared against a full literal on purpose. A field added later that
    // could carry transaction content fails here rather than passing a
    // shape check that only looks at the fields it already knows about.
    expect(stored).toEqual({
      id: 'preset-1',
      name: 'Everyday checking export',
      presetVersion: MAPPING_PRESET_VERSION,
      createdAt: CREATED_AT,
      encoding: 'utf-8',
      delimiter: ',',
      headerLineIndex: 0,
      dateColumn: 0,
      descriptionColumn: 1,
      amount: { kind: 'signed', amountColumn: 2, negativeMeans: 'debit' },
      dateFormat: 'iso',
      columnNames: ['Date', 'Description', 'Amount'],
    });
  });

  it('does not store the account the mapping was confirmed against', async () => {
    // `signedMapping` targets `account-under-test`. A preset describes how to
    // *read* a file, not where its rows belong, so carrying the account across
    // would silently retarget a future import.
    await saveMappingPreset(db, presetDraft(), { newId: sequentialIds(), clock: CLOCK });

    expect(JSON.stringify(await getMappingPreset(db, 'preset-1'))).not.toContain(
      'account-under-test',
    );
  });

  it('uses the cryptographic id generator when none is injected', async () => {
    const result = await saveMappingPreset(db, presetDraft(), { clock: CLOCK });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // RFC 4122 v4, which is what `newId` produces.
    expect(result.preset.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('replaces a preset saved under the same id without growing the list', async () => {
    const newId = sequentialIds();
    await saveMappingPreset(db, presetDraft(), { newId, clock: CLOCK });

    const second = await saveMappingPreset(db, presetDraft({ name: 'Renamed' }), {
      id: 'preset-1',
      clock: CLOCK,
    });

    expect(second.ok).toBe(true);
    if (second.ok) expect(second.replaced).toBe(true);
    expect(await countMappingPresets(db)).toBe(1);
    expect((await getMappingPreset(db, 'preset-1'))?.name).toBe('Renamed');
  });

  it('truncates an over-long name rather than refusing the save', async () => {
    const result = await saveMappingPreset(db, presetDraft({ name: 'x'.repeat(5_000) }), {
      newId: sequentialIds(),
      clock: CLOCK,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preset.name).toHaveLength(MAX_PRESET_NAME_LENGTH);
  });

  it('refuses to exceed the preset ceiling, and writes nothing when it refuses', async () => {
    const newId = sequentialIds();
    for (let index = 0; index < MAX_PRESETS; index += 1) {
      const saved = await saveMappingPreset(db, presetDraft({ name: `Preset ${index}` }), {
        newId,
        clock: CLOCK,
      });
      expect(saved.ok).toBe(true);
    }

    const overflow = await saveMappingPreset(db, presetDraft({ name: 'One too many' }), {
      newId,
      clock: CLOCK,
    });

    expect(overflow.ok).toBe(false);
    if (!overflow.ok) expect(overflow.reason).toBe('too-many-presets');
    expect(await countMappingPresets(db)).toBe(MAX_PRESETS);
  });
});

describe('rejecting malformed presets', () => {
  const base = () => buildPreset(presetDraft(), 'preset-1', CREATED_AT);

  const malformed: ReadonlyArray<{
    name: string;
    corrupt: (preset: Record<string, unknown>) => void;
  }> = [
    { name: 'an unknown property', corrupt: (p) => (p.descriptionRaw = 'PINEBROOK MARKET') },
    { name: 'a missing required field', corrupt: (p) => delete p.dateColumn },
    { name: 'an empty name', corrupt: (p) => (p.name = '') },
    {
      name: 'an over-long name',
      corrupt: (p) => (p.name = 'x'.repeat(MAX_PRESET_NAME_LENGTH + 1)),
    },
    { name: 'a negative column index', corrupt: (p) => (p.dateColumn = -1) },
    { name: 'a column index past the limit', corrupt: (p) => (p.dateColumn = MAX_COLUMNS) },
    { name: 'a non-integer column index', corrupt: (p) => (p.dateColumn = 1.5) },
    { name: 'an unsupported delimiter', corrupt: (p) => (p.delimiter = 'X') },
    { name: 'an unsupported encoding', corrupt: (p) => (p.encoding = 'shift-jis') },
    { name: 'a future preset version', corrupt: (p) => (p.presetVersion = 99) },
    { name: 'a timestamp that is not a timestamp', corrupt: (p) => (p.createdAt = 'yesterday') },
    { name: 'an impossible timestamp', corrupt: (p) => (p.createdAt = '2026-02-30T00:00:00.000Z') },
    {
      name: 'more column names than columns',
      corrupt: (p) => (p.columnNames = Array.from({ length: MAX_COLUMNS + 1 }, () => 'C')),
    },
    { name: 'a column name array that is not an array', corrupt: (p) => (p.columnNames = 'Date') },
    {
      name: 'an amount model with no discriminant',
      corrupt: (p) => (p.amount = { amountColumn: 2 }),
    },
  ];

  it.each(malformed)('refuses $name and stores nothing', async ({ corrupt }) => {
    const candidate = base() as unknown as Record<string, unknown>;
    corrupt(candidate);

    const validated = validateMappingPreset(candidate);
    expect(validated.ok).toBe(false);

    const stored = await putMappingPreset(db, candidate);
    expect(stored.ok).toBe(false);
    if (!stored.ok) {
      expect(stored.reason).toBe('invalid-shape');
      // Paths and codes only — a rejection may never echo what it received.
      expect(stored.problemPaths.length).toBeGreaterThan(0);
      expect(stored.message).not.toContain('PINEBROOK');
      for (const path of stored.problemPaths) {
        expect(path).not.toContain('PINEBROOK');
      }
    }

    expect(await countMappingPresets(db)).toBe(0);
  });

  it('accepts the untouched preset the malformed cases are derived from', async () => {
    // Without this, a `base()` that no longer validates would make every case
    // above pass for the wrong reason.
    const stored = await putMappingPreset(db, base());
    expect(stored.ok).toBe(true);
    expect(await countMappingPresets(db)).toBe(1);
  });
});

describe('listing and deleting presets', () => {
  it('lists presets by name', async () => {
    const newId = sequentialIds();
    await saveMappingPreset(db, presetDraft({ name: 'Zebra' }), { newId, clock: CLOCK });
    await saveMappingPreset(db, presetDraft({ name: 'Apple' }), { newId, clock: CLOCK });

    expect((await listMappingPresets(db)).map((preset) => preset.name)).toEqual(['Apple', 'Zebra']);
  });

  it('reports truthfully whether a delete removed anything, and repeats safely', async () => {
    await saveMappingPreset(db, presetDraft(), { newId: sequentialIds(), clock: CLOCK });

    expect(await deleteMappingPreset(db, 'preset-1')).toBe(true);
    expect(await deleteMappingPreset(db, 'preset-1')).toBe(false);
    expect(await deleteMappingPreset(db, 'never-existed')).toBe(false);
    expect(await countMappingPresets(db)).toBe(0);
  });
});
