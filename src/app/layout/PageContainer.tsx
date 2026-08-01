import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

interface PageContainerProps {
  children: ReactNode;
  className?: string;
  /** Removes vertical padding for pages that manage their own rhythm. */
  flush?: boolean;
}

export function PageContainer({ children, className, flush = false }: PageContainerProps) {
  return (
    <div
      className={cn(
        'mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8',
        !flush && 'py-8 lg:py-12',
        className,
      )}
    >
      {children}
    </div>
  );
}
