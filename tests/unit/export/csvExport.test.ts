import { describe, expect, it, vi } from 'vitest';
import {
  browserDownloadPorts,
  buildCleanedCsv,
  buildCsvExport,
  cleanedCsvFilename,
  CSV_COLUMNS,
  downloadCsv,
  formatAmount,
  neutralizeCell,
  quoteCsvField,
} from '../../../src/export/csvExport';
import type { Account, Transaction } from '../../../src/types/domain';

/**
 * The cleaned CSV export.
 *
 * These assert the produced text, not that a function was called. A formula
 * defense that is never checked against the actual bytes is a defense nobody
 * knows is working.
 */

const ACCOUNTS: readonly Account[] = [
  {
    id: 'checking',
    label: 'Everyday Checking',
    type: 'checking',
    currency: 'USD',
    archived: false,
  },
];

function transaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 'txn-1',
    fingerprint: '0'.repeat(64),
    importSessionId: 'session-1',
    originalRow: 1,
    accountId: 'checking',
    postedDate: '2026-04-08',
    descriptionRaw: 'PINEBROOK MARKET',
    merchantNormalized: 'PINEBROOK MARKET',
    amountCents: 1234,
    direction: 'debit',
    kind: 'purchase',
    categoryId: 'groceries',
    categorySource: 'user',
    classificationConfidence: 'high',
    tags: [],
    excludedFromSpending: false,
    createdAt: '2026-08-01T12:00:00.000Z',
    updatedAt: '2026-08-01T12:00:00.000Z',
    ...overrides,
  };
}

const csvOf = (...rows: Transaction[]) =>
  buildCleanedCsv({ transactions: rows, accounts: ACCOUNTS });

/** The data rows, header stripped. */
const dataRows = (csv: string) => csv.trimEnd().split('\r\n').slice(1);

describe('exact amounts', () => {
  it('converts integer cents without floating-point division', () => {
    expect(formatAmount(1234, 'debit')).toBe('-12.34');
    expect(formatAmount(1234, 'credit')).toBe('12.34');
    expect(formatAmount(5, 'debit')).toBe('-0.05');
    expect(formatAmount(100, 'credit')).toBe('1.00');
    expect(formatAmount(0, 'debit')).toBe('-0.00');
  });

  it('keeps cents exact for values a float would round', () => {
    // 0.1 + 0.2 territory: these are the values that expose float division.
    expect(formatAmount(1_010, 'debit')).toBe('-10.10');
    expect(formatAmount(2_029, 'debit')).toBe('-20.29');
    expect(formatAmount(999_999_999, 'credit')).toBe('9999999.99');
  });

  it('writes the amount into the CSV unmodified', () => {
    const csv = csvOf(transaction({ amountCents: 1234, direction: 'debit' }));
    expect(dataRows(csv)[0]).toContain('-12.34');
    // An app-generated negative number must not be prefixed as if it were a
    // formula, which would make it text in every spreadsheet.
    expect(dataRows(csv)[0]).not.toContain("'-12.34");
  });
});

describe('formula-injection defense', () => {
  const triggers: ReadonlyArray<{ name: string; value: string }> = [
    { name: 'equals', value: '=1+1' },
    { name: 'plus', value: '+1+1' },
    { name: 'minus', value: '-1+1' },
    { name: 'at', value: '@SUM(A1)' },
    { name: 'tab', value: '\tSUM(A1)' },
    { name: 'carriage return', value: '\r=1+1' },
    { name: 'line feed', value: '\n=1+1' },
  ];

  it.each(triggers)('neutralizes a leading $name', ({ value }) => {
    expect(neutralizeCell(value).startsWith("'")).toBe(true);
  });

  it.each(triggers)('neutralizes a leading $name after whitespace', ({ value }) => {
    // A spreadsheet trims before deciding, so leading spaces do not protect.
    expect(neutralizeCell(`   ${value}`).startsWith("'")).toBe(true);
  });

  it('leaves ordinary text alone', () => {
    expect(neutralizeCell('PINEBROOK MARKET')).toBe('PINEBROOK MARKET');
    expect(neutralizeCell('Split 50/50')).toBe('Split 50/50');
    expect(neutralizeCell('')).toBe('');
    expect(neutralizeCell('   ')).toBe('   ');
  });

  it('defends every user-controlled column in the produced CSV', () => {
    const csv = csvOf(
      transaction({
        descriptionRaw: '=cmd|calc',
        merchantNormalized: '@SUM(1)',
        note: '   -1+1',
        tags: ['+EVIL'],
      }),
    );

    const row = dataRows(csv)[0]!;
    expect(row).toContain("'=cmd|calc");
    expect(row).toContain("'@SUM(1)");
    expect(row).toContain("'   -1+1");
    expect(row).toContain("'+EVIL");
  });

  it('defends a hostile account label', () => {
    const csv = buildCleanedCsv({
      transactions: [transaction()],
      accounts: [{ ...ACCOUNTS[0]!, label: '=HYPERLINK("http://x")' }],
    });
    expect(dataRows(csv)[0]).toContain("'=HYPERLINK");
  });
});

describe('RFC-compatible escaping', () => {
  it('quotes fields containing a comma, a quote, or a line break', () => {
    expect(quoteCsvField('plain')).toBe('plain');
    expect(quoteCsvField('a,b')).toBe('"a,b"');
    expect(quoteCsvField('say "hi"')).toBe('"say ""hi"""');
    expect(quoteCsvField('line\nbreak')).toBe('"line\nbreak"');
  });

  it('escapes a description containing quotes and commas', () => {
    const csv = csvOf(transaction({ descriptionRaw: 'PINEBROOK, "THE" MARKET' }));
    expect(dataRows(csv)[0]).toContain('"PINEBROOK, ""THE"" MARKET"');
  });

  it('keeps the neutralizing apostrophe inside the quoted field', () => {
    const csv = csvOf(transaction({ descriptionRaw: '=A1,B2' }));
    expect(dataRows(csv)[0]).toContain('"\'=A1,B2"');
  });

  it('produces one header row with the fixed column order', () => {
    const csv = csvOf(transaction());
    expect(csv.split('\r\n')[0]).toBe(CSV_COLUMNS.join(','));
  });
});

describe('deterministic output', () => {
  it('orders rows by posting date then id, whatever order they arrive in', () => {
    const rows = [
      transaction({ id: 'c', postedDate: '2026-04-09' }),
      transaction({ id: 'b', postedDate: '2026-04-08' }),
      transaction({ id: 'a', postedDate: '2026-04-08' }),
    ];

    const forward = csvOf(...rows);
    const reversed = csvOf(...[...rows].reverse());

    expect(forward).toBe(reversed);
    expect(dataRows(forward)).toHaveLength(3);
  });

  it('renders the same input to the same bytes twice', () => {
    const rows = [transaction({ id: 'a' }), transaction({ id: 'b' })];
    expect(csvOf(...rows)).toBe(csvOf(...rows));
  });

  it('includes excluded transactions and says how they are treated', () => {
    const csv = csvOf(
      transaction({ id: 'a', excludedFromSpending: true, exclusionReason: 'You excluded this.' }),
      transaction({ id: 'b', kind: 'transfer' }),
    );

    expect(csv).toContain('You excluded this.');
    expect(csv).toContain('Not spending');
    expect(csv).toContain('You excluded this');
  });
});

describe('the export result', () => {
  it('reports the row count and a filename with no personal value', () => {
    const result = buildCsvExport(
      { transactions: [transaction()], accounts: ACCOUNTS },
      '2026-08-02T09:00:00.000Z',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rowCount).toBe(1);
    expect(result.filename).toBe('tri-state-spending-lens-transactions-2026-08-02.csv');
    // Nothing about the user is in the name a shared folder will display.
    expect(result.filename).not.toMatch(/PINEBROOK|Everyday|Checking|groceries/i);
  });

  it('refuses an empty export rather than producing a header-only file', () => {
    const result = buildCsvExport(
      { transactions: [], accounts: ACCOUNTS },
      '2026-08-02T09:00:00.000Z',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('nothing-to-export');
  });

  it('falls back to a safe filename for a malformed timestamp', () => {
    expect(cleanedCsvFilename('not-a-date')).toBe(
      'tri-state-spending-lens-transactions-export.csv',
    );
  });
});

describe('a large export stays bounded and correct', () => {
  it('renders 20,000 rows with one line each', () => {
    const rows = Array.from({ length: 20_000 }, (_, index) =>
      transaction({
        id: `txn-${String(index).padStart(6, '0')}`,
        amountCents: index + 1,
      }),
    );

    const csv = csvOf(...rows);
    // One header plus one line per row, and a trailing CRLF.
    expect(dataRows(csv)).toHaveLength(20_000);
    expect(csv.endsWith('\r\n')).toBe(true);
  });
});

describe('downloading', () => {
  it('revokes the object URL even when the click throws', () => {
    const revokeObjectURL = vi.fn();
    const ports = {
      createObjectURL: vi.fn(() => 'blob:fake'),
      revokeObjectURL,
      click: vi.fn(() => {
        throw new Error('click failed');
      }),
    };

    expect(() => downloadCsv('a,b\r\n', 'x.csv', ports)).toThrow();
    // A leaked blob URL keeps every exported transaction alive in memory.
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake');
  });

  it('revokes the object URL on the happy path', () => {
    const ports = {
      createObjectURL: vi.fn(() => 'blob:fake'),
      revokeObjectURL: vi.fn(),
      click: vi.fn(),
    };

    downloadCsv('a,b\r\n', 'x.csv', ports);

    expect(ports.click).toHaveBeenCalledWith('blob:fake', 'x.csv');
    expect(ports.revokeObjectURL).toHaveBeenCalledWith('blob:fake');
  });

  it('exposes browser ports without invoking them at module load', () => {
    // Constructing the ports must not itself touch the DOM.
    expect(typeof browserDownloadPorts().createObjectURL).toBe('function');
  });
});
