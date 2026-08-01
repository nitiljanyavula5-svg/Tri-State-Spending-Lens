import type { ReactNode } from 'react';

interface PageHeaderProps {
  /** Small label above the title, e.g. "Workspace". */
  eyebrow?: string;
  title: string;
  lede: string;
  /** Optional trailing controls, aligned right on wide screens. */
  actions?: ReactNode;
}

export function PageHeader({ eyebrow, title, lede, actions }: PageHeaderProps) {
  return (
    <div className="border-b border-line pb-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="max-w-2xl">
          {eyebrow ? (
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-muted">
              {eyebrow}
            </p>
          ) : null}
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
            {title}
          </h1>
          <p className="mt-2 text-base leading-relaxed text-ink-soft">{lede}</p>
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}
