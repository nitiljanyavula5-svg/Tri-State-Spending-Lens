import { describe, expect, it } from 'vitest';
import {
  classify,
  defaultKindForDirection,
  isRecomputable,
  ruleMatches,
} from '../../../src/classification/classify';
import { sortRulesByPrecedence } from '../../../src/db/repositories/rules';
import type { MerchantRule } from '../../../src/types/domain';

/**
 * The five-tier precedence chain (category-rules.md §5).
 *
 * §8 names the obligations these cover: a user decision survives everything, a
 * user rule beats a built-in, identical input produces identical output, and
 * kinds that would remove money from spending are only ever suggested.
 */

const row = (overrides: Partial<Parameters<typeof classify>[0]['row']> = {}) => ({
  descriptionRaw: 'PINEBROOK MARKET',
  direction: 'debit' as const,
  amountCents: 1234,
  ...overrides,
});

function rule(overrides: Partial<MerchantRule> = {}): MerchantRule {
  return {
    id: 'rule-1',
    matchType: 'contains',
    pattern: 'PINEBROOK',
    priority: 0,
    createdByUser: true,
    ...overrides,
  };
}

const run = (input: Partial<Parameters<typeof classify>[0]> = {}) =>
  classify({ row: row(), userRules: [], ...input });

describe('import defaults', () => {
  it('keeps the Phase 3 direction defaults', () => {
    expect(defaultKindForDirection('debit')).toBe('purchase');
    expect(defaultKindForDirection('credit')).toBe('unknown');
  });

  it('classifies an unrecognized debit as an uncategorized purchase', () => {
    const result = run({ row: row({ descriptionRaw: 'ZZQX UNKNOWN VENDOR' }) });

    expect(result.kind).toBe('purchase');
    expect(result.categoryId).toBe('other');
    expect(result.categorySource).toBe('uncategorized');
    expect(result.classificationConfidence).toBe('none');
  });

  it('classifies an unrecognized credit as unknown', () => {
    const result = run({
      row: row({ descriptionRaw: 'ZZQX UNKNOWN VENDOR', direction: 'credit' }),
    });
    expect(result.kind).toBe('unknown');
  });
});

describe('tier 1 — a user decision wins over everything', () => {
  it('beats a user rule that would say otherwise', () => {
    const result = run({
      userRules: [rule({ categoryId: 'shopping', kind: 'fee' })],
      userDecision: { categoryId: 'groceries' },
    });

    expect(result.categoryId).toBe('groceries');
    expect(result.categorySource).toBe('user');
    expect(result.classificationConfidence).toBe('high');
    expect(result.provenance).toBe('You set this');
  });

  it('beats a built-in keyword rule', () => {
    const result = run({
      row: row({ descriptionRaw: 'STARBUCKS' }),
      userDecision: { categoryId: 'groceries' },
    });
    expect(result.categoryId).toBe('groceries');
  });

  it('keeps a user merchant even when an alias would rename it', () => {
    const result = run({
      row: row({ descriptionRaw: 'AMZN MKTP US' }),
      userDecision: { merchantNormalized: 'MY OWN NAME' },
    });
    expect(result.merchantNormalized).toBe('MY OWN NAME');
  });

  it('ignores a category id outside the closed set', () => {
    const result = run({ userDecision: { categoryId: 'not-a-real-category' } });
    // Storing an unknown id would fail the backup schema on the next export.
    expect(result.categoryId).toBe('other');
  });
});

describe('tier 2 — user rules', () => {
  it('applies a matching rule and records its provenance', () => {
    const result = run({ userRules: [rule({ categoryId: 'groceries' })] });

    expect(result.categoryId).toBe('groceries');
    expect(result.categorySource).toBe('user_rule');
    expect(result.classificationConfidence).toBe('high');
    expect(result.provenance).toBe('Your rule');
  });

  it('beats a built-in keyword rule', () => {
    const result = run({
      row: row({ descriptionRaw: 'STARBUCKS' }),
      userRules: [rule({ pattern: 'STARBUCKS', categoryId: 'shopping' })],
    });
    // Left alone, the keyword tier would call this Dining.
    expect(result.categoryId).toBe('shopping');
    expect(result.categorySource).toBe('user_rule');
  });

  it('may set merchant, category, and kind together or separately', () => {
    const merchantOnly = run({ userRules: [rule({ normalizedMerchant: 'PINEBROOK' })] });
    expect(merchantOnly.merchantNormalized).toBe('PINEBROOK');

    const kindOnly = run({ userRules: [rule({ kind: 'fee' })] });
    expect(kindOnly.kind).toBe('fee');
    // A kind with an unambiguous purpose brings its category with it (§3.3).
    expect(kindOnly.categoryId).toBe('fees_interest');
  });

  it('ignores a rule the user did not create', () => {
    const result = run({
      userRules: [rule({ categoryId: 'shopping', createdByUser: false })],
    });
    expect(result.categorySource).not.toBe('user_rule');
  });
});

describe('rule matching is literal', () => {
  it('supports exact, starts-with, and contains', () => {
    expect(
      ruleMatches(rule({ matchType: 'exact', pattern: 'PINEBROOK MARKET' }), 'PINEBROOK MARKET'),
    ).toBe(true);
    expect(
      ruleMatches(rule({ matchType: 'exact', pattern: 'PINEBROOK' }), 'PINEBROOK MARKET'),
    ).toBe(false);
    expect(
      ruleMatches(rule({ matchType: 'starts_with', pattern: 'PINE' }), 'PINEBROOK MARKET'),
    ).toBe(true);
    expect(
      ruleMatches(rule({ matchType: 'starts_with', pattern: 'MARKET' }), 'PINEBROOK MARKET'),
    ).toBe(false);
    expect(ruleMatches(rule({ matchType: 'contains', pattern: 'BROOK' }), 'PINEBROOK MARKET')).toBe(
      true,
    );
  });

  it('never compiles a pattern as a regular expression', () => {
    // `.*` is matched as three literal characters, so it matches nothing here.
    expect(ruleMatches(rule({ matchType: 'contains', pattern: '.*' }), 'PINEBROOK MARKET')).toBe(
      false,
    );
    expect(ruleMatches(rule({ matchType: 'contains', pattern: '.*' }), 'A.*B')).toBe(true);
  });

  it('refuses an empty pattern', () => {
    expect(ruleMatches(rule({ pattern: '   ' }), 'PINEBROOK MARKET')).toBe(false);
  });
});

describe('deterministic tie-breaking', () => {
  it('orders by priority, then specificity, then pattern length, then id', () => {
    const rules = sortRulesByPrecedence([
      rule({ id: 'c', matchType: 'contains', pattern: 'PINE', priority: 0 }),
      rule({ id: 'a', matchType: 'exact', pattern: 'PINEBROOK MARKET', priority: 0 }),
      rule({ id: 'b', matchType: 'starts_with', pattern: 'PINEB', priority: 0 }),
      rule({ id: 'd', matchType: 'contains', pattern: 'MARKET', priority: 5 }),
    ]);

    // Priority first, then most specific match type.
    expect(rules.map((r) => r.id)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('breaks a full tie by pattern length, then id, never by insertion order', () => {
    const forward = sortRulesByPrecedence([
      rule({ id: 'zzz', matchType: 'contains', pattern: 'LONGER PATTERN' }),
      rule({ id: 'aaa', matchType: 'contains', pattern: 'SHORT' }),
    ]);
    const reversed = sortRulesByPrecedence([
      rule({ id: 'aaa', matchType: 'contains', pattern: 'SHORT' }),
      rule({ id: 'zzz', matchType: 'contains', pattern: 'LONGER PATTERN' }),
    ]);

    expect(forward.map((r) => r.id)).toEqual(['zzz', 'aaa']);
    expect(reversed.map((r) => r.id)).toEqual(forward.map((r) => r.id));
  });

  it('picks the first rule in precedence order when several match', () => {
    const rules = sortRulesByPrecedence([
      rule({ id: 'broad', matchType: 'contains', pattern: 'PINE', categoryId: 'shopping' }),
      rule({
        id: 'specific',
        matchType: 'exact',
        pattern: 'PINEBROOK MARKET',
        categoryId: 'groceries',
      }),
    ]);

    expect(classify({ row: row(), userRules: rules }).categoryId).toBe('groceries');
  });
});

describe('tier 4 — built-in keywords', () => {
  it('categorizes a recognizable merchant', () => {
    const result = run({ row: row({ descriptionRaw: 'HARBOR BEAN COFFEE' }) });
    expect(result.categoryId).toBe('dining');
    expect(result.categorySource).toBe('keyword_rule');
  });

  it('applies fee and cash-withdrawal kinds automatically', () => {
    // Both stay *included* in spending, so a wrong guess cannot hide money.
    const fee = run({ row: row({ descriptionRaw: 'MONTHLY FEE' }) });
    expect(fee.kind).toBe('fee');
    expect(fee.categoryId).toBe('fees_interest');

    const cash = run({ row: row({ descriptionRaw: 'ATM WITHDRAWAL' }) });
    expect(cash.kind).toBe('cash_withdrawal');
    expect(cash.categoryId).toBe('cash_atm');
  });
});

describe('kinds that would hide money are only suggested', () => {
  const cases = [
    { description: 'ONLINE TRANSFER TO SAVINGS', direction: 'debit' as const, kind: 'transfer' },
    { description: 'CREDIT CARD PAYMENT', direction: 'debit' as const, kind: 'payment' },
    { description: 'PAYROLL DEPOSIT', direction: 'credit' as const, kind: 'income' },
    { description: 'REFUND FROM STORE', direction: 'credit' as const, kind: 'refund' },
  ];

  it.each(cases)('suggests $kind without applying it', ({ description, direction, kind }) => {
    const result = run({ row: row({ descriptionRaw: description, direction }) });

    // The applied kind is still the import default...
    expect(result.kind).toBe(defaultKindForDirection(direction));
    // ...and the suggestion is surfaced for the user to confirm.
    expect(result.kindSuggestion?.kind).toBe(kind);
    expect(result.kindSuggestion?.confidence).toBe('low');
    expect(result.kindSuggestion?.reason).toMatch(/suggestion until you confirm/i);
  });

  it('names no cell value in a suggestion reason', () => {
    const result = run({ row: row({ descriptionRaw: 'ONLINE TRANSFER TO SAVINGS' }) });
    expect(result.kindSuggestion?.reason).not.toMatch(/SAVINGS|TRANSFER TO/);
  });
});

describe('determinism', () => {
  it('produces identical output for identical input', () => {
    const rules = sortRulesByPrecedence([rule({ categoryId: 'groceries' })]);
    const first = classify({ row: row(), userRules: rules });
    const second = classify({ row: row(), userRules: rules });
    expect(first).toEqual(second);
  });
});

describe('re-running classification', () => {
  it('may recompute only built-in and uncategorized rows', () => {
    // §5.4: tier-1 and tier-2 decisions are never recomputed.
    expect(isRecomputable('user')).toBe(false);
    expect(isRecomputable('user_rule')).toBe(false);
    expect(isRecomputable('merchant_rule')).toBe(true);
    expect(isRecomputable('keyword_rule')).toBe(true);
    expect(isRecomputable('uncategorized')).toBe(true);
  });
});
