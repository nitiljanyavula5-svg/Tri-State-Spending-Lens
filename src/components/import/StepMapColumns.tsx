import { useState } from 'react';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card, CardBody, CardTitle } from '../ui/Card';
import { ConfirmDialog } from './ConfirmDialog';
import { RadioGroup, SelectField, TextField } from './FormControls';
import { PreviewTable } from './PreviewTable';
import { MAX_PRESET_NAME_LENGTH } from '../../import/limits';
import type { ImportWizardApi } from '../../import/wizard/useImportWizard';
import type { MappingPresetsApi } from '../../import/wizard/useMappingPresets';
import { mappingIssues, type FileDraft } from '../../import/wizard/wizardState';

interface StepMapColumnsProps {
  readonly wizard: ImportWizardApi;
  readonly presets: MappingPresetsApi;
}

/**
 * Step 3 — which column holds what.
 *
 * The two amount layouts data-methodology.md §2.5 requires are offered as an
 * explicit choice rather than inferred, and the schema's own rule that no two
 * required fields may share a column is surfaced per field as the user works.
 */
export function StepMapColumns({ wizard, presets }: StepMapColumnsProps) {
  return (
    <div className="space-y-5">
      <p className="text-sm leading-relaxed text-ink-soft">
        Point each required field at a column. Unmapped columns are ignored rather than guessed at.
      </p>

      {presets.error ? (
        <p role="alert" className="text-sm text-pa">
          {presets.error}
        </p>
      ) : null}

      {wizard.state.files.map((draft) => (
        <FileMappingCard key={draft.id} draft={draft} wizard={wizard} presets={presets} />
      ))}
    </div>
  );
}

function FileMappingCard({
  draft,
  wizard,
  presets,
}: {
  draft: FileDraft;
  wizard: ImportWizardApi;
  presets: MappingPresetsApi;
}) {
  const [presetName, setPresetName] = useState('');
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);
  const titleId = `mapping-${draft.id}`;

  const columns = draft.columns;
  const issues = mappingIssues(wizard.state, draft);
  const issueFor = (path: string) => issues.find((issue) => issue.path === path)?.message;

  if (columns.length === 0 || draft.format === null) {
    return (
      <Card ariaLabelledBy={titleId}>
        <CardBody>
          <CardTitle id={titleId} as="h3">
            {draft.displayName}
          </CardTitle>
          <p className="mt-2 text-sm text-ink-soft">
            This file has no readable header yet. Go back and adjust its format.
          </p>
        </CardBody>
      </Card>
    );
  }

  const columnOptions = columns.map((name, index) => ({
    value: index,
    label: `${index + 1}. ${name.trim() || `Column ${index + 1}`}`,
  }));

  const compatibility = presets.compatibilityFor(columns);
  const sameLayoutFiles = wizard.state.files.filter(
    (other) =>
      other.id !== draft.id &&
      other.columns.length === columns.length &&
      other.columns.every((name, index) => name.trim() === columns[index]?.trim()),
  );

  const savePreset = async () => {
    const trimmed = presetName.trim();
    if (trimmed.length === 0) {
      setSaveMessage('Give the preset a name first.');
      return;
    }
    const mapping = wizard.state.files.find((file) => file.id === draft.id);
    if (!mapping || draft.format === null) return;

    // Built from the confirmed structure only. `buildPreset` drops the account
    // target and everything else file-specific.
    const result = await presets.save({
      name: trimmed,
      format: draft.format,
      mapping: {
        dateColumn: draft.mapping.dateColumn ?? 0,
        descriptionColumn: draft.mapping.descriptionColumn ?? 0,
        amount:
          draft.mapping.amountModel === 'signed'
            ? {
                kind: 'signed',
                amountColumn: draft.mapping.amountColumn ?? 0,
                negativeMeans: draft.mapping.negativeMeans,
              }
            : {
                kind: 'debit-credit',
                debitColumn: draft.mapping.debitColumn ?? 0,
                creditColumn: draft.mapping.creditColumn ?? 0,
              },
        ...(draft.mapping.accountLabelColumn === null
          ? {}
          : { accountLabelColumn: draft.mapping.accountLabelColumn }),
        ...(draft.mapping.typeColumn === null ? {} : { typeColumn: draft.mapping.typeColumn }),
        dateFormat: draft.dateFormat ?? 'iso',
        account: { kind: 'existing', accountId: 'not-stored-in-preset' },
      },
      columns,
    });

    setSaveMessage(result.ok ? 'Saved.' : (result.message ?? 'That preset could not be saved.'));
    if (result.ok) setPresetName('');
  };

  return (
    <Card ariaLabelledBy={titleId}>
      <CardBody>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <CardTitle id={titleId} as="h3">
            {draft.displayName}
          </CardTitle>
          {draft.appliedPresetId ? <Badge tone="ny">Preset applied</Badge> : null}
        </div>

        {/* ------------------------------------------------------- presets - */}
        {compatibility.length > 0 ? (
          <section aria-labelledby={`${titleId}-presets`} className="mt-4">
            <h4 id={`${titleId}-presets`} className="text-xs font-semibold text-ink-muted">
              Saved column mappings
            </h4>
            <ul className="mt-2 space-y-1.5">
              {compatibility.map(({ preset, compatible, reason }) => (
                <li key={preset.id} className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">{preset.name}</span>
                  <span className="text-xs text-ink-muted">{reason}</span>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!compatible}
                    onClick={() => wizard.applyPreset(draft.id, preset)}
                  >
                    {compatible ? 'Apply' : 'Does not fit'}
                  </Button>
                  <Button
                    variant="quiet"
                    size="sm"
                    onClick={() => setPendingDelete({ id: preset.id, name: preset.name })}
                  >
                    Delete
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* ------------------------------------------------------ mapping - */}
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <SelectField
            label="Date column"
            numeric
            value={draft.mapping.dateColumn}
            options={columnOptions}
            placeholder="Choose a column"
            onChange={(value) =>
              wizard.changeMapping(draft.id, { dateColumn: value === null ? null : Number(value) })
            }
            {...(issueFor('date') ? { error: issueFor('date')! } : {})}
          />
          <SelectField
            label="Description column"
            numeric
            value={draft.mapping.descriptionColumn}
            options={columnOptions}
            placeholder="Choose a column"
            onChange={(value) =>
              wizard.changeMapping(draft.id, {
                descriptionColumn: value === null ? null : Number(value),
              })
            }
            {...(issueFor('description') ? { error: issueFor('description')! } : {})}
          />
        </div>

        <div className="mt-4">
          <RadioGroup
            name={`amount-model-${draft.id}`}
            legend="How does this file record the amount?"
            value={draft.mapping.amountModel}
            onChange={(value) => wizard.changeMapping(draft.id, { amountModel: value })}
            options={[
              {
                value: 'signed',
                label: 'One amount column',
                description: 'Positive and negative values in a single column.',
              },
              {
                value: 'debit-credit',
                label: 'Separate debit and credit columns',
                description: 'Exactly one of the two carries a value on each row.',
              },
            ]}
          />
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {draft.mapping.amountModel === 'signed' ? (
            <SelectField
              label="Amount column"
              numeric
              value={draft.mapping.amountColumn}
              options={columnOptions}
              placeholder="Choose a column"
              onChange={(value) =>
                wizard.changeMapping(draft.id, {
                  amountColumn: value === null ? null : Number(value),
                })
              }
              {...(issueFor('amount') ? { error: issueFor('amount')! } : {})}
            />
          ) : (
            <>
              <SelectField
                label="Debit column"
                numeric
                value={draft.mapping.debitColumn}
                options={columnOptions}
                placeholder="Choose a column"
                onChange={(value) =>
                  wizard.changeMapping(draft.id, {
                    debitColumn: value === null ? null : Number(value),
                  })
                }
                {...(issueFor('debit') ? { error: issueFor('debit')! } : {})}
              />
              <SelectField
                label="Credit column"
                numeric
                value={draft.mapping.creditColumn}
                options={columnOptions}
                placeholder="Choose a column"
                onChange={(value) =>
                  wizard.changeMapping(draft.id, {
                    creditColumn: value === null ? null : Number(value),
                  })
                }
                {...(issueFor('credit') ? { error: issueFor('credit')! } : {})}
              />
            </>
          )}
        </div>

        <details className="mt-4">
          <summary className="cursor-pointer text-xs font-medium text-ink-muted">
            Optional columns
          </summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <SelectField
              label="Account label column"
              numeric
              value={draft.mapping.accountLabelColumn}
              options={columnOptions}
              placeholder="Not mapped"
              onChange={(value) =>
                wizard.changeMapping(draft.id, {
                  accountLabelColumn: value === null ? null : Number(value),
                })
              }
              hint="Recorded in the mapping. Phase 3 does not interpret it."
            />
            <SelectField
              label="Transaction type column"
              numeric
              value={draft.mapping.typeColumn}
              options={columnOptions}
              placeholder="Not mapped"
              onChange={(value) =>
                wizard.changeMapping(draft.id, {
                  typeColumn: value === null ? null : Number(value),
                })
              }
              hint="Recorded in the mapping. Phase 3 does not interpret it."
            />
          </div>
        </details>

        {sameLayoutFiles.length > 0 ? (
          <Button
            variant="secondary"
            size="sm"
            className="mt-4"
            onClick={() => wizard.copyMappingToMatchingFiles(draft.id)}
          >
            {`Use this mapping for ${sameLayoutFiles.length} file${sameLayoutFiles.length === 1 ? '' : 's'} with the same columns`}
          </Button>
        ) : null}

        {draft.inspection ? (
          <div className="mt-4">
            <PreviewTable
              caption={`Columns of ${draft.displayName}`}
              columns={columns}
              rows={draft.inspection.sampleRows}
              maxRows={4}
            />
          </div>
        ) : null}

        {/* --------------------------------------------------- save preset - */}
        <div className="mt-5 border-t border-line pt-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-0 flex-1">
              <TextField
                label="Save this mapping for next time"
                value={presetName}
                onChange={setPresetName}
                maxLength={MAX_PRESET_NAME_LENGTH}
                placeholder="A name you will recognize"
                hint="Stores column positions and conventions only — never any part of your statement."
              />
            </div>
            <Button variant="secondary" size="sm" onClick={() => void savePreset()}>
              Save preset
            </Button>
          </div>
          {saveMessage ? (
            <p role="status" className="mt-2 text-xs text-ink-soft">
              {saveMessage}
            </p>
          ) : null}
        </div>
      </CardBody>

      {pendingDelete ? (
        <ConfirmDialog
          title="Delete this saved mapping?"
          confirmLabel="Delete preset"
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            void presets.remove(pendingDelete.id);
            setPendingDelete(null);
          }}
        >
          <p>
            {`“${pendingDelete.name}” will be removed from this browser. Your imported transactions are not affected.`}
          </p>
        </ConfirmDialog>
      ) : null}
    </Card>
  );
}
