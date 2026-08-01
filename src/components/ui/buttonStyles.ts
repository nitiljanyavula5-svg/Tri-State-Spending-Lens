import { cn } from '../../lib/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'quiet';
export type ButtonSize = 'md' | 'sm';

const base =
  'inline-flex items-center justify-center gap-2 rounded-control border font-medium ' +
  'transition-colors duration-150 ease-calm ' +
  'disabled:cursor-not-allowed disabled:opacity-60';

const variants: Record<ButtonVariant, string> = {
  primary: 'border-transparent bg-ink text-ink-inverse hover:bg-ink-soft',
  secondary: 'border-line-control bg-surface text-ink hover:bg-canvas-sunk',
  quiet: 'border-transparent bg-transparent text-ink-soft hover:bg-canvas-sunk hover:text-ink',
};

const sizes: Record<ButtonSize, string> = {
  md: 'px-4 py-2.5 text-sm',
  sm: 'px-3 py-1.5 text-sm',
};

export function buttonStyles(
  variant: ButtonVariant = 'primary',
  size: ButtonSize = 'md',
  className?: string,
): string {
  return cn(base, variants[variant], sizes[size], className);
}
