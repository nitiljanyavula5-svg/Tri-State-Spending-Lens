import { useEffect, useId, useRef, useState } from 'react';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { RadioGroup, SelectField, TextField } from '../import/FormControls';
import { CATEGORIES } from '../../domain/categories';
import { validateRuleDraft, type RuleDraft } from '../../db/ruleCommands';
import {
  BROAD_CONTAINS_PATTERN_LENGTH,
  MAX_RULE_MATCH_PREVIEW,
  MAX_RULE_PATTERN_LENGTH,
} from '../../domain/reviewLimits';
import { canonicalizeText } from '../../import/canonical';
import type { MerchantRule, TransactionKind } from '../../types/domain';

/**
 * Create or edit one classification rule.
 *
 * Two things this dialog exists to make unmissable:
 *
 *  - **A rule is about the future.** Every explanation says so, and the match
 *    count is labelled as awareness rather than as a preview of a change. §12
 *    forbids a rule reaching back over stored rows, so the interface must not
 *    imply that saving one will.
 *  - **`contains` is the dangerous one.** It is offered, because it is genuinely
 *    useful, but it is described as broader and short patterns are refused by
 *    the same validator the write path uses.
 *
 * Validation runs through `validateRuleDraft` — the pure function the command
 * calls — so what the user is told while typing is exactly what the save will
 * decide. A dialog with its own rules could accept something the service then
 * rejects after the work is done.
 */

const MATCH_TYPE_OPTIONS: readonly {
  value: MerchantRule['matchType'];
  label: string;
  description: string;
}[] = [
  { value: 'exact', label: 'is exactly this', description: 'The narrowest and safest match.' },
  {
    value: 'starts_with',
    label: 'starts with this',
    description: 'Useful when a statement appends a store or terminal number.',
  },
  {
    value: 'contains',
    label: 'contains this anywhere',
    // The minimum length is stated by the validation error when it is
    // actually violated. Repeating it here as well left the same sentence on
    // screen twice, which reads as a warning about nothing.
    description: 'The broadest match, so check the count before saving.',
  },
];

const KIND_OPTIONS: readonly { value: TransactionKind; label: string }[] = [
  { value: 'purchase', label: 'Purchase' },
  { value: 'refund', label: 'Refund' },
  { value: 'income', label: 'Income' },
  { value: 'transfer', label: 'Transfer between my accounts' },
  { value: 'payment', label: 'Credit-card payment' },
  { value: 'fee', label: 'Fee' },
  { value: 'cash_withdrawal', label: 'Cash withdrawal' },
];

interface RuleEditorDialogProps {
  /** `null` creates a new rule. */
  readonly rule: MerchantRule | null;
  readonly busy: boolean;
  readonly errorMessage: string | null;
  readonly onSave: (draft: RuleDraft) => void;
  readonly onCancel: () => void;
  readonly countMatches: (
    rule: Pick<MerchantRule, 'matchType' | 'pattern'>,
  ) => Promise<{ count: number; truncated: boolean }>;
}

export function RuleEditorDialog({
  rule,
  busy,
  errorMessage,
  onSave,
  onCancel,
  countMatches,
}: RuleEditorDialogProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const [matchType, setMatchType] = useState<MerchantRule['matchType']>(rule?.matchType ?? 'exact');
  const [pattern, setPattern] = useState(rule?.pattern ?? '');
  const [merchant, setMerchant] = useState(rule?.normalizedMerchant ?? '');
  const [categoryId, setCategoryId] = useState<string | null>(rule?.categoryId ?? null);
  const [kind, setKind] = useState<TransactionKind | null>(rule?.kind ?? null);
  const [priority, setPriority] = useState(String(rule?.priority ?? 0));

  const [matchCount, setMatchCount] = useState<{ count: number; truncated: boolean } | null>(null);
  const [counting, setCounting] = useState(false);

  useEffect(() => {
    returnFocusRef.current = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => {
      // Focus goes back to the control that opened the dialog.
      returnFocusRef.current?.focus?.();
    };
  }, []);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      // Escape cancels. It never saves.
      onCancel();
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

  const parsedPriority = Number(priority);
  const draft: RuleDraft = {
    matchType,
    pattern,
    ...(merchant.trim().length === 0 ? {} : { normalizedMerchant: merchant }),
    ...(categoryId === null ? {} : { categoryId }),
    ...(kind === null ? {} : { kind }),
    priority: priority.trim() === '' ? 0 : parsedPriority,
  };

  // The same verdict the write path will reach, because it is the same call.
  const verdict = validateRuleDraft(draft);
  // Narrowed once, here. A closure over the union cannot be narrowed by tsc,
  // and casting inside each call site would defeat the point of the union.
  const rejection = verdict.ok ? null : verdict;
  const messageFor = (path: string): string | null =>
    rejection?.problemPaths.includes(path) ? rejection.message : null;

  const patternProblem = messageFor('pattern');
  const priorityProblem = messageFor('priority');
  const categoryProblem = messageFor('categoryId');
  const outputProblem = messageFor('outputs');

  const canonicalPattern = canonicalizeText(pattern).slice(0, MAX_RULE_PATTERN_LENGTH);
  const differsFromTyped = canonicalPattern.length > 0 && canonicalPattern !== pattern;

  async function checkMatches() {
    if (!verdict.ok || counting) return;
    setCounting(true);
    try {
      setMatchCount(await countMatches({ matchType, pattern: canonicalPattern }));
    } finally {
      setCounting(false);
    }
  }

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
          {rule ? 'Edit this rule' : 'Create a rule for future transactions'}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">
          A rule changes how <strong>future imports</strong> are read. It never rewrites
          transactions already in your workspace, and deleting it later never deletes, reverts, or
          recategorizes anything.
        </p>

        <div className="mt-4 space-y-4">
          <RadioGroup
            name="rule-match-type"
            legend="Apply this rule when the merchant"
            value={matchType}
            onChange={(value) => {
              setMatchType(value);
              setMatchCount(null);
            }}
            options={MATCH_TYPE_OPTIONS}
          />

          <TextField
            label="Pattern to match"
            value={pattern}
            onChange={(value) => {
              setPattern(value);
              setMatchCount(null);
            }}
            maxLength={MAX_RULE_PATTERN_LENGTH}
            hint="Matched literally against the cleaned merchant name — never as code."
            {...(patternProblem ? { error: patternProblem } : {})}
          />

          {differsFromTyped ? (
            <p className="text-xs text-ink-muted">
              Stored and matched as{' '}
              <span className="money font-medium text-ink">{canonicalPattern}</span>, because
              merchants are compared in a cleaned, upper-case form.
            </p>
          ) : null}

          {matchType === 'contains' && canonicalPattern.length < BROAD_CONTAINS_PATTERN_LENGTH ? (
            <p role="status" className="text-sm text-pa">
              This is a short “contains” pattern, so it may match more transactions than you expect.
              Check the match count before saving.
            </p>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              label="Rename the merchant to (optional)"
              value={merchant}
              onChange={setMerchant}
              maxLength={MAX_RULE_PATTERN_LENGTH}
              hint="Leave blank to keep the merchant as imported."
            />
            <SelectField
              label="Set the category to (optional)"
              value={categoryId}
              options={CATEGORIES.map((category) => ({
                value: category.id,
                label: category.label,
              }))}
              placeholder="Leave the category alone"
              onChange={setCategoryId}
              {...(categoryProblem ? { error: categoryProblem } : {})}
            />
            <SelectField
              label="Set the kind to (optional)"
              value={kind}
              options={KIND_OPTIONS}
              placeholder="Leave the kind alone"
              onChange={(value) => setKind(value as TransactionKind | null)}
            />
            <TextField
              label="Priority"
              value={priority}
              onChange={setPriority}
              hint="Higher wins. Ties break by the more specific match type, then the longer pattern."
              {...(priorityProblem ? { error: priorityProblem } : {})}
            />
          </div>

          {outputProblem ? (
            <p role="alert" className="text-sm font-medium text-pa">
              {outputProblem}
            </p>
          ) : null}

          {/* --------------------------------------------- match awareness - */}
          <section className="rounded-card border border-line p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={!verdict.ok || counting}
                onClick={() => void checkMatches()}
              >
                {counting ? 'Counting…' : 'Count matching transactions'}
              </Button>
              {matchCount ? (
                <Badge tone={matchCount.truncated ? 'notice' : 'neutral'}>
                  {matchCount.truncated
                    ? `More than ${MAX_RULE_MATCH_PREVIEW.toLocaleString('en-US')} match`
                    : `${matchCount.count.toLocaleString('en-US')} match`}
                </Badge>
              ) : null}
            </div>
            <p className="mt-2 text-sm leading-relaxed text-ink-soft">
              This counts transactions <strong>already stored</strong>, so you can see how broad the
              pattern is. Saving the rule does not change any of them.
            </p>
            {matchCount?.truncated ? (
              <p className="mt-1 text-sm leading-relaxed text-ink-muted">
                Counting stops at {MAX_RULE_MATCH_PREVIEW.toLocaleString('en-US')} so a very broad
                pattern cannot make this slow. The real number is higher.
              </p>
            ) : null}
          </section>
        </div>

        {errorMessage ? (
          <p role="alert" className="mt-3 text-sm font-medium text-pa">
            {errorMessage}
          </p>
        ) : null}

        <div className="mt-5 flex flex-wrap gap-2">
          <Button
            variant="primary"
            size="sm"
            disabled={busy || !verdict.ok}
            onClick={() => onSave(draft)}
          >
            {busy ? 'Saving…' : rule ? 'Save changes' : 'Create rule'}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={onCancel}
            data-autofocus="true"
          >
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
