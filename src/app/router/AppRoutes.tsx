import { Route, Routes } from 'react-router';
import { RootLayout } from '../layout/RootLayout';
import { ContextPage } from '../../pages/ContextPage';
import { ImportPage } from '../../pages/ImportPage';
import { LandingPage } from '../../pages/LandingPage';
import { MethodologyPage } from '../../pages/MethodologyPage';
import { NotFoundPage } from '../../pages/NotFoundPage';
import { PrivacyPage } from '../../pages/PrivacyPage';
import { BudgetPage } from '../../pages/app/BudgetPage';
import { InsightsPage } from '../../pages/app/InsightsPage';
import { OverviewPage } from '../../pages/app/OverviewPage';
import { RecurringPage } from '../../pages/app/RecurringPage';
import { SettingsPage } from '../../pages/app/SettingsPage';
import { TransactionsPage } from '../../pages/app/TransactionsPage';

/**
 * The complete route table (master plan §6).
 *
 * Exported separately from the router itself so tests can mount it inside a
 * MemoryRouter at any path without touching browser history.
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<RootLayout />}>
        <Route index element={<LandingPage />} />
        <Route path="context" element={<ContextPage />} />
        <Route path="methodology" element={<MethodologyPage />} />
        <Route path="privacy" element={<PrivacyPage />} />
        <Route path="import" element={<ImportPage />} />

        <Route path="app">
          <Route path="overview" element={<OverviewPage />} />
          <Route path="transactions" element={<TransactionsPage />} />
          <Route path="budget" element={<BudgetPage />} />
          <Route path="recurring" element={<RecurringPage />} />
          <Route path="insights" element={<InsightsPage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>

        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
