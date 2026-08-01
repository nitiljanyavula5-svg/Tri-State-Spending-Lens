import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../../src/app/router/AppRoutes';
import { primaryNav } from '../../src/app/navigation';

function renderApp(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>,
  );
}

describe('site shell', () => {
  it('offers a skip link as a way past the navigation', () => {
    renderApp();
    const skip = screen.getByRole('link', { name: /skip to main content/i });
    expect(skip).toHaveAttribute('href', '#main-content');
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content');
  });

  it('exposes the primary navigation with every main section', () => {
    renderApp();
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    for (const item of primaryNav) {
      expect(within(nav).getByRole('link', { name: item.label })).toHaveAttribute('href', item.to);
    }
  });

  it('marks the current section as the active page', () => {
    renderApp('/app/budget');
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(nav).getByRole('link', { name: 'Budget' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});

describe('mobile navigation', () => {
  it('starts collapsed', () => {
    renderApp();
    expect(screen.getByRole('button', { name: /menu/i })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('navigation', { name: 'All sections' })).not.toBeInTheDocument();
  });

  it('opens and closes from the keyboard-accessible toggle', async () => {
    const user = userEvent.setup();
    renderApp();
    const toggle = screen.getByRole('button', { name: /menu/i });

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('navigation', { name: 'All sections' })).toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes when Escape is pressed', async () => {
    const user = userEvent.setup();
    renderApp();
    const toggle = screen.getByRole('button', { name: /menu/i });

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    await user.keyboard('{Escape}');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes after navigating, so the panel never covers the new page', async () => {
    const user = userEvent.setup();
    renderApp();
    const toggle = screen.getByRole('button', { name: /menu/i });

    await user.click(toggle);
    const panel = screen.getByRole('navigation', { name: 'All sections' });
    await user.click(within(panel).getByRole('link', { name: /budget/i }));

    expect(screen.getByRole('heading', { level: 1, name: /^budget$/i })).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });
});
