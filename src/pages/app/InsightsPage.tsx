import { Lightbulb } from 'lucide-react';
import { PageContainer } from '../../app/layout/PageContainer';
import { ButtonLink } from '../../components/ui/Button';
import { Callout } from '../../components/ui/Callout';
import { EmptyState } from '../../components/ui/EmptyState';
import { PageHeader } from '../../components/ui/PageHeader';
import { useDocumentTitle } from '../../lib/useDocumentTitle';

export function InsightsPage() {
  useDocumentTitle('Insights');

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Workspace"
        title="Insights"
        lede="Plain observations produced by fixed local rules. Every card explains why you are seeing it and links to the transactions behind it."
        actions={
          <ButtonLink to="/import" variant="primary" size="sm">
            Import a CSV
          </ButtonLink>
        }
      />

      <div className="mt-8">
        <EmptyState
          icon={Lightbulb}
          title="No observations yet"
          description="Insights need enough history to say something true. A card that cannot meet its evidence requirement is withheld rather than softened with a hedge."
          items={[
            'Spending pace against the elapsed part of the month',
            'Category shift versus the previous complete month',
            'Estimated yearly cost of your recurring payments',
            'A recurring charge that appears to have increased',
            'Spending unusually concentrated at one merchant or category',
            'A purchase far above the recent range for that merchant',
            'A month-in-review summary once a month closes',
            'A warning when the imported data covers only part of a month',
          ]}
          status="Arrives in Phase 6 — rule-based insights and month in review."
        />
      </div>

      <Callout tone="privacy" title="No AI reads your transactions" className="mt-8">
        <p>
          These observations come from deterministic rules running on your device, not from a
          language model. Your descriptions and amounts are never sent anywhere to be interpreted.
          The trade-off is deliberate: an insight you can check beats one you have to trust.
        </p>
      </Callout>
    </PageContainer>
  );
}
