import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { DemoEntryCard } from '../../src/components/demo/DemoEntryCard';

function renderCard() {
  return render(
    <MemoryRouter>
      <DemoEntryCard />
    </MemoryRouter>,
  );
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

  it('leads into the workspace and to the privacy model', () => {
    renderCard();
    expect(screen.getByRole('link', { name: /try the demo/i })).toHaveAttribute(
      'href',
      '/app/overview',
    );
    expect(screen.getByRole('link', { name: /privacy model/i })).toHaveAttribute(
      'href',
      '/privacy',
    );
  });

  it('says plainly that the demo dataset does not exist yet', () => {
    renderCard();
    expect(screen.getByText(/demo dataset itself arrives in phase 2/i)).toBeInTheDocument();
  });
});
