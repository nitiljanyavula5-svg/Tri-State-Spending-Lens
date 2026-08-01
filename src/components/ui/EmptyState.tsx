import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import type { IconComponent } from './icon';

interface EmptyStateProps {
  icon: IconComponent;
  title: string;
  description: string;
  /** What will eventually appear on this page. */
  items?: readonly string[];
  itemsLabel?: string;
  /** Honest note about what is not built yet, e.g. "Arrives in Phase 3". */
  status?: string;
  actions?: ReactNode;
  className?: string;
}

/**
 * The empty state every route uses before real data exists. It explains what
 * will appear here rather than showing a blank panel or, worse, placeholder
 * numbers that could be mistaken for a result.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  items,
  itemsLabel = 'What will appear here',
  status,
  actions,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'rounded-card border border-dashed border-line-strong bg-surface p-6 sm:p-8',
        className,
      )}
    >
      <div className="flex gap-4">
        <span
          className="flex size-11 shrink-0 items-center justify-center rounded-control bg-canvas-sunk text-ink-soft"
          aria-hidden="true"
        >
          <Icon className="size-5" aria-hidden="true" />
        </span>

        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold tracking-tight text-ink">{title}</h2>
          <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-soft">{description}</p>

          {items && items.length > 0 ? (
            <div className="mt-5">
              <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-muted">
                {itemsLabel}
              </h3>
              <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                {items.map((item) => (
                  <li key={item} className="flex gap-2.5 text-sm leading-relaxed text-ink-soft">
                    <span
                      aria-hidden="true"
                      className="mt-2 size-1.5 shrink-0 rounded-full bg-line-control"
                    />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {status ? (
            <p className="mt-5 border-t border-line pt-4 text-sm text-ink-muted">{status}</p>
          ) : null}

          {actions ? <div className="mt-5 flex flex-wrap gap-2">{actions}</div> : null}
        </div>
      </div>
    </div>
  );
}
