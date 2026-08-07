import { MAX_AMOUNT_CENTS } from './limits';
import type { RejectionCode } from './errors';

/**
 * Exact decimal-string → integer-cents parsing.
 *
 * data-methodology.md §3.4 and calculation-contract.md §1 rule 4: money is
 * always integer cents and is never carried through floating point. That is not
 * a style preference — `parseFloat('0.07') * 100` is `7.000000000000001`, and
 * rounding that back is a coin-flip on values a bank actually emits. So this
 * module never calls `parseFloat`, `Number()`, or multiplies by 100. It reads
 * the digit characters and assembles cents directly.
 *
 * Rejection, never coercion: an amount that cannot be read exactly is refused,
 * because a wrong number in a financial total is worse than a missing row
 * (threat-model.md §7).
 */

export interface ParsedAmount {
  /** Unsigned magnitude in integer cents. */
  readonly cents: number;
  /** True when the source text carried a negative sign or accounting parentheses. */
  readonly negative: boolean;
}

export type AmountParseResult =
  | { readonly ok: true; readonly value: ParsedAmount }
  | { readonly ok: false; readonly code: RejectionCode };

/** Currency symbols a US bank export may carry. Anything else is refused. */
const USD_SYMBOL = '$';
const NON_USD_SYMBOLS = /[€£¥₹₽₩¢]/;

function fail(code: RejectionCode): AmountParseResult {
  return { ok: false, code };
}

/**
 * Reads a money string exactly.
 *
 * Accepted decorations (data-methodology.md §3.4): surrounding whitespace, a
 * `$`, thousands separators, a leading or trailing sign, and accounting
 * parentheses. Everything else is a rejection.
 */
export function parseAmountToCents(raw: string): AmountParseResult {
  let text = raw.trim();
  if (text.length === 0) return fail('amount-missing');

  if (NON_USD_SYMBOLS.test(text)) return fail('amount-non-usd-symbol');

  // Exponent notation is refused outright rather than evaluated: `1e3` is a
  // number, but it is not how a bank writes money, and accepting it would mean
  // running the value through a float.
  if (/[eE]/.test(text)) return fail('amount-exponent-notation');
  if (/infinity|nan/i.test(text)) return fail('amount-not-numeric');

  let negative = false;

  // Accounting parentheses: (12.34) is negative. Must wrap the whole value.
  if (text.startsWith('(') && text.endsWith(')')) {
    negative = true;
    text = text.slice(1, -1).trim();
  } else if (text.startsWith('(') || text.endsWith(')')) {
    return fail('amount-not-numeric');
  }

  // A sign may lead or trail, but only once. `--5.00` is malformed, not
  // double-negated, so the "have we already taken a sign" flag is load-bearing.
  let signTaken = false;
  if (text.startsWith('-') || text.startsWith('+')) {
    if (text.startsWith('-')) negative = !negative;
    text = text.slice(1).trim();
    signTaken = true;
  } else if (text.endsWith('-') || text.endsWith('+')) {
    if (text.endsWith('-')) negative = !negative;
    text = text.slice(0, -1).trim();
    signTaken = true;
  }

  // The currency symbol can sit on either side of the sign: both "-$12.34" and
  // "$-12.34" occur in real exports.
  if (text.startsWith(USD_SYMBOL)) {
    text = text.slice(1).trim();
    if (!signTaken && (text.startsWith('-') || text.startsWith('+'))) {
      if (text.startsWith('-')) negative = !negative;
      text = text.slice(1).trim();
      signTaken = true;
    }
  }

  if (text.length === 0) return fail('amount-not-numeric');
  // Any sign left over means something like `1-2` or `--5`.
  if (/[+-]/.test(text)) return fail('amount-not-numeric');

  const separated = text.split('.');
  if (separated.length > 2) return fail('amount-not-numeric');

  const wholePart = separated[0] ?? '';
  const fractionPart = separated[1];

  const groupCheck = validateWholePart(wholePart);
  if (groupCheck !== null) return fail(groupCheck);

  const digits = wholePart.replace(/,/g, '');
  if (digits.length === 0 && (fractionPart === undefined || fractionPart.length === 0)) {
    return fail('amount-not-numeric');
  }
  if (digits.length > 0 && !/^\d+$/.test(digits)) return fail('amount-not-numeric');

  let fractionDigits = '';
  if (fractionPart !== undefined) {
    if (!/^\d*$/.test(fractionPart)) return fail('amount-not-numeric');
    if (fractionPart.length > 2) return fail('amount-too-precise');
    fractionDigits = fractionPart;
  }

  // Assemble cents from digit characters only — no float ever exists.
  const wholeDigits = digits.length === 0 ? '0' : digits;
  const cents = wholeDigits.padStart(1, '0') + fractionDigits.padEnd(2, '0');

  // Strip leading zeros so the safe-integer check sees the true magnitude.
  const normalized = cents.replace(/^0+(?=\d)/, '');
  if (normalized.length > 16) return fail('amount-out-of-range');

  const value = Number(normalized);
  if (!Number.isSafeInteger(value)) return fail('amount-out-of-range');
  if (value > MAX_AMOUNT_CENTS) return fail('amount-out-of-range');

  return { ok: true, value: { cents: value, negative: negative && value !== 0 } };
}

/**
 * Checks the integer part's grouping.
 *
 * `1,234,567` is fine; `1,23,4567` and `12,34` are not. A malformed group is a
 * strong signal the file uses a different locale convention than assumed, so it
 * is refused rather than silently stripped.
 */
function validateWholePart(wholePart: string): RejectionCode | null {
  if (wholePart.length === 0) return null;
  if (!wholePart.includes(',')) {
    return /^\d*$/.test(wholePart) ? null : 'amount-not-numeric';
  }

  const groups = wholePart.split(',');
  const first = groups[0] ?? '';
  if (first.length === 0 || first.length > 3) return 'amount-malformed-grouping';
  if (!/^\d+$/.test(first)) return 'amount-not-numeric';

  for (const group of groups.slice(1)) {
    if (group.length !== 3) return 'amount-malformed-grouping';
    if (!/^\d+$/.test(group)) return 'amount-not-numeric';
  }

  return null;
}

/** Formats integer cents for display. Never used as a calculation input. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const magnitude = Math.abs(cents);
  const whole = Math.trunc(magnitude / 100);
  const fraction = magnitude % 100;
  return `${sign}${whole.toLocaleString('en-US')}.${String(fraction).padStart(2, '0')}`;
}
