import { Table2 } from 'lucide-react';
import { PageContainer } from '../../app/layout/PageContainer';
import { ButtonLink } from '../../components/ui/Button';
import { Callout } from '../../components/ui/Callout';
import { EmptyState } from '../../components/ui/EmptyState';
import { PageHeader } from '../../components/ui/PageHeader';
import { useDocumentTitle } from '../../lib/useDocumentTitle';

export function TransactionsPage() {
  useDocumentTitle('Transactions');

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Workspace"
        title="Transactions"
        lede="Search, review, categorize, and exclude individual transactions. Your corrections are permanent decisions that survive re-categorization and future imports."
        actions={
          <ButtonLink to="/import" variant="primary" size="sm">
            Import a CSV
          </ButtonLink>
        }
      />

      <div className="mt-8">
        <EmptyState
          icon={Table2}
          title="Nothing to review yet"
          description="Once transactions exist, this becomes a full review surface: a sortable, searchable grid that keeps the original bank description available forever, so a cleaned-up merchant name never hides what your statement actually said."
          items={[
            'Search by raw description or normalized merchant',
            'Filter by date, account, kind, category, tag, and inclusion',
            'Edit a category or merchant, one row at a time',
            'Mark transfers, refunds, income, card payments, fees, and cash withdrawals',
            'Include or exclude a transaction from spending totals',
            'Multi-select bulk edits, with undo for recent changes',
            'Notes and your own tags',
            'Export the filtered or full cleaned CSV',
          ]}
          status="Arrives in Phase 4 — transaction grid, merchant rules, and bulk editing."
          actions={
            <ButtonLink to="/methodology" variant="secondary" size="sm">
              How categories are chosen
            </ButtonLink>
          }
        />
      </div>

      <Callout tone="info" title="One edit will not rewrite your history" className="mt-8">
        <p>
          When you change a merchant or category, you will be offered two clearly separate actions:
          change this transaction only, or create a rule for similar transactions in future. If you
          choose the rule, the app will tell you how many existing transactions it would match and
          let you decide whether to apply it retroactively — and that action will be undoable.
        </p>
      </Callout>
    </PageContainer>
  );
}
