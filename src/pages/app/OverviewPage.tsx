import { lazy, Suspense } from 'react';
import { LayoutDashboard } from 'lucide-react';
import { PageContainer } from '../../app/layout/PageContainer';
import { useWorkspace } from '../../app/providers/workspaceContext';
import { ButtonLink } from '../../components/ui/Button';
import { Callout } from '../../components/ui/Callout';
import { EmptyState } from '../../components/ui/EmptyState';
import { PageHeader } from '../../components/ui/PageHeader';
import { WorkspaceDataPanel } from '../../components/workspace/WorkspaceDataPanel';
import { Button } from '../../components/ui/Button';
import { DashboardFilterBar } from '../../components/dashboard/DashboardFilterBar';
import { DataQualityBanner } from '../../components/dashboard/DataQualityBanner';
import { MonthComparison } from '../../components/dashboard/MonthComparison';
import { ReconciliationDisclosure } from '../../components/dashboard/ReconciliationDisclosure';
import { SummaryCards } from '../../components/dashboard/SummaryCards';
import { useDashboard } from '../../review/useDashboard';
import { describePeriod } from '../../review/dashboardPeriod';
import { useDocumentTitle } from '../../lib/useDocumentTitle';

/**
 * The Overview dashboard.
 *
 * Every figure on this page comes from one `useDashboard` call, which is the
 * only boundary between Dexie and the calculation layer. The page itself does no
 * arithmetic and never reads the database.
 *
 * The document title is a constant. privacy-model.md keeps personal values out
 * of titles and URLs, and a title carrying the selected period or an account
 * name would leak the workspace into the browser's history and tab list.
 */

/**
 * The chart components, loaded on demand.
 *
 * Recharts is ~370 kB of the bundle and is used on this page alone — and only
 * once a workspace has data whose totals reconcile. Statically importing it put
 * that weight in front of the landing page, the import wizard, and every other
 * route. `lazy` is the smallest pattern that fixes it: no new loading
 * architecture, just a boundary where one already existed.
 *
 * The named exports are mapped to `default` because that is what `lazy` takes;
 * the components themselves are unchanged and still tested directly.
 */
const NetSpendingTrendChart = lazy(() =>
  import('../../components/dashboard/NetSpendingTrendChart').then((module) => ({
    default: module.NetSpendingTrendChart,
  })),
);

const SpendingBreakdownChart = lazy(() =>
  import('../../components/dashboard/SpendingBreakdownChart').then((module) => ({
    default: module.SpendingBreakdownChart,
  })),
);

/** Holds the region's height while the chart module arrives, so nothing jumps. */
function ChartLoading() {
  return (
    <div className="min-h-40 rounded-card border border-line bg-surface p-4 sm:p-5">
      <p className="text-sm text-ink-soft">Loading chart…</p>
    </div>
  );
}

export function OverviewPage() {
  useDocumentTitle('Overview');
  const { db } = useWorkspace();
  const dashboard = useDashboard({ db });

  const { status, selection } = dashboard;
  const period =
    selection === null
      ? ''
      : describePeriod(dashboard.preset, dashboard.filters.range, dashboard.domain);

  const noResults = selection !== null && selection.population.length === 0;

  /**
   * Whether the figures may be presented as trustworthy.
   *
   * The reconciliation report proves on every render that the breakdowns add up
   * to net spending. If it does not hold, the honest response is to withhold the
   * figures rather than keep drawing them — a chart built on totals that
   * disagree with the cards would present a contradiction as a finding.
   */
  const trustworthy = selection !== null && selection.reconciliation.holds;

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Workspace"
        title="Overview"
        lede="Your spending for the selected period. Every figure traces back to the transactions behind it, and anything that cannot be computed honestly stays hidden with an explanation."
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

      {/* One polite live region for asynchronous state, so a screen reader hears
          the page settle without being told about every keystroke. */}
      <div role="status" aria-live="polite" className="sr-only">
        {status === 'loading' ? 'Loading your workspace.' : null}
        {status === 'ready' && noResults ? 'No transactions match the current filters.' : null}
        {status === 'failed' ? 'The workspace could not be read.' : null}
      </div>

      {status === 'failed' ? (
        <Callout tone="caution" title="This workspace could not be read" className="mt-8">
          <p>{dashboard.errorMessage}</p>
          <div className="mt-3">
            {/* Re-runs the whole read. Nothing partial is shown while it runs:
                the hook stays failed until a complete read succeeds. */}
            <Button type="button" variant="secondary" size="sm" onClick={dashboard.retry}>
              Retry
            </Button>
          </div>
        </Callout>
      ) : null}

      {status === 'loading' ? (
        // Reserves the region the cards will occupy, so arriving data does not
        // shove the page down.
        <div className="mt-8 min-h-40 rounded-card border border-line bg-surface p-5">
          <p className="text-sm text-ink-soft">Loading your workspace…</p>
        </div>
      ) : null}

      {status === 'empty' ? (
        <div className="mt-8">
          <EmptyState
            icon={LayoutDashboard}
            title="No transactions in this workspace yet"
            description="Import a CSV or load the fictional demo workspace, and this page fills in. Every figure will trace back to the transactions behind it, and any total that cannot be computed honestly stays hidden with an explanation instead of showing a zero."
            status="Nothing is calculated from an empty workspace — no date range is assumed and no total is invented."
          />
        </div>
      ) : null}

      {status === 'ready' && selection !== null ? (
        <>
          {/* Record counts and demo status, from Phase 2. Kept alongside the
              figures rather than replaced by them: it answers "what is stored",
              which is a different question from "what did I spend". */}
          <div className="mt-8">
            <WorkspaceDataPanel focus="overview" />
          </div>

          <DashboardFilterBar dashboard={dashboard} />

          <DataQualityBanner
            flags={selection.dataQuality}
            accountLabels={dashboard.accountLabels}
          />

          <section aria-labelledby="summary-title" className="mt-10">
            <h2 id="summary-title" className="text-lg font-semibold tracking-tight text-ink">
              Summary
            </h2>
            <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">
              {period ? `Showing ${period}.` : null} A figure that cannot be computed honestly is
              shown as unavailable with the reason, never as a zero.
            </p>

            <div className="mt-4">
              {noResults ? (
                <Callout tone="info" title="No transactions match these filters">
                  <p>
                    Nothing in this workspace falls inside the selected period and filters. Adjust
                    or reset the filters to see figures again.
                  </p>
                </Callout>
              ) : trustworthy ? (
                <SummaryCards
                  selection={selection}
                  period={period}
                  budgetRemaining={dashboard.budgetRemaining}
                />
              ) : (
                <Callout tone="caution" title="These totals do not reconcile">
                  <p>
                    The internal consistency checks did not hold for this selection, so the figures
                    are withheld rather than shown as though they were trustworthy. The
                    reconciliation section below lists which check broke.
                  </p>
                </Callout>
              )}
            </div>
          </section>

          {!noResults ? (
            <section aria-labelledby="detail-title" className="mt-10">
              <h2 id="detail-title" className="text-lg font-semibold tracking-tight text-ink">
                Detail
              </h2>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">
                Every chart below carries an exact table of the same figures, so nothing here is
                readable only as a picture.
              </p>

              <div className="mt-4 space-y-4">
                {/* Withheld when the invariants do not hold: a chart drawn from
                    figures that disagree with the cards above would present a
                    contradiction as though it were a finding. */}
                {trustworthy ? (
                  <>
                    <MonthComparison comparison={selection.comparison} />
                    <Suspense fallback={<ChartLoading />}>
                      <NetSpendingTrendChart buckets={selection.timeSeries} />
                      <SpendingBreakdownChart
                        selection={selection}
                        accountLabels={dashboard.accountLabels}
                      />
                    </Suspense>
                  </>
                ) : null}

                <ReconciliationDisclosure report={selection.reconciliation} />
              </div>
            </section>
          ) : null}
        </>
      ) : null}
    </PageContainer>
  );
}
