import { useState } from 'react';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Callout } from '../ui/Callout';
import { Card, CardBody, CardTitle } from '../ui/Card';
import { RadioGroup, SelectField, TextField } from './FormControls';
import { DATE_FORMAT_LABELS, type DateFormat } from '../../import/dates';
import type { Account, AccountType } from '../../types/domain';
import type { ImportWizardApi } from '../../import/wizard/useImportWizard';
import { stagedAccountFor, type FileDraft } from '../../import/wizard/wizardState';

const ACCOUNT_TYPES: readonly { value: AccountType; label: string }[] = [
  { value: 'checking', label: 'Checking' },
  { value: 'savings', label: 'Savings' },
  { value: 'credit_card', label: 'Credit card' },
  { value: 'cash', label: 'Cash' },
  { value: 'other', label: 'Other' },
];

interface StepConfirmConventionsProps {
  readonly wizard: ImportWizardApi;
  readonly accounts: readonly Account[];
}

/**
 * Step 4 — everything that cannot safely be inferred.
 *
 * Two decisions are deliberately forced rather than defaulted:
 *
 *  - **An ambiguous date format has no pre-selection.** When both month-first
 *    and day-first fit every sampled value, the file cannot distinguish them
 *    and guessing would silently misdate every row (data-methodology.md §3.3).
 *  - **The sign convention is shown with its consequence spelled out**, because
 *    §3.4 requires the user to see how positive and negative will be read
 *    before anything is committed.
 *
 * A new account is *staged*, not created. Nothing reaches IndexedDB until the
 * atomic commit in step 6.
 */
export function StepConfirmConventions({ wizard, accounts }: StepConfirmConventionsProps) {
  const { state } = wizard;

  return (
    <div className="space-y-5">
      <Callout tone="caution" title="Changing anything here re-reads your files">
        <p>
          Dates, signs, and the destination account all feed normalization. Changing one discards
          the rows already read and any duplicate decisions made about them, so nothing is ever
          committed under settings you have since changed.
        </p>
      </Callout>

      {state.files.map((draft) => (
        <FileConventionsCard key={draft.id} draft={draft} wizard={wizard} accounts={accounts} />
      ))}

      <Card ariaLabelledBy="statement-range-title">
        <CardBody>
          <CardTitle id="statement-range-title" as="h3">
            Statement period
          </CardTitle>
          <p className="mt-1 text-sm leading-relaxed text-ink-soft">
            Optional. Month completeness comes from the period your statement covers, not from the
            dates that happen to appear in it. Leave both blank if you are not sure.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <TextField
              label="Period starts"
              type="date"
              value={state.statementRangeStart}
              onChange={(value) => wizard.setStatementRange(value, state.statementRangeEnd)}
            />
            <TextField
              label="Period ends"
              type="date"
              value={state.statementRangeEnd}
              onChange={(value) => wizard.setStatementRange(state.statementRangeStart, value)}
              {...(state.statementRangeStart !== '' &&
              state.statementRangeEnd !== '' &&
              state.statementRangeStart > state.statementRangeEnd
                ? { error: 'The period ends before it begins.' }
                : {})}
            />
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

function FileConventionsCard({
  draft,
  wizard,
  accounts,
}: {
  draft: FileDraft;
  wizard: ImportWizardApi;
  accounts: readonly Account[];
}) {
  const [creating, setCreating] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newType, setNewType] = useState<AccountType>('checking');
  const titleId = `conventions-${draft.id}`;

  const detection = draft.dateDetection;
  const staged = stagedAccountFor(wizard.state, draft);

  const dateOptions = (['iso', 'us', 'eu'] as const)
    .filter(
      (format) =>
        !detection || detection.candidates.length === 0 || detection.candidates.includes(format),
    )
    .map((format) => ({
      value: format,
      label: DATE_FORMAT_LABELS[format],
      ...(detection?.discriminator && detection.recommended === format
        ? {
            description: `A value like ${detection.discriminator} in this file only fits this format.`,
          }
        : {}),
    }));

  const accountOptions = [
    ...accounts.map((account) => ({ value: account.id, label: `${account.label} (existing)` })),
    ...wizard.state.newAccounts.map((account) => ({
      value: account.id,
      label: `${account.label.trim() || 'Unnamed account'} (new in this import)`,
    })),
  ];

  return (
    <Card ariaLabelledBy={titleId}>
      <CardBody>
        <CardTitle id={titleId} as="h3">
          {draft.displayName}
        </CardTitle>

        {/* ---------------------------------------------------- date format - */}
        <div className="mt-4">
          {detection?.ambiguous ? (
            <p role="alert" className="mb-2 text-sm font-medium text-pa">
              This file cannot tell month-first from day-first on its own. Choose the format your
              bank uses — nothing is read until you do.
            </p>
          ) : null}
          <RadioGroup
            name={`date-format-${draft.id}`}
            legend="How are dates written in this file?"
            value={draft.dateFormat}
            onChange={(value) => wizard.setDateFormat(draft.id, value as DateFormat)}
            options={dateOptions}
            hint={
              detection
                ? `Checked against ${detection.sampleCount} sampled ${detection.sampleCount === 1 ? 'value' : 'values'}.`
                : 'Map a date column first to see which formats fit.'
            }
          />
        </div>

        {/* ------------------------------------------------- sign convention - */}
        {draft.mapping.amountModel === 'signed' ? (
          <div className="mt-4">
            <RadioGroup
              name={`sign-${draft.id}`}
              legend="Which sign means money leaving the account?"
              value={draft.mapping.negativeMeans}
              onChange={(value) =>
                wizard.changeMapping(draft.id, { negativeMeans: value as 'debit' | 'credit' })
              }
              options={[
                {
                  value: 'debit',
                  label: 'Negative is money out',
                  description: 'A row of −42.10 is spending; a row of 42.10 is money in.',
                },
                {
                  value: 'credit',
                  label: 'Positive is money out',
                  description: 'A row of 42.10 is spending; a row of −42.10 is money in.',
                },
              ]}
            />
          </div>
        ) : (
          <p className="mt-4 text-sm text-ink-soft">
            This file uses separate debit and credit columns, so the direction is stated by the
            layout and there is no sign convention to confirm.
          </p>
        )}

        {/* ---------------------------------------------------------- account - */}
        <div className="mt-4">
          <SelectField
            label="Which account do these rows belong to?"
            value={draft.accountId}
            options={accountOptions}
            placeholder="Choose an account"
            onChange={(value) =>
              wizard.selectAccount(draft.id, value === null ? null : String(value))
            }
            hint="Every account in this version is in US dollars."
          />

          {staged ? (
            <div className="mt-3 rounded-card border border-line bg-canvas-sunk p-3">
              <div className="flex items-center justify-between gap-2">
                <Badge tone="ny">Will be created by this import</Badge>
                <Button
                  variant="quiet"
                  size="sm"
                  onClick={() => wizard.removeNewAccount(staged.id)}
                >
                  Remove
                </Button>
              </div>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <TextField
                  label="Account name"
                  value={staged.label}
                  maxLength={120}
                  onChange={(value) => wizard.updateNewAccount(staged.id, { label: value })}
                  {...(staged.label.trim().length === 0
                    ? { error: 'Give this account a name.' }
                    : {})}
                />
                <SelectField
                  label="Account type"
                  value={staged.accountType}
                  options={ACCOUNT_TYPES}
                  onChange={(value) =>
                    value &&
                    wizard.updateNewAccount(staged.id, { accountType: value as AccountType })
                  }
                />
              </div>
              <p className="mt-2 text-xs text-ink-muted">
                Nothing is saved yet. This account is created only if the import succeeds.
              </p>
            </div>
          ) : creating ? (
            <div className="mt-3 rounded-card border border-line bg-canvas-sunk p-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <TextField
                  label="Account name"
                  value={newLabel}
                  maxLength={120}
                  onChange={setNewLabel}
                />
                <SelectField
                  label="Account type"
                  value={newType}
                  options={ACCOUNT_TYPES}
                  onChange={(value) => value && setNewType(value as AccountType)}
                />
              </div>
              <div className="mt-3 flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={newLabel.trim().length === 0}
                  onClick={() => {
                    wizard.stageNewAccount(draft.id, newLabel.trim(), newType);
                    setNewLabel('');
                    setCreating(false);
                  }}
                >
                  Stage this account
                </Button>
                <Button variant="quiet" size="sm" onClick={() => setCreating(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              className="mt-3"
              onClick={() => setCreating(true)}
            >
              Create a new account instead
            </Button>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
