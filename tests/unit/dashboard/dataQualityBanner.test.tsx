import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { DataQualityBanner } from '../../../src/components/dashboard/DataQualityBanner';
import { buildWarnings } from '../../../src/components/dashboard/dataQualityWarnings';
import type { DataQualityFlags } from '../../../src/calculations';

/**
 * The data-quality region, against data-methodology.md §6 and §14.11.
 *
 * The property under test is that materially different conditions stay
 * materially different: one generic "some data may be missing" would leave a
 * user unable to act on any of them.
 */

const CLEAN: DataQualityFlags = {
  partialMonth: false,
  incompleteIncome: false,
  incomeCompletenessWarning: null,
  unreviewedCredits: 0,
  uncategorizedIncludedCents: 0,
  coverageGap: false,
  singleAccountWithPayments: false,
  rejectedRowsPresent: false,
  insufficientHistory: false,
  unreviewedDebits: 0,
  excludedIncomeTransactionCount: 0,
  sessionsMissingStatementRange: 0,
  sessionsWithMalformedStatementRange: 0,
  sessionsWithUnattributedStatementRange: 0,
  ambiguousMultiAccountStatementRangeCount: 0,
  accountsWithAmbiguousStatementCoverage: [],
  accountsWithIncompleteCoverage: [],
};

const LABELS = new Map([
  ['acct-checking', 'Everyday Checking'],
  ['acct-card', 'Rewards Card'],
]);

const flags = (overrides: Partial<DataQualityFlags>): DataQualityFlags => ({
  ...CLEAN,
  ...overrides,
});

const idsFor = (overrides: Partial<DataQualityFlags>) =>
  buildWarnings(flags(overrides), LABELS).map((warning) => warning.id);

describe('a clean workspace', () => {
  it('shows no warnings at all', () => {
    expect(buildWarnings(CLEAN, LABELS)).toEqual([]);
    const { container } = render(<DataQualityBanner flags={CLEAN} accountLabels={LABELS} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('every typed warning is reachable', () => {
  it('reports confirmed-incomplete income distinctly from unconfirmed', () => {
    expect(idsFor({ incomeCompletenessWarning: 'income-data-incomplete' })).toContain(
      'income-data-incomplete',
    );
    expect(idsFor({ incomeCompletenessWarning: 'income-completeness-unconfirmed' })).toContain(
      'income-completeness-unconfirmed',
    );
  });

  it('does not read the legacy boolean to decide the income wording', () => {
    // `incompleteIncome` true but the authoritative field null: no income
    // warning, because the typed field is the one that decides (§14.1).
    expect(idsFor({ incompleteIncome: true, incomeCompletenessWarning: null })).not.toContain(
      'income-completeness-unconfirmed',
    );
  });

  it('reports unreviewed credits and debits separately', () => {
    const ids = idsFor({ unreviewedCredits: 2, unreviewedDebits: 3 });
    expect(ids).toContain('unreviewed-credits');
    expect(ids).toContain('unreviewed-debits');
  });

  it('reports excluded income transactions', () => {
    expect(idsFor({ excludedIncomeTransactionCount: 1 })).toContain('excluded-income');
  });

  it('reports missing, malformed, and unattributed statement ranges separately', () => {
    expect(idsFor({ sessionsMissingStatementRange: 1 })).toContain('missing-statement-range');
    expect(idsFor({ sessionsWithMalformedStatementRange: 1 })).toContain(
      'malformed-statement-range',
    );
    expect(idsFor({ sessionsWithUnattributedStatementRange: 1 })).toContain(
      'unattributed-statement-range',
    );
  });

  it('reports coverage gaps, single-account payments, rejected rows, and short history', () => {
    expect(idsFor({ coverageGap: true })).toContain('coverage-gap');
    expect(idsFor({ singleAccountWithPayments: true })).toContain('single-account-payments');
    expect(idsFor({ rejectedRowsPresent: true })).toContain('rejected-rows');
    expect(idsFor({ insufficientHistory: true })).toContain('insufficient-history');
  });

  it('reports an uncategorized share with its amount', () => {
    render(
      <DataQualityBanner
        flags={flags({ uncategorizedIncludedCents: 12_345 })}
        accountLabels={LABELS}
      />,
    );
    expect(screen.getByText(/\$123\.45/)).toBeInTheDocument();
  });
});

describe('coverage warnings are correctly scoped', () => {
  it('names the accounts whose selected period lacks coverage', () => {
    render(
      <DataQualityBanner
        flags={flags({ partialMonth: true, accountsWithIncompleteCoverage: ['acct-card'] })}
        accountLabels={LABELS}
      />,
    );
    const callout = screen.getByText(/not fully covered by statements/i).closest('div');
    expect(within(callout as HTMLElement).getByText(/Rewards Card/)).toBeInTheDocument();
  });

  it('falls back safely for an account id with no label', () => {
    render(
      <DataQualityBanner
        flags={flags({ partialMonth: true, accountsWithIncompleteCoverage: ['acct-ghost'] })}
        accountLabels={LABELS}
      />,
    );
    // Shown as an unnamed account rather than invented or omitted.
    expect(screen.getByText(/Unnamed account \(acct-ghost\)/)).toBeInTheDocument();
  });

  it('labels ambiguity as a workspace limitation, not a filter-scoped claim', () => {
    render(
      <DataQualityBanner
        flags={flags({
          ambiguousMultiAccountStatementRangeCount: 1,
          accountsWithAmbiguousStatementCoverage: ['acct-card', 'acct-checking'],
        })}
        accountLabels={LABELS}
      />,
    );
    expect(screen.getByText(/Workspace import coverage/i)).toBeInTheDocument();
    expect(screen.getByText(/applies to the whole workspace/i)).toBeInTheDocument();
  });

  it('does not blame the user or overclaim about the ambiguous accounts', () => {
    const [warning] = buildWarnings(
      flags({
        ambiguousMultiAccountStatementRangeCount: 1,
        accountsWithAmbiguousStatementCoverage: ['acct-card'],
      }),
      LABELS,
    );
    const body = warning?.body ?? '';
    expect(body).toMatch(/not a mistake/i);
    expect(body).not.toMatch(/you (did|made|should have)/i);
    expect(body).not.toMatch(/definitely missing/i);
    expect(body).not.toMatch(/reimport/i);
  });

  it('keeps filter-scoped and workspace-wide coverage warnings distinct', () => {
    const ids = idsFor({
      partialMonth: true,
      accountsWithIncompleteCoverage: ['acct-card'],
      ambiguousMultiAccountStatementRangeCount: 1,
      accountsWithAmbiguousStatementCoverage: ['acct-card', 'acct-checking'],
    });
    expect(ids).toContain('incomplete-coverage');
    expect(ids).toContain('ambiguous-coverage');
  });
});

describe('presentation', () => {
  it('keeps several simultaneous warnings as separate callouts', () => {
    render(
      <DataQualityBanner
        flags={flags({
          incomeCompletenessWarning: 'income-completeness-unconfirmed',
          unreviewedDebits: 1,
          coverageGap: true,
        })}
        accountLabels={LABELS}
      />,
    );
    const region = screen.getByRole('region', { name: /before you read these figures/i });
    // Three distinct titles, not one merged message.
    expect(within(region).getByText(/has not been confirmed/i)).toBeInTheDocument();
    expect(within(region).getByText(/unreviewed debit/i)).toBeInTheDocument();
    expect(within(region).getByText(/gap between imported statements/i)).toBeInTheDocument();
  });

  it('is discoverable as a titled region above the figures', () => {
    render(<DataQualityBanner flags={flags({ coverageGap: true })} accountLabels={LABELS} />);
    expect(
      screen.getByRole('heading', { name: /before you read these figures/i }),
    ).toBeInTheDocument();
  });

  it('uses singular and plural counts correctly', () => {
    const single = buildWarnings(flags({ unreviewedDebits: 1 }), LABELS)[0];
    const many = buildWarnings(flags({ unreviewedDebits: 4 }), LABELS)[0];
    expect(single?.title).toMatch(/1 unreviewed debit$/);
    expect(many?.title).toMatch(/4 unreviewed debits$/);
  });
});
