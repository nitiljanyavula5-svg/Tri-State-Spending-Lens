import type { ReconciliationReport } from '../../calculations';
import { Callout } from '../ui/Callout';
import { formatCount } from './format';

/**
 * Whether the figures on this page agree with each other.
 *
 * The Phase 5 exit condition is that cards, charts, and tables reconcile
 * exactly under every fixture. `selection.reconciliation` proves that on every
 * render, and this region makes the proof visible rather than leaving it a
 * property only the test suite ever sees.
 *
 * `expected` and `actual` are integer-cent totals and row counts — aggregates,
 * never a transaction amount and never a record. A failing check names the
 * invariant, not the data behind it.
 */

/** One string for the table's caption and its scroll region's name, so they cannot drift. */
const CHECKS_CAPTION = 'Each invariant, whether it holds, and the two aggregates compared.';

interface ReconciliationDisclosureProps {
  readonly report: ReconciliationReport;
}

export function ReconciliationDisclosure({ report }: ReconciliationDisclosureProps) {
  const failures = report.failures.length;

  return (
    <section
      aria-labelledby="reconciliation-title"
      className="rounded-card border border-line bg-surface p-4 sm:p-5"
    >
      <h3 id="reconciliation-title" className="text-base font-semibold tracking-tight text-ink">
        How these totals reconcile
      </h3>

      {report.holds ? (
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">
          Totals reconcile. All {formatCount(report.checks.length)} checks pass: the category,
          account, and time-period breakdowns each add up to net spending exactly, and every
          transaction is counted once.
        </p>
      ) : (
        <div className="mt-3">
          <Callout tone="caution" title="These totals do not reconcile">
            <p>
              {formatCount(failures)} of {formatCount(report.checks.length)}{' '}
              {failures === 1 ? 'check' : 'checks'} did not hold, so the figures on this page cannot
              be relied on. Charts and the month comparison are withheld while that is true. The
              checks below say which invariant broke.
            </p>
          </Callout>
        </div>
      )}

      <details className="mt-3">
        <summary className="cursor-pointer rounded-control py-1 text-sm font-medium text-ny focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">
          Show all {formatCount(report.checks.length)} checks
        </summary>
        {/* Focusable and named for the same reason the fallback tables are:
            a scrolling box no keyboard can reach is not an alternative. */}
        <div
          className="mt-3 overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          tabIndex={0}
          role="region"
          aria-label={CHECKS_CAPTION}
        >
          <table className="w-full min-w-72 border-collapse">
            <caption className="pb-2 text-left text-sm text-ink-soft">{CHECKS_CAPTION}</caption>
            <thead>
              <tr className="border-b border-line">
                <th
                  scope="col"
                  className="px-3 py-2 text-left text-xs font-medium uppercase tracking-[0.08em] text-ink-muted"
                >
                  Check
                </th>
                <th
                  scope="col"
                  className="px-3 py-2 text-left text-xs font-medium uppercase tracking-[0.08em] text-ink-muted"
                >
                  Result
                </th>
                <th
                  scope="col"
                  className="px-3 py-2 text-right text-xs font-medium uppercase tracking-[0.08em] text-ink-muted"
                >
                  Expected
                </th>
                <th
                  scope="col"
                  className="px-3 py-2 text-right text-xs font-medium uppercase tracking-[0.08em] text-ink-muted"
                >
                  Actual
                </th>
              </tr>
            </thead>
            <tbody>
              {report.checks.map((check) => (
                <tr key={check.name} className="border-b border-line/60">
                  <th scope="row" className="px-3 py-2 text-left text-sm font-normal text-ink">
                    {check.name}
                  </th>
                  <td className="px-3 py-2 text-sm text-ink">
                    {/* Words, not a colour or an icon alone. */}
                    {check.holds ? 'Passes' : 'Does not hold'}
                  </td>
                  <td className="money px-3 py-2 text-right text-sm text-ink-soft">
                    {check.expected}
                  </td>
                  <td className="money px-3 py-2 text-right text-sm text-ink-soft">
                    {check.actual}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
