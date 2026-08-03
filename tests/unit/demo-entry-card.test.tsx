import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DemoEntryCard } from '../../src/components/demo/DemoEntryCard';
import { renderWithProviders } from './helpers/renderApp';

function renderCard() {
  return renderWithProviders(<DemoEntryCard />);
}

describe('DemoEntryCard', () => {
  it('labels its sample figures as fictional, visibly and not only in a comment', () => {
    renderCard();
    expect(screen.getByText(/fictional sample data/i)).toBeInTheDocument();
    expect(screen.getByText(/illustration only/i)).toBeInTheDocument();
    expect(screen.getByText(/not calculated from any data/i)).toBeInTheDocument();
  });

  it('is reachable as a named region', () => {
    renderCard();
    expect(screen.getByRole('region', { name: /try a fictional workspace/i })).toBeInTheDocument();
  });

  it('offers loading the demo as an action, not as navigation', () => {
    renderCard();
    // Loading the demo writes to the local database, so it must be a button.
    // A link would imply navigation with no side effect.
    expect(screen.getByRole('button', { name: /try the demo/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /try the demo/i })).not.toBeInTheDocument();
  });

  it('links to the privacy model', () => {
    renderCard();
    expect(screen.getByRole('link', { name: /privacy model/i })).toHaveAttribute(
      'href',
      '/privacy',
    );
  });

  it('says the demo is stored only in this browser', () => {
    renderCard();
    expect(screen.getByText(/stored only in this browser/i)).toBeInTheDocument();
  });
});
