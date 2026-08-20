import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { TimeBucket } from '../../calculations';
import { buildTrendRows, type TrendRow } from './chartData';
import { TrendFallbackTable } from './ChartFallbackTable';
import { formatCurrency } from './format';
import { useChartsHidden } from './useChartsHidden';
import { useReducedMotion } from './useReducedMotion';

/**
 * Net spending across the selected period.
 *
 * The chart and the table below it are drawn from one `buildTrendRows` result,
 * so they cannot disagree. Nothing here sums or filters anything — the series
 * is the selector's dense output, unmodified.
 *
 * A partial bucket is marked by **shape**, not only colour: an incomplete point
 * is drawn as a hollow ring, its tooltip says so in words, and the table states
 * it in a column of its own. data-methodology.md §6 forbids drawing a partial
 * month as though it were whole, and a colour difference alone would fail that
 * for anyone who cannot see it.
 */

interface TooltipPayload {
  readonly payload?: TrendRow;
}

function TrendTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: readonly TooltipPayload[];
}) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  return (
    <div className="rounded-control border border-line-strong bg-surface p-2 shadow-card">
      <p className="text-xs font-semibold text-ink">{row.label}</p>
      <p className="money text-sm text-ink">{row.amount}</p>
      <p className="text-xs text-ink-muted">{row.completenessLabel}</p>
    </div>
  );
}

/** Hollow ring for a partial bucket, filled dot for a complete one. */
function TrendDot(props: { cx?: number; cy?: number; payload?: TrendRow }) {
  const { cx, cy, payload } = props;
  if (cx === undefined || cy === undefined || !payload) return null;
  return (
    <circle
      cx={cx}
      cy={cy}
      r={payload.isComplete ? 4 : 5}
      fill={payload.isComplete ? 'var(--color-ny)' : 'var(--color-surface)'}
      stroke="var(--color-ny)"
      strokeWidth={2}
    />
  );
}

interface NetSpendingTrendChartProps {
  readonly buckets: readonly TimeBucket[];
}

export function NetSpendingTrendChart({ buckets }: NetSpendingTrendChartProps) {
  const rows = buildTrendRows(buckets);
  const reducedMotion = useReducedMotion();
  const chartsHidden = useChartsHidden();
  const partialCount = rows.filter((row) => !row.isComplete).length;

  const summary =
    rows.length === 0
      ? 'No periods fall inside the current filters, so there is no trend to draw.'
      : rows.length === 1
        ? `A single period, ${rows[0]?.label}, at ${rows[0]?.amount}. A trend needs more than one period.`
        : `${rows.length} periods, from ${rows[0]?.label} to ${rows[rows.length - 1]?.label}.` +
          (partialCount > 0
            ? ` ${partialCount} of them ${partialCount === 1 ? 'is' : 'are'} not fully covered by statements and ${partialCount === 1 ? 'is' : 'are'} marked with a hollow point.`
            : '');

  return (
    <section aria-labelledby="trend-title" className="rounded-card border border-line bg-surface">
      <div className="p-4 sm:p-5">
        <h3 id="trend-title" className="text-base font-semibold tracking-tight text-ink">
          Net spending over time
        </h3>
        <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">{summary}</p>

        {rows.length > 0 ? (
          <>
            {/* Hidden below 360px: a chart that narrow is unreadable, and the
                table beneath is the honest presentation there. */}
            <div
              className="mt-4 hidden h-64 min-[360px]:block"
              role="img"
              aria-label={`Net spending over time. ${summary}`}
            >
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={rows as TrendRow[]} margin={{ top: 8, right: 8, bottom: 8 }}>
                  <CartesianGrid stroke="var(--color-line)" strokeDasharray="3 3" />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 11, fill: 'var(--color-ink-muted)' }}
                    stroke="var(--color-line-strong)"
                  />
                  <YAxis
                    tickFormatter={(value: number) => formatCurrency(value)}
                    tick={{ fontSize: 11, fill: 'var(--color-ink-muted)' }}
                    stroke="var(--color-line-strong)"
                    width={80}
                    // Always span zero. Left to auto-scale, an all-negative or
                    // single-point series gets a domain that excludes zero
                    // entirely — the baseline below then sits off-canvas, and a
                    // refund-heavy month reads as ordinary spending on an axis
                    // that never shows which side of zero it is on.
                    domain={[
                      (dataMin: number) => Math.min(0, dataMin),
                      (dataMax: number) => Math.max(0, dataMax),
                    ]}
                  />
                  {/* An explicit zero baseline, so a negative period reads as
                      below zero rather than merely lower than its neighbours. */}
                  <ReferenceLine y={0} stroke="var(--color-ink-muted)" strokeWidth={1} />
                  <Tooltip content={<TrendTooltip />} />
                  <Line
                    type="linear"
                    dataKey="netCents"
                    stroke="var(--color-ny)"
                    strokeWidth={2}
                    dot={<TrendDot />}
                    activeDot={{ r: 6 }}
                    isAnimationActive={!reducedMotion}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* Open when the chart cannot stand in for it: below 360px the chart
                is hidden outright, and a single period is not a trend. In both
                cases the table is the presentation, not an alternative to one. */}
            <details className="mt-4 min-[360px]:mt-3" open={chartsHidden || rows.length <= 1}>
              <summary className="cursor-pointer rounded-control py-1 text-sm font-medium text-ny focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">
                Net spending over time, as a table
              </summary>
              <div className="mt-3">
                <TrendFallbackTable
                  rows={rows}
                  caption="Net spending for each period in the selected range, with whether statements fully cover it."
                />
              </div>
            </details>
          </>
        ) : null}
      </div>
    </section>
  );
}
