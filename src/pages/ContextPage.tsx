import { Map as MapIcon } from 'lucide-react';
import { PageContainer } from '../app/layout/PageContainer';
import { Callout } from '../components/ui/Callout';
import { Card, CardBody, CardTitle } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { useDocumentTitle } from '../lib/useDocumentTitle';

const PLANNED_VIEWS = [
  'Spending by state — per-capita personal consumption expenditures for NJ, NY, and PA',
  'Category mix — selected state PCE categories with a documented crosswalk',
  'Price-level lens — Regional Price Parities for the three states',
  'Inflation trend — metro CPI, labelled by its actual metro geography',
  '“What does $100 feel like?” — an educational purchasing-power comparison',
  'A source panel on every chart: dataset, geography, unit, period, and limits',
] as const;

/** Every public-data chart must display all of these (master plan §7.9). */
const REQUIRED_METADATA = [
  'Source organization',
  'Dataset and series or table identifier',
  'Geography',
  'Unit',
  'Frequency',
  'Observation period',
  'Release or update date',
  'Link to the source',
  'Short limitation note',
] as const;

export function ContextPage() {
  useDocumentTitle('Tri-State Context');

  return (
    <PageContainer>
      <div className="border-b border-line pb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-muted">
          Public data
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
          Tri-State Context
        </h1>
        <p className="mt-2 max-w-2xl text-base leading-relaxed text-ink-soft">
          Trustworthy cost and spending data for New Jersey, New York, and Pennsylvania. This
          section is explanatory: it never blends into your personal totals, and a state average is
          never presented as the right amount for you to spend.
        </p>
      </div>

      <div className="mt-8">
        <EmptyState
          icon={MapIcon}
          title="Regional data is not loaded yet"
          description="Official figures are retrieved by development scripts, validated, and shipped as versioned static JSON with the site. Nothing on this page will ever be fetched from BEA or BLS by your browser."
          items={PLANNED_VIEWS}
          status="Arrives in Phase 7 — BEA and BLS snapshot pipeline, series registry, and source panels."
        />
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <Card accent="ny" ariaLabelledBy="sources-title">
          <CardBody>
            <CardTitle id="sources-title">Planned sources</CardTitle>
            <dl className="mt-4 space-y-4 text-sm leading-relaxed">
              <div>
                <dt className="font-semibold text-ink">BEA — state personal consumption</dt>
                <dd className="text-ink-soft">
                  Per-capita and category spending by state, published annually.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-ink">BEA — Regional Price Parities</dt>
                <dd className="text-ink-soft">
                  Comparable state and metro price levels, including housing rents.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-ink">BLS — metro Consumer Price Index</dt>
                <dd className="text-ink-soft">
                  New York–Newark–Jersey City and Philadelphia–Camden–Wilmington.
                </dd>
              </div>
            </dl>
          </CardBody>
        </Card>

        <Card ariaLabelledBy="metadata-title">
          <CardBody>
            <CardTitle id="metadata-title">Every chart will show its provenance</CardTitle>
            <p className="mt-2 text-sm leading-relaxed text-ink-soft">
              A chart without its source is an assertion. Each one must carry:
            </p>
            <ul className="mt-3 grid gap-1.5 sm:grid-cols-2">
              {REQUIRED_METADATA.map((field) => (
                <li key={field} className="flex gap-2 text-sm text-ink-soft">
                  <span
                    aria-hidden="true"
                    className="mt-2 size-1.5 shrink-0 rounded-full bg-line-control"
                  />
                  {field}
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      </div>

      <Callout
        tone="caution"
        title="Two comparisons this section will refuse to make"
        className="mt-8"
      >
        <p>
          New Jersey has no standalone statewide CPI, so none will be shown or implied; metro series
          are labelled by their real metro geographies. And a single household&apos;s category share
          is not comparable to BEA personal consumption data, whose definitions and populations are
          different — any category comparison requires a documented crosswalk and a visible
          limitation note.
        </p>
      </Callout>
    </PageContainer>
  );
}
