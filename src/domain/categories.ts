import type { Essentiality, Variability } from '../types/domain';

/**
 * The sixteen permanent categories (category-rules.md §2).
 *
 * The set is closed in v1.0. IDs are the persisted identity and must never
 * change; labels are display text and may be reworded without a migration.
 */
export interface CategoryDefinition {
  readonly id: string;
  readonly label: string;
  /** Seed only — a starting point, never a claim about the user (§4.1). */
  readonly defaultEssentiality: Essentiality;
  readonly defaultVariability: Variability;
}

export const CATEGORIES: readonly CategoryDefinition[] = [
  {
    id: 'housing',
    label: 'Housing',
    defaultEssentiality: 'essential',
    defaultVariability: 'fixed',
  },
  {
    id: 'utilities_bills',
    label: 'Utilities & Bills',
    defaultEssentiality: 'essential',
    defaultVariability: 'variable',
  },
  {
    id: 'groceries',
    label: 'Groceries',
    defaultEssentiality: 'essential',
    defaultVariability: 'variable',
  },
  {
    id: 'dining',
    label: 'Dining',
    defaultEssentiality: 'discretionary',
    defaultVariability: 'variable',
  },
  {
    id: 'transportation',
    label: 'Transportation',
    defaultEssentiality: 'essential',
    defaultVariability: 'variable',
  },
  {
    id: 'subscriptions_memberships',
    label: 'Subscriptions & Memberships',
    defaultEssentiality: 'discretionary',
    defaultVariability: 'fixed',
  },
  {
    id: 'shopping',
    label: 'Shopping',
    defaultEssentiality: 'discretionary',
    defaultVariability: 'variable',
  },
  {
    id: 'personal_care',
    label: 'Personal Care',
    defaultEssentiality: 'discretionary',
    defaultVariability: 'variable',
  },
  {
    id: 'entertainment',
    label: 'Entertainment',
    defaultEssentiality: 'discretionary',
    defaultVariability: 'variable',
  },
  {
    id: 'health',
    label: 'Health',
    defaultEssentiality: 'essential',
    defaultVariability: 'variable',
  },
  {
    id: 'education',
    label: 'Education',
    defaultEssentiality: 'essential',
    defaultVariability: 'variable',
  },
  {
    id: 'travel',
    label: 'Travel',
    defaultEssentiality: 'discretionary',
    defaultVariability: 'variable',
  },
  {
    id: 'fees_interest',
    label: 'Fees & Interest',
    defaultEssentiality: 'essential',
    defaultVariability: 'variable',
  },
  {
    id: 'gifts_donations',
    label: 'Gifts & Donations',
    defaultEssentiality: 'discretionary',
    defaultVariability: 'variable',
  },
  {
    id: 'cash_atm',
    label: 'Cash & ATM',
    defaultEssentiality: 'discretionary',
    defaultVariability: 'variable',
  },
  {
    id: 'other',
    label: 'Other',
    defaultEssentiality: 'discretionary',
    defaultVariability: 'variable',
  },
] as const;

export const CATEGORY_IDS: readonly string[] = CATEGORIES.map((category) => category.id);

const BY_ID = new Map(CATEGORIES.map((category) => [category.id, category]));

export function getCategory(id: string): CategoryDefinition | undefined {
  return BY_ID.get(id);
}

export function isCategoryId(id: string): boolean {
  return BY_ID.has(id);
}

/**
 * `other` doubles as the uncategorized review destination. Whether a row is
 * *awaiting* review or was deliberately placed there is carried by
 * `categorySource`, never by the category itself (category-rules.md §2).
 */
export const UNCATEGORIZED_CATEGORY_ID = 'other';

/** Kind-implied default categories (category-rules.md §3.3). */
export const KIND_DEFAULT_CATEGORY: Readonly<Record<string, string>> = {
  fee: 'fees_interest',
  cash_withdrawal: 'cash_atm',
  transfer: 'other',
  payment: 'other',
  income: 'other',
};
