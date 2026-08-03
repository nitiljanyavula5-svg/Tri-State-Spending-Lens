import { Target } from 'lucide-react';
import { PageContainer } from '../../app/layout/PageContainer';
import { useHasWorkspaceData } from '../../app/providers/workspaceContext';
import { WorkspaceDataPanel } from '../../components/workspace/WorkspaceDataPanel';
import { ButtonLink } from '../../components/ui/Button';
import { Callout } from '../../components/ui/Callout';
import { EmptyState } from '../../components/ui/EmptyState';
import { PageHeader } from '../../components/ui/PageHeader';
import { useDocumentTitle } from '../../lib/useDocumentTitle';

export function BudgetPage() {
  useDocumentTitle('Budget');
  const hasData = useHasWorkspaceData();

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Workspace"
        title="Budget"
        lede="A deliberately simple monthly plan: one overall limit, optional category limits, and optional income and savings targets."
        actions={
          <ButtonLink to="/import" variant="primary" size="sm">
            Import a CSV
          </ButtonLink>
        }
      />

      {hasData ? (
        <div className="mt-8">
          <WorkspaceDataPanel focus="budget" />
        </div>
      ) : null}

      <div className="mt-8">
        <EmptyState
          icon={Target}
          title={hasData ? 'Budget screens are not built yet' : 'No plan for this month yet'}
          description="Budgeting works even without income data — in that case the product focuses on spending limits and hides any cash-flow or savings-rate claim rather than guessing at one."
          items={[
            'An overall monthly spending limit',
            'Optional per-category limits',
            'Optional monthly income and savings targets',
            'Copy last month’s plan as a starting point',
            'Edit a future month before it begins',
            'Budget-versus-actual progress for every category',
            'A pace indicator based on how much of the month has elapsed',
            'Alerts inside the product only — no email, no push notifications',
          ]}
          status="Arrives in Phase 6 — monthly plans, pace, and category targets."
        />
      </div>

      <Callout tone="info" title="Two things this budget will not do" className="mt-8">
        <p>
          Unspent money will not roll over into the next month in this version, and the language
          will stay neutral: you will see “you have used 62% of your Dining budget with 48% of the
          month elapsed,” never a judgement about whether that spending was wasteful.
        </p>
      </Callout>
    </PageContainer>
  );
}
