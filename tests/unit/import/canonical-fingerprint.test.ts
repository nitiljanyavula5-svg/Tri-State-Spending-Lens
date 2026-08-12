import { describe, expect, it } from 'vitest';
import {
  canonicalizeText,
  hasReplacementCharacters,
  sanitizeForDisplay,
} from '../../../src/import/canonical';
import {
  assignOccurrenceIndexes,
  computeFingerprint,
  FINGERPRINT_VERSION,
  fingerprintCanonicalString,
  isValidFingerprint,
  occurrenceGroupKey,
  type FingerprintInput,
} from '../../../src/import/fingerprint';

const ch = (code: number) => String.fromCharCode(code);

describe('canonicalizeText', () => {
  it('trims, collapses whitespace, and uppercases', () => {
    expect(canonicalizeText('  harbor   bean  coffee  ')).toBe('HARBOR BEAN COFFEE');
  });

  it('turns a tab between words into a space rather than joining them', () => {
    expect(canonicalizeText(`ALPHA${ch(0x09)}BETA`)).toBe('ALPHA BETA');
  });

  it('removes zero-width and bidi characters that could misrepresent a row', () => {
    expect(canonicalizeText(`ZERO${ch(0x200b)}WIDTH`)).toBe('ZEROWIDTH');
    expect(canonicalizeText(`EXAMPLE${ch(0x202e)}MERCHANT`)).toBe('EXAMPLEMERCHANT');
    expect(canonicalizeText(`ISO${ch(0x2066)}LATE`)).toBe('ISOLATE');
  });

  it('removes control characters', () => {
    expect(canonicalizeText(`A${ch(0x00)}B${ch(0x1f)}C${ch(0x7f)}D`)).toBe('ABCD');
  });

  it('does no merchant cleanup — that is Phase 4 work', () => {
    // Two merchants that share words must stay distinct (category-rules.md §6.2).
    expect(canonicalizeText('SQ *GREEN HOUSE')).toBe('SQ *GREEN HOUSE');
    expect(canonicalizeText('GREEN HOUSE RENTALS')).toBe('GREEN HOUSE RENTALS');
    expect(canonicalizeText('SQ *GREEN HOUSE')).not.toBe(canonicalizeText('GREEN HOUSE RENTALS'));
  });

  it('leaves formula-like text intact as inert data', () => {
    expect(canonicalizeText('=1+1')).toBe('=1+1');
    expect(canonicalizeText("=cmd|' /C calc'!A1")).toBe("=CMD|' /C CALC'!A1");
  });

  it('is idempotent', () => {
    const once = canonicalizeText('  Mixed   Case\tHere  ');
    expect(canonicalizeText(once)).toBe(once);
  });
});

describe('sanitizeForDisplay', () => {
  it('keeps case but removes hostile characters', () => {
    expect(sanitizeForDisplay(`Harbor${ch(0x202e)} Bean`)).toBe('Harbor Bean');
  });

  it('flattens embedded newlines so a row cannot break the layout', () => {
    expect(sanitizeForDisplay('OAKMONT RENTALS\nRENT NOTICE')).toBe('OAKMONT RENTALS RENT NOTICE');
  });

  it('does not HTML-escape, because nothing renders these as markup', () => {
    expect(sanitizeForDisplay('<script>alert(1)</script>')).toBe('<script>alert(1)</script>');
  });
});

describe('hasReplacementCharacters', () => {
  it('detects undecodable bytes', () => {
    expect(hasReplacementCharacters(`CAF${ch(0xfffd)} BAYSIDE`)).toBe(true);
    expect(hasReplacementCharacters('CAFE BAYSIDE')).toBe(false);
  });
});

const BASE: FingerprintInput = {
  accountId: 'account-1',
  postedDate: '2026-01-08',
  direction: 'debit',
  amountCents: 475,
  descriptionCanonical: 'HARBOR BEAN COFFEE #114',
  occurrenceIndex: 0,
};

describe('fingerprint canonical string', () => {
  it('is version-pinned', () => {
    expect(fingerprintCanonicalString(BASE)).toContain(FINGERPRINT_VERSION);
  });

  it('length-prefixes fields so a description cannot shift the boundaries', () => {
    // Without length prefixes these two rows would serialize identically.
    const a = fingerprintCanonicalString({ ...BASE, descriptionCanonical: 'AB', accountId: 'C' });
    const b = fingerprintCanonicalString({ ...BASE, descriptionCanonical: 'A', accountId: 'BC' });
    expect(a).not.toBe(b);
  });

  it('is unaffected by a description containing separator-like characters', () => {
    const withSeparators = fingerprintCanonicalString({
      ...BASE,
      descriptionCanonical: '3:ABC|1:X',
    });
    expect(withSeparators).not.toBe(fingerprintCanonicalString(BASE));
  });

  it.each([
    ['accountId', { accountId: 'account-2' }],
    ['postedDate', { postedDate: '2026-01-09' }],
    ['direction', { direction: 'credit' as const }],
    ['amountCents', { amountCents: 476 }],
    ['descriptionCanonical', { descriptionCanonical: 'OTHER' }],
    ['occurrenceIndex', { occurrenceIndex: 1 }],
  ])('changes when %s changes', (_label, patch) => {
    expect(fingerprintCanonicalString({ ...BASE, ...patch })).not.toBe(
      fingerprintCanonicalString(BASE),
    );
  });
});

describe('computeFingerprint', () => {
  it('produces 64 lowercase hex characters', async () => {
    const digest = await computeFingerprint(BASE);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(isValidFingerprint(digest)).toBe(true);
  });

  it('is deterministic for identical input', async () => {
    expect(await computeFingerprint(BASE)).toBe(await computeFingerprint(BASE));
  });

  it('differs for a different occurrence of an otherwise identical row', async () => {
    const first = await computeFingerprint({ ...BASE, occurrenceIndex: 0 });
    const second = await computeFingerprint({ ...BASE, occurrenceIndex: 1 });
    expect(first).not.toBe(second);
  });

  it('accepts an injected digest so tests stay independent of Web Crypto', async () => {
    const stub = async (input: string) => `stub:${input.length}`;
    expect(await computeFingerprint(BASE, stub)).toBe(
      `stub:${fingerprintCanonicalString(BASE).length}`,
    );
  });
});

describe('occurrence indexes', () => {
  const key = (row: Omit<FingerprintInput, 'occurrenceIndex'>) => occurrenceGroupKey(row);

  it('numbers identical rows in source order so neither can absorb the other', () => {
    const rows = [
      { ...BASE, occurrenceIndex: 0 },
      { ...BASE, occurrenceIndex: 0 },
      { ...BASE, occurrenceIndex: 0 },
    ];
    expect(assignOccurrenceIndexes(rows, key)).toEqual([0, 1, 2]);
  });

  it('numbers distinct rows independently', () => {
    const rows = [
      { ...BASE },
      { ...BASE, amountCents: 290 },
      { ...BASE },
      { ...BASE, amountCents: 290 },
    ];
    expect(assignOccurrenceIndexes(rows, key)).toEqual([0, 0, 1, 1]);
  });

  it('is stable: the same file always yields the same assignment', () => {
    const rows = [{ ...BASE }, { ...BASE }, { ...BASE, postedDate: '2026-01-09' }];
    expect(assignOccurrenceIndexes(rows, key)).toEqual(assignOccurrenceIndexes(rows, key));
  });

  it('lets a reimported file reproduce exactly the same fingerprints', async () => {
    const rows = [{ ...BASE }, { ...BASE }];
    const indexes = assignOccurrenceIndexes(rows, key);
    const first = await Promise.all(
      rows.map((row, i) => computeFingerprint({ ...row, occurrenceIndex: indexes[i]! })),
    );

    const reimportIndexes = assignOccurrenceIndexes(rows, key);
    const second = await Promise.all(
      rows.map((row, i) => computeFingerprint({ ...row, occurrenceIndex: reimportIndexes[i]! })),
    );

    expect(second).toEqual(first);
    // ...and the two same-day purchases remain distinguishable from each other.
    expect(first[0]).not.toBe(first[1]);
  });
});
