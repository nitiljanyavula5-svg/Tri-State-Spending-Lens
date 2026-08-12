import { useState } from 'react';
import { Scale } from 'lucide-react';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Callout } from '../ui/Callout';
import { ConfirmDialog } from '../import/ConfirmDialog';
import { EmptyState } from '../ui/EmptyState';
import { RuleEditorDialog } from './RuleEditorDialog';
import { useRuleManager } from '../../review/useRuleManager';
import { getCategory } from '../../domain/categories';
import {
  MAX_BULK_TRANSACTIONS,
  MAX_RULE_MATCH_PREVIEW,
  MAX_USER_RULES,
} from '../../domain/reviewLimits';
import type { WorkspaceDatabase } from '../../db/database';
import type { RuleDraft } from '../../db/ruleCommands';
import type { UndoManager } from '../../db/undoManager';
import type { MerchantRule, TransactionKind } from '../../types/domain';

/**
 * The rule manager.
 *
 * Rules are the one thing a user creates that changes how *future* data is
 * read, so this surface spends most of its space explaining scope rather than
 * listing fields. The three sentences that matter — rules are not retroactive,
 * deleting one changes nothing, higher priority wins — are stated on the page
 * itself, not hidden behind a help link.
 *
 * Rules are listed in the order they actually apply, because `listUserRules`
 * sorts them with the same comparator classification uses. A list in storage
 * order would show a precedence the engine does not follow.
 */

const KIND_LABELS: Readonly<Record<TransactionKind, string>> = {
  purchase: 'Purchase',
  refund: 'Refund',
  income: 'Income',
  transfer: 'Transfer',
  payment: 'Card payment',
  fee: 'Fee',
  cash_withdrawal: 'Cash withdrawal',
  unknown: 'Not yet decided',
};

const MATCH_TYPE_LABELS: Readonly<Record<MerchantRule['matchType'], string>> = {
  exact: 'is exactly',
  starts_with: 'starts with',
  contains: 'contains',
};

interface RuleManagerProps {
  readonly db: WorkspaceDatabase | null;
  readonly ready: boolean;
  /**
   * The host page's live region.
   *
   * This component deliberately renders none of its own. A page carrying two
   * polite regions announces two things at once, and Settings already owns one
   * that every other outcome on the page goes through.
   */
  readonly onAnnounce: (message: string) => void;
  /** The session's undo stack, owned by the workspace provider. */
  readonly undo: UndoManager;
}

export function RuleManager({ db, ready, onAnnounce, undo }: RuleManagerProps) {
  const rules = useRuleManager({ db, undo, onAnnounce });

  const [editing, setEditing] = useState<{ rule: MerchantRule | null } | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<MerchantRule | null>(null);
  const [counts, setCounts] = useState<Record<string, { count: number; truncated: boolean }>>({});
  /** The rule whose retroactive application is being confirmed, with its scope. */
  const [applying, setApplying] = useState<{
    rule: MerchantRule;
    matches: number;
    truncated: boolean;
  } | null>(null);

  const page = rules.page;
  const list = page?.rules ?? [];
  const atLimit = (page?.totalCount ?? 0) >= MAX_USER_RULES;

  async function countFor(rule: MerchantRule) {
    const outcome = await rules.countMatches(rule);
    setCounts((current) => ({ ...current, [rule.id]: outcome }));
  }

  function save(draft: RuleDraft) {
    const target = editing?.rule;
    const work = target ? rules.update(target.id, draft) : rules.create(draft);
    void work.then((outcome) => {
      if (!outcome.ok) {
        setEditError(outcome.message);
        return;
      }
      setEditing(null);
      // category-rules.md §5.3: on creating a rule the product must show how
      // many stored transactions it matches and let the user decide whether to
      // apply it retroactively. Offered here rather than buried, and only when
      // there is actually something to offer.
      if (!target) void offerRetroactiveApply(outcome.rule);
    });
  }

  async function offerRetroactiveApply(rule: MerchantRule) {
    const preview = await rules.previewMatches(rule);
    if (preview.ids.length === 0) return;
    setApplying({ rule, matches: preview.ids.length, truncated: preview.truncated });
  }

  return (
    <section aria-labelledby="rule-manager-title" className="mt-8">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-line pb-4">
        <div className="max-w-2xl">
          <h2 id="rule-manager-title" className="text-lg font-semibold tracking-tight text-ink">
            Merchant rules
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-ink-soft">
            A rule tells future imports how to read a merchant. Patterns are matched literally
            against the cleaned merchant name, never compiled as code.
          </p>
        </div>
        <Button
          variant="primary"
          size="sm"
          disabled={!ready || rules.busy || atLimit}
          onClick={() => {
            setEditError(null);
            setEditing({ rule: null });
          }}
        >
          Create a rule
        </Button>
      </div>

      <Callout tone="info" title="What a rule does, and what it never does" className="mt-4">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Rules apply to <strong>future imports</strong>. Saving one does not change,
            recategorize, or rewrite transactions already in your workspace.
          </li>
          <li>
            Deleting a rule <strong>never deletes, reverts, or recategorizes a transaction</strong>.
            Rows keep the classification they were given.
          </li>
          <li>
            When two rules match, the <strong>higher priority wins</strong>. Ties break by the more
            specific match type — exactly, then starts with, then contains — and then by the longer
            pattern.
          </li>
          <li>
            A <strong>&ldquo;contains&rdquo; rule is the broad one</strong> and deserves extra care;
            count its matches before saving.
          </li>
          <li>
            Changing one transaction from its Review dialog is a different thing from creating a
            rule. One corrects a row; the other changes what happens next time.
          </li>
        </ul>
      </Callout>

      {/* The session's undo history, surfaced wherever a command can be run.
          Applying a rule is a bulk edit and joins the same stack. */}
      {undo.canUndo() ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            variant="secondary"
            size="sm"
            disabled={rules.busy}
            onClick={() => {
              if (!db) return;
              void undo.undo(db).then((outcome) => {
                // `refresh` re-renders this section, which re-reads
                // `undo.canUndo()` and drops the control when the stack empties.
                rules.refresh();
                onAnnounce(
                  outcome === null
                    ? 'There was nothing to undo.'
                    : outcome.ok
                      ? 'Change undone.'
                      : outcome.message,
                );
              });
            }}
          >
            {`Undo last change (${undo.peek()?.label})`}
          </Button>
          <span className="text-xs text-ink-muted">
            Undo is available until you reload this page. Your changes themselves are saved.
          </span>
        </div>
      ) : null}
      {atLimit ? (
        <Callout tone="caution" title="This workspace is at its rule limit" className="mt-4">
          <p>
            {`A workspace holds at most ${MAX_USER_RULES.toLocaleString('en-US')} rules. Delete one you no longer use before creating another.`}
          </p>
        </Callout>
      ) : null}

      {/* ------------------------------------------------------------ state - */}
      {rules.status === 'failed' ? (
        <Callout tone="caution" title="Your rules could not be read" className="mt-4">
          <p>
            Nothing was changed.{' '}
            <Button variant="secondary" size="sm" onClick={rules.refresh}>
              Try again
            </Button>
          </p>
        </Callout>
      ) : null}

      {rules.status === 'loading' && !page ? (
        <p className="mt-4 text-sm text-ink-muted">Loading your rules…</p>
      ) : null}

      {rules.status !== 'failed' && page && page.totalCount === 0 ? (
        <div className="mt-4">
          <EmptyState
            icon={Scale}
            title="You have not created any rules yet"
            description="Create one here, or tick “Also create a rule for future transactions like this” while reviewing a transaction. Either way the rule only affects imports from that point on."
          />
        </div>
      ) : null}

      {/* ------------------------------------------------------------ list - */}
      {page && page.totalCount > 0 ? (
        <>
          <p className="mt-4 text-sm font-semibold text-ink">
            {`${page.totalCount.toLocaleString('en-US')} rule${page.totalCount === 1 ? '' : 's'}, listed in the order they apply`}
          </p>

          {/* Named so the list is addressable on its own — the explanation
              above is also a list, and "the rules" has to be distinguishable
              from "the things to know about rules". */}
          <ul aria-label="Your rules" className="mt-3 space-y-3">
            {list.map((rule) => {
              const matches = counts[rule.id];
              return (
                <li key={rule.id} className="rounded-card border border-line bg-surface p-3 sm:p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-ink">
                        <span className="text-ink-muted">When the merchant </span>
                        <span className="font-medium">
                          {MATCH_TYPE_LABELS[rule.matchType]}
                        </span>{' '}
                        <span className="money font-semibold break-words">{rule.pattern}</span>
                      </p>

                      {/* Label above value until there is room for them side
                          by side: at 320px a `flex` row squeezed the value into
                          a column so narrow that "NORTHFIELD SUPPLY" broke
                          mid-word. */}
                      <dl className="mt-2 grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
                        {rule.normalizedMerchant ? (
                          <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
                            <dt className="shrink-0 text-ink-muted">Rename to</dt>
                            <dd className="min-w-0 break-words text-ink">
                              {rule.normalizedMerchant}
                            </dd>
                          </div>
                        ) : null}
                        {rule.categoryId ? (
                          <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
                            <dt className="shrink-0 text-ink-muted">Category</dt>
                            <dd className="text-ink">
                              {getCategory(rule.categoryId)?.label ?? rule.categoryId}
                            </dd>
                          </div>
                        ) : null}
                        {rule.kind ? (
                          <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
                            <dt className="shrink-0 text-ink-muted">Kind</dt>
                            <dd className="text-ink">{KIND_LABELS[rule.kind]}</dd>
                          </div>
                        ) : null}
                        <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
                          <dt className="shrink-0 text-ink-muted">Priority</dt>
                          <dd className="money text-ink">{rule.priority}</dd>
                        </div>
                      </dl>

                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Button
                          variant="quiet"
                          size="sm"
                          className="whitespace-nowrap"
                          onClick={() => void countFor(rule)}
                          aria-label={`Count transactions matching the rule for ${rule.pattern}`}
                        >
                          Count matches
                        </Button>
                        <Button
                          variant="quiet"
                          size="sm"
                          className="whitespace-nowrap"
                          disabled={rules.busy}
                          onClick={() => void offerRetroactiveApply(rule)}
                          aria-label={`Apply the rule for ${rule.pattern} to transactions already stored`}
                        >
                          Apply to existing
                        </Button>
                        {matches ? (
                          <Badge tone={matches.truncated ? 'notice' : 'neutral'}>
                            {matches.truncated
                              ? `More than ${MAX_RULE_MATCH_PREVIEW.toLocaleString('en-US')} stored transactions match`
                              : `${matches.count.toLocaleString('en-US')} stored transactions match`}
                          </Badge>
                        ) : null}
                        {matches?.truncated ? (
                          <span className="text-xs text-ink-muted">
                            Counting stops at {MAX_RULE_MATCH_PREVIEW.toLocaleString('en-US')}; the
                            real number is higher.
                          </span>
                        ) : null}
                      </div>
                    </div>

                    {/* Named with `aria-label` rather than a visually hidden
                        span: adjacent text nodes are concatenated without a
                        separator when the accessible name is computed, so
                        "Edit" plus " the rule for X" reads as "Editthe rule
                        for X". The visible word stays inside the name, which
                        is what WCAG 2.5.3 asks for. */}
                    <div className="flex shrink-0 flex-wrap gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={rules.busy}
                        aria-label={`Edit the rule for ${rule.pattern}`}
                        onClick={() => {
                          setEditError(null);
                          setEditing({ rule });
                        }}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={rules.busy}
                        aria-label={`Delete the rule for ${rule.pattern}`}
                        onClick={() => setDeleting(rule)}
                      >
                        Delete
                      </Button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>

          {page.pageCount > 1 ? (
            <nav aria-label="Rule pagination" className="mt-4 flex flex-wrap items-center gap-3">
              <Button
                variant="secondary"
                size="sm"
                disabled={page.page === 0}
                onClick={() => rules.setPage(page.page - 1)}
              >
                Previous
              </Button>
              <span className="money text-sm text-ink-soft">
                {`Page ${page.page + 1} of ${page.pageCount}`}
              </span>
              <Button
                variant="secondary"
                size="sm"
                disabled={page.page >= page.pageCount - 1}
                onClick={() => rules.setPage(page.page + 1)}
              >
                Next
              </Button>
            </nav>
          ) : null}
        </>
      ) : null}

      {editing ? (
        <RuleEditorDialog
          rule={editing.rule}
          busy={rules.busy}
          errorMessage={editError}
          countMatches={rules.countMatches}
          onCancel={() => setEditing(null)}
          onSave={save}
        />
      ) : null}

      {applying ? (
        <ConfirmDialog
          title="Apply this rule to transactions you already have?"
          confirmLabel="Apply to existing transactions"
          cancelLabel="Not now"
          busy={rules.busy}
          onCancel={() => setApplying(null)}
          onConfirm={() => {
            const target = applying;
            setApplying(null);
            void rules.applyToExisting(target.rule);
          }}
        >
          <p>
            {`This rule matches ${applying.matches.toLocaleString('en-US')} transaction${applying.matches === 1 ? '' : 's'} already stored in your workspace.`}
          </p>
          <p>
            <strong>Those transactions will change.</strong> This is the one action that rewrites
            history — creating the rule on its own changed nothing. The merchant, category, or kind
            the rule sets will replace what those rows have now.
          </p>
          {applying.truncated ? (
            <p>
              {`More than ${MAX_BULK_TRANSACTIONS.toLocaleString('en-US')} transactions match. Only the first ${MAX_BULK_TRANSACTIONS.toLocaleString('en-US')} will be changed, because that is the most one change may cover. Run this again afterwards to continue.`}
            </p>
          ) : null}
          <p>This is one change and can be undone straight afterwards.</p>
        </ConfirmDialog>
      ) : null}

      {deleting ? (
        <ConfirmDialog
          title="Delete this rule?"
          confirmLabel="Delete rule"
          busy={rules.busy}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const target = deleting;
            setDeleting(null);
            void rules.remove(target);
          }}
        >
          <p>{`The rule matching “${deleting.pattern}” will stop applying to future imports.`}</p>
          <p>
            <strong>Your transactions are not affected.</strong> Nothing is deleted, reverted, or
            recategorized — rows keep the classification they already have.
          </p>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
