import { describe, expect, it } from 'vitest';
import { normalizeFile, type NormalizedFileResult } from '../../../src/import/normalizeFile';
import { detectEncoding, decodeBytes } from '../../../src/import/decode';
import { detectDelimiter, detectHeaderRow, splitLines } from '../../../src/import/detectFormat';
import { MAX_SESSION_ROWS } from '../../../src/import/limits';
import type { FileFormat, FileMapping } from '../../../src/import/mapping';
import {
  COMMA_UTF8,
  debitCreditMapping,
  fixtureBytes,
  signedMapping,
  testSha256,
} from './helpers/fixtures';

const ACCOUNT = 'account-under-test';

async function run(
  fixture: string,
  mapping: FileMapping,
  format: FileFormat = COMMA_UTF8,
  maxRows = MAX_SESSION_ROWS,
): Promise<NormalizedFileResult> {
  const outcome = await normalizeFile({
    fileName: fixture,
    bytes: fixtureBytes(fixture),
    format,
    mapping,
    accountId: ACCOUNT,
    maxRows,
    sha256: testSha256,
  });

  if (!outcome.ok) throw new Error(`normalizeFile failed: ${outcome.failure.code}`);
  return outcome.result;
}

const totalCents = (result: NormalizedFileResult, direction: 'debit' | 'credit') =>
  result.rows.filter((r) => r.direction === direction).reduce((sum, r) => sum + r.amountCents, 0);

describe('01 — signed single-amount column, US dates', () => {
  it('normalizes every row to the documented totals', async () => {
    const result = await run('01-signed-amount-us-dates.csv', signedMapping({ dateFormat: 'us' }));

    expect(result.rowCount).toBe(12);
    expect(result.rows).toHaveLength(12);
    expect(result.rejections).toHaveLength(0);

    // tests/fixtures/README.md: gross outflow $1,244.79, one $1,450.00 credit.
    expect(totalCents(result, 'debit')).toBe(124_479);
    expect(totalCents(result, 'credit')).toBe(145_000);
  });

  it('converts US dates to ISO without timezone drift', async () => {
    const result = await run('01-signed-amount-us-dates.csv', signedMapping({ dateFormat: 'us' }));
    expect(result.rows[0]!.postedDate).toBe('2026-01-02');
    expect(result.rows.at(-1)!.postedDate).toBe('2026-01-31');
  });

  it('numbers rows from 1, excluding the header', async () => {
    const result = await run('01-signed-amount-us-dates.csv', signedMapping({ dateFormat: 'us' }));
    expect(result.rows.map((r) => r.originalRow).slice(0, 3)).toEqual([1, 2, 3]);
  });

  it('honours the confirmed sign convention', async () => {
    const flipped = await run(
      '01-signed-amount-us-dates.csv',
      signedMapping({
        dateFormat: 'us',
        amount: { kind: 'signed', amountColumn: 2, negativeMeans: 'credit' },
      }),
    );
    // Same magnitudes, mirrored directions.
    expect(totalCents(flipped, 'credit')).toBe(124_479);
    expect(totalCents(flipped, 'debit')).toBe(145_000);
  });
});

describe('02 — separate debit and credit columns', () => {
  it('reads direction structurally from which column is populated', async () => {
    const result = await run('02-debit-credit-columns.csv', debitCreditMapping());

    expect(result.rowCount).toBe(10);
    expect(result.rejections).toHaveLength(0);
    expect(totalCents(result, 'debit')).toBe(117_889);
    expect(totalCents(result, 'credit')).toBe(146_999);
  });

  it('ignores an unmapped trailing column rather than guessing at it', async () => {
    const result = await run('02-debit-credit-columns.csv', debitCreditMapping());
    // The fixture's fifth `Type` column (POS/ACH) is never mapped, so it must
    // not leak into any field. Asserting exact descriptions rather than a
    // substring: "PAYROLL DEPOSIT" itself contains "POS".
    expect(result.rows[0]!.descriptionRaw).toBe('PINEBROOK MARKET');
    expect(result.rows[2]!.descriptionRaw).toBe('PAYROLL DEPOSIT NORTHGATE LABS');
    expect(result.rows.every((r) => r.descriptionRaw !== 'POS' && r.descriptionRaw !== 'ACH')).toBe(
      true,
    );
  });
});

describe('03 — US and ISO dates describe the same transactions', () => {
  it('produces identical normalized business fields from both files', async () => {
    const us = await run('03a-dates-us-format.csv', signedMapping({ dateFormat: 'us' }));
    const iso = await run('03b-dates-iso-format.csv', signedMapping({ dateFormat: 'iso' }));

    const business = (r: NormalizedFileResult) =>
      r.rows.map(({ postedDate, amountCents, direction, descriptionCanonical }) => ({
        postedDate,
        amountCents,
        direction,
        descriptionCanonical,
      }));

    expect(business(iso)).toEqual(business(us));
  });

  it('produces identical fingerprints from both files', async () => {
    const us = await run('03a-dates-us-format.csv', signedMapping({ dateFormat: 'us' }));
    const iso = await run('03b-dates-iso-format.csv', signedMapping({ dateFormat: 'iso' }));
    expect(iso.rows.map((r) => r.fingerprint)).toEqual(us.rows.map((r) => r.fingerprint));
  });
});

describe('06 — legitimate identical same-day purchases', () => {
  it('keeps every row and gives each a distinct fingerprint', async () => {
    const result = await run('06-identical-same-day-purchases.csv', signedMapping());

    expect(result.rowCount).toBe(6);
    expect(result.rows).toHaveLength(6);
    expect(totalCents(result, 'debit')).toBe(5_132);

    // Nothing collapsed: six rows, six distinct fingerprints.
    expect(new Set(result.rows.map((r) => r.fingerprint)).size).toBe(6);
  });

  it('assigns occurrence indexes in source order', async () => {
    const result = await run('06-identical-same-day-purchases.csv', signedMapping());
    const coffees = result.rows.filter((r) => r.descriptionCanonical.includes('HARBOR BEAN'));
    const fares = result.rows.filter((r) => r.descriptionCanonical.includes('RIVERLINE'));

    expect(coffees.map((r) => r.occurrenceIndex)).toEqual([0, 1]);
    expect(fares.map((r) => r.occurrenceIndex)).toEqual([0, 1, 2]);
  });
});

describe('determinism', () => {
  it('reprocessing the same fixture reproduces every business field and fingerprint', async () => {
    const first = await run('01-signed-amount-us-dates.csv', signedMapping({ dateFormat: 'us' }));
    const second = await run('01-signed-amount-us-dates.csv', signedMapping({ dateFormat: 'us' }));
    expect(second.rows).toEqual(first.rows);
  });

  it('07a is byte-identical to 01 and therefore fingerprints identically', async () => {
    const original = await run(
      '01-signed-amount-us-dates.csv',
      signedMapping({ dateFormat: 'us' }),
    );
    const copy = await run('07a-reimport-exact-copy.csv', signedMapping({ dateFormat: 'us' }));
    expect(copy.rows.map((r) => r.fingerprint)).toEqual(original.rows.map((r) => r.fingerprint));
  });
});

describe('08a — missing and invalid fields', () => {
  it('accepts 7 and rejects 10, reconciling against the logical row count', async () => {
    const result = await run('08a-missing-and-invalid-fields.csv', signedMapping());

    expect(result.rowCount).toBe(17);
    expect(result.rows).toHaveLength(7);
    expect(result.rejections).toHaveLength(10);
    expect(result.rows.length + result.rejections.length).toBe(result.rowCount);
  });

  it('rejects each row with a specific, value-free reason', async () => {
    const result = await run('08a-missing-and-invalid-fields.csv', signedMapping());
    const codes = result.rejections.map((r) => r.code);

    expect(codes).toContain('date-missing');
    expect(codes).toContain('date-not-a-real-day');
    expect(codes).toContain('amount-missing');
    expect(codes).toContain('amount-not-numeric');
    expect(codes).toContain('amount-too-precise');
    expect(codes).toContain('amount-non-usd-symbol');

    // No rejection message may echo a cell value.
    for (const rejection of result.rejections) {
      expect(rejection.message).not.toMatch(/PINEBROOK|CEDAR GROVE|1,234/);
    }
  });

  it('never converts an invalid amount to zero', async () => {
    const result = await run('08a-missing-and-invalid-fields.csv', signedMapping());
    // Exactly one accepted row is genuinely $0.00 (the fixture's 0.00 row).
    expect(result.rows.filter((r) => r.amountCents === 0)).toHaveLength(1);
  });

  it('flags questionable rows without rejecting them', async () => {
    const result = await run('08a-missing-and-invalid-fields.csv', signedMapping());
    const codes = result.questions.map((q) => q.code);
    expect(codes).toContain('description-empty');
    expect(codes).toContain('description-whitespace-only');
    expect(codes).toContain('amount-zero');
  });

  it('parses quoted commas and embedded newlines as single fields', async () => {
    const result = await run('08a-missing-and-invalid-fields.csv', signedMapping());
    expect(result.rows.some((r) => r.descriptionRaw.includes('MAPLEWAY INSURANCE, AUTO'))).toBe(
      true,
    );
    expect(result.rows.some((r) => r.descriptionRaw.includes('\n'))).toBe(true);
  });
});

describe('09 — formula-like and HTML-like descriptions', () => {
  it('imports every row and leaves hostile text inert', async () => {
    const result = await run('09-formula-and-malicious-descriptions.csv', signedMapping());

    expect(result.rowCount).toBe(15);
    expect(result.rows).toHaveLength(15);
    expect(result.rejections).toHaveLength(0);
    expect(totalCents(result, 'debit')).toBe(25_500);
  });

  it('preserves descriptionRaw exactly, including formula triggers', async () => {
    const result = await run('09-formula-and-malicious-descriptions.csv', signedMapping());
    expect(result.rows.some((r) => r.descriptionRaw === '=1+1')).toBe(true);
    expect(result.rows.some((r) => r.descriptionRaw.startsWith('<script>'))).toBe(true);
  });

  it('keeps a long description intact when it fits under the field cap', async () => {
    const result = await run('09-formula-and-malicious-descriptions.csv', signedMapping());
    // threat-model.md §16 deferred the exact field cap to Phase 3; it is now
    // fixed at MAX_TEXT_FIELD_LENGTH (8192). The fixture's longest description
    // is 5000 characters, so it is stored whole rather than truncated.
    const longest = result.rows.reduce((a, b) =>
      b.descriptionRaw.length > a.descriptionRaw.length ? b : a,
    );
    expect(longest.descriptionRaw).toHaveLength(5000);
    expect(result.questions.some((q) => q.code === 'description-truncated')).toBe(false);
    expect(result.rows.every((r) => r.descriptionRaw.length <= 8192)).toBe(true);
  });

  it('truncates and flags a description that does exceed the cap', async () => {
    // Proves the truncation path itself works, since no frozen fixture reaches
    // the 8192-character cap.
    const oversized = `Date,Description,Amount\n2026-01-02,${'X'.repeat(9000)},-10.00\n`;
    const outcome = await normalizeFile({
      fileName: 'synthetic-overlong.csv',
      bytes: new TextEncoder().encode(oversized),
      format: COMMA_UTF8,
      mapping: signedMapping(),
      accountId: ACCOUNT,
      maxRows: MAX_SESSION_ROWS,
      sha256: testSha256,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.rows[0]!.descriptionRaw).toHaveLength(8192);
    expect(outcome.result.questions.some((q) => q.code === 'description-truncated')).toBe(true);
  });

  it('strips bidi and zero-width characters from the canonical form only', async () => {
    const result = await run('09-formula-and-malicious-descriptions.csv', signedMapping());
    const bidi = result.rows.find((r) => r.descriptionRaw.includes(String.fromCharCode(0x202e)));
    expect(bidi).toBeDefined();
    // Raw keeps the byte for auditability; the canonical form does not.
    expect(bidi!.descriptionCanonical).not.toContain(String.fromCharCode(0x202e));
  });
});

describe('08b — UTF-8 BOM and CRLF', () => {
  it('detects the BOM and keeps it out of the first column name', () => {
    const bytes = fixtureBytes('08b-encoding-bom-crlf.csv');
    const detection = detectEncoding(bytes);
    expect(detection.encoding).toBe('utf-8-bom');
    expect(detection.confidence).toBe('high');

    const decoded = decodeBytes(bytes, 'utf-8-bom', '08b');
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      const header = detectHeaderRow(splitLines(decoded.text), ',');
      expect(header?.columns[0]).toBe('Date');
    }
  });

  it('parses CRLF rows correctly', async () => {
    const result = await run('08b-encoding-bom-crlf.csv', signedMapping(), {
      encoding: 'utf-8-bom',
      delimiter: ',',
      headerLineIndex: 0,
    });
    expect(result.rowCount).toBe(4);
    expect(result.rejections).toHaveLength(0);
    expect(totalCents(result, 'debit')).toBe(10_840);
  });
});

describe('08c — invalid UTF-8', () => {
  it('replaces undecodable bytes, flags the row, and imports it', async () => {
    const bytes = fixtureBytes('08c-invalid-utf8.csv');
    expect(detectEncoding(bytes).encoding).not.toBe('utf-8');

    const result = await run('08c-invalid-utf8.csv', signedMapping(), {
      encoding: 'utf-8',
      delimiter: ',',
      headerLineIndex: 0,
    });

    expect(result.rowCount).toBe(3);
    expect(result.rows).toHaveLength(3);
    expect(result.hadInvalidBytes).toBe(true);
    expect(result.questions.some((q) => q.code === 'text-had-invalid-characters')).toBe(true);
    expect(totalCents(result, 'debit')).toBe(7_500);
  });
});

describe('detection on real fixtures', () => {
  it('detects the comma delimiter with high confidence', () => {
    const text = new TextDecoder().decode(fixtureBytes('01-signed-amount-us-dates.csv'));
    const detection = detectDelimiter(splitLines(text));
    expect(detection.delimiter).toBe(',');
    expect(detection.confidence).toBe('high');
  });

  it('finds the header on the first line of a plain export', () => {
    const text = new TextDecoder().decode(fixtureBytes('02-debit-credit-columns.csv'));
    const header = detectHeaderRow(splitLines(text), ',');
    expect(header?.headerLineIndex).toBe(0);
    expect(header?.columns).toEqual(['Date', 'Description', 'Debit', 'Credit', 'Type']);
  });
});

describe('session row budget', () => {
  it('stops at the remaining budget and reports truncation', async () => {
    const result = await run(
      '01-signed-amount-us-dates.csv',
      signedMapping({ dateFormat: 'us' }),
      COMMA_UTF8,
      5,
    );
    expect(result.rows).toHaveLength(5);
    expect(result.truncated).toBe(true);
  });
});
