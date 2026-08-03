import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { allNavItems } from '../../src/app/navigation';
import { renderApp as renderAt } from './helpers/renderApp';

/** Every route in master plan §6, with the heading that proves it rendered. */
const ROUTES: ReadonlyArray<{ path: string; heading: RegExp; title: string }> = [
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
  {
    path: '/this-route-does-not-exist',
    heading: /^page not found$/i,
    title: 'Page not found · Tri-State Spending Lens',
  },
];

describe('route table', () => {
  it.each(ROUTES)('renders $path with its own level-1 heading', ({ path, heading }) => {
    renderAt(path);
    expect(screen.getByRole('heading', { level: 1, name: heading })).toBeInTheDocument();
  });

  it.each(ROUTES)('renders exactly one level-1 heading at $path', ({ path }) => {
    renderAt(path);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it.each(ROUTES)('sets the document title at $path', ({ path, title }) => {
    renderAt(path);
    expect(document.title).toBe(title);
  });

  it.each(ROUTES)('renders the shared shell at $path', ({ path }) => {
    renderAt(path);
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
  });
});

describe('navigation targets', () => {
  it.each(allNavItems.map((item) => item.to))('%s is a real route, not the 404 page', (to) => {
    renderAt(to);
    expect(
      screen.queryByRole('heading', { level: 1, name: /^page not found$/i }),
    ).not.toBeInTheDocument();
  });
});
