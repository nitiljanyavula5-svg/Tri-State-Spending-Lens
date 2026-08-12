import type { AccountType } from '../../types/domain';
import type { Delimiter } from '../detectFormat';
import type { Encoding } from '../decode';
import type { DateFormat, DateFormatDetection } from '../dates';
import type { ImportFailure } from '../errors';
import type { FileFormat, FileMapping, MappingPreset } from '../mapping';
import { validateMapping } from '../mapping';
import type { FingerprintedRow, NormalizedFileResult } from '../normalizeFile';
import type { InspectionResult } from '../workerProtocol';
import { MAX_FILES_PER_SESSION } from '../limits';

/**
 * The import wizard's state machine.
 *
 * Pure by construction: no React, no worker, no IndexedDB. Everything the six
 * steps need to agree on lives here as data, and every transition is a function
 * of the previous state and one action.
 *
 * That matters most for **invalidation**. Changing a delimiter in step 2 has to
 * discard the column mapping, the normalized rows, the duplicate decisions, and
 * the Health Report derived from them. Spreading those rules across six
 * components is how a wizard ends up committing rows that were normalized under
 * settings the user has since changed. Here the rule is written once, next to
 * the action that triggers it, and can be tested without rendering anything.
 *
 * The second reason is **staleness**. Worker requests are asynchronous and
 * abandonable, so every async action carries the request id it belongs to and
 * the reducer drops any result that is not the one currently awaited. A slow
 * response from a superseded request cannot move the wizard, and that is a
 * property of a pure function rather than a race a component has to win.
 */

export const WIZARD_STEPS = [
  { id: 'choose', title: 'Choose files' },
  { id: 'format', title: 'Identify format' },
  { id: 'map', title: 'Map columns' },
  { id: 'confirm', title: 'Confirm conventions' },
  { id: 'review', title: 'Review preview' },
  { id: 'report', title: 'Import Health Report' },
] as const;

export type StepId = (typeof WIZARD_STEPS)[number]['id'];

export const STEP_IDS: readonly StepId[] = WIZARD_STEPS.map((step) => step.id);

export function stepIndex(step: StepId): number {
  return STEP_IDS.indexOf(step);
}

/* ---------------------------------------------------------------- drafts - */

/**
 * A column mapping while it is still being edited.
 *
 * Every column is nullable because "not chosen yet" is a real state the user
 * passes through, and `FileMapping` has no way to express it. `toFileMapping`
 * is the one place a draft becomes a validated mapping.
 */
export interface MappingDraft {
  readonly dateColumn: number | null;
  readonly descriptionColumn: number | null;
  readonly amountModel: 'signed' | 'debit-credit';
  readonly amountColumn: number | null;
  readonly negativeMeans: 'debit' | 'credit';
  readonly debitColumn: number | null;
  readonly creditColumn: number | null;
  readonly accountLabelColumn: number | null;
  readonly typeColumn: number | null;
}

export function emptyMappingDraft(): MappingDraft {
  return {
    dateColumn: null,
    descriptionColumn: null,
    amountModel: 'signed',
    amountColumn: null,
    // The standard convention, shown to the user with worked examples before
    // commit rather than applied silently (data-methodology.md §3.4).
    negativeMeans: 'debit',
    debitColumn: null,
    creditColumn: null,
    accountLabelColumn: null,
    typeColumn: null,
  };
}

/**
 * An account this import will create.
 *
 * Held at session level rather than per file so two files can land in one new
 * account, and so the id is decided **once**. That id is not cosmetic: it is
 * hashed into every fingerprint (data-methodology.md §4.2), so regenerating it
 * between normalization and commit would silently change every row's identity.
 */
export interface StagedAccount {
  readonly id: string;
  readonly label: string;
  readonly accountType: AccountType;
}

/** Where a confirmed setting came from, so the UI can say so honestly. */
export type SettingSource = 'detected' | 'edited';

export interface FileDraft {
  /** Stable local id. Never persisted. */
  readonly id: string;
  /** In memory only. Never written to IndexedDB. */
  readonly file: File;
  /** Neutralized name, the only form ever displayed or stored. */
  readonly displayName: string;
  readonly byteLength: number;

  readonly inspection: InspectionResult | null;
  readonly inspectionFailure: ImportFailure | null;
  /** Non-null while an inspect request is awaited. */
  readonly pendingInspectId: string | null;

  readonly format: FileFormat | null;
  readonly formatSource: SettingSource;
  readonly columns: readonly string[];

  readonly mapping: MappingDraft;
  readonly mappingSource: SettingSource;
  /** Preset the mapping came from, for display only. */
  readonly appliedPresetId: string | null;

  /** An existing account id, a staged new account's id, or null. */
  readonly accountId: string | null;

  readonly dateFormat: DateFormat | null;
  readonly dateFormatSource: SettingSource;
  readonly dateDetection: DateFormatDetection | null;

  readonly normalized: NormalizedFileResult | null;
  readonly normalizeFailure: ImportFailure | null;
  readonly pendingNormalizeId: string | null;
}

export type CommitPhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'committing' }
  | { readonly kind: 'failed'; readonly reason: string; readonly message: string }
  | {
      readonly kind: 'committed';
      readonly sessionId: string;
      readonly committedTransactionCount: number;
      readonly createdAccountIds: readonly string[];
      readonly replacedDemoWorkspace: boolean;
    };

export interface WizardState {
  readonly step: StepId;
  /** Deterministic order: files stay in the order they were added. */
  readonly files: readonly FileDraft[];
  /** Accounts this import will create, staged until the atomic commit. */
  readonly newAccounts: readonly StagedAccount[];
  /** Fixed, safe failures from file selection. */
  readonly selectionFailures: readonly ImportFailure[];
  readonly statementRangeStart: string;
  readonly statementRangeEnd: string;
  /**
   * Keep/exclude decisions, keyed by `decisionKey` — staged file id and row
   * number.
   *
   * Deliberately **not** keyed by fingerprint. A cross-file duplicate carries
   * the *same* fingerprint as the row it duplicates, so a fingerprint-keyed
   * decision to exclude the copy would also exclude the original and commit
   * neither. Nor by file *name*, which two staged files can share.
   *
   * Absent means keep, so forgetting to record a decision can never silently
   * drop a row.
   */
  readonly duplicateDecisions: ReadonlyMap<string, 'keep' | 'exclude'>;
  /** Fingerprints already in the workspace, loaded once per review pass. */
  readonly existingFingerprints: ReadonlySet<string>;
  readonly commit: CommitPhase;
  /** True once the user has confirmed replacing a demo workspace. */
  readonly demoReplacementConfirmed: boolean;
}

export function initialWizardState(): WizardState {
  return {
    step: 'choose',
    files: [],
    newAccounts: [],
    selectionFailures: [],
    statementRangeStart: '',
    statementRangeEnd: '',
    duplicateDecisions: new Map(),
    existingFingerprints: new Set(),
    commit: { kind: 'idle' },
    demoReplacementConfirmed: false,
  };
}

/* --------------------------------------------------------------- actions - */

export type WizardAction =
  | {
      type: 'files-added';
      files: readonly { id: string; file: File; displayName: string }[];
      failures: readonly ImportFailure[];
    }
  | { type: 'file-removed'; fileId: string }
  | { type: 'files-cleared' }
  | { type: 'inspect-started'; fileId: string; requestId: string }
  | { type: 'inspect-succeeded'; fileId: string; requestId: string; result: InspectionResult }
  | { type: 'inspect-failed'; fileId: string; requestId: string; failure: ImportFailure }
  | { type: 'inspect-cancelled'; fileId: string; requestId: string }
  | { type: 'format-changed'; fileId: string; patch: Partial<FileFormat> }
  | { type: 'mapping-changed'; fileId: string; patch: Partial<MappingDraft> }
  | { type: 'preset-applied'; fileId: string; preset: MappingPreset }
  | { type: 'mapping-copied-to-matching-files'; fileId: string }
  | { type: 'account-selected'; fileId: string; accountId: string | null }
  | { type: 'new-account-staged'; account: StagedAccount; fileId: string | null }
  | { type: 'new-account-updated'; accountId: string; patch: Partial<Omit<StagedAccount, 'id'>> }
  | { type: 'new-account-removed'; accountId: string }
  | { type: 'date-format-changed'; fileId: string; dateFormat: DateFormat }
  | { type: 'date-detected'; fileId: string; detection: DateFormatDetection }
  | { type: 'statement-range-changed'; start: string; end: string }
  | { type: 'normalize-started'; fileId: string; requestId: string }
  | {
      type: 'normalize-succeeded';
      fileId: string;
      requestId: string;
      result: NormalizedFileResult;
    }
  | { type: 'normalize-failed'; fileId: string; requestId: string; failure: ImportFailure }
  | { type: 'normalize-cancelled'; fileId: string; requestId: string }
  | { type: 'existing-fingerprints-loaded'; fingerprints: ReadonlySet<string> }
  | { type: 'duplicate-decision'; rowKey: string; decision: 'keep' | 'exclude' }
  | { type: 'duplicate-decision-bulk'; rowKeys: readonly string[]; decision: 'keep' | 'exclude' }
  | { type: 'demo-replacement-confirmed'; confirmed: boolean }
  | { type: 'step-changed'; step: StepId }
  | { type: 'commit-started' }
  | {
      type: 'commit-succeeded';
      sessionId: string;
      committedTransactionCount: number;
      createdAccountIds: readonly string[];
      replacedDemoWorkspace: boolean;
    }
  | { type: 'commit-failed'; reason: string; message: string }
  | { type: 'reset' };

/* ----------------------------------------------------------- invalidation - */

/**
 * Discards everything downstream of normalization for one file.
 *
 * Called whenever an input to normalization changes. Keeping the normalized
 * rows would let the wizard commit data produced under settings the user has
 * since changed, which §14 forbids outright.
 */
function withoutNormalization(draft: FileDraft): FileDraft {
  if (draft.normalized === null && draft.normalizeFailure === null && !draft.pendingNormalizeId) {
    return draft;
  }
  return { ...draft, normalized: null, normalizeFailure: null, pendingNormalizeId: null };
}

/**
 * Discards the mapping as well.
 *
 * Structural changes — delimiter, encoding, header line — renumber or rename
 * the columns a mapping refers to, so column 2 after the change is not the
 * column 2 the user chose before it.
 */
function withoutMapping(draft: FileDraft): FileDraft {
  return {
    ...withoutNormalization(draft),
    mapping: emptyMappingDraft(),
    mappingSource: 'detected',
    appliedPresetId: null,
    dateFormat: null,
    dateFormatSource: 'detected',
    dateDetection: null,
  };
}

/**
 * Clears duplicate decisions whenever the rows they refer to could change.
 *
 * A decision is keyed by fingerprint, and a fingerprint is a function of the
 * normalization inputs. Keeping a decision across a change would silently apply
 * an "exclude" the user made about a different row.
 */
function clearedDecisions(state: WizardState): Pick<WizardState, 'duplicateDecisions'> {
  return state.duplicateDecisions.size === 0
    ? { duplicateDecisions: state.duplicateDecisions }
    : { duplicateDecisions: new Map() };
}

/** A step the wizard may legitimately still be on after files changed. */
function clampStep(state: WizardState, files: readonly FileDraft[]): StepId {
  if (files.length === 0) return 'choose';
  return stepIndex(state.step) > stepIndex('format') ? 'format' : state.step;
}

/* --------------------------------------------------------------- reducer - */

export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case 'files-added': {
      const room = Math.max(0, MAX_FILES_PER_SESSION - state.files.length);
      const accepted = action.files.slice(0, room);

      const added: FileDraft[] = accepted.map(({ id, file, displayName }) => ({
        id,
        file,
        displayName,
        byteLength: file.size,
        inspection: null,
        inspectionFailure: null,
        pendingInspectId: null,
        format: null,
        formatSource: 'detected',
        columns: [],
        mapping: emptyMappingDraft(),
        mappingSource: 'detected',
        appliedPresetId: null,
        accountId: null,
        dateFormat: null,
        dateFormatSource: 'detected',
        dateDetection: null,
        normalized: null,
        normalizeFailure: null,
        pendingNormalizeId: null,
      }));

      const files = [...state.files, ...added];

      return {
        ...state,
        files,
        selectionFailures: action.failures,
        ...clearedDecisions(state),
        step: clampStep(state, files),
        commit: { kind: 'idle' },
      };
    }

    case 'file-removed': {
      const files = state.files.filter((draft) => draft.id !== action.fileId);
      if (files.length === state.files.length) return state;
      return {
        ...state,
        files,
        ...clearedDecisions(state),
        step: clampStep(state, files),
        commit: { kind: 'idle' },
      };
    }

    case 'files-cleared':
      return { ...initialWizardState(), existingFingerprints: state.existingFingerprints };

    case 'inspect-started':
      return patchFile(state, action.fileId, (draft) => ({
        ...draft,
        pendingInspectId: action.requestId,
        inspectionFailure: null,
      }));

    case 'inspect-succeeded':
      return patchFile(state, action.fileId, (draft) => {
        // Stale guard: a superseded request's result never lands.
        if (draft.pendingInspectId !== action.requestId) return draft;

        const header = action.result.header;
        return {
          ...withoutMapping(draft),
          pendingInspectId: null,
          inspection: action.result,
          inspectionFailure: null,
          format: {
            encoding: action.result.encoding.encoding,
            delimiter: action.result.delimiter.delimiter,
            headerLineIndex: header?.headerLineIndex ?? 0,
          },
          formatSource: 'detected',
          columns: header ? [...header.columns] : [],
        };
      });

    case 'inspect-failed':
      return patchFile(state, action.fileId, (draft) =>
        draft.pendingInspectId !== action.requestId
          ? draft
          : { ...draft, pendingInspectId: null, inspectionFailure: action.failure },
      );

    case 'inspect-cancelled':
      return patchFile(state, action.fileId, (draft) =>
        draft.pendingInspectId !== action.requestId ? draft : { ...draft, pendingInspectId: null },
      );

    case 'format-changed':
      return {
        ...patchFile(state, action.fileId, (draft) =>
          draft.format === null
            ? draft
            : {
                ...withoutMapping(draft),
                format: { ...draft.format, ...action.patch },
                formatSource: 'edited',
              },
        ),
        ...clearedDecisions(state),
      };

    case 'mapping-changed':
      return {
        ...patchFile(state, action.fileId, (draft) => ({
          ...withoutNormalization(draft),
          mapping: { ...draft.mapping, ...action.patch },
          mappingSource: 'edited',
          // The mapping no longer matches the preset it came from.
          appliedPresetId: null,
        })),
        ...clearedDecisions(state),
      };

    case 'preset-applied':
      return {
        ...patchFile(state, action.fileId, (draft) => {
          const preset = action.preset;
          return {
            ...withoutNormalization(draft),
            format: {
              encoding: preset.encoding,
              delimiter: preset.delimiter,
              headerLineIndex: preset.headerLineIndex,
            },
            formatSource: 'edited',
            mapping: mappingDraftFromPreset(preset),
            mappingSource: 'edited',
            appliedPresetId: preset.id,
            dateFormat: preset.dateFormat,
            dateFormatSource: 'edited',
          };
        }),
        ...clearedDecisions(state),
      };

    case 'mapping-copied-to-matching-files': {
      const source = state.files.find((draft) => draft.id === action.fileId);
      if (!source) return state;

      const signature = columnSignature(source.columns);
      if (signature === null) return state;

      return {
        ...state,
        files: state.files.map((draft) =>
          draft.id === source.id || columnSignature(draft.columns) !== signature
            ? draft
            : {
                ...withoutNormalization(draft),
                mapping: source.mapping,
                mappingSource: 'edited',
                appliedPresetId: source.appliedPresetId,
                dateFormat: source.dateFormat,
                dateFormatSource: source.dateFormatSource,
              },
        ),
        ...clearedDecisions(state),
      };
    }

    case 'account-selected':
      return {
        ...patchFile(state, action.fileId, (draft) => ({
          ...withoutNormalization(draft),
          accountId: action.accountId,
        })),
        ...clearedDecisions(state),
      };

    case 'new-account-staged': {
      const withAccount: WizardState = {
        ...state,
        newAccounts: [...state.newAccounts, action.account],
      };
      if (action.fileId === null) return withAccount;
      return {
        ...patchFile(withAccount, action.fileId, (draft) => ({
          ...withoutNormalization(draft),
          accountId: action.account.id,
        })),
        ...clearedDecisions(state),
      };
    }

    case 'new-account-updated':
      return {
        ...state,
        newAccounts: state.newAccounts.map((account) =>
          account.id === action.accountId ? { ...account, ...action.patch } : account,
        ),
        // A renamed account is still the same account: the id is unchanged, so
        // fingerprints are unaffected and normalized rows stay valid.
      };

    case 'new-account-removed': {
      const newAccounts = state.newAccounts.filter((account) => account.id !== action.accountId);
      if (newAccounts.length === state.newAccounts.length) return state;
      return {
        ...state,
        newAccounts,
        files: state.files.map((draft) =>
          draft.accountId === action.accountId
            ? { ...withoutNormalization(draft), accountId: null }
            : draft,
        ),
        ...clearedDecisions(state),
      };
    }

    case 'date-format-changed':
      return {
        ...patchFile(state, action.fileId, (draft) => ({
          ...withoutNormalization(draft),
          dateFormat: action.dateFormat,
          dateFormatSource: 'edited',
        })),
        ...clearedDecisions(state),
      };

    case 'date-detected':
      return patchFile(state, action.fileId, (draft) =>
        // Detection proposes; it never overrides a choice the user has made.
        draft.dateFormatSource === 'edited'
          ? { ...draft, dateDetection: action.detection }
          : {
              ...draft,
              dateDetection: action.detection,
              dateFormat: action.detection.ambiguous ? null : action.detection.recommended,
            },
      );

    case 'statement-range-changed':
      return {
        ...state,
        statementRangeStart: action.start,
        statementRangeEnd: action.end,
        files: state.files.map(withoutNormalization),
        ...clearedDecisions(state),
      };

    case 'normalize-started':
      return patchFile(state, action.fileId, (draft) => ({
        ...draft,
        pendingNormalizeId: action.requestId,
        normalizeFailure: null,
      }));

    case 'normalize-succeeded':
      return patchFile(state, action.fileId, (draft) =>
        draft.pendingNormalizeId !== action.requestId
          ? draft
          : {
              ...draft,
              pendingNormalizeId: null,
              normalized: action.result,
              normalizeFailure: null,
            },
      );

    case 'normalize-failed':
      return patchFile(state, action.fileId, (draft) =>
        draft.pendingNormalizeId !== action.requestId
          ? draft
          : { ...draft, pendingNormalizeId: null, normalizeFailure: action.failure },
      );

    case 'normalize-cancelled':
      return patchFile(state, action.fileId, (draft) =>
        draft.pendingNormalizeId !== action.requestId
          ? draft
          : { ...draft, pendingNormalizeId: null },
      );

    case 'existing-fingerprints-loaded':
      return { ...state, existingFingerprints: action.fingerprints };

    case 'duplicate-decision': {
      const next = new Map(state.duplicateDecisions);
      next.set(action.rowKey, action.decision);
      return { ...state, duplicateDecisions: next };
    }

    case 'duplicate-decision-bulk': {
      const next = new Map(state.duplicateDecisions);
      for (const key of action.rowKeys) next.set(key, action.decision);
      return { ...state, duplicateDecisions: next };
    }

    case 'demo-replacement-confirmed':
      return { ...state, demoReplacementConfirmed: action.confirmed };

    case 'step-changed':
      return { ...state, step: action.step };

    case 'commit-started':
      return { ...state, commit: { kind: 'committing' } };

    case 'commit-succeeded':
      return {
        ...state,
        commit: {
          kind: 'committed',
          sessionId: action.sessionId,
          committedTransactionCount: action.committedTransactionCount,
          createdAccountIds: action.createdAccountIds,
          replacedDemoWorkspace: action.replacedDemoWorkspace,
        },
      };

    case 'commit-failed':
      // The staged state is deliberately preserved so the user can correct and
      // retry rather than starting over (§10).
      return {
        ...state,
        commit: { kind: 'failed', reason: action.reason, message: action.message },
      };

    case 'reset':
      return { ...initialWizardState(), existingFingerprints: state.existingFingerprints };

    default:
      return state;
  }
}

function patchFile(
  state: WizardState,
  fileId: string,
  patch: (draft: FileDraft) => FileDraft,
): WizardState {
  let changed = false;
  const files = state.files.map((draft) => {
    if (draft.id !== fileId) return draft;
    const next = patch(draft);
    if (next !== draft) changed = true;
    return next;
  });
  return changed ? { ...state, files } : state;
}

/**
 * A comparison key for a file's column layout, or null when it has none.
 *
 * JSON-encoded rather than joined with a separator: a column literally named
 * `A|B` must not compare equal to two columns named `A` and `B`, and encoding
 * sidesteps having to pick a character no bank would ever use.
 */
function columnSignature(columns: readonly string[]): string | null {
  if (columns.length === 0) return null;
  return JSON.stringify(columns.map((name) => name.trim().toLowerCase()));
}

export function mappingDraftFromPreset(preset: MappingPreset): MappingDraft {
  const base = emptyMappingDraft();
  return {
    ...base,
    dateColumn: preset.dateColumn,
    descriptionColumn: preset.descriptionColumn,
    amountModel: preset.amount.kind,
    amountColumn: preset.amount.kind === 'signed' ? preset.amount.amountColumn : null,
    negativeMeans: preset.amount.kind === 'signed' ? preset.amount.negativeMeans : 'debit',
    debitColumn: preset.amount.kind === 'debit-credit' ? preset.amount.debitColumn : null,
    creditColumn: preset.amount.kind === 'debit-credit' ? preset.amount.creditColumn : null,
    accountLabelColumn: preset.accountLabelColumn ?? null,
    typeColumn: preset.typeColumn ?? null,
  };
}

/* -------------------------------------------------------------- selectors - */

/** The staged new account a file targets, when it targets one. */
export function stagedAccountFor(state: WizardState, draft: FileDraft): StagedAccount | null {
  if (draft.accountId === null) return null;
  return state.newAccounts.find((account) => account.id === draft.accountId) ?? null;
}

/**
 * The account target in the shape `fileMappingSchema` expects.
 *
 * A staged account becomes a `new` target and an unknown id becomes `existing`.
 * The engine only uses this to know whether an account has to be created; the
 * id that reaches the fingerprint is `draft.accountId` either way, which is why
 * a staged id must be decided before normalization and never regenerated.
 */
export function accountTargetFor(
  state: WizardState,
  draft: FileDraft,
):
  | { kind: 'existing'; accountId: string }
  | { kind: 'new'; label: string; accountType: AccountType; currencyConfirmed: true }
  | null {
  if (draft.accountId === null) return null;

  const staged = stagedAccountFor(state, draft);
  if (staged) {
    if (staged.label.trim().length === 0) return null;
    return {
      kind: 'new',
      label: staged.label.trim(),
      accountType: staged.accountType,
      currencyConfirmed: true,
    };
  }

  return { kind: 'existing', accountId: draft.accountId };
}

/**
 * Assembles a draft into a mapping the engine will accept.
 *
 * Validation is delegated to `validateMapping`, the same runtime schema the
 * worker uses. The component never re-implements a rule — §7 requires the
 * check to live in one place, and this is it.
 */
export function toFileMapping(state: WizardState, draft: FileDraft): FileMapping | null {
  const m = draft.mapping;
  if (m.dateColumn === null || m.descriptionColumn === null) return null;
  if (draft.dateFormat === null) return null;

  const account = accountTargetFor(state, draft);
  if (account === null) return null;

  const amount =
    m.amountModel === 'signed'
      ? m.amountColumn === null
        ? null
        : { kind: 'signed' as const, amountColumn: m.amountColumn, negativeMeans: m.negativeMeans }
      : m.debitColumn === null || m.creditColumn === null
        ? null
        : {
            kind: 'debit-credit' as const,
            debitColumn: m.debitColumn,
            creditColumn: m.creditColumn,
          };
  if (amount === null) return null;

  const candidate = {
    dateColumn: m.dateColumn,
    descriptionColumn: m.descriptionColumn,
    amount,
    ...(m.accountLabelColumn === null ? {} : { accountLabelColumn: m.accountLabelColumn }),
    ...(m.typeColumn === null ? {} : { typeColumn: m.typeColumn }),
    dateFormat: draft.dateFormat,
    account,
    ...(state.statementRangeStart === '' ? {} : { statementRangeStart: state.statementRangeStart }),
    ...(state.statementRangeEnd === '' ? {} : { statementRangeEnd: state.statementRangeEnd }),
  };

  const validated = validateMapping(candidate);
  return validated.ok ? validated.mapping : null;
}

/** Mapping problems for one file, as field paths and safe messages. */
export function mappingIssues(
  state: WizardState,
  draft: FileDraft,
): readonly { path: string; message: string }[] {
  const m = draft.mapping;
  const missing: { path: string; message: string }[] = [];

  if (m.dateColumn === null) missing.push({ path: 'date', message: 'Choose the date column.' });
  if (m.descriptionColumn === null) {
    missing.push({ path: 'description', message: 'Choose the description column.' });
  }
  if (m.amountModel === 'signed' && m.amountColumn === null) {
    missing.push({ path: 'amount', message: 'Choose the amount column.' });
  }
  if (m.amountModel === 'debit-credit') {
    if (m.debitColumn === null)
      missing.push({ path: 'debit', message: 'Choose the debit column.' });
    if (m.creditColumn === null) {
      missing.push({ path: 'credit', message: 'Choose the credit column.' });
    }
  }
  if (missing.length > 0) return missing;

  // Everything required is chosen, so the remaining problems are the schema's
  // to report — column collisions among them. Step 3 runs before the account
  // and date format are confirmed, so stand-ins fill those slots: this function
  // answers "is the *mapping* valid", not "is the file ready to commit".
  const withAccount: FileDraft =
    draft.accountId === null ? { ...draft, accountId: 'pending-account-choice' } : draft;
  const withDate: FileDraft =
    withAccount.dateFormat === null ? { ...withAccount, dateFormat: 'iso' } : withAccount;

  return validateMappingDraft(state, withDate);
}

function validateMappingDraft(
  state: WizardState,
  draft: FileDraft,
): readonly { path: string; message: string }[] {
  const m = draft.mapping;
  const claimed = new Map<number, string>();
  const issues: { path: string; message: string }[] = [];

  const claim = (column: number | null, field: string) => {
    if (column === null) return;
    const existing = claimed.get(column);
    if (existing !== undefined) {
      issues.push({
        path: field,
        message: `This column is already mapped to ${existing}. Each required field needs its own column.`,
      });
      return;
    }
    claimed.set(column, field);
  };

  claim(m.dateColumn, 'date');
  claim(m.descriptionColumn, 'description');
  if (m.amountModel === 'signed') claim(m.amountColumn, 'amount');
  else {
    claim(m.debitColumn, 'debit');
    claim(m.creditColumn, 'credit');
  }

  if (issues.length > 0) return issues;

  const mapping = toFileMapping(state, draft);
  if (mapping === null) {
    issues.push({ path: 'mapping', message: 'This mapping is not valid yet.' });
  }
  return issues;
}

export function isFileReadyToNormalize(state: WizardState, draft: FileDraft): boolean {
  return draft.format !== null && toFileMapping(state, draft) !== null;
}

/**
 * Identifies one staged row, for keep/exclude decisions.
 *
 * Keyed on the **staged file's local id**, not its name. Two files a user
 * selects can carry the same name — the same statement pulled from two folders,
 * or one export downloaded twice — and their row numbers then collide, so a
 * `fileName#originalRow` key would make a decision about one file silently
 * apply to the other. The id is a per-session UUID that exists only in memory
 * and is never written to IndexedDB.
 *
 * Length-prefixed so no combination of id and row number can alias another,
 * the same framing the fingerprint encoding uses.
 */
export function decisionKey(fileId: string, originalRow: number): string {
  return `${fileId.length}:${fileId}${originalRow}`;
}

/** One staged row together with the file it came from. */
export interface StagedRow {
  readonly fileId: string;
  readonly row: FingerprintedRow;
}

/**
 * Every staged row paired with its file, in file order then row order.
 *
 * The pairing is what makes a decision unambiguous; `sessionRows` alone cannot
 * distinguish two files that share a name.
 */
export function stagedRows(state: WizardState): readonly StagedRow[] {
  const rows: StagedRow[] = [];
  for (const draft of state.files) {
    if (!draft.normalized) continue;
    for (const row of draft.normalized.rows) rows.push({ fileId: draft.id, row });
  }
  return rows;
}

/**
 * Splits staged rows into those that will be committed and those the user
 * excluded.
 *
 * Deliberately not `applyDuplicateDecisions` from the engine: that keys on
 * fingerprint, which cannot tell a cross-file duplicate from the row it
 * duplicates, so excluding one would drop both.
 */
export function partitionByDecisions(state: WizardState): {
  readonly kept: readonly FingerprintedRow[];
  readonly excluded: readonly FingerprintedRow[];
} {
  const kept: FingerprintedRow[] = [];
  const excluded: FingerprintedRow[] = [];

  for (const { fileId, row } of stagedRows(state)) {
    if (state.duplicateDecisions.get(decisionKey(fileId, row.originalRow)) === 'exclude') {
      excluded.push(row);
    } else {
      kept.push(row);
    }
  }

  return { kept, excluded };
}

/** Every staged row across all files, in file order then row order. */
export function sessionRows(state: WizardState): readonly FingerprintedRow[] {
  const rows: FingerprintedRow[] = [];
  for (const draft of state.files) {
    if (draft.normalized) rows.push(...draft.normalized.rows);
  }
  return rows;
}

export function sessionRowCount(state: WizardState): number {
  return state.files.reduce((total, draft) => total + (draft.normalized?.rowCount ?? 0), 0);
}

export function allFilesNormalized(state: WizardState): boolean {
  return state.files.length > 0 && state.files.every((draft) => draft.normalized !== null);
}

export function isBusy(state: WizardState): boolean {
  return state.files.some(
    (draft) => draft.pendingInspectId !== null || draft.pendingNormalizeId !== null,
  );
}

/**
 * Whether the wizard may move to a step, and why not when it may not.
 *
 * Returning the reason rather than a bare boolean lets the UI explain a
 * disabled Continue button instead of leaving the user guessing.
 */
export function blockedReason(state: WizardState, target: StepId): string | null {
  if (stepIndex(target) <= stepIndex(state.step)) return null;

  const files = state.files;
  if (files.length === 0) return 'Choose at least one CSV file to continue.';

  if (stepIndex(target) > stepIndex('choose')) {
    if (isBusy(state)) return 'Wait for the files to finish being read.';
  }

  if (stepIndex(target) > stepIndex('format')) {
    if (files.some((draft) => draft.format === null)) {
      return 'Every file needs a confirmed format before continuing.';
    }
    if (files.some((draft) => draft.columns.length === 0)) {
      return 'Every file needs a header row with at least one column.';
    }
  }

  if (stepIndex(target) > stepIndex('map')) {
    if (files.some((draft) => mappingIssues(state, draft).length > 0)) {
      return 'Every file needs its date, description, and amount columns mapped.';
    }
  }

  if (stepIndex(target) > stepIndex('confirm')) {
    if (files.some((draft) => draft.accountId === null)) {
      return 'Choose an account for every file.';
    }
    if (files.some((draft) => stagedAccountFor(state, draft)?.label.trim() === '')) {
      return 'Name every new account.';
    }
    if (files.some((draft) => draft.dateFormat === null)) {
      return 'Confirm the date format for every file.';
    }
    if (files.some((draft) => toFileMapping(state, draft) === null)) {
      return 'Some settings are still incomplete or contradict each other.';
    }
  }

  if (stepIndex(target) > stepIndex('review')) {
    if (!allFilesNormalized(state)) return 'Wait for every file to be read.';
  }

  return null;
}

export function canAdvance(state: WizardState, target: StepId): boolean {
  return blockedReason(state, target) === null;
}

/** The step after the current one, or null at the end. */
export function nextStep(step: StepId): StepId | null {
  return STEP_IDS[stepIndex(step) + 1] ?? null;
}

export function previousStep(step: StepId): StepId | null {
  const index = stepIndex(step);
  return index <= 0 ? null : (STEP_IDS[index - 1] ?? null);
}

/**
 * Staged accounts a commit will actually create.
 *
 * Only the ones a file still targets. An account the user drafted and then
 * reassigned away from must not be created: an import may not leave behind an
 * account that holds nothing and that the user never chose to keep.
 */
export function accountsToCreate(state: WizardState): readonly StagedAccount[] {
  const targeted = new Set(state.files.map((draft) => draft.accountId));
  return state.newAccounts
    .filter((account) => targeted.has(account.id))
    .map((account) => ({ ...account, label: account.label.trim() }));
}

export type { Delimiter, Encoding, FileFormat, FileMapping, DateFormat };
