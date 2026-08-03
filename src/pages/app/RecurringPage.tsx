import { RefreshCw } from 'lucide-react';
import { PageContainer } from '../../app/layout/PageContainer';
import { useHasWorkspaceData } from '../../app/providers/workspaceContext';
import { WorkspaceDataPanel } from '../../components/workspace/WorkspaceDataPanel';
import { ButtonLink } from '../../components/ui/Button';
import { Callout } from '../../components/ui/Callout';
import { EmptyState } from '../../components/ui/EmptyState';
import { PageHeader } from '../../components/ui/PageHeader';
import { useDocumentTitle } from '../../lib/useDocumentTitle';

export function RecurringPage() {
  useDocumentTitle('Recurring');
  const hasData = useHasWorkspaceData();

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Workspace"
        title="Recurring charges"
        lede="Repeated payments the product believes it has spotted, each shown with its evidence, a confidence label, and controls to correct it."
        actions={
          <ButtonLink to="/import" variant="primary" size="sm">
            Import a CSV
          </ButtonLink>
        }
      />

      {hasData ? (
        <div className="mt-8">
          <WorkspaceDataPanel focus="recurring" />
        </div>
      ) : null}

      <div className="mt-8">
        <EmptyState
          icon={RefreshCw}
          title={
            hasData ? 'The recurring view is not built yet' : 'No recurring charges detected yet'
          }
          description="Detection needs several months of transactions before it can distinguish a genuine pattern from a coincidence. Until then, this page stays empty rather than guessing."
          items={[
            'Merchant and likely cadence: weekly through annual',
            'Typical amount, or a range when the amount varies',
            'Last charge and expected next charge',
            'Estimated annualized cost, using the detected cadence',
            'A flag when a charge appears to have gone up, showing both amounts',
            'Confidence of high, medium, or low — with the reasoning shown',
            'Confirm, reject, merge, split, recategorize, or exclude any series',
          ]}
          status="Arrives in Phase 6 — recurring detection, confidence, and annualized cost."
        />
      </div>

      <Callout
        tone="caution"
        title="A detected series is a suggestion, not a fact"
        className="mt-8"
      >
        <p>
          Every series here will be a hypothesis you can correct, and your correction will stick.
          Note also that not everything repeated is a subscription: rent, insurance, and utilities
          recur too, so the product calls these recurring charges rather than lumping them together
          as subscriptions.
        </p>
      </Callout>
    </PageContainer>
  );
}
