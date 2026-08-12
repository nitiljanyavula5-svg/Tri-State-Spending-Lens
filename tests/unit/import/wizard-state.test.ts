import { describe, expect, it } from 'vitest';
import {
  blockedReason,
  canAdvance,
  emptyMappingDraft,
  initialWizardState,
  mappingIssues,
  accountsToCreate,
  sessionRows,
  stagedAccountFor,
  toFileMapping,
  wizardReducer,
  type FileDraft,
  type WizardState,
} from '../../../src/import/wizard/wizardState';
import type { InspectionResult } from '../../../src/import/workerProtocol';
import type { NormalizedFileResult } from '../../../src/import/normalizeFile';
import { MAX_FILES_PER_SESSION } from '../../../src/import/limits';

/**
 * The wizard's transition rules.
 *
 * These assert behaviour that has no DOM: what a change invalidates, which
 * results are ignored as stale, and when the wizard may advance. Getting them
 * wrong is how a wizard commits rows normalized under settings the user has
 * since changed, so they are tested here rather than inferred from a rendered
 * screen.
 */

function fakeFile(name = 'statement.csv'): File {
  return new File(['Date,Description,Amount\n2026-04-08,SHOP,-1.00\n'], name, { type: 'text/csv' });
}

function inspection(
  columns: readonly string[] = ['Date', 'Description', 'Amount'],
): InspectionResult {
  return {
    fileName: 'statement.csv',
    byteLength: 64,
    encoding: {
      encoding: 'utf-8',
      confidence: 'high',
      reason: 'No byte-order mark.',
      bomLength: 0,
    },
    delimiter: {
      delimiter: ',',
      confidence: 'high',
      reason: 'Commas were consistent.',
      scores: [],
    },
    header: {
      headerLineIndex: 0,
      columns: [...columns],
      confidence: 'high',
      reason: 'The first line looks like a header.',
      skippedLines: 0,
    },
    sampleRows: [['2026-04-08', 'SHOP', '-1.00']],
    sampleLineCount: 2,
  };
}

function normalized(rowCount = 2): NormalizedFileResult {
  return {
    fileName: 'statement.csv',
    rowCount,
    rows: Array.from({ length: rowCount }, (_, index) => ({
      fileName: 'statement.csv',
      originalRow: index + 1,
      postedDate: '2026-04-08',
      descriptionRaw: 'SHOP',
      merchantNormalized: 'SHOP',
      descriptionCanonical: 'SHOP',
      amountCents: 100,
      direction: 'debit' as const,
      questions: [],
      fingerprint: String(index).padStart(64, '0'),
      occurrenceIndex: index,
      accountId: 'account-1',
    })),
    rejections: [],
    questions: [],
    structuralWarnings: [],
    truncated: false,
    hadInvalidBytes: false,
  };
}

/** A state with one file inspected, mapped, and pointed at an account. */
function readyState(): WizardState {
  let state = initialWizardState();
  state = wizardReducer(state, {
    type: 'files-added',
    files: [{ id: 'f1', file: fakeFile(), displayName: 'statement.csv' }],
    failures: [],
  });
  state = wizardReducer(state, { type: 'inspect-started', fileId: 'f1', requestId: 'r1' });
  state = wizardReducer(state, {
    type: 'inspect-succeeded',
    fileId: 'f1',
    requestId: 'r1',
    result: inspection(),
  });
  state = wizardReducer(state, {
    type: 'mapping-changed',
    fileId: 'f1',
    patch: { dateColumn: 0, descriptionColumn: 1, amountModel: 'signed', amountColumn: 2 },
  });
  state = wizardReducer(state, { type: 'account-selected', fileId: 'f1', accountId: 'account-1' });
  state = wizardReducer(state, { type: 'date-format-changed', fileId: 'f1', dateFormat: 'iso' });
  return state;
}

const file = (state: WizardState): FileDraft => state.files[0]!;

describe('staging files', () => {
  it('keeps files in the order they were added, for deterministic occurrence indexes', () => {
    let state = initialWizardState();
    state = wizardReducer(state, {
      type: 'files-added',
      files: [
        { id: 'a', file: fakeFile('a.csv'), displayName: 'a.csv' },
        { id: 'b', file: fakeFile('b.csv'), displayName: 'b.csv' },
      ],
      failures: [],
    });

    expect(state.files.map((draft) => draft.id)).toEqual(['a', 'b']);
  });

  it('refuses to stage more than the session file limit', () => {
    let state = initialWizardState();
    state = wizardReducer(state, {
      type: 'files-added',
      files: Array.from({ length: MAX_FILES_PER_SESSION + 5 }, (_, index) => ({
        id: `f${index}`,
        file: fakeFile(),
        displayName: 'statement.csv',
      })),
      failures: [],
    });

    expect(state.files).toHaveLength(MAX_FILES_PER_SESSION);
  });

  it('returns to the first step when the last file is removed', () => {
    let state = readyState();
    state = wizardReducer(state, { type: 'step-changed', step: 'confirm' });
    state = wizardReducer(state, { type: 'file-removed', fileId: 'f1' });

    expect(state.files).toHaveLength(0);
    expect(state.step).toBe('choose');
  });
});

describe('stale worker results are ignored', () => {
  it('drops an inspection whose request was superseded', () => {
    let state = initialWizardState();
    state = wizardReducer(state, {
      type: 'files-added',
      files: [{ id: 'f1', file: fakeFile(), displayName: 'statement.csv' }],
      failures: [],
    });
    state = wizardReducer(state, { type: 'inspect-started', fileId: 'f1', requestId: 'current' });

    // An abandoned earlier request answering late.
    const after = wizardReducer(state, {
      type: 'inspect-succeeded',
      fileId: 'f1',
      requestId: 'abandoned',
      result: inspection(['Wrong', 'Columns']),
    });

    expect(file(after).inspection).toBeNull();
    expect(file(after).pendingInspectId).toBe('current');
  });

  it('drops a normalization whose request was superseded', () => {
    let state = readyState();
    state = wizardReducer(state, { type: 'normalize-started', fileId: 'f1', requestId: 'current' });

    const after = wizardReducer(state, {
      type: 'normalize-succeeded',
      fileId: 'f1',
      requestId: 'abandoned',
      result: normalized(999),
    });

    expect(file(after).normalized).toBeNull();
  });

  it('accepts the result that matches the pending request', () => {
    let state = readyState();
    state = wizardReducer(state, { type: 'normalize-started', fileId: 'f1', requestId: 'r9' });
    state = wizardReducer(state, {
      type: 'normalize-succeeded',
      fileId: 'f1',
      requestId: 'r9',
      result: normalized(2),
    });

    expect(file(state).normalized?.rowCount).toBe(2);
    expect(file(state).pendingNormalizeId).toBeNull();
  });
});

describe('an upstream change invalidates everything downstream', () => {
  function normalizedReadyState(): WizardState {
    let state = readyState();
    state = wizardReducer(state, { type: 'normalize-started', fileId: 'f1', requestId: 'r2' });
    state = wizardReducer(state, {
      type: 'normalize-succeeded',
      fileId: 'f1',
      requestId: 'r2',
      result: normalized(),
    });
    state = wizardReducer(state, {
      type: 'duplicate-decision',
      rowKey: 'statement.csv#1',
      decision: 'exclude',
    });
    return state;
  }

  it('changing the delimiter discards the mapping, the rows, and the decisions', () => {
    const before = normalizedReadyState();
    expect(before.duplicateDecisions.size).toBe(1);

    const after = wizardReducer(before, {
      type: 'format-changed',
      fileId: 'f1',
      patch: { delimiter: ';' },
    });

    // The columns move, so the mapping that pointed at them is meaningless.
    expect(file(after).mapping).toEqual(emptyMappingDraft());
    expect(file(after).normalized).toBeNull();
    expect(file(after).dateFormat).toBeNull();
    expect(after.duplicateDecisions.size).toBe(0);
  });

  it('changing a mapped column discards the rows but keeps the rest of the mapping', () => {
    const after = wizardReducer(normalizedReadyState(), {
      type: 'mapping-changed',
      fileId: 'f1',
      patch: { descriptionColumn: 2 },
    });

    expect(file(after).normalized).toBeNull();
    expect(after.duplicateDecisions.size).toBe(0);
    expect(file(after).mapping.dateColumn).toBe(0);
  });

  it('changing the date format discards the rows', () => {
    const after = wizardReducer(normalizedReadyState(), {
      type: 'date-format-changed',
      fileId: 'f1',
      dateFormat: 'us',
    });

    expect(file(after).normalized).toBeNull();
    expect(after.duplicateDecisions.size).toBe(0);
  });

  it('changing the account discards the rows, because the account is hashed into every fingerprint', () => {
    const after = wizardReducer(normalizedReadyState(), {
      type: 'account-selected',
      fileId: 'f1',
      accountId: 'account-2',
    });

    expect(file(after).normalized).toBeNull();
    expect(after.duplicateDecisions.size).toBe(0);
  });

  it('changing the statement range discards every file’s rows', () => {
    const after = wizardReducer(normalizedReadyState(), {
      type: 'statement-range-changed',
      start: '2026-04-01',
      end: '2026-04-30',
    });

    expect(after.files.every((draft) => draft.normalized === null)).toBe(true);
    expect(after.duplicateDecisions.size).toBe(0);
  });

  it('renaming a staged account keeps the rows, because its id has not changed', () => {
    let state = readyState();
    state = wizardReducer(state, {
      type: 'new-account-staged',
      account: { id: 'new-1', label: 'Rewards', accountType: 'credit_card' },
      fileId: 'f1',
    });
    state = wizardReducer(state, { type: 'normalize-started', fileId: 'f1', requestId: 'r3' });
    state = wizardReducer(state, {
      type: 'normalize-succeeded',
      fileId: 'f1',
      requestId: 'r3',
      result: normalized(),
    });

    const after = wizardReducer(state, {
      type: 'new-account-updated',
      accountId: 'new-1',
      patch: { label: 'Rewards Card' },
    });

    expect(file(after).normalized).not.toBeNull();
    expect(stagedAccountFor(after, file(after))?.label).toBe('Rewards Card');
  });
});

describe('detection proposes but never overrides the user', () => {
  it('pre-selects an unambiguous detected format', () => {
    let state = readyState();
    state = wizardReducer(state, { type: 'files-cleared' });
    state = wizardReducer(state, {
      type: 'files-added',
      files: [{ id: 'f1', file: fakeFile(), displayName: 'statement.csv' }],
      failures: [],
    });
    state = wizardReducer(state, {
      type: 'date-detected',
      fileId: 'f1',
      detection: {
        candidates: ['us'],
        recommended: 'us',
        ambiguous: false,
        discriminator: '13/01/2026',
        sampleCount: 10,
      },
    });

    expect(file(state).dateFormat).toBe('us');
  });

  it('leaves an ambiguous format unset rather than guessing', () => {
    let state = initialWizardState();
    state = wizardReducer(state, {
      type: 'files-added',
      files: [{ id: 'f1', file: fakeFile(), displayName: 'statement.csv' }],
      failures: [],
    });
    state = wizardReducer(state, {
      type: 'date-detected',
      fileId: 'f1',
      detection: {
        candidates: ['us', 'eu'],
        recommended: 'us',
        ambiguous: true,
        discriminator: null,
        sampleCount: 10,
      },
    });

    // Guessing here would silently misdate every row (data-methodology.md §3.3).
    expect(file(state).dateFormat).toBeNull();
  });

  it('does not overwrite a format the user already chose', () => {
    let state = readyState();
    state = wizardReducer(state, {
      type: 'date-detected',
      fileId: 'f1',
      detection: {
        candidates: ['eu'],
        recommended: 'eu',
        ambiguous: false,
        discriminator: null,
        sampleCount: 10,
      },
    });

    expect(file(state).dateFormat).toBe('iso');
  });
});

describe('mapping validation', () => {
  it('refuses two required fields sharing one column', () => {
    const state = wizardReducer(readyState(), {
      type: 'mapping-changed',
      fileId: 'f1',
      patch: { descriptionColumn: 0 },
    });

    const issues = mappingIssues(state, file(state));
    expect(issues.some((issue) => issue.message.includes('already mapped'))).toBe(true);
  });

  it('reports each missing required field', () => {
    let state = initialWizardState();
    state = wizardReducer(state, {
      type: 'files-added',
      files: [{ id: 'f1', file: fakeFile(), displayName: 'statement.csv' }],
      failures: [],
    });

    const paths = mappingIssues(state, file(state)).map((issue) => issue.path);
    expect(paths).toContain('date');
    expect(paths).toContain('description');
    expect(paths).toContain('amount');
  });

  it('requires both columns in the debit-credit layout', () => {
    const state = wizardReducer(readyState(), {
      type: 'mapping-changed',
      fileId: 'f1',
      patch: { amountModel: 'debit-credit', debitColumn: 2 },
    });

    expect(mappingIssues(state, file(state)).map((issue) => issue.path)).toContain('credit');
  });

  it('builds a valid mapping once every choice is made', () => {
    const state = readyState();
    const mapping = toFileMapping(state, file(state));

    expect(mapping).not.toBeNull();
    expect(mapping?.amount).toEqual({
      kind: 'signed',
      amountColumn: 2,
      negativeMeans: 'debit',
    });
    expect(mapping?.account).toEqual({ kind: 'existing', accountId: 'account-1' });
  });

  it('refuses a statement range that ends before it begins', () => {
    let state = readyState();
    state = wizardReducer(state, {
      type: 'statement-range-changed',
      start: '2026-04-30',
      end: '2026-04-01',
    });

    expect(toFileMapping(state, file(state))).toBeNull();
  });
});

describe('staged accounts', () => {
  it('never reaches the commit list until a file targets it', () => {
    let state = readyState();
    state = wizardReducer(state, {
      type: 'new-account-staged',
      account: { id: 'new-1', label: 'Unused', accountType: 'savings' },
      fileId: null,
    });

    expect(state.newAccounts).toHaveLength(1);
    // Drafted but not chosen: creating it would leave an empty account behind.
    expect(accountsToCreate(state)).toHaveLength(0);
  });

  it('is included once a file points at it', () => {
    let state = readyState();
    state = wizardReducer(state, {
      type: 'new-account-staged',
      account: { id: 'new-1', label: '  Rewards  ', accountType: 'credit_card' },
      fileId: 'f1',
    });

    expect(accountsToCreate(state)).toEqual([
      { id: 'new-1', label: 'Rewards', accountType: 'credit_card' },
    ]);
  });

  it('unassigns files when the staged account is removed', () => {
    let state = readyState();
    state = wizardReducer(state, {
      type: 'new-account-staged',
      account: { id: 'new-1', label: 'Rewards', accountType: 'credit_card' },
      fileId: 'f1',
    });
    state = wizardReducer(state, { type: 'new-account-removed', accountId: 'new-1' });

    expect(file(state).accountId).toBeNull();
    expect(accountsToCreate(state)).toHaveLength(0);
  });
});

describe('advancing between steps', () => {
  it('will not leave the first step with no files', () => {
    expect(canAdvance(initialWizardState(), 'format')).toBe(false);
    expect(blockedReason(initialWizardState(), 'format')).toMatch(/at least one/i);
  });

  it('will not leave the format step while a file is still being read', () => {
    let state = initialWizardState();
    state = wizardReducer(state, {
      type: 'files-added',
      files: [{ id: 'f1', file: fakeFile(), displayName: 'statement.csv' }],
      failures: [],
    });
    state = wizardReducer(state, { type: 'inspect-started', fileId: 'f1', requestId: 'r1' });

    expect(blockedReason(state, 'format')).toMatch(/finish being read/i);
  });

  it('will not leave the mapping step with an incomplete mapping', () => {
    let state = readyState();
    state = wizardReducer(state, {
      type: 'mapping-changed',
      fileId: 'f1',
      patch: { amountColumn: null },
    });

    expect(blockedReason(state, 'confirm')).toMatch(/mapped/i);
  });

  it('will not leave the conventions step without an account', () => {
    const state = wizardReducer(readyState(), {
      type: 'account-selected',
      fileId: 'f1',
      accountId: null,
    });

    expect(blockedReason(state, 'review')).toMatch(/account/i);
  });

  it('will not reach the report before every file is read', () => {
    expect(blockedReason(readyState(), 'report')).toMatch(/every file/i);
  });

  it('allows going backwards at any time', () => {
    const state = wizardReducer(readyState(), { type: 'step-changed', step: 'review' });
    expect(canAdvance(state, 'choose')).toBe(true);
  });
});

describe('committing', () => {
  it('keeps the staged state after a failure so the user can retry', () => {
    let state = readyState();
    state = wizardReducer(state, { type: 'commit-started' });
    state = wizardReducer(state, {
      type: 'commit-failed',
      reason: 'workspace-write-failed',
      message: 'Nothing was changed.',
    });

    expect(state.commit.kind).toBe('failed');
    expect(state.files).toHaveLength(1);
    expect(file(state).accountId).toBe('account-1');
  });

  it('records what was committed', () => {
    const state = wizardReducer(readyState(), {
      type: 'commit-succeeded',
      sessionId: 'session-1',
      committedTransactionCount: 12,
      createdAccountIds: ['new-1'],
      replacedDemoWorkspace: true,
    });

    expect(state.commit).toEqual({
      kind: 'committed',
      sessionId: 'session-1',
      committedTransactionCount: 12,
      createdAccountIds: ['new-1'],
      replacedDemoWorkspace: true,
    });
  });

  it('resetting clears the files but keeps the workspace fingerprints already read', () => {
    let state = readyState();
    state = wizardReducer(state, {
      type: 'existing-fingerprints-loaded',
      fingerprints: new Set(['a'.repeat(64)]),
    });
    state = wizardReducer(state, { type: 'reset' });

    expect(state.files).toHaveLength(0);
    expect(state.step).toBe('choose');
    expect(state.existingFingerprints.size).toBe(1);
  });
});

describe('duplicate decisions', () => {
  it('defaults to keeping, so a missing decision cannot drop a row', () => {
    const state = readyState();
    expect(state.duplicateDecisions.size).toBe(0);
    expect(sessionRows(state)).toHaveLength(0);
  });

  it('records individual and bulk decisions', () => {
    let state = readyState();
    state = wizardReducer(state, {
      type: 'duplicate-decision',
      rowKey: 'a.csv#1',
      decision: 'exclude',
    });
    state = wizardReducer(state, {
      type: 'duplicate-decision-bulk',
      rowKeys: ['b.csv#1', 'b.csv#2'],
      decision: 'exclude',
    });

    expect(state.duplicateDecisions.get('a.csv#1')).toBe('exclude');
    expect(state.duplicateDecisions.size).toBe(3);
  });
});
