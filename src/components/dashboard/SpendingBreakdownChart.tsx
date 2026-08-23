import { useId, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { DashboardSelection } from '../../calculations';
import { getCategory } from '../../domain/categories';
import { buildBreakdownRows, type BreakdownRow } from './chartData';
import { BreakdownFallbackTable } from './ChartFallbackTable';
import { formatCurrency } from './format';
import { useChartsHidden } from './useChartsHidden';
import { useReducedMotion } from './useReducedMotion';

/**
 * Where the spending went, by category or by account.
 *
 * Horizontal bars rather than a pie: a pie cannot render a negative slice, and
 * a cross-period refund produces exactly that (calculation-contract.md §5.3).
 * Bars also give long category and account names somewhere to sit.
 *
 * Switching between category and account re-reads a *different selector output*
 * — it never re-filters or re-sums transactions. Both breakdowns were computed
 * from the same population in the same pass.
 */

interface TooltipPayload {
  readonly payload?: BreakdownRow;
}

function BreakdownTooltip({
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
      {row.isCollapsed ? (
        <p className="text-xs text-ink-muted">Combines {row.entryCount} smaller entries</p>
      ) : null}
    </div>
  );
}

export type BreakdownDimension = 'category' | 'account';

interface SpendingBreakdownChartProps {
  readonly selection: DashboardSelection;
  readonly accountLabels: ReadonlyMap<string, string>;
}

export function SpendingBreakdownChart({ selection, accountLabels }: SpendingBreakdownChartProps) {
  const [dimension, setDimension] = useState<BreakdownDimension>('category');
  const reducedMotion = useReducedMotion();
  const chartsHidden = useChartsHidden();
  const groupId = useId();

  const rows =
    dimension === 'category'
      ? buildBreakdownRows(selection.byCategory, (key) => getCategory(key)?.label ?? key)
      : buildBreakdownRows(selection.byAccount, (key) => accountLabels.get(key) ?? key);

  const heading = dimension === 'category' ? 'Category' : 'Account';
  const summary =
    rows.length === 0
      ? 'No spending in this period, so there is nothing to break down.'
      : `${rows.length} ${rows.length === 1 ? 'row' : 'rows'}, largest first, totalling ${formatCurrency(
          selection.netSpending.netSpendingCents,
        )}.`;

  return (
    <section
      aria-labelledby="breakdown-title"
      className="rounded-card border border-line bg-surface"
    >
      <div className="p-4 sm:p-5">
        <h3 id="breakdown-title" className="text-base font-semibold tracking-tight text-ink">
          Where the spending went
        </h3>

        <fieldset className="mt-3">
          <legend className="text-xs font-medium text-ink-muted">Break down by</legend>
          <div className="mt-1.5 flex flex-wrap gap-3">
            {(['category', 'account'] as const).map((value) => (
              <div key={value} className="flex items-center gap-2">
                <input
                  id={`${groupId}-${value}`}
                  type="radio"
                  name={`${groupId}-dimension`}
                  value={value}
                  checked={dimension === value}
                  onChange={() => setDimension(value)}
                  className="size-4 shrink-0 accent-ink"
                />
                <label
                  htmlFor={`${groupId}-${value}`}
                  className="cursor-pointer py-1 text-sm text-ink"
                >
                  {value === 'category' ? 'Category' : 'Account'}
                </label>
              </div>
            ))}
          </div>
        </fieldset>

        <p className="mt-3 text-sm leading-relaxed text-ink-soft">{summary}</p>

        {rows.length > 0 ? (
          <>
            <div
              className="mt-4 hidden min-[360px]:block"
              style={{ height: Math.max(160, rows.length * 40) }}
              role="img"
              aria-label={`Net spending by ${dimension}. ${summary}`}
            >
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={rows as BreakdownRow[]}
                  layout="vertical"
                  margin={{ top: 4, right: 16, bottom: 4, left: 8 }}
                >
                  <CartesianGrid
                    stroke="var(--color-line)"
                    strokeDasharray="3 3"
                    horizontal={false}
                  />
                  <XAxis
                    type="number"
                    tickFormatter={(value: number) => formatCurrency(value)}
                    tick={{ fontSize: 11, fill: 'var(--color-ink-muted)' }}
                    stroke="var(--color-line-strong)"
                    // Always span zero, so bars read as left or right of it.
                    // An all-negative breakdown would otherwise be drawn on an
                    // axis that never shows zero, making returned money look
                    // like ordinary spending.
                    domain={[
                      (dataMin: number) => Math.min(0, dataMin),
                      (dataMax: number) => Math.max(0, dataMax),
                    ]}
                  />
                  <YAxis
                    type="category"
                    dataKey="label"
                    width={120}
                    tick={{ fontSize: 11, fill: 'var(--color-ink-muted)' }}
                    stroke="var(--color-line-strong)"
                  />
                  {/* Zero baseline, so a negative bar reads as money returned. */}
                  <ReferenceLine x={0} stroke="var(--color-ink-muted)" strokeWidth={1} />
                  <Tooltip content={<BreakdownTooltip />} cursor={false} />
                  <Bar dataKey="netCents" isAnimationActive={!reducedMotion}>
                    {rows.map((row) => (
                      // Identity comes from the labelled axis, not the fill.
                      // The collapsed row is outlined so it reads as different
                      // in kind even before the label is read.
                      <Cell
                        key={row.key}
                        fill={row.netCents < 0 ? 'var(--color-pa)' : 'var(--color-ny)'}
                        stroke={row.isCollapsed ? 'var(--color-ink)' : 'none'}
                        strokeWidth={row.isCollapsed ? 2 : 0}
                        strokeDasharray={row.isCollapsed ? '4 2' : undefined}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Below 360px the chart is hidden, so this table is the only
                presentation of the figures and must not start collapsed. */}
            <details className="mt-4 min-[360px]:mt-3" open={chartsHidden}>
              <summary className="cursor-pointer rounded-control py-1 text-sm font-medium text-ny focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">
                Spending by {dimension}, as a table
              </summary>
              <div className="mt-3">
                <BreakdownFallbackTable
                  rows={rows}
                  headingLabel={heading}
                  caption={`Net spending by ${dimension}, largest first. These are the same rows the chart shows.`}
                />
              </div>
            </details>
          </>
        ) : null}
      </div>
    </section>
  );
}
