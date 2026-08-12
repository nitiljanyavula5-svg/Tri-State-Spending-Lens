import type { TransactionKind, Direction } from '../types/domain';

/**
 * Built-in keyword rules — tiers 3 and 4 of the precedence chain.
 *
 * The safety rule that shapes this whole module is category-rules.md §7:
 *
 *   Transfer and payment detection may only **suggest**. Because `transfer` and
 *   `payment` are excluded from net spending, an incorrect automatic assignment
 *   would silently hide real spending.
 *
 * So kinds are split into two groups. `fee` and `cash_withdrawal` may be
 * applied automatically: both are *included* in net spending, so getting one
 * wrong overstates a category but never hides money. `transfer`, `payment`,
 * `income`, and `refund` all change whether a transaction counts at all, so
 * they are only ever raised as suggestions for the user to confirm.
 *
 * Patterns are matched literally against the normalized merchant. Nothing here
 * is compiled as a regular expression from user input (threat-model.md).
 */

export type KeywordConfidence = 'medium' | 'low';

export interface KeywordRule {
  readonly id: string;
  /** Matched against the normalized merchant, uppercase. */
  readonly phrase: string;
  readonly categoryId?: string;
  readonly kind?: TransactionKind;
  /** Restricts the rule to one direction, when the signal only makes sense there. */
  readonly direction?: Direction;
}

/**
 * Category keywords.
 *
 * Deliberately conservative and small. A wrong category is a visible, one-click
 * correction; the cost of guessing is low and the benefit of a sensible start
 * is real. Contrast with kinds, where a wrong guess hides money.
 */
export const CATEGORY_KEYWORDS: readonly KeywordRule[] = [
  { id: 'kw-grocery-shoprite', phrase: 'SHOPRITE', categoryId: 'groceries' },
  { id: 'kw-grocery-wholefoods', phrase: 'WHOLE FOODS', categoryId: 'groceries' },
  { id: 'kw-grocery-traderjoes', phrase: 'TRADER JOES', categoryId: 'groceries' },
  { id: 'kw-grocery-acme', phrase: 'ACME MARKET', categoryId: 'groceries' },
  { id: 'kw-grocery-generic', phrase: 'SUPERMARKET', categoryId: 'groceries' },
  { id: 'kw-grocery-market', phrase: 'GROCERY', categoryId: 'groceries' },

  { id: 'kw-dining-starbucks', phrase: 'STARBUCKS', categoryId: 'dining' },
  { id: 'kw-dining-dunkin', phrase: 'DUNKIN', categoryId: 'dining' },
  { id: 'kw-dining-coffee', phrase: 'COFFEE', categoryId: 'dining' },
  { id: 'kw-dining-pizza', phrase: 'PIZZA', categoryId: 'dining' },
  { id: 'kw-dining-restaurant', phrase: 'RESTAURANT', categoryId: 'dining' },
  { id: 'kw-dining-cafe', phrase: 'CAFE', categoryId: 'dining' },

  { id: 'kw-transport-njtransit', phrase: 'NJ TRANSIT', categoryId: 'transportation' },
  { id: 'kw-transport-septa', phrase: 'SEPTA', categoryId: 'transportation' },
  { id: 'kw-transport-mta', phrase: 'MTA', categoryId: 'transportation' },
  { id: 'kw-transport-transit', phrase: 'TRANSIT', categoryId: 'transportation' },
  { id: 'kw-transport-parking', phrase: 'PARKING', categoryId: 'transportation' },
  { id: 'kw-transport-ezpass', phrase: 'E-ZPASS', categoryId: 'transportation' },
  { id: 'kw-transport-fuel', phrase: 'FUEL', categoryId: 'transportation' },
  { id: 'kw-transport-gas', phrase: 'GAS STATION', categoryId: 'transportation' },
  { id: 'kw-transport-uber', phrase: 'UBER', categoryId: 'transportation' },
  { id: 'kw-transport-lyft', phrase: 'LYFT', categoryId: 'transportation' },

  { id: 'kw-utilities-pseg', phrase: 'PSEG', categoryId: 'utilities_bills' },
  { id: 'kw-utilities-conedison', phrase: 'CON EDISON', categoryId: 'utilities_bills' },
  { id: 'kw-utilities-peco', phrase: 'PECO', categoryId: 'utilities_bills' },
  { id: 'kw-utilities-electric', phrase: 'ELECTRIC', categoryId: 'utilities_bills' },
  { id: 'kw-utilities-water', phrase: 'WATER DEPT', categoryId: 'utilities_bills' },
  { id: 'kw-utilities-internet', phrase: 'INTERNET', categoryId: 'utilities_bills' },
  { id: 'kw-utilities-wireless', phrase: 'WIRELESS', categoryId: 'utilities_bills' },

  { id: 'kw-subs-netflix', phrase: 'NETFLIX', categoryId: 'subscriptions_memberships' },
  { id: 'kw-subs-spotify', phrase: 'SPOTIFY', categoryId: 'subscriptions_memberships' },
  { id: 'kw-subs-hulu', phrase: 'HULU', categoryId: 'subscriptions_memberships' },
  { id: 'kw-subs-gym', phrase: 'FITNESS', categoryId: 'subscriptions_memberships' },
  { id: 'kw-subs-membership', phrase: 'MEMBERSHIP', categoryId: 'subscriptions_memberships' },

  { id: 'kw-health-pharmacy', phrase: 'PHARMACY', categoryId: 'health' },
  { id: 'kw-health-cvs', phrase: 'CVS', categoryId: 'health' },
  { id: 'kw-health-walgreens', phrase: 'WALGREENS', categoryId: 'health' },
  { id: 'kw-health-dental', phrase: 'DENTAL', categoryId: 'health' },
  { id: 'kw-health-medical', phrase: 'MEDICAL', categoryId: 'health' },

  { id: 'kw-shopping-amazon', phrase: 'AMAZON', categoryId: 'shopping' },
  { id: 'kw-shopping-target', phrase: 'TARGET', categoryId: 'shopping' },
  { id: 'kw-shopping-walmart', phrase: 'WALMART', categoryId: 'shopping' },

  { id: 'kw-entertainment-cinema', phrase: 'CINEMA', categoryId: 'entertainment' },
  { id: 'kw-entertainment-theatre', phrase: 'THEATRE', categoryId: 'entertainment' },
  { id: 'kw-entertainment-theater', phrase: 'THEATER', categoryId: 'entertainment' },

  { id: 'kw-housing-rent', phrase: 'RENT PAYMENT', categoryId: 'housing' },
  { id: 'kw-housing-mortgage', phrase: 'MORTGAGE', categoryId: 'housing' },
  { id: 'kw-housing-property', phrase: 'PROPERTY TAX', categoryId: 'housing' },
];

/**
 * Kinds safe to apply without confirmation.
 *
 * Both are debits that remain *included* in net spending, so an incorrect
 * assignment changes which category a figure lands in, never whether the money
 * is counted (calculation-contract.md §3).
 */
export const AUTO_KIND_KEYWORDS: readonly KeywordRule[] = [
  { id: 'kw-fee-service', phrase: 'SERVICE CHARGE', kind: 'fee', direction: 'debit' },
  { id: 'kw-fee-monthly', phrase: 'MONTHLY FEE', kind: 'fee', direction: 'debit' },
  { id: 'kw-fee-overdraft', phrase: 'OVERDRAFT FEE', kind: 'fee', direction: 'debit' },
  { id: 'kw-fee-maintenance', phrase: 'MAINTENANCE FEE', kind: 'fee', direction: 'debit' },
  { id: 'kw-fee-interest', phrase: 'INTEREST CHARGE', kind: 'fee', direction: 'debit' },
  { id: 'kw-fee-late', phrase: 'LATE FEE', kind: 'fee', direction: 'debit' },
  { id: 'kw-fee-foreign', phrase: 'FOREIGN TRANSACTION FEE', kind: 'fee', direction: 'debit' },
  { id: 'kw-fee-atmfee', phrase: 'ATM FEE', kind: 'fee', direction: 'debit' },

  { id: 'kw-cash-atm', phrase: 'ATM WITHDRAWAL', kind: 'cash_withdrawal', direction: 'debit' },
  {
    id: 'kw-cash-withdrawal',
    phrase: 'CASH WITHDRAWAL',
    kind: 'cash_withdrawal',
    direction: 'debit',
  },
  { id: 'kw-cash-back', phrase: 'CASH BACK', kind: 'cash_withdrawal', direction: 'debit' },
];

/**
 * Kinds that may only ever be **suggested**.
 *
 * Every one of these changes whether a transaction counts toward net spending,
 * so applying one without asking could silently erase real spending from the
 * user's totals. They surface in the review queue instead.
 */
export const SUGGESTED_KIND_KEYWORDS: readonly KeywordRule[] = [
  { id: 'kw-transfer-generic', phrase: 'TRANSFER', kind: 'transfer' },
  { id: 'kw-transfer-online', phrase: 'ONLINE TRANSFER', kind: 'transfer' },
  { id: 'kw-transfer-zelle', phrase: 'ZELLE', kind: 'transfer' },
  { id: 'kw-transfer-venmo', phrase: 'VENMO', kind: 'transfer' },

  { id: 'kw-payment-cardpayment', phrase: 'CARD PAYMENT', kind: 'payment' },
  { id: 'kw-payment-autopay', phrase: 'AUTOPAY', kind: 'payment' },
  { id: 'kw-payment-thankyou', phrase: 'PAYMENT THANK YOU', kind: 'payment' },
  { id: 'kw-payment-ccpayment', phrase: 'CREDIT CARD PAYMENT', kind: 'payment' },

  { id: 'kw-income-payroll', phrase: 'PAYROLL', kind: 'income', direction: 'credit' },
  { id: 'kw-income-directdep', phrase: 'DIRECT DEP', kind: 'income', direction: 'credit' },
  { id: 'kw-income-salary', phrase: 'SALARY', kind: 'income', direction: 'credit' },

  { id: 'kw-refund-refund', phrase: 'REFUND', kind: 'refund', direction: 'credit' },
  { id: 'kw-refund-return', phrase: 'RETURN', kind: 'refund', direction: 'credit' },
  { id: 'kw-refund-credit', phrase: 'MERCHANDISE CREDIT', kind: 'refund', direction: 'credit' },
];

export interface KeywordMatch {
  readonly rule: KeywordRule;
  readonly confidence: KeywordConfidence;
}

/**
 * Splits on non-alphanumerics so `COFFEE` matches `HARBOR BEAN COFFEE` as a
 * whole token, and `E-ZPASS` matches as its own phrase.
 */
function tokensOf(merchant: string): readonly string[] {
  return merchant.split(/[^A-Z0-9]+/i).filter((token) => token.length > 0);
}

/**
 * Finds the best keyword match for a merchant.
 *
 * A whole-phrase match scores `medium`; a bare substring scores `low`, exactly
 * as §5.1 specifies. Longer phrases win, so `ATM FEE` beats a hypothetical
 * `FEE` and the more specific signal is the one that applies.
 */
export function matchKeyword(
  merchant: string,
  direction: Direction,
  rules: readonly KeywordRule[],
): KeywordMatch | null {
  const upper = merchant.toUpperCase();
  const tokens = new Set(tokensOf(upper));

  let best: KeywordMatch | null = null;

  for (const rule of rules) {
    if (rule.direction !== undefined && rule.direction !== direction) continue;

    const phrase = rule.phrase.toUpperCase();
    const phraseTokens = tokensOf(phrase);

    // A whole-phrase hit: every token present, and the phrase appears intact.
    const wholePhrase =
      phraseTokens.length > 0 &&
      (phraseTokens.length === 1
        ? tokens.has(phraseTokens[0]!)
        : upper.includes(phrase) || phraseTokens.every((token) => tokens.has(token)));

    const substring = upper.includes(phrase);
    if (!wholePhrase && !substring) continue;

    const confidence: KeywordConfidence = wholePhrase ? 'medium' : 'low';
    const better =
      best === null ||
      phrase.length > best.rule.phrase.length ||
      (confidence === 'medium' && best.confidence === 'low');

    if (better) best = { rule, confidence };
  }

  return best;
}
