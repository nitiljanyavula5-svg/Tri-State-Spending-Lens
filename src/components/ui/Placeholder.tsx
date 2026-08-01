import { cn } from '../../lib/cn';

interface PlaceholderMetricProps {
  label: string;
  /** Why there is no value yet. Never a fake number. */
  note: string;
  className?: string;
}

/**
 * A summary-card slot with no value.
 *
 * It renders an em dash, never a zero and never sample figures: a `0` in a
 * financial summary is indistinguishable from a measured result, and
 * calculation-contract.md §1 requires an undefined value to be hidden with an
 * explanation rather than displayed as `0`.
 */
export function PlaceholderMetric({ label, note, className }: PlaceholderMetricProps) {
  return (
    <div className={cn('rounded-card border border-line bg-surface p-4', className)}>
      <p className="text-xs font-medium uppercase tracking-[0.08em] text-ink-muted">{label}</p>
      <p className="money mt-2 text-2xl font-semibold text-line-control" aria-hidden="true">
        &mdash;
      </p>
      <p className="mt-1 text-xs leading-relaxed text-ink-muted">{note}</p>
    </div>
  );
}

interface PlaceholderPanelProps {
  title: string;
  description: string;
  className?: string;
}

/**
 * A reserved region for a chart or table that does not exist yet. Deliberately
 * not a fake chart — a decorative graph would imply data the app has not got.
 */
export function PlaceholderPanel({ title, description, className }: PlaceholderPanelProps) {
  return (
    <div
      className={cn(
        'flex min-h-40 flex-col justify-center rounded-card border border-dashed border-line-strong',
        'bg-canvas-sunk/60 p-5',
        className,
      )}
    >
      <p className="text-sm font-semibold text-ink">{title}</p>
      <p className="mt-1.5 max-w-prose text-sm leading-relaxed text-ink-muted">{description}</p>
    </div>
  );
}
