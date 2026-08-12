import { CheckCircle2 } from 'lucide-react';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Callout } from '../ui/Callout';
import { Card, CardBody, CardTitle } from '../ui/Card';
import { ConfirmDialog } from './ConfirmDialog';
import type { Account } from '../../types/domain';
import type { ImportWizardApi } from '../../import/wizard/useImportWizard';
import { accountsToCreate, stagedAccountFor } from '../../import/wizard/wizardState';

interface StepHealthReportProps {
  readonly wizard: ImportWizardApi;
  readonly accounts: readonly Account[];
  readonly onDone: () => void;
}

/**
 * Step 6 — the Import Health Report, and the commit.
 *
 * Every figure comes from `buildHealthReport`, which asserts its own invariants
 * (`rowCount = acceptedCount + rejectedCount` among them). This component
 * displays those numbers; it never recomputes one, because two implementations
 * of the same count is exactly how a report starts lying.
 */
export function StepHealthReport({ wizard, accounts, onDone }: StepHealthReportProps) {
  const { state, healthReport } = wizard;

  if (state.commit.kind === 'committed') {
    const committed = state.commit;
    return (
      <div className="space-y-5">
        <div className="rounded-card border border-nj/40 bg-nj-wash p-5">
          <div className="flex items-start gap-3">
            <CheckCircle2 aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-nj" />
            <div>
              <h3 className="text-base font-semibold text-ink">Import complete</h3>
              <p className="mt-1 text-sm leading-relaxed text-ink-soft">
                {`${committed.committedTransactionCount.toLocaleString('en-US')} transactions were saved to this browser.`}
                {committed.createdAccountIds.length > 0
                  ? ` ${committed.createdAccountIds.length} new account${committed.createdAccountIds.length === 1 ? ' was' : 's were'} created.`
                  : ''}
                {committed.replacedDemoWorkspace
                  ? ' The sample data has been replaced by your own.'
                  : ''}
              </p>
              <p className="mt-2 text-sm text-ink-soft">
                You can undo this from the import history below, which removes this import and
                nothing else.
              </p>
            </div>
          </div>
        </div>
        <Button variant="primary" onClick={onDone}>
          Import another file
        </Button>
      </div>
    );
  }

  if (healthReport === null) {
    return <p className="text-sm text-ink-soft">Finish reading the files first.</p>;
  }

  const committing = state.commit.kind === 'committing';
  const failed = state.commit.kind === 'failed' ? state.commit : null;
  const newAccounts = accountsToCreate(state);

  const targets = state.files.map((draft) => {
    const staged = stagedAccountFor(state, draft);
    const existing = accounts.find((account) => account.id === draft.accountId);
    return {
      fileId: draft.id,
      fileName: draft.displayName,
      accountLabel: staged ? `${staged.label} (new)` : (existing?.label ?? 'Account not found'),
    };
  });

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Stat label="Rows read" value={healthReport.rowCount} emphasis />
        <Stat label="Will be imported" value={healthReport.acceptedCount} emphasis />
        <Stat label="Not imported" value={healthReport.rejectedCount} emphasis />
        <Stat label="Invalid rows" value={healthReport.invalidCount} />
        <Stat label="Duplicates you excluded" value={healthReport.excludedDuplicateCount} />
        <Stat label="Duplicate candidates" value={healthReport.duplicateCandidateCount} />
        <Stat label="Imported but need review" value={healthReport.questionableCount} />
        <Stat label="Uncategorized" value={healthReport.uncategorizedCount} />
      </div>

      <Card ariaLabelledBy="reconcile-title">
        <CardBody>
          <CardTitle id="reconcile-title" as="h3">
            How these numbers add up
          </CardTitle>
          <p className="money mt-2 text-sm text-ink">
            {`${healthReport.rowCount.toLocaleString('en-US')} rows read = ${healthReport.acceptedCount.toLocaleString('en-US')} imported + ${healthReport.rejectedCount.toLocaleString('en-US')} not imported`}
          </p>
          <p className="mt-2 text-sm leading-relaxed text-ink-soft">
            Rows needing review and uncategorized rows overlap the imported ones — they are counted
            separately, not subtracted. A duplicate candidate is only counted as not-imported if you
            excluded it.
          </p>
        </CardBody>
      </Card>

      <Card ariaLabelledBy="targets-title">
        <CardBody>
          <CardTitle id="targets-title" as="h3">
            What will be saved
          </CardTitle>
          <ul className="mt-3 divide-y divide-line border-y border-line text-sm">
            {targets.map((target) => (
              <li key={target.fileId} className="flex flex-wrap justify-between gap-2 py-2">
                <span className="min-w-0 truncate text-ink">{target.fileName}</span>
                <span className="text-ink-soft">{target.accountLabel}</span>
              </li>
            ))}
          </ul>
          {state.statementRangeStart || state.statementRangeEnd ? (
            <p className="mt-3 text-sm text-ink-soft">
              {`Statement period: ${state.statementRangeStart || 'not given'} to ${state.statementRangeEnd || 'not given'}.`}
            </p>
          ) : null}
          {newAccounts.length > 0 ? (
            <p className="mt-3 text-sm text-ink-soft">
              {`${newAccounts.length} account${newAccounts.length === 1 ? '' : 's'} will be created as part of this import. If the import fails, ${newAccounts.length === 1 ? 'it' : 'they'} will not exist.`}
            </p>
          ) : null}
          {healthReport.truncatedReporting ? (
            <p className="mt-3 text-xs text-ink-muted">
              Some lists above were shortened for display. Every count covers all rows.
            </p>
          ) : null}
        </CardBody>
      </Card>

      {healthReport.warnings.length > 0 ? (
        <Card ariaLabelledBy="warnings-title">
          <CardBody>
            <CardTitle id="warnings-title" as="h3">
              Warnings
            </CardTitle>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-soft">
              {healthReport.warnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}

      {wizard.requiresDemoConfirmation ? (
        <Callout tone="caution" title="This workspace holds the sample data">
          <p>
            Importing your own statements replaces the fictional demo accounts, transactions, and
            import history entirely, so invented figures are never mixed with real ones. Your saved
            column mappings are kept.
          </p>
        </Callout>
      ) : null}

      {failed ? (
        <div role="alert" className="rounded-card border border-pa/40 bg-pa-wash p-4">
          <p className="text-sm font-semibold text-ink">The import was not saved</p>
          <p className="mt-1 text-sm leading-relaxed text-ink-soft">{failed.message}</p>
          <p className="mt-1 text-sm text-ink-soft">
            Your choices are still here — go back and adjust anything, or try again.
          </p>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          disabled={!wizard.canStartCommit}
          onClick={() => void commitNow(wizard)}
        >
          {committing
            ? 'Saving…'
            : `Import ${healthReport.acceptedCount.toLocaleString('en-US')} transactions`}
        </Button>
        {committing ? (
          <span role="status" className="text-sm text-ink-soft">
            Saving to this browser. Do not close this tab.
          </span>
        ) : null}
      </div>

      {wizard.requiresDemoConfirmation && wizard.state.demoReplacementConfirmed ? (
        <ConfirmDialog
          title="Replace the sample data with your own?"
          confirmLabel="Replace and import"
          busy={committing}
          onCancel={() => wizard.confirmDemoReplacement(false)}
          onConfirm={() => void wizard.commit()}
        >
          <p>
            The demo accounts, transactions, and import history in this browser will be removed and
            replaced by this import. It happens in one step: if the import fails, the sample data is
            left exactly as it is.
          </p>
          <p>Your saved column mappings are not affected.</p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

/**
 * Starts the commit, via the demo confirmation when one is required.
 *
 * The dialog is the gate in the interface; `commitImport` enforces the same
 * rule again in the persistence layer, so bypassing this component cannot
 * bypass the confirmation.
 */
function commitNow(wizard: ImportWizardApi): Promise<void> | void {
  if (wizard.requiresDemoConfirmation && !wizard.state.demoReplacementConfirmed) {
    wizard.confirmDemoReplacement(true);
    return;
  }
  return wizard.commit();
}

function Stat({
  label,
  value,
  emphasis = false,
}: {
  label: string;
  value: number;
  emphasis?: boolean;
}) {
  return (
    <div
      className={`rounded-card border p-3 ${emphasis ? 'border-line-strong bg-canvas' : 'border-line bg-canvas-sunk'}`}
    >
      <p className="text-xs text-ink-muted">{label}</p>
      <p className="money mt-0.5 text-lg font-semibold text-ink">{value.toLocaleString('en-US')}</p>
      {emphasis ? (
        <Badge tone="neutral" className="mt-1.5">
          counted
        </Badge>
      ) : null}
    </div>
  );
}
