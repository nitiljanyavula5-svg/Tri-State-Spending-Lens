import { useCallback, useState } from 'react';
import { PageContainer } from '../app/layout/PageContainer';
import { PageHeader } from '../components/ui/PageHeader';
import { Callout } from '../components/ui/Callout';
import { ImportHistoryPanel } from '../components/import/ImportHistoryPanel';
import { ImportWizard } from '../components/import/ImportWizard';
import { useWorkspace } from '../app/providers/workspaceContext';
import { useDocumentTitle } from '../lib/useDocumentTitle';

export function ImportPage() {
  // The title is a constant. No filename, account, or amount ever reaches it
  // (threat-model.md §8).
  useDocumentTitle('Import');

  const { status, blockedMessage } = useWorkspace();

  // A committed import has to show up in the history below it immediately.
  const [historyToken, setHistoryToken] = useState(0);
  const refreshHistory = useCallback(() => setHistoryToken((token) => token + 1), []);

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Utility"
        title="Import a bank CSV"
        lede="Your file is read in your browser and never uploaded. Each import is all-or-nothing, and can be rolled back later without touching anything else in your workspace."
      />

      <Callout tone="privacy" title="Nothing here is uploaded" className="mt-8">
        <p>
          Parsing happens on this device, in a background worker so the page stays responsive. The
          original file is discarded once its rows are normalized; only the cleaned rows are kept,
          along with each row&apos;s original line number and description so any figure can be
          traced back to your statement.
        </p>
      </Callout>

      {status === 'blocked' ? (
        <div role="alert" className="mt-8 rounded-card border border-pa/40 bg-pa-wash p-4">
          <p className="text-sm font-semibold text-ink">Importing is unavailable</p>
          <p className="mt-1 text-sm leading-relaxed text-ink-soft">{blockedMessage}</p>
        </div>
      ) : status === 'opening' ? (
        <p role="status" className="mt-8 text-sm text-ink-soft">
          Opening your local workspace…
        </p>
      ) : (
        <div className="mt-8">
          <ImportWizard onWorkspaceChanged={refreshHistory} />
        </div>
      )}

      <div className="mt-10">
        <ImportHistoryPanel refreshToken={historyToken} />
      </div>
    </PageContainer>
  );
}
