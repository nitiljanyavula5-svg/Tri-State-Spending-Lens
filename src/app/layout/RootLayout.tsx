import { Outlet } from 'react-router';
import { SkipLink } from '../../components/ui/SkipLink';
import { SiteFooter } from './SiteFooter';
import { SiteHeader } from './SiteHeader';

export function RootLayout() {
  return (
    <div className="flex min-h-svh flex-col">
      <SkipLink />
      <SiteHeader />
      {/* tabIndex allows the skip link to move focus here. */}
      <main id="main-content" tabIndex={-1} className="flex-1 outline-none">
        <Outlet />
      </main>
      <SiteFooter />
    </div>
  );
}
