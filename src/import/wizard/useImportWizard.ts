import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import type { WorkspaceDatabase } from '../../db/database';
import { buildStagedImport, commitImport } from '../../db/importCommit';
import { analyzeDuplicates, analyzeWithinFileDuplicates } from '../duplicates';
import { detectDateFormat } from '../dates';
import { sanitizeSourceFileName, validateSelection } from '../fileValidation';
import { buildHealthReport, type HealthReport } from '../healthReport';
import { MAX_SESSION_ROWS } from '../limits';
import { createImportWorkerClient, type ImportWorkerClient } from '../importWorkerClient';
import { newId } from '../../lib/ids';
import type { AccountType } from '../../types/domain';
import {
  accountsToCreate,
  allFilesNormalized,
  decisionKey,
  initialWizardState,
  isFileReadyToNormalize,
  partitionByDecisions,
  sessionRowCount,
  sessionRows,
  toFileMapping,
  wizardReducer,
  type FileDraft,
  type MappingDraft,
  type StepId,
  type WizardState,
} from './wizardState';
import type { MappingPreset } from '../mapping';
import type { CandidateSource } from '../duplicates';
import type { FingerprintedRow } from '../normalizeFile';

/**
 * Side effects for the import wizard.
 *
 * Everything stateful and pure lives in `wizardState`; everything asynchronous
 * lives here. The split means a component never talks to the worker or to
 * Dexie directly (§4), and the transition rules stay testable without either.
 *
 * Resource ownership is explicit: one worker client per mounted wizard,
 * disposed on unmount, which terminates every request still in flight.
 */

export interface DuplicateGroup {
  readonly fingerprint: string;
  /** Staged file this row came from. In-memory only; never persisted. */
  readonly fileId: string;
  /** Neutralized name, for display. Two staged files may share one. */
  readonly fileName: string;
  readonly originalRow: number;
  readonly source: CandidateSource;
  readonly reason: string;
  readonly matchedFileName?: string;
  readonly matchedOriginalRow?: number;
  /** The key a keep/exclude decision for this exact row is recorded under. */
  readonly decisionKey: string;
}

export interface UseImportWizardOptions {
  readonly db: WorkspaceDatabase | null;
  readonly workspaceMode: 'empty' | 'demo' | 'personal';
  /** Injectable for tests; production builds the real module worker. */
  readonly createClient?: () => ImportWorkerClient;
  readonly generateId?: () => string;
  /** Called after a commit or rollback so the app can refresh its view. */
  readonly onWorkspaceChanged?: () => void;
}

export interface ImportWizardApi {
  readonly state: WizardState;
  readonly healthReport: HealthReport | null;
  readonly duplicateCandidates: readonly DuplicateGroup[];
  readonly duplicatesTruncated: boolean;
  readonly requiresDemoConfirmation: boolean;
  /**
   * Whether the commit button may be pressed.
   *
   * Distinct from `canCommit`: in demo mode the confirmation dialog is *reached
   * by pressing the button*, so gating the button on the confirmation would
   * make it unreachable.
   */
  readonly canStartCommit: boolean;
  /** Whether `commit()` will actually write. */
  readonly canCommit: boolean;

  addFiles(files: readonly File[]): void;
  removeFile(fileId: string): void;
  clearFiles(): void;
  changeFormat(fileId: string, patch: Partial<FileDraft['format'] & object>): void;
  changeMapping(fileId: string, patch: Partial<MappingDraft>): void;
  applyPreset(fileId: string, preset: MappingPreset): void;
  copyMappingToMatchingFiles(fileId: string): void;
  selectAccount(fileId: string, accountId: string | null): void;
  stageNewAccount(fileId: string | null, label: string, accountType: AccountType): string;
  updateNewAccount(accountId: string, patch: { label?: string; accountType?: AccountType }): void;
  removeNewAccount(accountId: string): void;
  setDateFormat(fileId: string, dateFormat: 'iso' | 'us' | 'eu'): void;
  setStatementRange(start: string, end: string): void;
  setDuplicateDecision(rowKey: string, decision: 'keep' | 'exclude'): void;
  setBulkDuplicateDecision(rowKeys: readonly string[], decision: 'keep' | 'exclude'): void;
  confirmDemoReplacement(confirmed: boolean): void;
  goToStep(step: StepId): void;
  cancelProcessing(): void;
  commit(): Promise<void>;
  reset(): void;
}

export function useImportWizard(options: UseImportWizardOptions): ImportWizardApi {
  const { db, workspaceMode, createClient, generateId = newId, onWorkspaceChanged } = options;

  const [state, dispatch] = useReducer(wizardReducer, undefined, initialWizardState);

  /**
   * One client for the wizard's lifetime.
   *
   * Built lazily so a test that never touches a file never constructs a worker,
   * and disposed on unmount so leaving the route mid-import terminates the
   * work rather than leaving it running against a gone component (§14).
   */
  const clientRef = useRef<ImportWorkerClient | null>(null);
  const getClient = useCallback((): ImportWorkerClient => {
    clientRef.current ??= createClient ? createClient() : createImportWorkerClient();
    return clientRef.current;
  }, [createClient]);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clientRef.current?.dispose();
      clientRef.current = null;
    };
  }, []);

  /** Drops a dispatch that arrives after unmount. */
  const safeDispatch = useCallback((action: Parameters<typeof dispatch>[0]) => {
    if (mountedRef.current) dispatch(action);
  }, []);

  /* ------------------------------------------------------------ selection - */

  const addFiles = useCallback(
    (files: readonly File[]) => {
      const { accepted, failures } = validateSelection(
        files.map((file) => ({ name: file.name, size: file.size, type: file.type })),
      );
      const acceptedNames = new Set(accepted.map((candidate) => candidate.name));

      safeDispatch({
        type: 'files-added',
        files: files
          .filter((file) => acceptedNames.has(file.name))
          .map((file) => ({
            id: generateId(),
            file,
            displayName: sanitizeSourceFileName(file.name),
          })),
        failures,
      });
    },
    [generateId, safeDispatch],
  );

  const removeFile = useCallback(
    (fileId: string) => safeDispatch({ type: 'file-removed', fileId }),
    [safeDispatch],
  );

  const clearFiles = useCallback(() => {
    clientRef.current?.dispose();
    clientRef.current = null;
    safeDispatch({ type: 'files-cleared' });
  }, [safeDispatch]);

  /* ----------------------------------------------------------- inspection - */

  // Files are inspected as soon as they are staged. The effect keys off files
  // that have neither a result nor a request in flight, so it runs once per
  // file and re-runs only if the file is replaced.
  useEffect(() => {
    const pending = state.files.filter(
      (draft) =>
        draft.inspection === null &&
        draft.inspectionFailure === null &&
        draft.pendingInspectId === null,
    );
    if (pending.length === 0) return;

    for (const draft of pending) {
      const requestId = generateId();
      safeDispatch({ type: 'inspect-started', fileId: draft.id, requestId });

      void getClient()
        .inspect(draft.file, { requestId })
        .then((outcome) => {
          if (outcome.status === 'ok') {
            safeDispatch({
              type: 'inspect-succeeded',
              fileId: draft.id,
              requestId,
              result: outcome.result,
            });
          } else if (outcome.status === 'failed') {
            safeDispatch({
              type: 'inspect-failed',
              fileId: draft.id,
              requestId,
              failure: outcome.failure,
            });
          } else {
            safeDispatch({ type: 'inspect-cancelled', fileId: draft.id, requestId });
          }
        });
    }
  }, [state.files, generateId, getClient, safeDispatch]);

  /* -------------------------------------------------------- date sampling - */

  // Once a date column is chosen, its sampled cells decide which formats are
  // even possible. Detection proposes; §8 forbids resolving an ambiguous one.
  useEffect(() => {
    for (const draft of state.files) {
      const column = draft.mapping.dateColumn;
      if (column === null || draft.inspection === null) continue;
      if (draft.dateDetection !== null) continue;

      const samples = draft.inspection.sampleRows
        .map((row) => row[column] ?? '')
        .filter((value) => value.trim().length > 0);
      if (samples.length === 0) continue;

      safeDispatch({
        type: 'date-detected',
        fileId: draft.id,
        detection: detectDateFormat(samples),
      });
    }
  }, [state.files, safeDispatch]);

  /* -------------------------------------------------------- normalization - */

  const normalizeAll = useCallback(async () => {
    const client = getClient();
    let budget = MAX_SESSION_ROWS;

    // Sequential, in file order. The session row budget is shared, so a later
    // file's limit depends on what earlier files consumed — and file order is
    // what makes occurrence indexes deterministic (§8).
    for (const draft of state.files) {
      const mapping = toFileMapping(state, draft);
      if (draft.format === null || mapping === null || draft.accountId === null) continue;
      if (draft.normalized !== null) {
        budget = Math.max(0, budget - draft.normalized.rowCount);
        continue;
      }

      const requestId = generateId();
      safeDispatch({ type: 'normalize-started', fileId: draft.id, requestId });

      const outcome = await client.normalize(
        {
          file: draft.file,
          format: draft.format,
          mapping,
          accountId: draft.accountId,
          maxRows: budget,
        },
        { requestId },
      );

      if (outcome.status === 'ok') {
        budget = Math.max(0, budget - outcome.result.rowCount);
        safeDispatch({
          type: 'normalize-succeeded',
          fileId: draft.id,
          requestId,
          result: outcome.result,
        });
      } else if (outcome.status === 'failed') {
        safeDispatch({
          type: 'normalize-failed',
          fileId: draft.id,
          requestId,
          failure: outcome.failure,
        });
      } else {
        safeDispatch({ type: 'normalize-cancelled', fileId: draft.id, requestId });
      }
    }
  }, [state, generateId, getClient, safeDispatch]);

  // Normalization runs on arrival at the review step, for whatever is missing.
  const normalizeStartedRef = useRef(false);
  useEffect(() => {
    if (state.step !== 'review') {
      normalizeStartedRef.current = false;
      return;
    }
    if (normalizeStartedRef.current) return;

    const needsWork = state.files.some(
      (draft) =>
        draft.normalized === null &&
        draft.normalizeFailure === null &&
        draft.pendingNormalizeId === null &&
        isFileReadyToNormalize(state, draft),
    );
    if (!needsWork) return;

    normalizeStartedRef.current = true;
    void normalizeAll().finally(() => {
      normalizeStartedRef.current = false;
    });
  }, [state, normalizeAll]);

  /* ------------------------------------------------- existing fingerprints - */

  useEffect(() => {
    if (state.step !== 'review' || !db?.isOpen()) return;
    if (state.existingFingerprints.size > 0) return;

    let cancelled = false;
    void db.transactions
      .toArray()
      .then((rows) => {
        if (cancelled) return;
        safeDispatch({
          type: 'existing-fingerprints-loaded',
          fingerprints: new Set(rows.map((row) => row.fingerprint)),
        });
      })
      .catch(() => {
        // A failed read means no workspace-scope duplicate suggestions. The
        // import is still correct: candidates are only ever suggestions.
      });

    return () => {
      cancelled = true;
    };
  }, [state.step, state.existingFingerprints.size, db, safeDispatch]);

  /* ------------------------------------------------------------- derived - */

  /**
   * Duplicate candidates from both mechanisms, in one deduplicated list.
   *
   * Rows are handed to the engine with `fileName` replaced by the **staged file
   * id**, so two files sharing a name cannot be conflated and every candidate
   * comes back carrying an identity a decision can be keyed on. Display names
   * are restored afterwards. The rows that are actually committed are the
   * originals — this substitution exists only for analysis.
   */
  const analysis = useMemo(() => {
    const displayNameById = new Map(state.files.map((draft) => [draft.id, draft.displayName]));

    /** Analysis view of one row: identity by file id rather than by name. */
    const asAnalysisRow = (fileId: string, row: FingerprintedRow) => ({ ...row, fileName: fileId });

    const perFile = state.files.map((draft) => ({
      fileId: draft.id,
      rows: (draft.normalized?.rows ?? []).map((row) => asAnalysisRow(draft.id, row)),
    }));

    const allRows = perFile.flatMap((file) => file.rows);
    if (allRows.length === 0) {
      return { candidates: [] as DuplicateGroup[], truncated: false, candidateCount: 0 };
    }

    // Repeats inside a single file: compared without the occurrence index, so
    // rows the fingerprint deliberately keeps distinct are still surfaced.
    const withinFile = perFile.map((file) => analyzeWithinFileDuplicates(file.rows));

    // Overlap across staged files and against the workspace, by fingerprint.
    const across = analyzeDuplicates({
      rows: allRows,
      existingFingerprints: state.existingFingerprints,
    });

    const truncated = across.truncated || withinFile.some((a) => a.truncated);

    // One row is one candidate. When both mechanisms flag it, the
    // workspace-scope reason is the more useful one to show.
    const byRow = new Map<string, DuplicateGroup>();
    const rank: Record<CandidateSource, number> = {
      'existing-workspace': 3,
      'staged-session': 2,
      'within-file': 1,
    };

    for (const candidate of [...withinFile.flatMap((a) => a.candidates), ...across.candidates]) {
      const fileId = candidate.fileName;
      const key = decisionKey(fileId, candidate.originalRow);
      const existing = byRow.get(key);
      if (existing && rank[existing.source] >= rank[candidate.source]) continue;

      byRow.set(key, {
        fingerprint: candidate.fingerprint,
        fileId,
        fileName: displayNameById.get(fileId) ?? fileId,
        originalRow: candidate.originalRow,
        source: candidate.source,
        reason: candidate.reason,
        ...(candidate.matchedFileName === undefined
          ? {}
          : {
              matchedFileName:
                displayNameById.get(candidate.matchedFileName) ?? candidate.matchedFileName,
            }),
        ...(candidate.matchedOriginalRow === undefined
          ? {}
          : { matchedOriginalRow: candidate.matchedOriginalRow }),
        decisionKey: key,
      });
    }

    const candidates = [...byRow.values()];
    return { candidates, truncated, candidateCount: candidates.length };
  }, [state]);

  const healthReport = useMemo(() => {
    if (!allFilesNormalized(state)) return null;

    const { excluded } = partitionByDecisions(state);

    /**
     * Row lookups scoped to one staged file.
     *
     * Within a single file `originalRow` is unique, so resolving a question or
     * a candidate to its row inside that file's own index is exact. Flattening
     * every file first and matching on file name plus row number is what would
     * let two same-named files inherit each other's flags.
     */
    const rowsByFile = new Map<string, Map<number, FingerprintedRow>>();
    const displayNameByRow = new Map<FingerprintedRow, string>();
    for (const draft of state.files) {
      const byRow = new Map<number, FingerprintedRow>();
      for (const row of draft.normalized?.rows ?? []) {
        byRow.set(row.originalRow, row);
        // The user's sanitized filename, never the staged file's identity.
        displayNameByRow.set(row, draft.displayName);
      }
      rowsByFile.set(draft.id, byRow);
    }

    const questionableRows = new Set<FingerprintedRow>();
    for (const draft of state.files) {
      const byRow = rowsByFile.get(draft.id);
      for (const question of draft.normalized?.questions ?? []) {
        const row = byRow?.get(question.originalRow);
        if (row) questionableRows.add(row);
      }
    }

    const candidateRows = new Set<FingerprintedRow>();
    for (const candidate of analysis.candidates) {
      const row = rowsByFile.get(candidate.fileId)?.get(candidate.originalRow);
      if (row) candidateRows.add(row);
    }

    return buildHealthReport({
      rowCount: sessionRowCount(state),
      normalizedRows: sessionRows(state),
      excludedRows: excluded,
      // Rejections are shown with the sanitized name of the file they came from.
      rejections: state.files.flatMap((draft) =>
        (draft.normalized?.rejections ?? []).map((rejection) => ({
          ...rejection,
          fileName: draft.displayName,
        })),
      ),
      questions: state.files.flatMap((draft) => [...(draft.normalized?.questions ?? [])]),
      duplicateCandidates: analysis.candidates,
      questionableRows,
      candidateRows,
      displayFileNameFor: (row) => displayNameByRow.get(row) ?? row.fileName,
      warnings: state.files.flatMap((draft) => [
        ...(draft.normalized?.structuralWarnings ?? []),
        ...(draft.normalized?.truncated
          ? ['Some rows were not read because the import row limit was reached.']
          : []),
        ...(draft.normalized?.hadInvalidBytes
          ? ['Some characters could not be decoded and were replaced.']
          : []),
      ]),
    });
  }, [state, analysis]);

  const requiresDemoConfirmation = workspaceMode === 'demo';

  const canStartCommit =
    state.step === 'report' &&
    healthReport !== null &&
    state.commit.kind !== 'committing' &&
    state.commit.kind !== 'committed';

  const canCommit = canStartCommit && (!requiresDemoConfirmation || state.demoReplacementConfirmed);

  /* -------------------------------------------------------------- commit - */

  // Guards the window between the click and the reducer's `committing` state.
  // Two clicks in the same tick would otherwise both read the old state and
  // both call the service (§10).
  const committingRef = useRef(false);

  const commit = useCallback(async () => {
    if (committingRef.current) return;
    if (!db?.isOpen() || healthReport === null) return;
    if (requiresDemoConfirmation && !state.demoReplacementConfirmed) return;

    committingRef.current = true;
    safeDispatch({ type: 'commit-started' });

    try {
      const { kept, excluded } = partitionByDecisions(state);

      const staged = buildStagedImport({
        rowCount: sessionRowCount(state),
        acceptedRows: kept,
        excludedRows: excluded,
        rejections: state.files.flatMap((draft) => [...(draft.normalized?.rejections ?? [])]),
        duplicateCandidates: analysis.candidates,
        warnings: healthReport.warnings,
        sourceFileNames: state.files.map((draft) => draft.displayName),
        newAccounts: accountsToCreate(state).map((account) => ({
          id: account.id,
          label: account.label,
          type: account.accountType,
          currency: 'USD' as const,
          archived: false,
        })),
        ...(state.statementRangeStart === ''
          ? {}
          : { statementRangeStart: state.statementRangeStart }),
        ...(state.statementRangeEnd === '' ? {} : { statementRangeEnd: state.statementRangeEnd }),
      });

      const result = await commitImport(db, staged, {
        ...(requiresDemoConfirmation ? { confirmDemoReplacement: true } : {}),
      });

      if (result.ok) {
        safeDispatch({
          type: 'commit-succeeded',
          sessionId: result.sessionId,
          committedTransactionCount: result.committedTransactionCount,
          createdAccountIds: result.createdAccountIds,
          replacedDemoWorkspace: result.replacedDemoWorkspace,
        });
        onWorkspaceChanged?.();
      } else {
        safeDispatch({ type: 'commit-failed', reason: result.reason, message: result.message });
      }
    } catch {
      // A thrown error here would otherwise leave the button stuck in its
      // committing state. The message is fixed: no cause is surfaced.
      safeDispatch({
        type: 'commit-failed',
        reason: 'workspace-write-failed',
        message:
          'The import could not be saved. Nothing was changed — your workspace is exactly as it was.',
      });
    } finally {
      committingRef.current = false;
    }
  }, [
    db,
    state,
    healthReport,
    analysis,
    requiresDemoConfirmation,
    onWorkspaceChanged,
    safeDispatch,
  ]);

  /* --------------------------------------------------------------- rest - */

  const cancelProcessing = useCallback(() => {
    clientRef.current?.dispose();
    clientRef.current = null;
  }, []);

  const reset = useCallback(() => {
    cancelProcessing();
    safeDispatch({ type: 'reset' });
  }, [cancelProcessing, safeDispatch]);

  const stageNewAccount = useCallback(
    (fileId: string | null, label: string, accountType: AccountType): string => {
      // The id is minted here, once, and is what every fingerprint for this
      // account will be built from.
      const id = generateId();
      safeDispatch({ type: 'new-account-staged', account: { id, label, accountType }, fileId });
      return id;
    },
    [generateId, safeDispatch],
  );

  return {
    state,
    healthReport,
    duplicateCandidates: analysis.candidates,
    duplicatesTruncated: analysis.truncated,
    requiresDemoConfirmation,
    canStartCommit,
    canCommit,

    addFiles,
    removeFile,
    clearFiles,
    changeFormat: (fileId, patch) => safeDispatch({ type: 'format-changed', fileId, patch }),
    changeMapping: (fileId, patch) => safeDispatch({ type: 'mapping-changed', fileId, patch }),
    applyPreset: (fileId, preset) => safeDispatch({ type: 'preset-applied', fileId, preset }),
    copyMappingToMatchingFiles: (fileId) =>
      safeDispatch({ type: 'mapping-copied-to-matching-files', fileId }),
    selectAccount: (fileId, accountId) =>
      safeDispatch({ type: 'account-selected', fileId, accountId }),
    stageNewAccount,
    updateNewAccount: (accountId, patch) =>
      safeDispatch({ type: 'new-account-updated', accountId, patch }),
    removeNewAccount: (accountId) => safeDispatch({ type: 'new-account-removed', accountId }),
    setDateFormat: (fileId, dateFormat) =>
      safeDispatch({ type: 'date-format-changed', fileId, dateFormat }),
    setStatementRange: (start, end) =>
      safeDispatch({ type: 'statement-range-changed', start, end }),
    setDuplicateDecision: (key, decision) =>
      safeDispatch({ type: 'duplicate-decision', rowKey: key, decision }),
    setBulkDuplicateDecision: (keys, decision) =>
      safeDispatch({ type: 'duplicate-decision-bulk', rowKeys: keys, decision }),
    confirmDemoReplacement: (confirmed) =>
      safeDispatch({ type: 'demo-replacement-confirmed', confirmed }),
    goToStep: (step) => safeDispatch({ type: 'step-changed', step }),
    cancelProcessing,
    commit,
    reset,
  };
}
