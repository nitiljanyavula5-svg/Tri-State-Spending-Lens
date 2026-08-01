import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export type BadgeTone = 'neutral' | 'nj' | 'ny' | 'pa' | 'notice';

const tones: Record<BadgeTone, string> = {
  neutral: 'border-line-strong bg-canvas-sunk text-ink-soft',
  nj: 'border-nj/30 bg-nj-wash text-nj',
  ny: 'border-ny/30 bg-ny-wash text-ny',
  pa: 'border-pa/30 bg-pa-wash text-pa',
  notice: 'border-pa/40 bg-pa-wash text-pa',
};

interface BadgeProps {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
}

/** A small square-ish chip. Deliberately not a pill (master plan §13). */
export function Badge({ children, tone = 'neutral', className }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-chip border px-2 py-0.5',
        'text-xs font-medium tracking-wide',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
