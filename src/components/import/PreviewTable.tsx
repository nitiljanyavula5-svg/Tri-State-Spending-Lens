import { sanitizeForDisplay } from '../../import/canonical';

interface PreviewTableProps {
  readonly caption: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
  /** Hard ceiling on rendered rows, independent of what was passed in. */
  readonly maxRows: number;
  readonly totalRows?: number;
}

/**
 * A bounded, text-only look at a file's contents.
 *
 * Three properties matter more than the layout:
 *
 *  - **Bounded twice.** The engine already caps what it hands over, and this
 *    caps again on the way to the DOM. A hundred-thousand-row file can never
 *    become a hundred-thousand-row table (§4).
 *  - **Text, never markup.** Cells go through React's text interpolation, so a
 *    description containing `<script>` renders as those characters. There is no
 *    `dangerouslySetInnerHTML` anywhere in the import UI.
 *  - **Display-sanitized.** `sanitizeForDisplay` strips control, zero-width,
 *    and bidi characters, so a crafted description cannot reorder the text
 *    around it or hide part of itself (threat-model.md §5).
 */
export function PreviewTable({ caption, columns, rows, maxRows, totalRows }: PreviewTableProps) {
  const shown = rows.slice(0, maxRows);
  const total = totalRows ?? rows.length;
  const truncated = total > shown.length;

  return (
    // The scroll container is focusable and named. A `overflow-x: auto` region
    // that cannot be focused is unreachable for anyone scrolling by keyboard —
    // which is most of the time on a narrow screen, where this table always
    // overflows. `role="region"` plus the caption as its name is what makes the
    // focus stop meaningful rather than a bare tab stop on an unnamed div.
    <div
      className="overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
      tabIndex={0}
      role="region"
      aria-label={caption}
    >
      <table className="w-full min-w-[32rem] border-collapse text-left text-xs">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-line">
            {columns.map((column, index) => (
              <th
                key={`${column}-${index}`}
                scope="col"
                className="px-2 py-1.5 font-semibold whitespace-nowrap text-ink-muted"
              >
                {sanitizeForDisplay(column) || `Column ${index + 1}`}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-b border-line/60 last:border-0">
              {columns.map((_, cellIndex) => (
                <td key={cellIndex} className="max-w-[16rem] truncate px-2 py-1.5 text-ink-soft">
                  {sanitizeForDisplay(row[cellIndex] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {truncated ? (
        <p className="mt-2 text-xs text-ink-muted">
          {`Showing the first ${shown.length.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} rows. The counts elsewhere cover every row.`}
        </p>
      ) : null}
    </div>
  );
}
