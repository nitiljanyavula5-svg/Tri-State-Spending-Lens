import { useEffect, useId, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router';
import { Menu, Settings, Upload, X } from 'lucide-react';
import { BrandMark } from '../../components/brand/BrandMark';
import { buttonStyles } from '../../components/ui/buttonStyles';
import { cn } from '../../lib/cn';
import { primaryNav, publicNav, utilityNav } from '../navigation';

const desktopLink = ({ isActive }: { isActive: boolean }) =>
  cn(
    'rounded-control px-3 py-2 text-sm font-medium transition-colors duration-150 ease-calm',
    isActive ? 'bg-canvas-sunk text-ink' : 'text-ink-soft hover:bg-canvas-sunk hover:text-ink',
  );

const mobileLink = ({ isActive }: { isActive: boolean }) =>
  cn(
    'block rounded-control px-3 py-2.5 transition-colors duration-150 ease-calm',
    isActive ? 'bg-canvas-sunk' : 'hover:bg-canvas-sunk',
  );

export function SiteHeader() {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuId = useId();
  const { pathname } = useLocation();

  // Close the menu whenever the route changes, so a tap on a link does not
  // leave the panel covering the page it just navigated to.
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  // Escape closes the menu, matching the disclosure pattern users expect.
  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [menuOpen]);

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-canvas/95 backdrop-blur-sm">
      <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-4 py-3 sm:px-6 lg:px-8">
        <Link to="/" className="flex shrink-0 items-center gap-2.5 rounded-control py-1 text-ink">
          <BrandMark className="size-8" />
          <span className="text-sm font-semibold leading-tight tracking-tight sm:text-base">
            Tri-State
            <span className="hidden sm:inline"> Spending Lens</span>
          </span>
        </Link>

        <nav aria-label="Primary" className="ml-auto hidden lg:block">
          <ul className="flex items-center gap-0.5">
            {primaryNav.map((item) => (
              <li key={item.to}>
                <NavLink to={item.to} className={desktopLink}>
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <div className="ml-auto flex items-center gap-2 lg:ml-3">
          {/* max-* variants, not a bare `hidden`: buttonStyles already sets
              `inline-flex`, and two unprefixed display utilities would be
              decided by stylesheet order rather than by intent. */}
          <Link to="/import" className={cn(buttonStyles('secondary', 'sm'), 'max-sm:hidden')}>
            <Upload className="size-4" aria-hidden="true" />
            Import
          </Link>
          <Link
            to="/app/settings"
            className={cn(buttonStyles('quiet', 'sm'), 'max-lg:hidden')}
            aria-label="Settings"
          >
            <Settings className="size-4" aria-hidden="true" />
          </Link>

          <button
            type="button"
            className={cn(buttonStyles('secondary', 'sm'), 'lg:hidden')}
            aria-expanded={menuOpen}
            aria-controls={menuId}
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? (
              <X className="size-4" aria-hidden="true" />
            ) : (
              <Menu className="size-4" aria-hidden="true" />
            )}
            Menu
          </button>
        </div>
      </div>

      <div id={menuId} hidden={!menuOpen} className="border-t border-line bg-surface lg:hidden">
        <nav aria-label="All sections" className="mx-auto w-full max-w-6xl px-4 py-4 sm:px-6">
          <p className="px-3 pb-2 text-xs font-semibold uppercase tracking-[0.12em] text-ink-muted">
            Workspace
          </p>
          <ul>
            {primaryNav.map((item) => (
              <li key={item.to}>
                <NavLink to={item.to} className={mobileLink}>
                  <span className="block text-sm font-medium text-ink">{item.label}</span>
                  <span className="mt-0.5 block text-xs text-ink-muted">{item.description}</span>
                </NavLink>
              </li>
            ))}
          </ul>

          <p className="mt-4 px-3 pb-2 text-xs font-semibold uppercase tracking-[0.12em] text-ink-muted">
            Utilities
          </p>
          <ul>
            {[...utilityNav, ...publicNav].map((item) => (
              <li key={item.to}>
                <NavLink to={item.to} end={item.end} className={mobileLink}>
                  <span className="block text-sm font-medium text-ink">{item.label}</span>
                  <span className="mt-0.5 block text-xs text-ink-muted">{item.description}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </header>
  );
}
