import type { ReactNode } from 'react';
import { Info, Lock, TriangleAlert } from 'lucide-react';
import { cn } from '../../lib/cn';

export type CalloutTone = 'info' | 'privacy' | 'caution';

const tones: Record<CalloutTone, { wrapper: string; icon: string }> = {
  info: { wrapper: 'border-ny/25 bg-ny-wash', icon: 'text-ny' },
  privacy: { wrapper: 'border-nj/25 bg-nj-wash', icon: 'text-nj' },
  caution: { wrapper: 'border-pa/30 bg-pa-wash', icon: 'text-pa' },
};

const icons = {
  info: Info,
  privacy: Lock,
  caution: TriangleAlert,
};

interface CalloutProps {
  title: string;
  children: ReactNode;
  tone?: CalloutTone;
  className?: string;
}

export function Callout({ title, children, tone = 'info', className }: CalloutProps) {
  const Icon = icons[tone];
  const styles = tones[tone];

  return (
    <div className={cn('rounded-card border p-4 sm:p-5', styles.wrapper, className)}>
      <div className="flex gap-3">
        <Icon aria-hidden="true" className={cn('mt-0.5 size-5 shrink-0', styles.icon)} />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink">{title}</p>
          <div className="mt-1 text-sm leading-relaxed text-ink-soft">{children}</div>
        </div>
      </div>
    </div>
  );
}
