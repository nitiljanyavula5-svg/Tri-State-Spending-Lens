import { describe, expect, it } from 'vitest';
import {
  MERCHANT_ALIAS_VERSION,
  MAX_MERCHANT_LENGTH,
  normalizeMerchant,
  normalizeUserMerchant,
} from '../../../src/classification/merchants';

/**
 * Conservative merchant normalization.
 *
 * The binding constraint is category-rules.md §6.2 — normalization must not
 * guess. Most of these tests therefore assert what the module *refuses* to do,
 * because the failure mode that matters is two different businesses being
 * silently merged into one line of a spending total.
 */

const merchantOf = (raw: string) => normalizeMerchant(raw).merchant;

describe('deterministic cleanup', () => {
  it('trims, collapses whitespace, and uppercases', () => {
    expect(merchantOf('   pinebrook    market  ')).toBe('PINEBROOK MARKET');
    expect(merchantOf('Harbor\tBean\nCoffee')).toBe('HARBOR BEAN COFFEE');
  });

  it('produces the same answer every time', () => {
    const input = 'SQ *HARBOR BEAN COFFEE 03/14';
    const first = normalizeMerchant(input);
    const second = normalizeMerchant(input);
    expect(first).toEqual(second);
  });

  it('is idempotent — feeding the output back changes nothing', () => {
    const samples = [
      'SQ *GREEN HOUSE',
      'POS DEBIT WHOLEFDS MKT 10012',
      'AMZN MKTP US*2M4TR',
      '   spaced   out   name   ',
      'TST* NOODLE POINT KITCHEN 03/14',
      'CHECKCARD PURCHASE EASTGATE FUEL STOP',
    ];

    for (const sample of samples) {
      const once = merchantOf(sample);
      const twice = merchantOf(once);
      // An idempotence failure would make a merchant drift every time
      // classification re-ran, quietly splitting one merchant into several.
      expect(twice).toBe(once);
    }
  });

  it('reports the alias version it was derived under', () => {
    expect(normalizeMerchant('PINEBROOK MARKET').aliasVersion).toBe(MERCHANT_ALIAS_VERSION);
  });

  it('bounds the result', () => {
    expect(merchantOf('X'.repeat(5_000))).toHaveLength(MAX_MERCHANT_LENGTH);
  });

  it('returns an empty merchant rather than inventing one', () => {
    expect(merchantOf('   ')).toBe('');
    expect(merchantOf('')).toBe('');
  });
});

describe('card-network prefixes', () => {
  it('removes a documented prefix', () => {
    expect(merchantOf('SQ *HARBOR BEAN COFFEE')).toBe('HARBOR BEAN COFFEE');
    expect(merchantOf('TST* NOODLE POINT')).toBe('NOODLE POINT');
    expect(merchantOf('POS DEBIT EASTGATE FUEL')).toBe('EASTGATE FUEL');
    expect(merchantOf('CHECKCARD BAYSIDE DELI')).toBe('BAYSIDE DELI');
  });

  it('removes at most one, so a merchant whose name starts with a prefix survives', () => {
    // Chaining removals would turn this into `COFFEE`, which is a guess about a
    // business genuinely called "POS COFFEE".
    expect(merchantOf('POS POS COFFEE')).toBe('POS COFFEE');
  });

  it('never strips a prefix down to nothing', () => {
    expect(merchantOf('POS')).toBe('POS');
    expect(merchantOf('SQ *')).toBe('SQ *');
  });
});

describe('the non-merging rule', () => {
  it('keeps the example category-rules.md §6.2 names explicitly', () => {
    const a = merchantOf('SQ *GREEN HOUSE');
    const b = merchantOf('GREEN HOUSE RENTALS');

    expect(a).toBe('GREEN HOUSE');
    expect(b).toBe('GREEN HOUSE RENTALS');
    // The whole point: shared words are not evidence of a shared merchant.
    expect(a).not.toBe(b);
  });

  it('keeps merchants that merely share a word distinct', () => {
    const pairs: ReadonlyArray<readonly [string, string]> = [
      ['CEDAR GROVE PHARMACY', 'CEDAR GROVE DINER'],
      ['ATLAS FITNESS CLUB', 'ATLAS AUTO REPAIR'],
      ['HARBOR BEAN COFFEE', 'HARBOR FREIGHT'],
      ['QUILL AND PAGE BOOKS', 'PAGE ONE MEDIA'],
    ];

    for (const [left, right] of pairs) {
      expect(merchantOf(left)).not.toBe(merchantOf(right));
    }
  });

  it('does not strip store numbers from merchants outside a reviewed family', () => {
    // A blanket number-stripping regex is exactly what §6.2 forbids.
    expect(merchantOf('PINEBROOK MARKET #114')).toBe('PINEBROOK MARKET #114');
    expect(merchantOf('BAYSIDE DELI 42')).toBe('BAYSIDE DELI 42');
  });
});

describe('reviewed aliases', () => {
  it('maps exact aliases to one merchant', () => {
    expect(merchantOf('AMZN MKTP US')).toBe('AMAZON');
    expect(merchantOf('AMAZON.COM')).toBe('AMAZON');
    expect(merchantOf('WM SUPERCENTER')).toBe('WALMART');
  });

  it('applies a reviewed prefix family, store number and all', () => {
    expect(merchantOf('WHOLEFDS MKT 10012')).toBe('WHOLE FOODS');
    expect(merchantOf('SHOPRITE #421')).toBe('SHOPRITE');
    expect(merchantOf('WALGREENS #8891')).toBe('WALGREENS');
  });

  it('applies an alias after removing a network prefix', () => {
    expect(merchantOf('POS DEBIT WHOLEFDS MKT 10012')).toBe('WHOLE FOODS');
  });

  it('reports where the merchant came from', () => {
    expect(normalizeMerchant('AMZN MKTP US').source).toBe('alias');
    expect(normalizeMerchant('SQ *HARBOR BEAN').source).toBe('prefix-stripped');
    expect(normalizeMerchant('PINEBROOK MARKET').source).toBe('canonical');
  });
});

describe('unicode and punctuation', () => {
  it('strips control, zero-width, and bidi characters', () => {
    const withBidi = `PINEBROOK${String.fromCharCode(0x202e)} MARKET`;
    expect(merchantOf(withBidi)).toBe('PINEBROOK MARKET');

    const withZeroWidth = `HARBOR${String.fromCharCode(0x200b)}BEAN`;
    expect(merchantOf(withZeroWidth)).toBe('HARBORBEAN');
  });

  it('keeps punctuation that is part of a name', () => {
    expect(merchantOf("o'malley & sons")).toBe("O'MALLEY & SONS");
    expect(merchantOf('e-zpass nj')).toBe('E-ZPASS NJ');
  });

  it('keeps accented characters rather than transliterating them', () => {
    // Guessing at a transliteration would merge two genuinely different names.
    expect(merchantOf('café rouge')).toBe('CAFÉ ROUGE');
  });
});

describe('a merchant the user typed', () => {
  it('is bounded and canonicalized the same way', () => {
    expect(normalizeUserMerchant('  my   corner shop ')).toBe('MY CORNER SHOP');
    expect(normalizeUserMerchant('x'.repeat(500))).toHaveLength(MAX_MERCHANT_LENGTH);
  });
});
