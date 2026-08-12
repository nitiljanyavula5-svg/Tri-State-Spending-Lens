import { useCallback, useEffect, useRef, useState } from 'react';
import { FileClock } from 'lucide-react';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card, CardBody, CardTitle } from '../ui/Card';
import { EmptyState } from '../ui/EmptyState';
import { ConfirmDialog } from './ConfirmDialog';
import { useWorkspace } from '../../app/providers/workspaceContext';
import {
  listImportHistory,
  rollbackImportSession,
  type ImportHistoryEntry,
} from '../../db/importHistory';

/** Sessions rendered at once. Older ones are reachable by loading more. */
const PAGE_SIZE = 20;

/**
 * Import history, with rollback.
 *
 * Everything shown comes from the stored `ImportSession` via
 * `listImportHistory`, which is already bounded and filename-sanitized. No raw
 * CSV, row preview, rejected row, or wizard state is stored, so none can be
 * displayed here — the absence is structural, not a rendering choice.
 */
interface ImportHistoryPanelProps {
  /**
   * Bumped by the page after a commit. History is read once on mount, so
   * without this an import would not appear until the next navigation.
   */
  readonly refreshToken?: number;
}

export function ImportHistoryPanel({ refreshToken = 0 }: ImportHistoryPanelProps = {}) {
  const { db } = useWorkspace();
  const [entries, setEntries] = useState<readonly ImportHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [pending, setPending] = useState<ImportHistoryEntry | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);

  /** Guards the window between the click and the busy state being rendered. */
  const rollingBackRef = useRef(false);
  const [rollingBack, setRollingBack] = useState(false);

  const reload = useCallback(async () => {
    // Stay in the loading state while the workspace is still opening. Setting
    // an empty list here would render "No imports yet" for a workspace that has
    // not been read — a claim about the user's data made before looking at it.
    if (!db?.isOpen()) return;

    try {
      setEntries(await listImportHistory(db));
      setError(null);
    } catch {
      setEntries([]);
      setError('Your import history could not be read. Nothing has been changed.');
    }
  }, [db]);

  useEffect(() => {
    void reload();
    // `refreshToken` is a dependency on purpose: a change means the workspace
    // was written to elsewhere on this page and the list is now stale.
  }, [reload, refreshToken]);

  const confirmRollback = async () => {
    if (rollingBackRef.current || !pending || !db?.isOpen()) return;

    rollingBackRef.current = true;
    setRollingBack(true);
    try {
      const result = await rollbackImportSession(db, pending.sessionId);
      if (result.ok) {
        setOutcome(
          `Removed ${result.removedTransactionCount.toLocaleString('en-US')} transaction${
            result.removedTransactionCount === 1 ? '' : 's'
          } from that import.${
            result.emptiedAccountIds.length > 0
              ? ` ${result.emptiedAccountIds.length} account${result.emptiedAccountIds.length === 1 ? '' : 's'} now hold no transactions; ${result.emptiedAccountIds.length === 1 ? 'it was' : 'they were'} kept, and you can remove ${result.emptiedAccountIds.length === 1 ? 'it' : 'them'} from Settings.`
              : ''
          }`,
        );
      } else {
        setOutcome(result.message);
      }
      await reload();
    } finally {
      rollingBackRef.current = false;
      setRollingBack(false);
      setPending(null);
    }
  };

  if (entries === null) {
    return (
      <Card ariaLabelledBy="history-title">
        <CardBody>
          <CardTitle id="history-title">Import history</CardTitle>
          <p role="status" className="mt-2 text-sm text-ink-soft">
            Reading your import history…
          </p>
        </CardBody>
      </Card>
    );
  }

  if (error) {
    return (
      <Card ariaLabelledBy="history-title">
        <CardBody>
          <CardTitle id="history-title">Import history</CardTitle>
          <p role="alert" className="mt-2 text-sm text-pa">
            {error}
          </p>
        </CardBody>
      </Card>
    );
  }

  if (entries.length === 0) {
    return (
      <div>
        {/* Rolling back the last import empties the list. The outcome still has
            to be reported, or the user is left without confirmation that the
            thing they just asked for actually happened. */}
        {outcome ? (
          <p
            role="status"
            className="mb-4 rounded-card border border-line bg-canvas-sunk p-3 text-sm text-ink-soft"
          >
            {outcome}
          </p>
        ) : null}
        <EmptyState
          icon={FileClock}
          title="No imports yet"
          description="Once you import a CSV, it appears here with its file names, row counts, and a rollback control that removes only that import."
          items={[
            'Accepted, rejected, and duplicate-candidate counts for every import',
            'The statement period, when you provided one',
            'Rollback that removes one import session and nothing else',
          ]}
        />
      </div>
    );
  }

  return (
    <section aria-labelledby="history-title">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="history-title" className="text-lg font-semibold text-ink">
          Import history
        </h2>
        <p className="text-sm text-ink-muted">
          {`${entries.length.toLocaleString('en-US')} import${entries.length === 1 ? '' : 's'}`}
        </p>
      </div>

      {outcome ? (
        <p
          role="status"
          className="mt-3 rounded-card border border-line bg-canvas-sunk p-3 text-sm text-ink-soft"
        >
          {outcome}
        </p>
      ) : null}

      <ul className="mt-4 space-y-3">
        {entries.slice(0, visible).map((entry) => (
          <li key={entry.sessionId}>
            <Card>
              <CardBody>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-ink">
                      {new Date(entry.importedAt).toLocaleString('en-US', {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                    </p>
                    <p className="mt-0.5 text-xs break-words text-ink-muted">
                      {entry.sourceFileNames.join(', ') || 'No file name recorded'}
                    </p>
                    {entry.accountLabels.length > 0 ? (
                      <p className="mt-0.5 text-xs text-ink-muted">
                        {entry.accountLabels.join(', ')}
                      </p>
                    ) : null}
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={rollingBack}
                    onClick={() => setPending(entry)}
                  >
                    Roll back
                  </Button>
                </div>

                <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs">
                  <Figure label="Rows read" value={entry.rowCount} />
                  <Figure label="Imported" value={entry.acceptedCount} />
                  <Figure label="Not imported" value={entry.rejectedCount} />
                  <Figure label="Duplicate candidates" value={entry.duplicateCandidateCount} />
                  <Figure label="Still stored" value={entry.storedTransactionCount} />
                </dl>

                {entry.statementRangeStart || entry.statementRangeEnd ? (
                  <p className="mt-2 text-xs text-ink-muted">
                    {`Statement period ${entry.statementRangeStart ?? 'unknown'} to ${entry.statementRangeEnd ?? 'unknown'}`}
                  </p>
                ) : null}

                {!entry.countsReconcile ? (
                  <p className="mt-2">
                    <Badge tone="notice">
                      This import&apos;s counts do not add up and may have come from another version
                    </Badge>
                  </p>
                ) : null}

                {entry.warnings.length > 0 ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs font-medium text-ink-muted">
                      {`${entry.warnings.length} warning${entry.warnings.length === 1 ? '' : 's'}`}
                    </summary>
                    <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-ink-soft">
                      {entry.warnings.map((warning, index) => (
                        <li key={index}>{warning}</li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </CardBody>
            </Card>
          </li>
        ))}
      </ul>

      {entries.length > visible ? (
        <Button
          variant="secondary"
          size="sm"
          className="mt-4"
          onClick={() => setVisible((count) => count + PAGE_SIZE)}
        >
          {`Show ${Math.min(PAGE_SIZE, entries.length - visible)} more`}
        </Button>
      ) : null}

      {pending ? (
        <ConfirmDialog
          title="Roll back this import?"
          confirmLabel={`Remove ${pending.storedTransactionCount.toLocaleString('en-US')} transactions`}
          busy={rollingBack}
          onCancel={() => setPending(null)}
          onConfirm={() => void confirmRollback()}
        >
          <p>
            {`Every transaction from the import on ${new Date(pending.importedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })} will be removed — ${pending.storedTransactionCount.toLocaleString('en-US')} in total.`}
          </p>
          <p>
            Transactions from other imports are not touched, and no account is deleted. This cannot
            be undone, but you can import the file again.
          </p>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="money font-medium text-ink">{value.toLocaleString('en-US')}</dd>
    </div>
  );
}
