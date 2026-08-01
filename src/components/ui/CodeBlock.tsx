import { cn } from '../../lib/cn';

interface CodeBlockProps {
  /** Accessible name for the scroll region — say what the block contains. */
  label: string;
  children: string;
  className?: string;
}

/**
 * Preformatted text that scrolls horizontally rather than widening the page.
 *
 * The wrapper is deliberately focusable: a region that scrolls but cannot be
 * reached by keyboard is unusable without a mouse, and `tabIndex` plus a name
 * is what makes it navigable.
 */
export function CodeBlock({ label, children, className }: CodeBlockProps) {
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className={cn(
        'money overflow-x-auto rounded-control border border-line bg-canvas-sunk',
        'p-4 text-xs leading-relaxed text-ink',
        className,
      )}
    >
      <pre>
        <code>{children}</code>
      </pre>
    </div>
  );
}
