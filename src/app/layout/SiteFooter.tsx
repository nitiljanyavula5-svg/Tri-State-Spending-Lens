import { Link } from 'react-router';
import { BrandMark } from '../../components/brand/BrandMark';
import { primaryNav, publicNav, utilityNav } from '../navigation';

const columns = [
  { heading: 'Workspace', items: primaryNav },
  { heading: 'Utilities', items: utilityNav },
  { heading: 'About', items: publicNav },
] as const;

export function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-line bg-canvas-sunk">
      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <div className="flex items-center gap-2.5">
              <BrandMark className="size-8" />
              <span className="text-sm font-semibold tracking-tight text-ink">
                Tri-State Spending Lens
              </span>
            </div>
            <p className="mt-3 max-w-xs text-sm leading-relaxed text-ink-soft">
              A privacy-first financial analysis and budgeting tool for New Jersey, New York, and
              Pennsylvania. Your files stay in your browser.
            </p>
          </div>

          {columns.map((column) => (
            <nav key={column.heading} aria-label={column.heading}>
              <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-muted">
                {column.heading}
              </h2>
              <ul className="mt-3 space-y-2">
                {column.items.map((item) => (
                  <li key={item.to}>
                    <Link
                      to={item.to}
                      className="rounded-chip text-sm text-ink-soft hover:text-ink hover:underline"
                    >
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <p className="mt-10 border-t border-line-strong pt-6 text-xs leading-relaxed text-ink-muted">
          Foundation preview. This build is the application shell only: CSV import, local storage,
          calculations, budgeting, recurring detection, and regional data are not implemented yet.
          Any figures shown are fictional and clearly labelled.
        </p>
      </div>
    </footer>
  );
}
