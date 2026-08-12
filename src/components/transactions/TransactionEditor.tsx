import { useEffect, useId, useRef, useState } from 'react';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { RadioGroup, SelectField, TextField } from '../import/FormControls';
import { CATEGORIES, getCategory } from '../../domain/categories';
import {
  spendingTreatment,
  TREATMENT_EXPLANATIONS,
  TREATMENT_LABELS,
  unusualDirectionForKind,
  userExclusionApplies,
} from '../../classification/spending';
import { formatAmount } from '../../export/csvExport';
import {
  MAX_MERCHANT_LENGTH,
  MAX_NOTE_LENGTH,
  MAX_TAGS_PER_TRANSACTION,
  MIN_CONTAINS_PATTERN_LENGTH,
} from '../../domain/reviewLimits';
import type { RuleDraft } from '../../db/ruleCommands';
import type { TransactionPatch } from '../../db/transactionCommands';
import type { Account, Transaction, TransactionKind } from '../../types/domain';

/**
 * The single-transaction review dialog.
 *
 * Two things the layout has to make obvious, because they are the product's
 * promises:
 *
 *  - **The source is read-only.** The statement's date, description, amount,
 *    direction, and account are shown as facts, not fields. There is no control
 *    that could change them, so §7's immutability is visible rather than merely
 *    enforced somewhere else.
 *  - **A rule is a separate decision.** Changing a category here changes one
 *    row. Creating a rule is an explicit second choice with its own explanation
 *    of what it will and will not do.
 */

const KIND_OPTIONS: readonly { value: TransactionKind; label: string }[] = [
  { value: 'purchase', label: 'Purchase' },
  { value: 'refund', label: 'Refund' },
  { value: 'income', label: 'Income' },
  { value: 'transfer', label: 'Transfer between my accounts' },
  { value: 'payment', label: 'Credit-card payment' },
  { value: 'fee', label: 'Fee' },
  { value: 'cash_withdrawal', label: 'Cash withdrawal' },
  { value: 'unknown', label: 'Not yet decided' },
];

const CATEGORY_OPTIONS = CATEGORIES.map((category) => ({
  value: category.id,
  label: category.label,
}));

interface TransactionEditorProps {
  readonly transaction: Transaction;
  readonly accounts: readonly Account[];
  readonly busy: boolean;
  readonly errorMessage: string | null;
  readonly onSave: (patch: TransactionPatch) => void;
  readonly onSaveWithRule: (patch: TransactionPatch, rule: RuleDraft) => void;
  readonly onClose: () => void;
}

export function TransactionEditor({
  transaction,
  accounts,
  busy,
  errorMessage,
  onSave,
  onSaveWithRule,
  onClose,
}: TransactionEditorProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const [merchant, setMerchant] = useState(transaction.merchantNormalized);
  const [categoryId, setCategoryId] = useState(transaction.categoryId);
  const [kind, setKind] = useState<TransactionKind>(transaction.kind);
  const [excluded, setExcluded] = useState(transaction.excludedFromSpending);
  const [essentiality, setEssentiality] = useState(transaction.essentiality ?? '');
  const [variability, setVariability] = useState(transaction.variability ?? '');
  const [tagsText, setTagsText] = useState(transaction.tags.join(', '));
  const [note, setNote] = useState(transaction.note ?? '');
  const [createRule, setCreateRule] = useState(false);
  const [ruleMatchType, setRuleMatchType] = useState<RuleDraft['matchType']>('exact');

  useEffect(() => {
    returnFocusRef.current = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => {
      // Focus goes back to whatever opened the dialog, so a keyboard user is
      // never dropped at the top of the document.
      returnFocusRef.current?.focus?.();
    };
  }, []);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      // Escape cancels. It never saves.
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;

    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href]',
    );
    if (!focusable || focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const treatment = spendingTreatment({ ...transaction, kind, excludedFromSpending: excluded });
  const exclusionMeaningful = userExclusionApplies(kind);
  const directionWarning = unusualDirectionForKind(kind, transaction.direction);
  const accountLabel =
    accounts.find((account) => account.id === transaction.accountId)?.label ??
    transaction.accountId;

  const tags = tagsText
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);

  const patch: TransactionPatch = {
    merchantNormalized: merchant,
    categoryId,
    kind,
    excludedFromSpending: exclusionMeaningful ? excluded : false,
    essentiality: essentiality === '' ? null : (essentiality as 'essential' | 'discretionary'),
    variability: variability === '' ? null : (variability as 'fixed' | 'variable'),
    tags,
    note: note.trim().length === 0 ? null : note,
  };

  const ruleDraft: RuleDraft = {
    matchType: ruleMatchType,
    pattern: transaction.merchantNormalized,
    normalizedMerchant: merchant === transaction.merchantNormalized ? undefined : merchant,
    categoryId,
    kind,
  };

  const tooManyTags = tags.length > MAX_TAGS_PER_TRANSACTION;
  const noteTooLong = note.length > MAX_NOTE_LENGTH;
  const merchantEmpty = merchant.trim().length === 0;
  const ruleTooBroad =
    ruleMatchType === 'contains' &&
    transaction.merchantNormalized.trim().length < MIN_CONTAINS_PATTERN_LENGTH;
  const blocked = tooManyTags || noteTooLong || merchantEmpty || (createRule && ruleTooBroad);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-ink/40 p-2 sm:items-center sm:p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
        className="my-auto w-full max-w-2xl rounded-card border border-line bg-canvas p-4 shadow-lg sm:p-5"
      >
        <h2 id={titleId} className="text-base font-semibold text-ink">
          Review this transaction
        </h2>

        {/* ------------------------------------------------ source facts - */}
        <section
          aria-labelledby={`${titleId}-source`}
          className="mt-3 rounded-card bg-canvas-sunk p-3"
        >
          <h3 id={`${titleId}-source`} className="text-xs font-semibold text-ink-muted">
            From your statement — never changed
          </h3>
          <dl className="mt-2 grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
            <div className="flex gap-2">
              <dt className="text-ink-muted">Date</dt>
              <dd className="money text-ink">{transaction.postedDate}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-ink-muted">Amount</dt>
              <dd className="money text-ink">
                {formatAmount(transaction.amountCents, transaction.direction)}{' '}
                <span className="text-ink-muted">
                  ({transaction.direction === 'debit' ? 'money out' : 'money in'})
                </span>
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-ink-muted">Account</dt>
              <dd className="min-w-0 truncate text-ink">{accountLabel}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-ink-muted">Row</dt>
              <dd className="money text-ink">{transaction.originalRow}</dd>
            </div>
            <div className="flex gap-2 sm:col-span-2">
              <dt className="shrink-0 text-ink-muted">Description</dt>
              <dd className="min-w-0 break-words text-ink">{transaction.descriptionRaw}</dd>
            </div>
          </dl>
        </section>

        {/* ------------------------------------------------- interpretation - */}
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <TextField
            label="Merchant"
            value={merchant}
            onChange={setMerchant}
            maxLength={MAX_MERCHANT_LENGTH}
            {...(merchantEmpty ? { error: 'A merchant name is required.' } : {})}
          />
          <SelectField
            label="Category"
            value={categoryId}
            options={CATEGORY_OPTIONS}
            onChange={(value) => value && setCategoryId(value)}
          />
          <SelectField
            label="Kind"
            value={kind}
            options={KIND_OPTIONS}
            onChange={(value) => value && setKind(value as TransactionKind)}
          />
          <SelectField
            label="Essential or discretionary"
            value={essentiality}
            options={[
              { value: 'essential', label: 'Essential' },
              { value: 'discretionary', label: 'Discretionary' },
            ]}
            placeholder="Not decided"
            onChange={(value) => setEssentiality(value ?? '')}
          />
          <SelectField
            label="Fixed or variable"
            value={variability}
            options={[
              { value: 'fixed', label: 'Fixed' },
              { value: 'variable', label: 'Variable' },
            ]}
            placeholder="Not decided"
            onChange={(value) => setVariability(value ?? '')}
          />
          <TextField
            label="Tags"
            value={tagsText}
            onChange={setTagsText}
            hint="Separate with commas."
            {...(tooManyTags ? { error: `At most ${MAX_TAGS_PER_TRANSACTION} tags.` } : {})}
          />
          <div className="sm:col-span-2">
            <TextField
              label="Note"
              value={note}
              onChange={setNote}
              maxLength={MAX_NOTE_LENGTH + 1}
              {...(noteTooLong ? { error: `At most ${MAX_NOTE_LENGTH} characters.` } : {})}
            />
          </div>
        </div>

        {/* --------------------------------------------- spending treatment - */}
        <section className="mt-4 rounded-card border border-line p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={treatment === 'needs-review' ? 'notice' : 'neutral'}>
              {TREATMENT_LABELS[treatment]}
            </Badge>
            {transaction.categorySource === 'user' ? <Badge tone="nj">You set this</Badge> : null}
            {transaction.categorySource === 'user_rule' ? <Badge tone="nj">Your rule</Badge> : null}
            {transaction.categorySource === 'uncategorized' ? (
              <Badge tone="notice">Not yet categorized</Badge>
            ) : null}
          </div>
          <p className="mt-2 text-sm leading-relaxed text-ink-soft">
            {TREATMENT_EXPLANATIONS[treatment]}
          </p>

          {/* `py-1` on the label below: the label is the click target, and a
              bare checkbox-plus-one-line row is only 20px tall. */}
          {exclusionMeaningful ? (
            <label className="mt-3 flex w-fit cursor-pointer items-start gap-2 py-1 text-sm text-ink">
              <input
                type="checkbox"
                checked={excluded}
                onChange={(event) => setExcluded(event.target.checked)}
                className="mt-0.5 size-4 accent-ink"
              />
              Leave this out of spending totals
            </label>
          ) : (
            /* No Include control here on purpose: the contract always excludes
               this kind, and a control that appeared to override it would be a
               lie (§13). */
            <p className="mt-3 text-sm text-ink-muted">
              This kind is never counted as spending. To count it, change the kind above.
            </p>
          )}

          {directionWarning ? (
            <p role="status" className="mt-2 text-sm text-pa">
              {directionWarning}
            </p>
          ) : null}
        </section>

        {/* ------------------------------------------------------- rule - */}
        <section className="mt-4 rounded-card border border-line p-3">
          <label className="flex w-fit cursor-pointer items-start gap-2 py-1 text-sm font-medium text-ink">
            <input
              type="checkbox"
              checked={createRule}
              onChange={(event) => setCreateRule(event.target.checked)}
              className="mt-0.5 size-4 accent-ink"
            />
            Also create a rule for future transactions like this
          </label>

          {createRule ? (
            <div className="mt-3 space-y-3">
              <RadioGroup
                name="rule-match-type"
                legend="Match future transactions when the merchant"
                value={ruleMatchType}
                onChange={setRuleMatchType}
                options={[
                  { value: 'exact', label: 'is exactly this' },
                  { value: 'starts_with', label: 'starts with this' },
                  { value: 'contains', label: 'contains this' },
                ]}
                {...(ruleTooBroad
                  ? {
                      error: `A "contains" rule needs at least ${MIN_CONTAINS_PATTERN_LENGTH} characters.`,
                    }
                  : {})}
              />
              <p className="text-sm leading-relaxed text-ink-soft">
                The rule will match{' '}
                <span className="font-medium text-ink">{transaction.merchantNormalized}</span> and
                set the category to{' '}
                <span className="font-medium text-ink">{getCategory(categoryId)?.label}</span>.
              </p>
              <p className="text-sm leading-relaxed text-ink-muted">
                Rules apply to <strong>future imports only</strong>. Transactions already in your
                workspace are not changed, and nothing is rewritten behind your back.
              </p>
            </div>
          ) : null}
        </section>

        {errorMessage ? (
          <p role="alert" className="mt-3 text-sm font-medium text-pa">
            {errorMessage}
          </p>
        ) : null}

        <div className="mt-5 flex flex-wrap gap-2">
          <Button
            variant="primary"
            size="sm"
            disabled={busy || blocked}
            onClick={() => (createRule ? onSaveWithRule(patch, ruleDraft) : onSave(patch))}
          >
            {busy ? 'Saving…' : createRule ? 'Save and create rule' : 'Save this transaction'}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={onClose}
            data-autofocus="true"
          >
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
