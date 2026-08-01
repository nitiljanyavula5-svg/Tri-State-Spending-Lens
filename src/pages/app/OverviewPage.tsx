import { LayoutDashboard } from 'lucide-react';
import { PageContainer } from '../../app/layout/PageContainer';
import { ButtonLink } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { PageHeader } from '../../components/ui/PageHeader';
import { PlaceholderMetric, PlaceholderPanel } from '../../components/ui/Placeholder';
import { useDocumentTitle } from '../../lib/useDocumentTitle';

/** The summary cards specified in master plan §7.5. None of them can have a value yet. */
const SUMMARY_CARDS = [
  { label: 'Net spending', note: 'Purchases, fees, and cash out, minus refunds.' },
  { label: 'Money in', note: 'Income only. Refunds and transfers are not income.' },
  { label: 'Net cash flow', note: 'Hidden until income data exists.' },
  { label: 'Budget remaining', note: 'Appears once a monthly limit is set.' },
  { label: 'Savings rate', note: 'Undefined without income; never shown as 0%.' },
  { label: 'Largest category', note: 'Needs at least one included transaction.' },
  { label: 'Possible recurring monthly cost', note: 'A suggestion, not a bill.' },
  { label: 'Transactions analyzed', note: 'Counts every included transaction.' },
] as const;

const PANELS = [
  {
    title: 'Monthly net-spending trend',
    description:
      'Complete calendar months only. A partial month is never drawn as if it were whole.',
  },
  {
    title: 'Category breakdown',
    description:
      'With the uncategorized share called out, so an “Other” spike is never mistaken for behaviour.',
  },
  {
    title: 'Budget versus actual by category',
    description: 'Progress against each category limit, with pace relative to the elapsed month.',
  },
  {
    title: 'Top merchants',
    description: 'Grouped by normalized merchant, with the original description always reachable.',
  },
  {
    title: 'Fixed versus variable spending',
    description:
      'Using your own classification, since the same category means different things to different people.',
  },
  {
    title: 'Essential versus discretionary spending',
    description: 'A planning distinction, never a judgement about how you spend.',
  },
  {
    title: 'Weekday and calendar pattern',
    description: 'When spending clusters across the week and the month.',
  },
  {
    title: 'Recent large or unusual purchases',
    description: 'Only when there is enough history to say what “usual” means for that merchant.',
  },
] as const;

export function OverviewPage() {
  useDocumentTitle('Overview');

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Workspace"
        title="Overview"
        lede="Your current month at a glance, with an easy switch to the previous month, the last 90 days, year to date, or a custom range."
        actions={
          <>
            <ButtonLink to="/import" variant="primary" size="sm">
              Import a CSV
            </ButtonLink>
            <ButtonLink to="/methodology" variant="secondary" size="sm">
              How these are calculated
            </ButtonLink>
          </>
        }
      />

      <div className="mt-8">
        <EmptyState
          icon={LayoutDashboard}
          title="No transactions in this workspace yet"
          description="Import a CSV or load the fictional demo workspace, and this page fills in. Every figure will trace back to the transactions behind it, and any total that cannot be computed honestly stays hidden with an explanation instead of showing a zero."
          status="The local database and demo dataset arrive in Phase 2; the calculations behind these cards arrive in Phase 5."
        />
      </div>

      <section aria-labelledby="summary-title" className="mt-10">
        <h2 id="summary-title" className="text-lg font-semibold tracking-tight text-ink">
          Summary cards
        </h2>
        <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">
          These slots are reserved and deliberately empty. A placeholder zero in a financial summary
          is indistinguishable from a measured result.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {SUMMARY_CARDS.map((card) => (
            <PlaceholderMetric key={card.label} label={card.label} note={card.note} />
          ))}
        </div>
      </section>

      <section aria-labelledby="panels-title" className="mt-10">
        <h2 id="panels-title" className="text-lg font-semibold tracking-tight text-ink">
          Charts and panels
        </h2>
        <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">
          Each region below is reserved for a chart. Nothing decorative is drawn in the meantime — a
          sample graph would imply data this workspace does not have. Every chart will offer an
          accessible data-table alternative and will never rely on colour alone.
        </p>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          {PANELS.map((panel) => (
            <PlaceholderPanel
              key={panel.title}
              title={panel.title}
              description={panel.description}
            />
          ))}
        </div>
      </section>
    </PageContainer>
  );
}
