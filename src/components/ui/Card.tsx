import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export type CardAccent = 'none' | 'nj' | 'ny' | 'pa';

const accents: Record<CardAccent, string> = {
  none: '',
  nj: 'border-t-2 border-t-nj',
  ny: 'border-t-2 border-t-ny',
  pa: 'border-t-2 border-t-pa',
};

interface CardProps {
  children: ReactNode;
  /** A thin top rule in a regional accent. Used sparingly, per master plan §13. */
  accent?: CardAccent;
  className?: string;
  /** Renders as <section> with an accessible name when provided. */
  ariaLabelledBy?: string;
}

export function Card({ children, accent = 'none', className, ariaLabelledBy }: CardProps) {
  return (
    <section
      aria-labelledby={ariaLabelledBy}
      className={cn(
        // min-w-0 lets a card shrink inside a grid or flex parent. Without it,
        // grid items keep min-width:auto and wide content such as a <pre>
        // pushes the whole column past the viewport instead of scrolling
        // inside its own overflow container.
        'min-w-0 rounded-card border border-line bg-surface shadow-card',
        accents[accent],
        className,
      )}
    >
      {children}
    </section>
  );
}

interface CardBodyProps {
  children: ReactNode;
  className?: string;
}

export function CardBody({ children, className }: CardBodyProps) {
  return <div className={cn('p-5 sm:p-6', className)}>{children}</div>;
}

interface CardTitleProps {
  children: ReactNode;
  id?: string;
  className?: string;
  as?: 'h2' | 'h3';
}

export function CardTitle({ children, id, className, as: Tag = 'h2' }: CardTitleProps) {
  return (
    <Tag id={id} className={cn('text-base font-semibold tracking-tight text-ink', className)}>
      {children}
    </Tag>
  );
}
