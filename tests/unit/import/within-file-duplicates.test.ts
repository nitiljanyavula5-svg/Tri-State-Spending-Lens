import { describe, expect, it } from 'vitest';
import { analyzeDuplicates, analyzeWithinFileDuplicates } from '../../../src/import/duplicates';
import { normalizeFile } from '../../../src/import/normalizeFile';
import { MAX_SESSION_ROWS } from '../../../src/import/limits';
import { COMMA_UTF8, fixtureBytes, signedMapping, testSha256 } from './helpers/fixtures';

/**
 * Within-file duplicate candidates.
 *
 * The persisted fingerprint contract and the suggestion mechanism pull in
 * opposite directions here, and both have to hold at once:
 *
 *  - Two identical rows in one file must keep **distinct fingerprints**, so
 *    neither can absorb the other in storage (§4.3).
 *  - The second one must still be **offered** as a candidate, because a user
 *    re-exporting a statement wants to see it.
 *
 * These tests pin both halves, so a future change that satisfies one by
 * breaking the other fails here.
 */

const ACCOUNT = 'account-under-test';

async function rowsOf(fixture: string, dateFormat: 'us' | 'iso' = 'iso') {
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

describe('the persisted fingerprint contract is unchanged', () => {
  it('gives identical same-day purchases distinct fingerprints', async () => {
    const file = await rowsOf('06-identical-same-day-purchases.csv');

    expect(file.rows).toHaveLength(6);
    // Six rows, six fingerprints: the occurrence index keeps them distinct so
    // neither of two real coffees can absorb the other.
    expect(new Set(file.rows.map((row) => row.fingerprint)).size).toBe(6);
  });

  it('still nominates none of them by fingerprint', async () => {
    const file = await rowsOf('06-identical-same-day-purchases.csv');

    // The accepted behaviour of `analyzeDuplicates`, unchanged: it cannot see
    // within-file repeats, which is why a second mechanism exists.
    expect(
      analyzeDuplicates({ rows: file.rows, existingFingerprints: new Set() }).candidates,
    ).toHaveLength(0);
  });
});

describe('the within-file mechanism', () => {
  it('flags the second and later repeats, never the first', async () => {
    const file = await rowsOf('06-identical-same-day-purchases.csv');
    const { candidates } = analyzeWithinFileDuplicates(file.rows);

    // Two coffees -> one candidate; three fares -> two candidates; the lone
    // market row -> none.
    expect(candidates).toHaveLength(3);
    expect(candidates.every((candidate) => candidate.source === 'within-file')).toBe(true);

    // Rows 2, 4, and 5 are the repeats. Rows 1, 3, and 6 are the keepers.
    expect(candidates.map((candidate) => candidate.originalRow).sort((a, b) => a - b)).toEqual([
      2, 4, 5,
    ]);
  });

  it('points every candidate back at the first sighting it repeats', async () => {
    const file = await rowsOf('06-identical-same-day-purchases.csv');
    const { candidates } = analyzeWithinFileDuplicates(file.rows);

    const byRow = new Map(candidates.map((candidate) => [candidate.originalRow, candidate]));
    expect(byRow.get(2)?.matchedOriginalRow).toBe(1);
    // Both transit repeats point at the first fare, not at each other.
    expect(byRow.get(4)?.matchedOriginalRow).toBe(3);
    expect(byRow.get(5)?.matchedOriginalRow).toBe(3);
  });

  it('keeps each candidate’s own fingerprint, so a decision names one row', async () => {
    const file = await rowsOf('06-identical-same-day-purchases.csv');
    const { candidates } = analyzeWithinFileDuplicates(file.rows);

    const rowsByNumber = new Map(file.rows.map((row) => [row.originalRow, row]));
    for (const candidate of candidates) {
      expect(candidate.fingerprint).toBe(rowsByNumber.get(candidate.originalRow)?.fingerprint);
    }
    // Three candidates, three distinct fingerprints — none aliases another.
    expect(new Set(candidates.map((candidate) => candidate.fingerprint)).size).toBe(3);
  });

  it('gives a reason that names no cell value and claims no proof', async () => {
    const file = await rowsOf('06-identical-same-day-purchases.csv');
    const { candidates } = analyzeWithinFileDuplicates(file.rows);

    for (const candidate of candidates) {
      expect(candidate.reason).not.toMatch(/HARBOR|RIVERLINE|PINEBROOK|4\.75|2\.90/);
      // A suggestion, stated as one.
      expect(candidate.reason).toMatch(/can look like this|nothing is removed/i);
    }
  });

  it('finds nothing in a file with no repeats', async () => {
    const file = await rowsOf('01-signed-amount-us-dates.csv', 'us');
    expect(analyzeWithinFileDuplicates(file.rows).candidates).toHaveLength(0);
  });

  it('removes nothing on its own', async () => {
    const file = await rowsOf('06-identical-same-day-purchases.csv');
    const before = file.rows.length;

    analyzeWithinFileDuplicates(file.rows);

    // Analysis is a read. Every row is still there for the user to decide on.
    expect(file.rows).toHaveLength(before);
  });
});
