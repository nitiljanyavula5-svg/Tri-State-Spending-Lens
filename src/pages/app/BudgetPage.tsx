import { Target } from 'lucide-react';
import { PageContainer } from '../../app/layout/PageContainer';
import { useWorkspace } from '../../app/providers/workspaceContext';
import { WorkspaceDataPanel } from '../../components/workspace/WorkspaceDataPanel';
import { Button, ButtonLink } from '../../components/ui/Button';
import { Callout } from '../../components/ui/Callout';
import { EmptyState } from '../../components/ui/EmptyState';
import { PageHeader } from '../../components/ui/PageHeader';
import { BudgetMonthNav } from '../../components/budget/BudgetMonthNav';
import { BudgetPlanEditor } from '../../components/budget/BudgetPlanEditor';
import { BudgetSummary } from '../../components/budget/BudgetSummary';
import { CategoryBudgetTable } from '../../components/budget/CategoryBudgetTable';
import { useBudget } from '../../review/useBudget';
import { useDocumentTitle } from '../../lib/useDocumentTitle';

/**
 * The monthly budget.
 *
 * Every figure comes from one `useBudget` call, which is the only boundary
 * between Dexie and the calculation layer. The page does no arithmetic and
 * never reads the database directly.
 *
 * The document title is a constant. privacy-model.md keeps personal values out
 * of titles and URLs, and a title carrying the selected month would put the
 * workspace into the browser's history and tab list.
 */
export function BudgetPage() {
  useDocumentTitle('Budget');
  const { db } = useWorkspace();
  const budget = useBudget({ db });

  const { status, selection } = budget;

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Workspace"
        title="Budget"
        lede="A deliberately simple monthly plan: one overall limit, optional category limits, and optional income and savings targets. Anything that cannot be computed honestly stays hidden with an explanation."
        actions={
          <>
            <ButtonLink to="/app/overview" variant="secondary" size="sm">
              Back to Overview
            </ButtonLink>
            <ButtonLink to="/import" variant="primary" size="sm">
              Import a CSV
            </ButtonLink>
          </>
        }
      />

      {/* One polite live region for asynchronous state, so a screen reader hears
          the page settle without being told about every keystroke. */}
      <div role="status" aria-live="polite" className="sr-only">
        {status === 'loading' ? 'Loading your workspace.' : null}
        {status === 'failed' ? 'The workspace could not be read.' : null}
      </div>

      {status === 'failed' ? (
        <Callout tone="caution" title="This workspace could not be read" className="mt-8">
          <p>{budget.errorMessage}</p>
          <div className="mt-3">
            <Button type="button" variant="secondary" size="sm" onClick={budget.retry}>
              Retry
            </Button>
          </div>
        </Callout>
      ) : null}

      {status === 'loading' ? (
        <div className="mt-8 min-h-40 rounded-card border border-line bg-surface p-5">
          <p className="text-sm text-ink-soft">Loading your workspace…</p>
        </div>
      ) : null}

      {status === 'empty' ? (
        <div className="mt-8">
          <EmptyState
            icon={Target}
            title="No transactions in this workspace yet"
            description="A budget is only meaningful next to real spending. Import a CSV or load the fictional demo workspace, and this page will compare each month against the plan you set."
            status="Nothing is calculated from an empty workspace — no limit is assumed and no total is invented."
          />
        </div>
      ) : null}

      {status === 'ready' && selection !== null ? (
        <>
          <div className="mt-8">
            <WorkspaceDataPanel focus="budget" />
          </div>

          <BudgetMonthNav budget={budget} />

          {budget.activeAccountCount === 0 ? (
            <Callout tone="caution" title="No active accounts" className="mt-8">
              <p>
                Every account in this workspace is archived, so nothing counts toward a budget.
                Un-archive an account to measure spending against a plan.
              </p>
            </Callout>
          ) : null}

          {!selection.hasPlan ? (
            <Callout tone="info" title="No plan for this month yet" className="mt-8">
              <p>
                Set a limit below to start one, or copy last month’s plan. Spending for this month
                is still shown, so you can plan against what actually happened.
              </p>
            </Callout>
          ) : null}

          {selection.monthPosition === 'past' && !selection.monthComplete ? (
            <Callout
              tone="caution"
              title="This month is not fully covered by statements"
              className="mt-8"
            >
              <p>
                Imported statements do not cover every day of {selection.month}, so the figures
                below are what has been recorded rather than a final total for the month.
              </p>
            </Callout>
          ) : null}

          <BudgetSummary selection={selection} />
          <CategoryBudgetTable selection={selection} />
          <BudgetPlanEditor budget={budget} />

          <Callout tone="info" title="Two things this budget does not do" className="mt-10">
            <p>
              Unspent money does not roll over into the next month, and the language stays neutral:
              you will see how much of a limit you have used against how much of the month has
              elapsed, never a judgement about whether that spending was wasteful.
            </p>
          </Callout>
        </>
      ) : null}
    </PageContainer>
  );
}
