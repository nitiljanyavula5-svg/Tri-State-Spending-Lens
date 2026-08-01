import { SlidersHorizontal } from 'lucide-react';
import { PageContainer } from '../../app/layout/PageContainer';
import { ButtonLink } from '../../components/ui/Button';
import { Callout } from '../../components/ui/Callout';
import { Card, CardBody, CardTitle } from '../../components/ui/Card';
import { EmptyState } from '../../components/ui/EmptyState';
import { PageHeader } from '../../components/ui/PageHeader';
import { useDocumentTitle } from '../../lib/useDocumentTitle';

const SECTIONS = [
  {
    id: 'accounts',
    title: 'Accounts',
    detail:
      'Label each imported account and set its type — checking, savings, credit card, cash, or other — so transfers and card payments can be recognized rather than counted twice.',
  },
  {
    id: 'merchant-rules',
    title: 'Merchant rules',
    detail:
      'Review the rules you have created, see how many transactions each one matches, change its priority, or remove it. Patterns are matched literally, never as code.',
  },
  {
    id: 'backup-restore',
    title: 'Backup and restore',
    detail:
      'Download the whole workspace as a versioned JSON file, or restore one. A restore validates the file before touching anything, so a damaged backup cannot destroy good data.',
  },
  {
    id: 'storage',
    title: 'Storage',
    detail:
      'How much space the workspace uses, what browser eviction means for it, and an optional request to mark the storage as persistent.',
  },
  {
    id: 'delete-all',
    title: 'Delete all data',
    detail:
      'Clear every transaction, budget, rule, and setting after an explicit confirmation. There is nothing stored on a server to delete, and the product will not pretend otherwise.',
  },
] as const;

export function SettingsPage() {
  useDocumentTitle('Settings');

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Utility"
        title="Settings"
        lede="Accounts, merchant rules, backup and restore, storage, and the delete-all control."
      />

      <div className="mt-8">
        <EmptyState
          icon={SlidersHorizontal}
          title="Nothing to configure yet"
          description="These settings act on a local workspace that does not exist in this build. They are described below rather than rendered as controls, because a backup button that silently does nothing is worse than no button at all."
          status="Arrives in Phase 2 — local database, delete, and basic backup and restore."
          actions={
            <ButtonLink to="/privacy" variant="secondary" size="sm">
              Read the privacy model
            </ButtonLink>
          }
        />
      </div>

      <div className="mt-8 grid gap-4 lg:grid-cols-2">
        {SECTIONS.map((section) => (
          <Card key={section.id} ariaLabelledBy={`setting-${section.id}`}>
            <CardBody>
              <CardTitle id={`setting-${section.id}`} as="h3">
                {section.title}
              </CardTitle>
              <p className="mt-2 text-sm leading-relaxed text-ink-soft">{section.detail}</p>
            </CardBody>
          </Card>
        ))}
      </div>

      <Callout tone="caution" title="Back up before you rely on this" className="mt-8">
        <p>
          A local-first workspace is private but not indestructible. Clearing site data, browsing
          privately, or a browser reclaiming space can all remove what is stored here. Downloading a
          backup before a large import or a browser change is the only reliable protection.
        </p>
      </Callout>
    </PageContainer>
  );
}
