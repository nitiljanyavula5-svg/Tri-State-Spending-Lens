/** Lens-over-grid mark: a thin map/grid/lens motif, used sparingly (master plan §13). */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="8" className="fill-ink" />
      <path
        d="M15 5.5v19M5.5 15h19"
        className="stroke-canvas"
        strokeWidth="1"
        opacity="0.35"
        strokeLinecap="round"
      />
      <circle cx="15" cy="15" r="6.5" className="fill-none stroke-nj" strokeWidth="2" />
      <path
        d="m20 20 5 5"
        className="stroke-pa"
        strokeWidth="2.5"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}
