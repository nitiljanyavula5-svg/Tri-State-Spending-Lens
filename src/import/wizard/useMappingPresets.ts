import { useCallback, useEffect, useState } from 'react';
import type { WorkspaceDatabase } from '../../db/database';
import {
  deleteMappingPreset,
  listMappingPresets,
  saveMappingPreset,
} from '../../db/repositories/mappingPresets';
import { presetMatchScore, type MappingPreset, type PresetDraft } from '../mapping';

/**
 * Saved column mappings, for the Map-columns step.
 *
 * A thin wrapper over the repository: it holds the loaded list and reloads
 * after a write. Every rule about what a preset may contain, how many a
 * workspace may hold, and what makes one valid lives in the repository and its
 * schema — §7 requires the component to reuse that rather than restate it.
 */

/** Below this share of matching column names, a preset is not offered. */
export const PRESET_MATCH_THRESHOLD = 1;

export interface PresetCompatibility {
  readonly preset: MappingPreset;
  readonly score: number;
  readonly compatible: boolean;
  /** Constant explanation, safe to display. */
  readonly reason: string;
}

export interface MappingPresetsApi {
  readonly presets: readonly MappingPreset[];
  readonly loading: boolean;
  readonly error: string | null;
  compatibilityFor(columns: readonly string[]): readonly PresetCompatibility[];
  save(draft: PresetDraft): Promise<{ ok: boolean; message?: string }>;
  remove(id: string): Promise<void>;
  reload(): Promise<void>;
}

export function useMappingPresets(db: WorkspaceDatabase | null): MappingPresetsApi {
  const [presets, setPresets] = useState<readonly MappingPreset[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!db?.isOpen()) {
      setPresets([]);
      return;
    }
    setLoading(true);
    try {
      setPresets(await listMappingPresets(db));
      setError(null);
    } catch {
      // No preset list is a degraded but usable state: mapping by hand still
      // works. The message names no stored value.
      setError('Saved column mappings could not be read. You can still map the columns by hand.');
    } finally {
      setLoading(false);
    }
  }, [db]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const compatibilityFor = useCallback(
    (columns: readonly string[]): readonly PresetCompatibility[] =>
      presets.map((preset) => {
        // The engine's own scoring, not a second algorithm (§7).
        const score = presetMatchScore(preset, columns);
        const compatible = score >= PRESET_MATCH_THRESHOLD;
        return {
          preset,
          score,
          compatible,
          reason: compatible
            ? 'The column names match this file exactly.'
            : score === 0
              ? 'This preset was saved for a file with different columns.'
              : 'Some column names differ from the file this preset was saved for.',
        };
      }),
    [presets],
  );

  const save = useCallback(
    async (draft: PresetDraft) => {
      if (!db?.isOpen()) return { ok: false, message: 'The local workspace is not open.' };
      const result = await saveMappingPreset(db, draft);
      await reload();
      return result.ok ? { ok: true } : { ok: false, message: result.message };
    },
    [db, reload],
  );

  const remove = useCallback(
    async (id: string) => {
      if (!db?.isOpen()) return;
      await deleteMappingPreset(db, id);
      await reload();
    },
    [db, reload],
  );

  return { presets, loading, error, compatibilityFor, save, remove, reload };
}
