import { describe, expect, it } from 'vitest';
import {
  CATEGORIES,
  CATEGORY_IDS,
  getCategory,
  isCategoryId,
  KIND_DEFAULT_CATEGORY,
  UNCATEGORIZED_CATEGORY_ID,
} from '../../../src/domain/categories';

/** Transcribed from category-rules.md §2 — the closed v1.0 set. */
const SPECIFIED_IDS = [
  'housing',
  'utilities_bills',
  'groceries',
  'dining',
  'transportation',
  'subscriptions_memberships',
  'shopping',
  'personal_care',
  'entertainment',
  'health',
  'education',
  'travel',
  'fees_interest',
  'gifts_donations',
  'cash_atm',
  'other',
];

describe('permanent categories', () => {
  it('matches the sixteen specified categories exactly, in order', () => {
    expect(CATEGORY_IDS).toEqual(SPECIFIED_IDS);
  });

  it('contains no judgmental category such as "Luxury"', () => {
    // The master plan replaced "Luxury" with Shopping and Personal Care to
    // avoid subjective classification (category-rules.md §2).
    const labels = CATEGORIES.map((c) => c.label.toLowerCase());
    expect(labels).not.toContain('luxury');
    expect(labels).toContain('shopping');
    expect(labels).toContain('personal care');
  });

  it('gives every category a seed essentiality and variability', () => {
    for (const category of CATEGORIES) {
      expect(['essential', 'discretionary']).toContain(category.defaultEssentiality);
      expect(['fixed', 'variable']).toContain(category.defaultVariability);
    }
  });

  it('matches the specified seed values for the categories most likely to be argued about', () => {
    expect(getCategory('housing')).toMatchObject({
      defaultEssentiality: 'essential',
      defaultVariability: 'fixed',
    });
    expect(getCategory('dining')).toMatchObject({
      defaultEssentiality: 'discretionary',
      defaultVariability: 'variable',
    });
    expect(getCategory('subscriptions_memberships')).toMatchObject({
      defaultEssentiality: 'discretionary',
      defaultVariability: 'fixed',
    });
    expect(getCategory('fees_interest')).toMatchObject({
      defaultEssentiality: 'essential',
      defaultVariability: 'variable',
    });
  });

  it('uses `other` as the uncategorized review destination', () => {
    expect(UNCATEGORIZED_CATEGORY_ID).toBe('other');
    expect(isCategoryId(UNCATEGORIZED_CATEGORY_ID)).toBe(true);
  });

  it('rejects an unknown category id', () => {
    expect(isCategoryId('crypto_moonshots')).toBe(false);
    expect(getCategory('crypto_moonshots')).toBeUndefined();
  });

  it('maps kind-implied defaults to real categories', () => {
    expect(KIND_DEFAULT_CATEGORY.fee).toBe('fees_interest');
    expect(KIND_DEFAULT_CATEGORY.cash_withdrawal).toBe('cash_atm');
    for (const categoryId of Object.values(KIND_DEFAULT_CATEGORY)) {
      expect(isCategoryId(categoryId)).toBe(true);
    }
  });
});
