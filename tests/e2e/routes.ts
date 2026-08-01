/** The route table both end-to-end suites walk. Mirrors master plan §6. */
export const ROUTES = [
  { path: '/', heading: /see where your money goes/i, title: 'Tri-State Spending Lens' },
  {
    path: '/context',
    heading: /^tri-state context$/i,
    title: 'Tri-State Context · Tri-State Spending Lens',
  },
  {
    path: '/methodology',
    heading: /^methodology$/i,
    title: 'Methodology · Tri-State Spending Lens',
  },
  {
    path: '/privacy',
    heading: /your financial data stays in your browser/i,
    title: 'Privacy · Tri-State Spending Lens',
  },
  { path: '/import', heading: /^import a bank csv$/i, title: 'Import · Tri-State Spending Lens' },
  { path: '/app/overview', heading: /^overview$/i, title: 'Overview · Tri-State Spending Lens' },
  {
    path: '/app/transactions',
    heading: /^transactions$/i,
    title: 'Transactions · Tri-State Spending Lens',
  },
  { path: '/app/budget', heading: /^budget$/i, title: 'Budget · Tri-State Spending Lens' },
  {
    path: '/app/recurring',
    heading: /^recurring charges$/i,
    title: 'Recurring · Tri-State Spending Lens',
  },
  { path: '/app/insights', heading: /^insights$/i, title: 'Insights · Tri-State Spending Lens' },
  { path: '/app/settings', heading: /^settings$/i, title: 'Settings · Tri-State Spending Lens' },
] as const;
