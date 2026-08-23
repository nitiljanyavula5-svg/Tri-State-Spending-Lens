import type { BreakdownRow, TrendRow } from './chartData';

/**
 * The semantic equivalent of a chart.
 *
 * A chart cannot expose every datum to assistive technology, and master plan
 * §13 accepts that only because an exact table is immediately available. These
 * tables are built from the *same adapter rows* the chart draws, so "the same
 * figures" is structural rather than a promise someone has to keep.
 *
 * Amounts are right-aligned and already formatted; completeness is stated in
 * words, never by colour alone.
 *
 * Both scroll containers are focusable and named, the same shape
 * `PreviewTable` uses. An `overflow-x: auto` box that cannot take focus is
 * unreachable for anyone scrolling by keyboard, and these tables always
 * overflow on a narrow screen — which is exactly where they replace the chart
 * rather than merely accompany it. The caption names the region, so the focus
 * stop announces what it landed on instead of being a bare tab stop.
 */

const CELL = 'px-3 py-2 text-sm';
const HEAD = 'px-3 py-2 text-left text-xs font-medium uppercase tracking-[0.08em] text-ink-muted';

interface TrendTableProps {
  readonly rows: readonly TrendRow[];
  readonly caption: string;
}

export function TrendFallbackTable({ rows, caption }: TrendTableProps) {
  return (
    <div
      className="overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
      tabIndex={0}
      role="region"
      aria-label={caption}
    >
      <table className="w-full min-w-72 border-collapse">
        <caption className="pb-2 text-left text-sm text-ink-soft">{caption}</caption>
        <thead>
          <tr className="border-b border-line">
            <th scope="col" className={HEAD}>
              Period
            </th>
            <th scope="col" className={`${HEAD} text-right`}>
              Net spending
            </th>
            <th scope="col" className={HEAD}>
              Statement coverage
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-b border-line/60">
              <th scope="row" className={`${CELL} text-left font-normal text-ink`}>
                {row.label}
              </th>
              <td className={`money ${CELL} text-right text-ink`}>{row.amount}</td>
              <td className={`${CELL} text-ink-soft`}>{row.completenessLabel}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface BreakdownTableProps {
  readonly rows: readonly BreakdownRow[];
  readonly caption: string;
  readonly headingLabel: string;
}

export function BreakdownFallbackTable({ rows, caption, headingLabel }: BreakdownTableProps) {
  return (
    <div
      className="overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
      tabIndex={0}
      role="region"
      aria-label={caption}
    >
      <table className="w-full min-w-72 border-collapse">
        <caption className="pb-2 text-left text-sm text-ink-soft">{caption}</caption>
        <thead>
          <tr className="border-b border-line">
            <th scope="col" className={HEAD}>
              {headingLabel}
            </th>
            <th scope="col" className={`${HEAD} text-right`}>
              Net spending
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-b border-line/60">
              <th scope="row" className={`${CELL} text-left font-normal text-ink`}>
                <span className="break-words">{row.label}</span>
                {row.isCollapsed ? (
                  // Stated in words so the collapsed row can never be mistaken
                  // for a real entry that happens to be called "Other".
                  <span className="block text-xs text-ink-muted">
                    Combines {row.entryCount} smaller entries
                  </span>
                ) : null}
              </th>
              <td className={`money ${CELL} text-right text-ink`}>{row.amount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
