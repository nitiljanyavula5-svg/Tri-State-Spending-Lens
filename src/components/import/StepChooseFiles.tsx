import { useId, useRef, useState } from 'react';
import { FileText, Upload, X } from 'lucide-react';
import { Button } from '../ui/Button';
import { Callout } from '../ui/Callout';
import { describeBytes } from '../../import/fileValidation';
import {
  ACCEPTED_EXTENSIONS,
  MAX_FILE_BYTES,
  MAX_FILES_PER_SESSION,
  MAX_SESSION_ROWS,
} from '../../import/limits';
import type { ImportWizardApi } from '../../import/wizard/useImportWizard';

const MAX_FILE_MIB = MAX_FILE_BYTES / (1024 * 1024);

interface StepChooseFilesProps {
  readonly wizard: ImportWizardApi;
}

export function StepChooseFiles({ wizard }: StepChooseFilesProps) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const { state } = wizard;

  const accept = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    wizard.addFiles([...list]);
    // Clearing the input lets the same file be chosen again after removal.
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <div className="space-y-6">
      <Callout tone="privacy" title="Your file stays on this device">
        <p>
          The file is read here, in your browser, by a background worker. Nothing is uploaded, and
          no part of it is sent anywhere. The original file is discarded once its rows are
          normalized.
        </p>
      </Callout>

      <div>
        <label htmlFor={inputId} className="block text-sm font-semibold text-ink">
          Choose CSV files
        </label>
        <p id={`${inputId}-help`} className="mt-1 text-sm text-ink-soft">
          {`Up to ${MAX_FILES_PER_SESSION} files, ${MAX_FILE_MIB} MB each, ${MAX_SESSION_ROWS.toLocaleString('en-US')} rows in total. A .csv extension is required, but it is not a promise the contents will read correctly — that is checked in the next steps.`}
        </p>

        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            accept(event.dataTransfer?.files ?? null);
          }}
          className={`mt-3 rounded-card border border-dashed p-5 text-center transition-colors ${
            dragging ? 'border-nj bg-nj-wash' : 'border-line-strong bg-canvas-sunk'
          }`}
        >
          <Upload aria-hidden="true" className="mx-auto size-6 text-ink-muted" />
          <input
            ref={inputRef}
            id={inputId}
            type="file"
            multiple
            accept={ACCEPTED_EXTENSIONS.join(',')}
            aria-describedby={`${inputId}-help`}
            onChange={(event) => accept(event.target.files)}
            className="mx-auto mt-3 block w-full max-w-sm text-sm text-ink-soft file:mr-3 file:rounded-control file:border file:border-line-strong file:bg-canvas file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-ink"
          />
          <p className="mt-2 text-xs text-ink-muted">or drop files here</p>
        </div>
      </div>

      {state.selectionFailures.length > 0 ? (
        <div role="alert" className="rounded-card border border-pa/40 bg-pa-wash p-4">
          <p className="text-sm font-semibold text-ink">Some files were not added</p>
          <ul className="mt-2 space-y-1 text-sm text-ink-soft">
            {state.selectionFailures.map((failure, index) => (
              <li key={`${failure.code}-${index}`}>
                {failure.fileName ? `${failure.fileName}: ` : ''}
                {failure.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {state.files.length > 0 ? (
        <section aria-labelledby="staged-files-title">
          <div className="flex items-center justify-between gap-3">
            <h3 id="staged-files-title" className="text-sm font-semibold text-ink">
              {`Staged files (${state.files.length})`}
            </h3>
            <Button variant="quiet" size="sm" onClick={wizard.clearFiles}>
              Clear all
            </Button>
          </div>

          <ul className="mt-3 divide-y divide-line border-y border-line">
            {state.files.map((draft) => (
              <li key={draft.id} className="flex items-center gap-3 py-2.5">
                <FileText aria-hidden="true" className="size-4 shrink-0 text-ink-muted" />
                <div className="min-w-0 flex-1">
                  {/* The neutralized name is the only form ever rendered. */}
                  <p className="truncate text-sm font-medium text-ink">{draft.displayName}</p>
                  <p className="text-xs text-ink-muted">
                    {describeBytes(draft.byteLength)}
                    {draft.pendingInspectId ? ' · reading…' : ''}
                    {draft.inspectionFailure ? ` · ${draft.inspectionFailure.message}` : ''}
                  </p>
                </div>
                <Button
                  variant="quiet"
                  size="sm"
                  onClick={() => wizard.removeFile(draft.id)}
                  aria-label={`Remove ${draft.displayName}`}
                >
                  <X aria-hidden="true" className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
