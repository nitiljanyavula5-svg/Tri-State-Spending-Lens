/**
 * Bounds shared by the persistence layer and the import pipeline.
 *
 * This module deliberately imports nothing. Both layers need the stored-text
 * ceiling — `src/import/limits.ts` derives its field cap from it, and
 * `src/db/backupSchema.ts` bounds every stored string with it — and Phase 3
 * adds a second edge in the other direction, because the backup document now
 * validates the mapping presets that `src/import/mapping.ts` defines.
 *
 * Holding the constant in either of those files would close that loop into a
 * cycle, and the failure mode is worse than a build error: `limits.ts`
 * initializes `MAX_FIELD_LENGTH` at module scope, so the read would land in the
 * temporal dead zone and throw while the module graph was still evaluating —
 * a crash on load rather than a compile-time complaint. A leaf module makes the
 * cycle impossible to reintroduce by accident.
 */

/**
 * Provisional bound on any stored text field.
 *
 * threat-model.md §16 leaves the exact field-length cap to be fixed in Phase 3
 * alongside the parser, once the fixtures show realistic bank description
 * lengths. Restore still needs *a* bound so a hostile backup cannot exhaust
 * memory, so this generous value applies until Phase 3 records the real one.
 */
export const MAX_TEXT_FIELD_LENGTH = 8192;
