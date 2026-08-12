import type { WorkspaceDatabase } from '../database';
import type { MappingPreset } from '../../types/domain';
import { MAX_PRESETS } from '../../import/limits';
import { buildPreset, mappingPresetSchema, type PresetDraft } from '../../import/mapping';
import { systemClock, type Clock } from '../../lib/clock';
import { newId } from '../../lib/ids';

/**
 * Persisted column-mapping presets.
 *
 * data-methodology.md §2.4: a preset records *how to read a file* — column
 * positions, delimiter, encoding, date and sign conventions — and never what
 * the file contained. There is no field here capable of holding a description,
 * an amount, a date, an account label, or a filename from imported data, so the
 * guarantee is structural rather than a promise this module has to keep.
 *
 * Everything is validated through `mappingPresetSchema` on the way in, so a
 * caller that constructs a preset by hand cannot store a shape the restore path
 * would later refuse.
 */

export type MappingPresetRejectionReason =
  | 'invalid-shape'
  /** The workspace already holds `MAX_PRESETS`. */
  | 'too-many-presets';

export interface MappingPresetRejection {
  readonly ok: false;
  readonly reason: MappingPresetRejectionReason;
  /** Safe to display: never contains a stored value (threat-model.md §8). */
  readonly message: string;
  /** Field paths that failed validation. Paths only — never received values. */
  readonly problemPaths: readonly string[];
}

export interface MappingPresetAcceptance {
  readonly ok: true;
  readonly preset: MappingPreset;
  /** True when this replaced a preset that already had the same id. */
  readonly replaced: boolean;
}

export type SaveMappingPresetResult = MappingPresetAcceptance | MappingPresetRejection;

const REJECTION_MESSAGES: Record<MappingPresetRejectionReason, string> = {
  'invalid-shape':
    'That column mapping could not be saved because some of its settings are missing or of the wrong type. Nothing was changed.',
  'too-many-presets': `This workspace already holds the maximum of ${MAX_PRESETS} saved column mappings. Delete one you no longer use, then save again.`,
};

function reject(
  reason: MappingPresetRejectionReason,
  problemPaths: readonly string[] = [],
): MappingPresetRejection {
  return { ok: false, reason, message: REJECTION_MESSAGES[reason], problemPaths };
}

/**
 * Validates a candidate preset without touching the database.
 *
 * Issue paths carry field names only. Zod's own messages can quote the value it
 * rejected, which threat-model.md §15 item 4 forbids in anything displayable.
 */
export function validateMappingPreset(candidate: unknown): SaveMappingPresetResult {
  const parsed = mappingPresetSchema.safeParse(candidate);
  if (parsed.success) return { ok: true, preset: parsed.data, replaced: false };

  const paths = new Set<string>();
  for (const issue of parsed.error.issues.slice(0, 25)) {
    const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '(preset)';
    paths.add(`${path} — ${issue.code}`);
  }

  return reject('invalid-shape', [...paths]);
}

export interface SaveMappingPresetOptions {
  /**
   * Reuse an existing preset id to overwrite it; omit to mint a new one.
   *
   * Production callers omit both this and `newId`, so ids come from the
   * CSPRNG-backed generator in `src/lib/ids.ts` (threat-model.md §12). Tests
   * inject a deterministic generator instead of asserting against randomness.
   */
  readonly id?: string;
  readonly newId?: () => string;
  readonly clock?: Clock;
}

/**
 * Saves a preset built from a confirmed mapping.
 *
 * The count check and the write share one transaction. Counting first and
 * writing afterwards would let two saves racing in the same tab both observe
 * `MAX_PRESETS - 1` and both commit, which is exactly the bound this is
 * supposed to enforce.
 */
export async function saveMappingPreset(
  db: WorkspaceDatabase,
  draft: PresetDraft,
  options: SaveMappingPresetOptions = {},
): Promise<SaveMappingPresetResult> {
  const generateId = options.newId ?? newId;
  const clock = options.clock ?? systemClock;

  const candidate = buildPreset(draft, options.id ?? generateId(), clock());
  const validated = validateMappingPreset(candidate);
  if (!validated.ok) return validated;

  const preset = validated.preset;

  return db.transaction('rw', db.mappingPresets, async () => {
    const existing = await db.mappingPresets.get(preset.id);

    // Replacing a preset does not add one, so it stays allowed at the ceiling.
    if (!existing && (await db.mappingPresets.count()) >= MAX_PRESETS) {
      return reject('too-many-presets');
    }

    await db.mappingPresets.put(preset);
    return { ok: true, preset, replaced: existing !== undefined };
  });
}

/**
 * Stores an already-shaped preset, validating it first.
 *
 * Separate from `saveMappingPreset` because that one *builds* a preset from a
 * live mapping. This is the path for a preset that already exists as a
 * record — a test fixture, or one round-tripped through a backup.
 */
export async function putMappingPreset(
  db: WorkspaceDatabase,
  candidate: unknown,
): Promise<SaveMappingPresetResult> {
  const validated = validateMappingPreset(candidate);
  if (!validated.ok) return validated;

  const preset = validated.preset;

  return db.transaction('rw', db.mappingPresets, async () => {
    const existing = await db.mappingPresets.get(preset.id);
    if (!existing && (await db.mappingPresets.count()) >= MAX_PRESETS) {
      return reject('too-many-presets');
    }

    await db.mappingPresets.put(preset);
    return { ok: true, preset, replaced: existing !== undefined };
  });
}

/** Presets in display order. Ties break by id so the order is total. */
export async function listMappingPresets(db: WorkspaceDatabase): Promise<MappingPreset[]> {
  const presets = await db.mappingPresets.toArray();
  return presets.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export async function getMappingPreset(
  db: WorkspaceDatabase,
  id: string,
): Promise<MappingPreset | undefined> {
  return db.mappingPresets.get(id);
}

export async function countMappingPresets(db: WorkspaceDatabase): Promise<number> {
  return db.mappingPresets.count();
}

/**
 * Removes one preset.
 *
 * Returns whether a preset was actually there, so a caller can report the truth
 * instead of claiming a deletion that did not happen. Repeating the call is
 * safe: the second returns `false` and changes nothing.
 */
export async function deleteMappingPreset(db: WorkspaceDatabase, id: string): Promise<boolean> {
  return db.transaction('rw', db.mappingPresets, async () => {
    const existing = await db.mappingPresets.get(id);
    if (!existing) return false;
    await db.mappingPresets.delete(id);
    return true;
  });
}
