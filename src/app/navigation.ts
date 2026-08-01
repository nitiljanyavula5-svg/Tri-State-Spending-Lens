/**
 * Single source of truth for navigation.
 *
 * Master plan §6: the main navigation is Overview, Transactions, Budget,
 * Recurring, Insights, and Tri-State Context. Import and Settings are utility
 * actions rather than permanent primary-navigation competitors.
 *
 * Desktop nav, mobile nav, the footer, and the route smoke tests all read
 * from here, so a route can never exist without a way to reach it.
 */

export interface NavItem {
  /** Visible label. */
  readonly label: string;
  /** Route path. */
  readonly to: string;
  /** Short description used in the mobile menu and on the site map. */
  readonly description: string;
  /** Match nested paths as active, not just an exact match. */
  readonly end?: boolean;
}

export const primaryNav: readonly NavItem[] = [
  {
    label: 'Overview',
    to: '/app/overview',
    description: 'Current-month status and financial summary',
  },
  {
    label: 'Transactions',
    to: '/app/transactions',
    description: 'Search, review, categorize, and exclude transactions',
  },
  {
    label: 'Budget',
    to: '/app/budget',
    description: 'Monthly overall and category budgets, savings target',
  },
  {
    label: 'Recurring',
    to: '/app/recurring',
    description: 'Possible recurring charges and annualized cost',
  },
  {
    label: 'Insights',
    to: '/app/insights',
    description: 'Rule-based observations and month in review',
  },
  {
    label: 'Tri-State Context',
    to: '/context',
    description: 'NJ, NY, and PA economic context',
  },
];

export const utilityNav: readonly NavItem[] = [
  {
    label: 'Import',
    to: '/import',
    description: 'Import wizard and import history',
  },
  {
    label: 'Settings',
    to: '/app/settings',
    description: 'Accounts, rules, backup, storage, and delete controls',
  },
];

export const publicNav: readonly NavItem[] = [
  { label: 'Home', to: '/', description: 'Landing page and privacy promise', end: true },
  { label: 'Methodology', to: '/methodology', description: 'How every number is produced' },
  {
    label: 'Privacy',
    to: '/privacy',
    description: 'Technical privacy model and local-data controls',
  },
];

/** Every navigable route, used by the route smoke tests. */
export const allNavItems: readonly NavItem[] = [...publicNav, ...primaryNav, ...utilityNav];
