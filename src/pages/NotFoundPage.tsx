import { Compass } from 'lucide-react';
import { PageContainer } from '../app/layout/PageContainer';
import { ButtonLink } from '../components/ui/Button';
import { EmptyState } from '../components/ui/EmptyState';
import { PageHeader } from '../components/ui/PageHeader';
import { primaryNav, publicNav, utilityNav } from '../app/navigation';
import { useDocumentTitle } from '../lib/useDocumentTitle';

export function NotFoundPage() {
  useDocumentTitle('Page not found');

  return (
    <PageContainer>
      <PageHeader
        eyebrow="404"
        title="Page not found"
        lede="This address does not match any page in Tri-State Spending Lens."
      />
      <EmptyState
        className="mt-8"
        icon={Compass}
        title="That page does not exist"
        description="The address you followed does not match any part of this product. Nothing has gone wrong with your data — this is only a broken link."
        items={[...publicNav, ...primaryNav, ...utilityNav].map(
          (item) => `${item.label} — ${item.description}`,
        )}
        itemsLabel="Everywhere you can go"
        actions={
          <ButtonLink to="/" variant="primary">
            Back to the start
          </ButtonLink>
        }
      />
    </PageContainer>
  );
}
