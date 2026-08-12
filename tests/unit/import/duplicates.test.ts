import { describe, expect, it } from 'vitest';
import {
  analyzeDuplicates,
  applyDuplicateDecisions,
  type DuplicateDecisions,
} from '../../../src/import/duplicates';
import { buildHealthReport, HealthReportInvariantError } from '../../../src/import/healthReport';
import { normalizeFile, type FingerprintedRow } from '../../../src/import/normalizeFile';
import { MAX_SESSION_ROWS } from '../../../src/import/limits';
import { COMMA_UTF8, fixtureBytes, signedMapping, testSha256 } from './helpers/fixtures';

const ACCOUNT = 'account-under-test';

async function rowsOf(fixture: string, dateFormat: 'us' | 'iso' = 'us') {
  const outcome = await normalizeFile({
    fileName: fixture,
    bytes: fixtureBytes(fixture),
    format: COMMA_UTF8,
    mapping: signedMapping({ dateFormat }),
    accountId: ACCOUNT,
    maxRows: MAX_SESSION_ROWS,
    sha256: testSha256,
  });
  if (!outcome.ok) throw new Error(outcome.failure.code);
  return outcome.result;
}

describe('within one file', () => {
  it('never flags legitimate identical same-day purchases', async () => {
    const file = await rowsOf('06-identical-same-day-purchases.csv', 'iso');

    const analysis = analyzeDuplicates({
      rows: file.rows,
      existingFingerprints: new Set(),
    });

    // The occurrence index makes these distinct by construction (§4.3).
    expect(analysis.candidates).toHaveLength(0);
    expect(file.rows).toHaveLength(6);
  });
});

describe('against the existing workspace', () => {
  it('flags every row of an exact reimport', async () => {
    const first = await rowsOf('01-signed-amount-us-dates.csv');
    const stored = new Set(first.rows.map((r) => r.fingerprint));

    const reimport = await rowsOf('07a-reimport-exact-copy.csv');
    const analysis = analyzeDuplicates({ rows: reimport.rows, existingFingerprints: stored });

    expect(analysis.candidates).toHaveLength(12);
    expect(analysis.candidates.every((c) => c.source === 'existing-workspace')).toBe(true);
  });

  it('flags only the overlap of a partially re-downloaded statement', async () => {
    const first = await rowsOf('01-signed-amount-us-dates.csv');
    const stored = new Set(first.rows.map((r) => r.fingerprint));

    const overlap = await rowsOf('07b-reimport-partial-overlap.csv');
    const analysis = analyzeDuplicates({ rows: overlap.rows, existingFingerprints: stored });

    // 07b repeats 01's last four rows and adds three new ones.
    expect(overlap.rows).toHaveLength(7);
    expect(analysis.candidates).toHaveLength(4);
    expect(analysis.candidates.every((c) => c.source === 'existing-workspace')).toBe(true);
  });
});

describe('across staged files', () => {
  it('flags the later occurrence and keeps the first as new', async () => {
    const a = await rowsOf('01-signed-amount-us-dates.csv');
    const b = await rowsOf('07a-reimport-exact-copy.csv');

    const analysis = analyzeDuplicates({
      rows: [...a.rows, ...b.rows],
      existingFingerprints: new Set(),
    });

    expect(analysis.candidates).toHaveLength(12);
    expect(analysis.candidates.every((c) => c.source === 'staged-session')).toBe(true);
    // Every candidate points back at the row it repeats.
    expect(
      analysis.candidates.every((c) => c.matchedFileName === '01-signed-amount-us-dates.csv'),
    ).toBe(true);
  });

  it('gives each candidate a reason that names no cell value', async () => {
    const a = await rowsOf('01-signed-amount-us-dates.csv');
    const analysis = analyzeDuplicates({
      rows: [...a.rows, ...a.rows],
      existingFingerprints: new Set(),
    });

    for (const candidate of analysis.candidates) {
      expect(candidate.reason.length).toBeGreaterThan(0);
      expect(candidate.reason).not.toMatch(/HARBOR|PINEBROOK|1,?450|OAKMONT/);
    }
  });
});

describe('nothing is removed automatically', () => {
  it('keeps every candidate when no decision is recorded', async () => {
    const file = await rowsOf('01-signed-amount-us-dates.csv');
    const decisions: DuplicateDecisions = new Map();

    const { kept, excluded } = applyDuplicateDecisions(file.rows, decisions);
    expect(kept).toHaveLength(12);
    expect(excluded).toHaveLength(0);
  });

  it('excludes only what the user explicitly marked', async () => {
    const file = await rowsOf('01-signed-amount-us-dates.csv');
    const target = file.rows[0]!.fingerprint;
    const decisions: DuplicateDecisions = new Map([[target, 'exclude']]);

    const { kept, excluded } = applyDuplicateDecisions(file.rows, decisions);
    expect(excluded).toHaveLength(1);
    expect(excluded[0]!.fingerprint).toBe(target);
    expect(kept).toHaveLength(11);
  });
});

/* ------------------------------------------------------------- report - */

function report(
  rowCount: number,
  normalizedRows: readonly FingerprintedRow[],
  excludedRows: readonly FingerprintedRow[] = [],
  extra: Partial<Parameters<typeof buildHealthReport>[0]> = {},
) {
  const input = {
    rowCount,
    normalizedRows,
    excludedRows,
    rejections: [],
    questions: [],
    duplicateCandidates: [],
    warnings: [],
    ...extra,
  };

  // `buildHealthReport` now takes questionable and candidate rows by reference,
  // because a file name plus a row number cannot tell two same-named staged
  // files apart. These fixtures are a single file, where `originalRow` is
  // unique, so resolving by row number here is exact — the production caller
  // resolves inside each staged file's own index for the same reason.
  const rowByNumber = new Map(normalizedRows.map((row) => [row.originalRow, row]));
  const resolve = (items: readonly { originalRow: number }[]): ReadonlySet<FingerprintedRow> => {
    const rows = new Set<FingerprintedRow>();
    for (const item of items) {
      const row = rowByNumber.get(item.originalRow);
      if (row) rows.add(row);
    }
    return rows;
  };

  return buildHealthReport({
    ...input,
    questionableRows: resolve(input.questions),
    candidateRows: resolve(input.duplicateCandidates),
  });
}

describe('Health Report invariants', () => {
  it('reconciles rowCount against accepted plus rejected', async () => {
    const file = await rowsOf('08a-missing-and-invalid-fields.csv', 'iso');
    const built = report(file.rowCount, file.rows, [], { rejections: file.rejections });

    expect(built.rowCount).toBe(17);
    expect(built.acceptedCount).toBe(7);
    expect(built.rejectedCount).toBe(10);
    expect(built.acceptedCount + built.rejectedCount).toBe(built.rowCount);
  });

  it('separates an invalid row from a row the user chose to exclude', async () => {
    const file = await rowsOf('01-signed-amount-us-dates.csv');
    const target = file.rows[0]!;

    // A row can only be excluded if it was offered as a candidate first, so the
    // candidate has to be present for the report to be coherent.
    const built = report(file.rowCount, file.rows, [target], {
      duplicateCandidates: [
        {
          fingerprint: target.fingerprint,
          fileName: target.fileName,
          originalRow: target.originalRow,
          source: 'existing-workspace',
          reason: 'Already in your workspace.',
        },
      ],
    });

    expect(built.invalidCount).toBe(0);
    expect(built.excludedDuplicateCount).toBe(1);
    expect(built.duplicateCandidateCount).toBe(1);
    expect(built.rejectedCount).toBe(1);
    expect(built.acceptedCount).toBe(11);
  });

  it('refuses a report claiming more exclusions than candidates', async () => {
    const file = await rowsOf('01-signed-amount-us-dates.csv');
    // Excluding a row that was never flagged is incoherent and must not pass.
    expect(() => report(file.rowCount, file.rows, [file.rows[0]!])).toThrow(
      HealthReportInvariantError,
    );
  });

  it('counts questionable rows as overlapping accepted, not competing with it', async () => {
    const file = await rowsOf('08a-missing-and-invalid-fields.csv', 'iso');
    const built = report(file.rowCount, file.rows, [], {
      rejections: file.rejections,
      questions: file.questions,
    });

    expect(built.questionableCount).toBeGreaterThan(0);
    expect(built.questionableCount).toBeLessThanOrEqual(built.acceptedCount);
    // Questionable rows are still part of acceptedCount.
    expect(built.acceptedCount + built.rejectedCount).toBe(built.rowCount);
  });

  it('reports every accepted row as uncategorized in Phase 3', async () => {
    const file = await rowsOf('01-signed-amount-us-dates.csv');
    const built = report(file.rowCount, file.rows);
    expect(built.uncategorizedCount).toBe(built.acceptedCount);
  });

  it('rejects a report whose counts do not add up', () => {
    expect(() =>
      // rowCount claims 100 but nothing was accepted or rejected.
      report(100, []),
    ).toThrow(HealthReportInvariantError);
  });

  it('bounds the preview while preserving full counts', async () => {
    const file = await rowsOf('01-signed-amount-us-dates.csv');
    const many = Array.from({ length: 500 }, (_, i) => ({
      ...file.rows[0]!,
      originalRow: i + 1,
      fingerprint: `fp-${i}`,
    }));

    const built = report(500, many);
    expect(built.acceptedCount).toBe(500);
    expect(built.previewRows.length).toBeLessThanOrEqual(50);
    expect(built.truncatedReporting).toBe(true);
  });

  it('renders preview descriptions display-safe', async () => {
    const file = await rowsOf('09-formula-and-malicious-descriptions.csv', 'iso');
    const built = report(file.rowCount, file.rows);

    for (const row of built.previewRows) {
      expect(row.description).not.toContain(String.fromCharCode(0x202e));
      expect(row.description).not.toContain('\n');
    }
  });
});
