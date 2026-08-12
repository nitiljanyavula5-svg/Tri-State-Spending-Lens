import { Badge } from '../ui/Badge';
import { Card, CardBody, CardTitle } from '../ui/Card';
import { SelectField } from './FormControls';
import { PreviewTable } from './PreviewTable';
import { MAX_PREVIEW_ROWS } from '../../import/limits';
import type { Delimiter } from '../../import/detectFormat';
import type { Encoding } from '../../import/decode';
import type { ImportWizardApi } from '../../import/wizard/useImportWizard';
import type { FileDraft } from '../../import/wizard/wizardState';

const ENCODINGS: readonly { value: Encoding; label: string }[] = [
  { value: 'utf-8', label: 'UTF-8' },
  { value: 'utf-8-bom', label: 'UTF-8 with byte-order mark' },
  { value: 'utf-16le', label: 'UTF-16 little-endian' },
  { value: 'utf-16be', label: 'UTF-16 big-endian' },
  { value: 'windows-1252', label: 'Windows-1252' },
];

const DELIMITERS: readonly { value: Delimiter; label: string }[] = [
  { value: ',', label: 'Comma  ,' },
  { value: ';', label: 'Semicolon  ;' },
  { value: '\t', label: 'Tab' },
  { value: '|', label: 'Pipe  |' },
];

function confidenceTone(confidence: 'high' | 'medium' | 'low') {
  return confidence === 'high' ? 'nj' : confidence === 'medium' ? 'ny' : 'notice';
}

interface StepIdentifyFormatProps {
  readonly wizard: ImportWizardApi;
}

/**
 * Step 2 — what the detector proposed, and what the user decided.
 *
 * Detection only ever *proposes* (data-methodology.md §2.4). Every control here
 * shows both the detector's confidence and whether the current value is still
 * the detected one or has been changed, so "detected" and "confirmed" are never
 * conflated. Changing a value is what makes it the user's choice — and the
 * reducer discards the mapping and normalized rows built on the old structure.
 */
export function StepIdentifyFormat({ wizard }: StepIdentifyFormatProps) {
  return (
    <div className="space-y-5">
      <p className="text-sm leading-relaxed text-ink-soft">
        These settings were detected from a sample of each file. They are proposals — change
        anything that looks wrong. Changing the delimiter or header row clears the column mapping,
        because the columns themselves move.
      </p>

      {wizard.state.files.map((draft) => (
        <FileFormatCard key={draft.id} draft={draft} wizard={wizard} />
      ))}
    </div>
  );
}

function FileFormatCard({ draft, wizard }: { draft: FileDraft; wizard: ImportWizardApi }) {
  const titleId = `format-${draft.id}`;

  if (draft.inspectionFailure) {
    return (
      <Card ariaLabelledBy={titleId}>
        <CardBody>
          <CardTitle id={titleId} as="h3">
            {draft.displayName}
          </CardTitle>
          <p role="alert" className="mt-2 text-sm text-pa">
            {draft.inspectionFailure.message}
          </p>
          <p className="mt-1 text-sm text-ink-soft">
            Remove this file in the previous step to continue without it.
          </p>
        </CardBody>
      </Card>
    );
  }

  if (!draft.inspection || !draft.format) {
    return (
      <Card ariaLabelledBy={titleId}>
        <CardBody>
          <CardTitle id={titleId} as="h3">
            {draft.displayName}
          </CardTitle>
          <p className="mt-2 text-sm text-ink-soft">Reading this file…</p>
        </CardBody>
      </Card>
    );
  }

  const { inspection, format } = draft;
  const header = inspection.header;

  return (
    <Card ariaLabelledBy={titleId}>
      <CardBody>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <CardTitle id={titleId} as="h3">
            {draft.displayName}
          </CardTitle>
          <Badge tone={draft.formatSource === 'edited' ? 'ny' : 'neutral'}>
            {draft.formatSource === 'edited' ? 'Changed by you' : 'Detected'}
          </Badge>
        </div>

        <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs">
          <div className="flex items-center gap-1.5">
            <dt className="text-ink-muted">Encoding confidence</dt>
            <dd>
              <Badge tone={confidenceTone(inspection.encoding.confidence)}>
                {inspection.encoding.confidence}
              </Badge>
            </dd>
          </div>
          <div className="flex items-center gap-1.5">
            <dt className="text-ink-muted">Delimiter confidence</dt>
            <dd>
              <Badge tone={confidenceTone(inspection.delimiter.confidence)}>
                {inspection.delimiter.confidence}
              </Badge>
            </dd>
          </div>
          {header ? (
            <div className="flex items-center gap-1.5">
              <dt className="text-ink-muted">Header confidence</dt>
              <dd>
                <Badge tone={confidenceTone(header.confidence)}>{header.confidence}</Badge>
              </dd>
            </div>
          ) : null}
        </dl>

        <p className="mt-2 text-xs leading-relaxed text-ink-muted">
          {inspection.encoding.reason} {inspection.delimiter.reason}
          {header ? ` ${header.reason}` : ''}
        </p>

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <SelectField
            label="Encoding"
            value={format.encoding}
            options={ENCODINGS}
            onChange={(value) =>
              value && wizard.changeFormat(draft.id, { encoding: value as Encoding })
            }
          />
          <SelectField
            label="Delimiter"
            value={format.delimiter}
            options={DELIMITERS}
            onChange={(value) =>
              value && wizard.changeFormat(draft.id, { delimiter: value as Delimiter })
            }
          />
          <SelectField
            label="Header row"
            numeric
            value={format.headerLineIndex}
            options={Array.from(
              { length: Math.max(1, inspection.sampleLineCount) },
              (_, index) => ({
                value: index,
                label: `Line ${index + 1}`,
              }),
            ).slice(0, 25)}
            onChange={(value) =>
              value !== null && wizard.changeFormat(draft.id, { headerLineIndex: Number(value) })
            }
            hint={header && header.skippedLines > 0 ? `${header.skippedLines} lines skipped` : ''}
          />
        </div>

        {header && header.columns.length > 0 ? (
          <div className="mt-4">
            <PreviewTable
              caption={`First rows of ${draft.displayName}`}
              columns={header.columns}
              rows={inspection.sampleRows}
              maxRows={Math.min(5, MAX_PREVIEW_ROWS)}
            />
          </div>
        ) : (
          <p role="alert" className="mt-3 text-sm text-pa">
            No header row could be read with these settings. Try a different delimiter or header
            line.
          </p>
        )}
      </CardBody>
    </Card>
  );
}
