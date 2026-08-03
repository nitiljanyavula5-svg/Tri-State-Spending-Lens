import { useCallback, useId, useRef, useState } from 'react';
import { Download, FlaskConical, Trash2, Upload } from 'lucide-react';
import { PageContainer } from '../../app/layout/PageContainer';
import { useWorkspace } from '../../app/providers/workspaceContext';
import { ReplaceWorkspaceConfirm } from '../../components/demo/ReplaceWorkspaceConfirm';
import { useDemoLoader } from '../../components/demo/useDemoLoader';
import { Badge } from '../../components/ui/Badge';
import { Button, ButtonLink } from '../../components/ui/Button';
import { Callout } from '../../components/ui/Callout';
import { Card, CardBody, CardTitle } from '../../components/ui/Card';
import { PageHeader } from '../../components/ui/PageHeader';
import { useDocumentTitle } from '../../lib/useDocumentTitle';

const DESCRIBED_ONLY = [
  {
    id: 'accounts',
    title: 'Accounts',
    detail:
      'Label each imported account and set its type — checking, savings, credit card, cash, or other — so transfers and card payments can be recognized rather than counted twice. Account editing arrives with the transaction grid in Phase 4.',
  },
  {
    id: 'merchant-rules',
    title: 'Merchant rules',
    detail:
      'Review the rules you have created, see how many transactions each one matches, change its priority, or remove it. Patterns are matched literally, never as code. Rule management arrives in Phase 4.',
  },
] as const;

function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'Unavailable';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

export function SettingsPage() {
  useDocumentTitle('Settings');
  const { status, blockedMessage, summary, storage, actions } = useWorkspace();

  const [message, setMessage] = useState<string | null>(null);
  const [problemPaths, setProblemPaths] = useState<string[]>([]);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const restoreInputId = useId();

  const ready = status === 'ready' && summary !== null;
  const isDemo = summary?.mode === 'demo';
  const hasData = Boolean(summary && !summary.isEmpty);

  const announceDemoLoaded = useCallback(
    (outcome: { transactionCount: number; accountCount: number }) => {
      setProblemPaths([]);
      setMessage(
        `Demo workspace loaded: ${outcome.transactionCount.toLocaleString('en-US')} fictional transactions across ${outcome.accountCount} accounts.`,
      );
    },
    [],
  );

  // The same loader the landing page uses, so Settings cannot replace personal
  // data without the confirmation step.
  const demo = useDemoLoader({ onLoaded: announceDemoLoaded });

  /**
   * `onFailure` is supplied per call rather than shared, because only some of
   * these operations can honestly promise nothing changed. A single generic
   * "Nothing was changed" would be a claim this function cannot make for an
   * operation it knows nothing about.
   */
  async function run(task: () => Promise<string>, onFailure: string) {
    setBusy(true);
    setProblemPaths([]);
    try {
      setMessage(await task());
    } catch {
      // Error text never carries a field value (threat-model.md §8).
      setMessage(onFailure);
    } finally {
      setBusy(false);
    }
  }

  const handleRestoreFile = async (file: File) => {
    setBusy(true);
    setProblemPaths([]);
    try {
      // Goes through the provider so the file-size limit is enforced before any
      // bytes are read.
      const report = await actions.restoreFromFile(file);
      if (report.outcome === 'restored') {
        const total = Object.values(report.counts ?? {}).reduce((sum, n) => sum + n, 0);
        setMessage(
          `Workspace restored. ${total.toLocaleString('en-US')} records were written${
            report.migratedFrom === undefined
              ? ''
              : `, after migrating from schema version ${report.migratedFrom}`
          }.`,
        );
      } else {
        setMessage(report.rejection?.message ?? 'That backup was not restored.');
        setProblemPaths(report.rejection?.problemPaths ?? []);
      }
    } catch {
      setMessage('That file could not be read. Nothing was changed.');
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Utility"
        title="Settings"
        lede="Accounts, merchant rules, backup and restore, storage, and the delete-all control."
        actions={isDemo ? <Badge tone="nj">Fictional demo data loaded</Badge> : undefined}
      />

      {status === 'blocked' ? (
        <Callout tone="caution" title="The local workspace could not be opened" className="mt-8">
          <p>{blockedMessage}</p>
        </Callout>
      ) : null}

      {/* One polite live region, so every outcome is announced rather than only
          appearing visually. */}
      <div role="status" aria-live="polite" className="mt-8">
        {message ? (
          <div className="rounded-card border border-ny/25 bg-ny-wash p-4">
            <p className="text-sm font-medium text-ink">{message}</p>
            {problemPaths.length > 0 ? (
              <>
                <p className="mt-2 text-xs text-ink-soft">
                  Fields that failed validation (names only — no values from the file are shown):
                </p>
                <ul className="mt-1 space-y-0.5">
                  {problemPaths.map((path) => (
                    <li key={path} className="money text-xs text-ink-muted">
                      {path}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="mt-8 grid gap-4 lg:grid-cols-2">
        <Card ariaLabelledBy="setting-demo">
          <CardBody>
            <CardTitle id="setting-demo" as="h3">
              Demo workspace
            </CardTitle>
            <p className="mt-2 text-sm leading-relaxed text-ink-soft">
              Fill the workspace with obviously fictional transactions spanning four complete
              months. Resetting restores the original dataset exactly — it is generated
              deterministically, so it is identical every time.
            </p>
            <p className="mt-2 text-sm leading-relaxed text-ink-soft">
              Loading the demo replaces everything currently stored. It never merges invented
              transactions into real data.
            </p>
            {demo.confirming ? (
              <div className="mt-4">
                <ReplaceWorkspaceConfirm
                  busy={demo.busy}
                  onConfirm={demo.confirm}
                  onCancel={demo.cancel}
                />
              </div>
            ) : (
              <div className="mt-4 flex flex-wrap gap-2">
                {/* Shares `useDemoLoader` with the landing page, so this button
                    cannot skip the confirmation that protects personal data. */}
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!demo.ready || demo.busy}
                  onClick={demo.request}
                >
                  <FlaskConical className="size-4" aria-hidden="true" />
                  {demo.busy
                    ? 'Loading the demo…'
                    : isDemo
                      ? 'Reload demo workspace'
                      : 'Load demo workspace'}
                </Button>
                {isDemo ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!ready || busy}
                    onClick={() =>
                      run(
                        async () => {
                          const result = await actions.resetDemo();
                          return `Demo reset to its original state: ${result.transactionCount.toLocaleString('en-US')} fictional transactions.`;
                        },
                        // The reset is one transaction, so this claim is safe.
                        'Resetting the demo did not complete. The workspace was left as it was.',
                      )
                    }
                  >
                    Reset demo
                  </Button>
                ) : null}
              </div>
            )}

            {demo.error ? <p className="mt-3 text-xs text-negative">{demo.error}</p> : null}
          </CardBody>
        </Card>

        <Card ariaLabelledBy="setting-backup">
          <CardBody>
            <CardTitle id="setting-backup" as="h3">
              Backup and restore
            </CardTitle>
            <p className="mt-2 text-sm leading-relaxed text-ink-soft">
              A backup is a single versioned JSON file written straight to this device. Restoring
              validates the whole file before touching anything, so a damaged or unrecognized backup
              cannot destroy good data.
            </p>

            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={!ready || busy}
                onClick={() =>
                  run(
                    async () => {
                      const filename = await actions.downloadBackup();
                      return `Backup downloaded as ${filename}.`;
                    },
                    // Exporting only reads, so nothing can have changed.
                    'The backup did not complete. Your data was only read, never modified.',
                  )
                }
              >
                <Download className="size-4" aria-hidden="true" />
                Download workspace backup
              </Button>
            </div>

            <div className="mt-4">
              <label htmlFor={restoreInputId} className="block text-sm font-medium text-ink">
                <span className="inline-flex items-center gap-2">
                  <Upload className="size-4" aria-hidden="true" />
                  Restore a workspace backup
                </span>
              </label>
              <input
                ref={fileInputRef}
                id={restoreInputId}
                type="file"
                accept="application/json,.json"
                disabled={!ready || busy}
                className="mt-2 block w-full rounded-control border border-line-control bg-surface p-2 text-sm text-ink file:mr-3 file:rounded-chip file:border-0 file:bg-canvas-sunk file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-ink"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void handleRestoreFile(file);
                }}
              />
              <p className="mt-2 text-xs leading-relaxed text-ink-muted">
                Restoring replaces everything currently stored. A backup from a newer version is
                refused rather than guessed at.
              </p>
            </div>
          </CardBody>
        </Card>

        <Card ariaLabelledBy="setting-storage">
          <CardBody>
            <CardTitle id="setting-storage" as="h3">
              Storage
            </CardTitle>
            <dl className="mt-3 divide-y divide-line border-y border-line">
              <div className="flex items-baseline justify-between gap-4 py-2">
                <dt className="text-sm text-ink-muted">Used by this site</dt>
                <dd className="money text-sm font-medium text-ink">
                  {formatBytes(storage.usageBytes)}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-4 py-2">
                <dt className="text-sm text-ink-muted">Browser allowance</dt>
                <dd className="money text-sm font-medium text-ink">
                  {formatBytes(storage.quotaBytes)}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-4 py-2">
                <dt className="text-sm text-ink-muted">Marked persistent</dt>
                <dd className="text-sm font-medium text-ink">
                  {storage.persisted === null ? 'Unavailable' : storage.persisted ? 'Yes' : 'No'}
                </dd>
              </div>
            </dl>
            <div className="mt-4">
              <Button
                variant="secondary"
                size="sm"
                disabled={!ready || busy}
                onClick={() =>
                  run(
                    async () => {
                      const granted = await actions.requestPersistentStorage();
                      return granted
                        ? 'The browser marked this storage as persistent. That reduces the chance of eviction; it does not guarantee the data cannot be removed.'
                        : 'The browser did not mark this storage as persistent. Downloading a backup remains the reliable protection.';
                    },
                    // This asks the browser about storage; it never touches records.
                    'The persistence request did not complete. Your stored data was not affected.',
                  )
                }
              >
                Request persistent storage
              </Button>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-ink-muted">
              IndexedDB is local browser storage, not encrypted vault storage. Anyone who can use
              this unlocked browser profile may be able to inspect it. Clearing site data, browsing
              privately, or changing domains can remove what is stored, and browsers may evict data
              when space runs low.
            </p>
          </CardBody>
        </Card>

        <Card ariaLabelledBy="setting-delete">
          <CardBody>
            <CardTitle id="setting-delete" as="h3">
              Delete all data
            </CardTitle>
            <p className="mt-2 text-sm leading-relaxed text-ink-soft">
              Clears every transaction, budget, merchant rule, recurring series, and setting stored
              in this browser. Deletion is local only — there is nothing stored on a server to
              delete, and this product will not pretend otherwise.
            </p>

            {confirmingDelete ? (
              <div className="mt-4 rounded-card border border-negative/30 bg-surface p-4">
                <p className="text-sm font-semibold text-ink">
                  Delete everything stored in this browser?
                </p>
                <p className="mt-1 text-sm leading-relaxed text-ink-soft">
                  This cannot be undone. If you have not downloaded a backup, do that first.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setConfirmingDelete(false);
                      void run(
                        async () => {
                          await actions.deleteEverything();
                          return 'All local data has been deleted. Transactions, budgets, merchant rules, recurring series, and settings are gone from this browser.';
                        },
                        // Deletion runs in one transaction, so a failure means
                        // none of it happened.
                        'The deletion did not complete. Your data is still here — nothing was removed.',
                      );
                    }}
                  >
                    Yes, delete everything
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => setConfirmingDelete(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div className="mt-4">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!ready || busy || !hasData}
                  onClick={() => setConfirmingDelete(true)}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                  Delete all data
                </Button>
                {!hasData ? (
                  <p className="mt-2 text-xs text-ink-muted">
                    There is nothing stored in this browser to delete.
                  </p>
                ) : null}
              </div>
            )}
          </CardBody>
        </Card>

        {DESCRIBED_ONLY.map((section) => (
          <Card key={section.id} ariaLabelledBy={`setting-${section.id}`}>
            <CardBody>
              <CardTitle id={`setting-${section.id}`} as="h3">
                {section.title}
              </CardTitle>
              <p className="mt-2 text-sm leading-relaxed text-ink-soft">{section.detail}</p>
            </CardBody>
          </Card>
        ))}
      </div>

      <Callout tone="caution" title="Back up before you rely on this" className="mt-8">
        <p>
          A local-first workspace is private but not indestructible. Clearing site data, browsing
          privately, or a browser reclaiming space can all remove what is stored here. Downloading a
          backup before a large import or a browser change is the only reliable protection.
        </p>
      </Callout>

      <div className="mt-6">
        <ButtonLink to="/privacy" variant="secondary" size="sm">
          Read the privacy model
        </ButtonLink>
      </div>
    </PageContainer>
  );
}
