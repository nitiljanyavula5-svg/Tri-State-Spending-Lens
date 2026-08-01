/**
 * Visible only when focused. The first tab stop on every page, so a keyboard
 * user never has to walk the whole navigation to reach content.
 */
export function SkipLink() {
  return (
    <a
      href="#main-content"
      className="sr-only rounded-control border border-line-control bg-surface px-4 py-2 text-sm font-medium text-ink focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:shadow-raised"
    >
      Skip to main content
    </a>
  );
}
