import { FileClock } from 'lucide-react';
import { PageContainer } from '../app/layout/PageContainer';
import { PageHeader } from '../components/ui/PageHeader';
import { Callout } from '../components/ui/Callout';
import { Card, CardBody, CardTitle } from '../components/ui/Card';
import { CodeBlock } from '../components/ui/CodeBlock';
import { EmptyState } from '../components/ui/EmptyState';
import { useDocumentTitle } from '../lib/useDocumentTitle';

const WIZARD_STEPS = [
  { name: 'Choose files', detail: 'One or more CSV files, with the size limit shown up front.' },
  {
    name: 'Identify format',
    detail: 'Delimiter, encoding, and header row are detected and proposed for you to confirm.',
  },
  {
    name: 'Map columns',
    detail: 'Date, description, and amount — or separate debit and credit columns.',
  },
  {
    name: 'Confirm conventions',
    detail: 'Which sign means money out, the date format, the account, and the statement range.',
  },
  {
    name: 'Review preview',
    detail: 'Normalized rows and every warning, before anything is saved.',
  },
  {
    name: 'Import Health Report',
    detail: 'Accepted, rejected, duplicate, questionable, and uncategorized rows, all reconciled.',
  },
] as const;

const LIMITS = [
  { label: 'File type', value: 'CSV only' },
  { label: 'Maximum file size', value: '10 MB per file' },
  { label: 'Maximum rows', value: '100,000 per import' },
  { label: 'Currency', value: 'USD only' },
] as const;

export function ImportPage() {
  useDocumentTitle('Import');

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

      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card ariaLabelledBy="wizard-title">
          <CardBody>
            <CardTitle id="wizard-title">The six steps</CardTitle>
            <p className="mt-2 text-sm leading-relaxed text-ink-soft">
              You confirm how the file should be read before anything is saved. Detection only ever
              proposes.
            </p>
            <ol className="mt-5 space-y-4">
              {WIZARD_STEPS.map((step, index) => (
                <li key={step.name} className="flex gap-4">
                  <span
                    aria-hidden="true"
                    className="money flex size-7 shrink-0 items-center justify-center rounded-control border border-line bg-canvas-sunk text-xs font-semibold text-ink-muted"
                  >
                    {index + 1}
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-ink">{step.name}</p>
                    <p className="mt-0.5 text-sm leading-relaxed text-ink-soft">{step.detail}</p>
                  </div>
                </li>
              ))}
            </ol>
          </CardBody>
        </Card>

        <div className="grid gap-6">
          <Card ariaLabelledBy="layouts-title">
            <CardBody>
              <CardTitle id="layouts-title">Supported layouts</CardTitle>
              <CodeBlock label="Single amount column layout" className="mt-3">
                {'Date | Description | Amount'}
              </CodeBlock>
              <CodeBlock label="Separate debit and credit column layout" className="mt-2">
                {'Date | Description | Debit | Credit'}
              </CodeBlock>
              <p className="mt-3 text-sm leading-relaxed text-ink-soft">
                Extra columns such as an account or memo field can be mapped, or left alone.
                Unmapped columns are ignored rather than guessed at.
              </p>
            </CardBody>
          </Card>

          <Card ariaLabelledBy="limits-title">
            <CardBody>
              <CardTitle id="limits-title">Limits</CardTitle>
              <dl className="mt-3 divide-y divide-line border-y border-line">
                {LIMITS.map((limit) => (
                  <div key={limit.label} className="flex items-baseline justify-between gap-4 py-2">
                    <dt className="text-sm text-ink-muted">{limit.label}</dt>
                    <dd className="text-sm font-medium text-ink">{limit.value}</dd>
                  </div>
                ))}
              </dl>
            </CardBody>
          </Card>
        </div>
      </div>

      <div className="mt-8">
        <EmptyState
          icon={FileClock}
          title="No imports yet"
          description="Once the import engine exists, every import will appear here with its file names, row counts, warnings, and a rollback control that removes only that session's transactions."
          items={[
            'Import history with accepted, rejected, and duplicate counts',
            'A health report you can reopen at any time',
            'One-click rollback for a single import session',
            'Reusable column-mapping presets, saved locally',
            'Duplicate candidates surfaced for review, never deleted automatically',
            'Invalid rows explained by row number, never converted to zero',
          ]}
          status="Arrives in Phase 3 — CSV import engine, worker parsing, and import sessions."
        />
      </div>
    </PageContainer>
  );
}
