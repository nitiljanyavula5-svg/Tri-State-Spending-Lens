import { render, type RenderResult } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { ReactNode } from 'react';
import { AppRoutes } from '../../../src/app/router/AppRoutes';
import { WorkspaceProvider } from '../../../src/app/providers/WorkspaceProvider';
import type { WorkspaceDatabase } from '../../../src/db/database';

interface RenderAppOptions {
  /** Provide a database to exercise the real workspace wiring. */
  database?: WorkspaceDatabase;
}

/**
 * Renders the whole app at a path.
 *
 * The workspace provider is disabled unless a database is supplied, so route
 * and markup tests neither need IndexedDB nor accidentally depend on it.
 */
export function renderApp(path = '/', options: RenderAppOptions = {}): RenderResult {
  const { database } = options;
  return render(
    <MemoryRouter initialEntries={[path]}>
      <WorkspaceProvider database={database} disabled={!database}>
        <AppRoutes />
      </WorkspaceProvider>
    </MemoryRouter>,
  );
}

/** Wraps arbitrary children in a router and a disabled workspace provider. */
export function renderWithProviders(ui: ReactNode, database?: WorkspaceDatabase): RenderResult {
  return render(
    <MemoryRouter>
      <WorkspaceProvider database={database} disabled={!database}>
        {ui}
      </WorkspaceProvider>
    </MemoryRouter>,
  );
}
