import { Database } from 'lucide-react';
import { useWorkspace } from '../../app/providers/workspaceContext';
import { Badge } from '../ui/Badge';
import { Card, CardBody, CardTitle } from '../ui/Card';

export type WorkspaceFocus = 'overview' | 'transactions' | 'budget' | 'recurring';

const FOCUS_ROWS: Record<WorkspaceFocus, readonly (keyof CountLabels)[]> = {
  overview: ['transactions', 'accounts', 'budgetPlans', 'recurringSeries'],
  transactions: ['transactions', 'accounts', 'merchantRules'],
  budget: ['budgetPlans', 'budgetCategoryTargets'],
  recurring: ['recurringSeries', 'transactions'],
};

interface CountLabels {
  transactions: string;
  accounts: string;
  budgetPlans: string;
  budgetCategoryTargets: string;
  recurringSeries: string;
  merchantRules: string;
}

const LABELS: CountLabels = {
  transactions: 'Transactions stored',
  accounts: 'Accounts',
  budgetPlans: 'Monthly plans stored',
  budgetCategoryTargets: 'Category limits stored',
  recurringSeries: 'Recurring series stored',
  merchantRules: 'Merchant rules',
};

/**
 * Describes what the local workspace currently holds.
 *
 * Deliberately shows record counts and the stored date span only — never net
 * spending, money in, cash flow, savings rate, or budget remaining. Those are
 * calculation-contract figures produced by the shared selector layer, which is
 * Phase 5 work. Showing a number here that looked like a total would be exactly
 * the "two screens disagree" failure the contract exists to prevent.
 */
export function WorkspaceDataPanel({ focus }: { focus: WorkspaceFocus }) {
  const { summary } = useWorkspace();

  if (!summary || summary.isEmpty) return null;

  const rows = FOCUS_ROWS[focus];
  const isDemo = summary.mode === 'demo';

  return (
    <Card accent={isDemo ? 'nj' : 'ny'} ariaLabelledBy="workspace-data-title">
      <CardBody>
        <div className="flex flex-wrap items-center gap-3">
          <span
            className="flex size-9 items-center justify-center rounded-control bg-canvas-sunk text-ink-soft"
            aria-hidden="true"
          >
            <Database className="size-4.5" aria-hidden="true" />
          </span>
          <CardTitle id="workspace-data-title">
            {isDemo ? 'Fictional demo workspace loaded' : 'Local workspace loaded'}
          </CardTitle>
          {isDemo ? <Badge tone="nj">Fictional demo data</Badge> : null}
        </div>

        <dl className="mt-5 grid gap-x-8 gap-y-3 sm:grid-cols-2">
          {rows.map((key) => (
            <div
              key={key}
              className="flex items-baseline justify-between gap-4 border-b border-line pb-2"
            >
              <dt className="text-sm text-ink-muted">{LABELS[key]}</dt>
              <dd className="money text-sm font-semibold text-ink">
                {summary.counts[key].toLocaleString('en-US')}
              </dd>
            </div>
          ))}

          {summary.storedDateRange ? (
            <div className="flex items-baseline justify-between gap-4 border-b border-line pb-2">
              <dt className="text-sm text-ink-muted">Stored date span</dt>
              <dd className="money text-sm font-semibold text-ink">
                {summary.storedDateRange.start} to {summary.storedDateRange.end}
              </dd>
            </div>
          ) : null}
        </dl>

        {summary.accountLabels.length > 0 ? (
          <p className="mt-4 text-sm leading-relaxed text-ink-soft">
            Accounts: {summary.accountLabels.join(', ')}
          </p>
        ) : null}

        <p className="mt-4 border-t border-line pt-4 text-xs leading-relaxed text-ink-muted">
          These are record counts, not financial totals. Net spending, money in, cash flow, savings
          rate, and budget progress are produced by the shared calculation layer, which arrives in
          Phase 5 — so this build shows nothing that could be mistaken for a computed figure.
        </p>
      </CardBody>
    </Card>
  );
}
