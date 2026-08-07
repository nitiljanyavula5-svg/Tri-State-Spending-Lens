import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Callout } from '../ui/Callout';
import { Card, CardBody, CardTitle } from '../ui/Card';
import { PreviewTable } from './PreviewTable';
import { MAX_PREVIEW_ROWS, MAX_REJECTION_SAMPLES } from '../../import/limits';
import type { ImportWizardApi } from '../../import/wizard/useImportWizard';
import { sessionRows } from '../../import/wizard/wizardState';

interface StepReviewProps {
  readonly wizard: ImportWizardApi;
}

/**
 * Step 5 — what will be imported, and what the pipeline is unsure about.
 *
 * This is a bounded pre-import preview, not the Phase 4 review grid: rows
 * cannot be edited or recategorized here. The only decision on offer is
 * keep-or-exclude for a duplicate candidate.
 *
 * Duplicate candidates are **suggestions**. Nothing is removed automatically,
 * the default is to keep, and the wording never claims a matching fingerprint
 * proves two rows are the same transaction (data-methodology.md §4.1).
 */
export function StepReview({ wizard }: StepReviewProps) {
  const { state, healthReport, duplicateCandidates, duplicatesTruncated } = wizard;
  const busy = state.files.some((draft) => draft.pendingNormalizeId !== null);
  const rows = sessionRows(state);

  if (busy || healthReport === null) {
    return (
      <div className="space-y-4">
        <p role="status" className="text-sm text-ink-soft">
          Reading your files in a background worker. The page stays responsive while this runs.
        </p>
        <ul className="space-y-1 text-sm text-ink-muted">
          {state.files.map((draft) => (
            <li key={draft.id}>
              {draft.displayName}
              {draft.pendingNormalizeId
                ? ' — reading…'
                : draft.normalized
                  ? ` — ${draft.normalized.rowCount.toLocaleString('en-US')} rows read`
                  : draft.normalizeFailure
                    ? ` — ${draft.normalizeFailure.message}`
                    : ' — waiting'}
            </li>
          ))}
        </ul>
        <Button variant="secondary" size="sm" onClick={wizard.cancelProcessing}>
          Cancel processing
        </Button>
      </div>
    );
  }

  const previewRows = healthReport.previewRows;
  const excludedKeys = new Set(
    [...state.duplicateDecisions.entries()]
      .filter(([, decision]) => decision === 'exclude')
      .map(([key]) => key),
  );

  const withinFile = duplicateCandidates.filter((candidate) => candidate.source === 'within-file');
  const acrossFiles = duplicateCandidates.filter(
    (candidate) => candidate.source === 'staged-session',
  );
  const againstWorkspace = duplicateCandidates.filter(
    (candidate) => candidate.source === 'existing-workspace',
  );

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Rows read" value={healthReport.rowCount} />
        <Stat label="Will be imported" value={healthReport.acceptedCount} />
        <Stat label="Not imported" value={healthReport.rejectedCount} />
        <Stat label="Duplicate candidates" value={healthReport.duplicateCandidateCount} />
      </div>

      <Card ariaLabelledBy="preview-title">
        <CardBody>
          <CardTitle id="preview-title" as="h3">
            A sample of what will be imported
          </CardTitle>
          <p className="mt-1 text-sm text-ink-soft">
            {`Showing up to ${MAX_PREVIEW_ROWS} rows. Descriptions are shown as plain text.`}
          </p>
          <div className="mt-3">
            <PreviewTable
              caption="Normalized rows that will be imported"
              columns={['File', 'Row', 'Date', 'Description', 'Amount', 'Direction', 'Flags']}
              rows={previewRows.map((row) => [
                row.fileName,
                String(row.originalRow),
                row.postedDate,
                row.description,
                formatCents(row.amountCents),
                row.direction === 'debit' ? 'Money out' : 'Money in',
                [
                  row.isDuplicateCandidate ? 'duplicate candidate' : '',
                  row.isQuestionable ? 'needs review' : '',
                ]
                  .filter(Boolean)
                  .join(', '),
              ])}
              maxRows={MAX_PREVIEW_ROWS}
              totalRows={healthReport.acceptedCount}
            />
          </div>
        </CardBody>
      </Card>

      {duplicateCandidates.length > 0 ? (
        <Card ariaLabelledBy="duplicates-title">
          <CardBody>
            <CardTitle id="duplicates-title" as="h3">
              Possible duplicates
            </CardTitle>
            <Callout tone="caution" title="These are suggestions, not findings" className="mt-3">
              <p>
                A match means these rows agree on account, date, direction, amount, and description.
                That does not prove they are the same transaction — two identical purchases on one
                day are perfectly ordinary. Nothing is removed unless you exclude it.
              </p>
            </Callout>

            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  wizard.setBulkDuplicateDecision(
                    duplicateCandidates.map((candidate) => candidate.decisionKey),
                    'keep',
                  )
                }
              >
                {`Keep all ${duplicateCandidates.length} candidates`}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  wizard.setBulkDuplicateDecision(
                    duplicateCandidates.map((candidate) => candidate.decisionKey),
                    'exclude',
                  )
                }
              >
                {`Exclude all ${duplicateCandidates.length} candidates`}
              </Button>
            </div>

            <DuplicateGroupList
              title="Repeated inside one file"
              description="An identical row appears earlier in the same file. Both are still imported unless you exclude one."
              candidates={withinFile}
              excluded={excludedKeys}
              wizard={wizard}
            />
            <DuplicateGroupList
              title="Overlapping between the files you chose"
              description="Two of the staged files contain the same row."
              candidates={acrossFiles}
              excluded={excludedKeys}
              wizard={wizard}
            />
            <DuplicateGroupList
              title="Already in your workspace"
              description="A matching row was imported before."
              candidates={againstWorkspace}
              excluded={excludedKeys}
              wizard={wizard}
            />

            {duplicatesTruncated ? (
              <p className="mt-3 text-xs text-ink-muted">
                More candidates were found than can be listed. The counts above cover all of them,
                and any not listed here are kept.
              </p>
            ) : null}
          </CardBody>
        </Card>
      ) : (
        <p className="text-sm text-ink-soft">
          No possible duplicates were found in these files or against your workspace.
        </p>
      )}

      {healthReport.rejectionSamples.length > 0 ? (
        <Card ariaLabelledBy="rejected-title">
          <CardBody>
            <CardTitle id="rejected-title" as="h3">
              {`Rows that cannot be imported (${healthReport.invalidCount.toLocaleString('en-US')})`}
            </CardTitle>
            <p className="mt-1 text-sm text-ink-soft">
              Each is identified by its row number and the reason it failed. The row&apos;s contents
              are not shown and are never stored.
            </p>
            <ul className="mt-3 divide-y divide-line border-y border-line text-sm">
              {healthReport.rejectionSamples.slice(0, MAX_REJECTION_SAMPLES).map((rejection) => (
                <li
                  key={`${rejection.fileName}-${rejection.originalRow}-${rejection.code}`}
                  className="flex flex-wrap items-baseline gap-x-2 py-1.5"
                >
                  <span className="font-medium text-ink">{`Row ${rejection.originalRow}`}</span>
                  <span className="text-xs text-ink-muted">{rejection.fileName}</span>
                  <span className="text-ink-soft">{rejection.message}</span>
                </li>
              ))}
            </ul>
            {healthReport.invalidCount > healthReport.rejectionSamples.length ? (
              <p className="mt-2 text-xs text-ink-muted">
                {`Showing ${healthReport.rejectionSamples.length} of ${healthReport.invalidCount.toLocaleString('en-US')}. Every one is counted.`}
              </p>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      <p className="text-xs text-ink-muted">
        {`${rows.length.toLocaleString('en-US')} rows were read successfully across ${state.files.length} file${state.files.length === 1 ? '' : 's'}.`}
      </p>
    </div>
  );
}

function DuplicateGroupList({
  title,
  description,
  candidates,
  excluded,
  wizard,
}: {
  title: string;
  description: string;
  candidates: readonly ImportWizardApi['duplicateCandidates'][number][];
  excluded: ReadonlySet<string>;
  wizard: ImportWizardApi;
}) {
  if (candidates.length === 0) return null;

  return (
    <section className="mt-5">
      <h4 className="text-sm font-semibold text-ink">{`${title} (${candidates.length})`}</h4>
      <p className="text-xs text-ink-muted">{description}</p>
      <ul className="mt-2 divide-y divide-line border-y border-line">
        {candidates.map((candidate) => {
          const isExcluded = excluded.has(candidate.decisionKey);
          return (
            <li
              key={candidate.decisionKey}
              className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2"
            >
              <span className="text-sm text-ink">{`Row ${candidate.originalRow}`}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-ink-muted">
                {candidate.fileName}
                {candidate.matchedOriginalRow !== undefined
                  ? ` · matches row ${candidate.matchedOriginalRow}`
                  : ''}
              </span>
              <Badge tone={isExcluded ? 'notice' : 'nj'}>
                {isExcluded ? 'Will be excluded' : 'Will be imported'}
              </Badge>
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  wizard.setDuplicateDecision(
                    candidate.decisionKey,
                    isExcluded ? 'keep' : 'exclude',
                  )
                }
              >
                {isExcluded ? 'Keep it' : 'Exclude it'}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-card border border-line bg-canvas-sunk p-3">
      <p className="text-xs text-ink-muted">{label}</p>
      <p className="money mt-0.5 text-lg font-semibold text-ink">{value.toLocaleString('en-US')}</p>
    </div>
  );
}

/** Cents to a plain dollar string. Display only — never used for arithmetic. */
function formatCents(cents: number): string {
  const dollars = Math.trunc(cents / 100);
  const remainder = Math.abs(cents % 100);
  return `$${dollars.toLocaleString('en-US')}.${String(remainder).padStart(2, '0')}`;
}
