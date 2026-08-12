import type { WorkspaceDatabase } from './database';
import { transactionLinkSchema } from './backupSchema';
import { editTransactions, type CommandResult, type TransactionPatch } from './transactionCommands';
import type {
  Account,
  Transaction,
  TransactionKind,
  TransactionLink,
  TransactionLinkKind,
} from '../types/domain';
import { MAX_REVIEW_SUGGESTIONS, MAX_SUGGESTION_GROUP_SIZE } from '../domain/reviewLimits';
import { systemClock, type Clock } from '../lib/clock';
import { newId } from '../lib/ids';

/**
 * Transfer, card-payment, and refund relationships.
 *
 * category-rules.md §7 is unambiguous about the danger here: `transfer` and
 * `payment` are **excluded from net spending**, so an incorrect automatic
 * assignment silently hides real money the user spent. Everything in this
 * module therefore splits cleanly in two:
 *
 *  - **Suggestion functions are pure and never touch the database.** They take
 *    rows, return a bounded ranked list, and mutate nothing.
 *  - **Confirmation commands are atomic and explicit.** They run only when a
 *    user has said yes, and they are undoable as one unit.
 *
 * The default is always no relationship. Two same-value purchases at the same
 * shop on the same day are a completely ordinary thing to do, and nothing here
 * changes them.
 */

/** A transfer's two sides usually post within a few days of each other. */
export const TRANSFER_WINDOW_DAYS = 4;

/** How far back a refund may reach for its purchase. */
export const REFUND_LOOKBACK_DAYS = 120;

/** Suggestions returned per request. Bounded so a UI list is never unbounded. */
export const MAX_SUGGESTIONS = 20;

/**
 * Whole days between two ISO calendar dates.
 *
 * `Date.UTC` is safe here because both dates were validated as real calendar
 * days at import (data-methodology.md §3.3); this is arithmetic on known-good
 * values, not the lenient parsing the pipeline forbids.
 */
export function daysBetween(a: string, b: string): number {
  const toDays = (iso: string) => {
    const [year, month, day] = iso.split('-').map(Number);
    return Date.UTC(year!, month! - 1, day!) / 86_400_000;
  };
  return Math.abs(toDays(a) - toDays(b));
}

/* ------------------------------------------------------- transfer pairs - */

export interface TransferSuggestion {
  readonly counterpartId: string;
  /** `payment` when a credit-card account is involved, else `transfer`. */
  readonly proposedKind: Extract<TransactionKind, 'transfer' | 'payment'>;
  readonly daysApart: number;
  /** Constant, value-free explanation. */
  readonly reason: string;
  /** Always false here. A suggestion is never proof. */
  readonly confirmed: false;
}

export interface TransferSuggestionInput {
  readonly transaction: Transaction;
  /** Candidate counterparts — normally the workspace, already bounded. */
  readonly candidates: readonly Transaction[];
  readonly accounts: readonly Account[];
  /** Ids already spoken for by a confirmed relationship. */
  readonly linkedTransactionIds?: ReadonlySet<string>;
}

const TRANSFER_REASON =
  'A transaction in another of your accounts has the same amount, the opposite direction, and a nearby date. That often means money moved between your own accounts — but two unrelated payments can look identical, so nothing changes until you confirm.';

const PAYMENT_REASON =
  'A transaction in another of your accounts has the same amount and the opposite direction, and one of the accounts is a credit card. That often means a card payment — but nothing changes until you confirm.';

/**
 * Deterministic transfer and card-payment candidates.
 *
 * Pure: no database, no clock. The same inputs always produce the same ranked
 * list, which is what makes the suggestion testable and the ordering stable in
 * a UI.
 */
export function suggestTransferPairs(input: TransferSuggestionInput): TransferSuggestion[] {
  const { transaction, candidates, accounts } = input;
  const linked = input.linkedTransactionIds ?? new Set<string>();
  if (linked.has(transaction.id)) return [];

  const accountTypes = new Map(accounts.map((account) => [account.id, account.type]));

  const matches: TransferSuggestion[] = [];

  for (const candidate of candidates) {
    if (candidate.id === transaction.id) continue;
    // A transfer moves money *between* accounts; same-account rows cannot pair.
    if (candidate.accountId === transaction.accountId) continue;
    if (linked.has(candidate.id)) continue;
    if (candidate.amountCents !== transaction.amountCents) continue;
    if (candidate.direction === transaction.direction) continue;

    const daysApart = daysBetween(transaction.postedDate, candidate.postedDate);
    if (daysApart > TRANSFER_WINDOW_DAYS) continue;

    const involvesCard =
      accountTypes.get(transaction.accountId) === 'credit_card' ||
      accountTypes.get(candidate.accountId) === 'credit_card';

    matches.push({
      counterpartId: candidate.id,
      proposedKind: involvesCard ? 'payment' : 'transfer',
      daysApart,
      reason: involvesCard ? PAYMENT_REASON : TRANSFER_REASON,
      confirmed: false,
    });
  }

  // Closest date first, then id — a total order, so the list does not shuffle
  // between renders.
  return matches
    .sort((a, b) => a.daysApart - b.daysApart || a.counterpartId.localeCompare(b.counterpartId))
    .slice(0, MAX_SUGGESTIONS);
}

/* ------------------------------------------------------------- refunds - */

export interface RefundSuggestion {
  readonly purchaseId: string;
  readonly daysApart: number;
  readonly reason: string;
  readonly confirmed: false;
}

export interface RefundSuggestionInput {
  /** The credit that may be a refund. */
  readonly refund: Transaction;
  readonly candidates: readonly Transaction[];
  readonly linkedTransactionIds?: ReadonlySet<string>;
}

const REFUND_REASON =
  'An earlier purchase in the same account has the same merchant and exactly the same amount. That is usually the purchase this refund reverses — confirm it to link them.';

/**
 * Deterministic refund candidates.
 *
 * Conservative by design: exact amount, same reviewed merchant, same account,
 * and the purchase must come first. A looser match would attach a refund to the
 * wrong purchase and carry the wrong category across with it.
 */
export function suggestRefundMatches(input: RefundSuggestionInput): RefundSuggestion[] {
  const { refund, candidates } = input;
  const linked = input.linkedTransactionIds ?? new Set<string>();

  if (refund.direction !== 'credit') return [];
  if (linked.has(refund.id)) return [];

  const matches: RefundSuggestion[] = [];

  for (const candidate of candidates) {
    if (candidate.id === refund.id) continue;
    if (linked.has(candidate.id)) continue;
    if (candidate.direction !== 'debit') continue;
    if (candidate.accountId !== refund.accountId) continue;
    if (candidate.amountCents !== refund.amountCents) continue;
    if (candidate.merchantNormalized !== refund.merchantNormalized) continue;
    // A refund cannot precede the purchase it returns.
    if (candidate.postedDate > refund.postedDate) continue;

    const daysApart = daysBetween(refund.postedDate, candidate.postedDate);
    if (daysApart > REFUND_LOOKBACK_DAYS) continue;

    matches.push({ purchaseId: candidate.id, daysApart, reason: REFUND_REASON, confirmed: false });
  }

  // Most recent purchase first: when a merchant was used repeatedly, the
  // nearest earlier purchase is the likeliest source.
  return matches
    .sort((a, b) => a.daysApart - b.daysApart || a.purchaseId.localeCompare(b.purchaseId))
    .slice(0, MAX_SUGGESTIONS);
}

/* -------------------------------------------------- workspace collection - */

/**
 * A pair the review interface can render, with both rows already loaded.
 *
 * Carries whole transactions rather than ids because the reviewer has to see
 * what they are confirming — two dates, two accounts, two amounts. Fetching
 * them one at a time from a component would be exactly the per-row database
 * access this boundary exists to prevent.
 */
export interface TransferPairSuggestion {
  /** The money-out side. */
  readonly outgoing: Transaction;
  /** The money-in side. */
  readonly incoming: Transaction;
  readonly proposedKind: Extract<TransactionKind, 'transfer' | 'payment'>;
  readonly daysApart: number;
  readonly reason: string;
}

export interface RefundCandidate {
  readonly purchase: Transaction;
  readonly daysApart: number;
  readonly reason: string;
}

export interface RefundSuggestionGroup {
  readonly refund: Transaction;
  readonly candidates: readonly RefundCandidate[];
  /**
   * More than one earlier purchase fits exactly.
   *
   * Surfaced rather than resolved: picking the nearest one and presenting it as
   * the answer would be a guess wearing a confirmation button (§7).
   */
  readonly ambiguous: boolean;
}

export interface SuggestionCollection<T> {
  readonly suggestions: readonly T[];
  /** True when a bound stopped the search before it ran out of candidates. */
  readonly truncated: boolean;
}

/** Kinds whose credit side is still an open question. */
const REFUND_REVIEW_KINDS: ReadonlySet<TransactionKind> = new Set<TransactionKind>([
  'refund',
  'unknown',
]);

/**
 * Groups rows by a key, capping each group.
 *
 * The cap is what keeps collection near-linear: pairing inside a group is
 * quadratic, so an unbounded group of identical amounts would dominate the
 * whole scan. Rows are taken in id order so the cap keeps a deterministic
 * subset rather than whatever order the database happened to yield.
 */
function groupBounded(
  rows: readonly Transaction[],
  keyOf: (row: Transaction) => string,
): { groups: Map<string, Transaction[]>; truncated: boolean } {
  const groups = new Map<string, Transaction[]>();
  let truncated = false;

  for (const row of [...rows].sort((a, b) => a.id.localeCompare(b.id))) {
    const key = keyOf(row);
    const bucket = groups.get(key);
    if (!bucket) {
      groups.set(key, [row]);
      continue;
    }
    if (bucket.length >= MAX_SUGGESTION_GROUP_SIZE) {
      truncated = true;
      continue;
    }
    bucket.push(row);
  }

  return { groups, truncated };
}

/**
 * Every transfer or card-payment pair worth offering, across the workspace.
 *
 * **Reads only.** Collecting suggestions writes nothing — no link, no kind, no
 * timestamp. That is the whole point of §7's split: looking at a suggestion
 * must leave the workspace byte-identical, because a user who opens this page
 * and closes it has not decided anything.
 *
 * The matching decision itself is delegated to `suggestTransferPairs`, so there
 * is exactly one definition of what a transfer looks like. This function only
 * decides *which rows are worth asking about*, by bucketing on amount — the
 * matcher requires equal amounts, so rows with different ones can never pair
 * and never need comparing.
 *
 * Anchored on the debit side, so a pair is produced once rather than twice.
 */
export async function collectTransferSuggestions(
  db: WorkspaceDatabase,
  limit: number = MAX_REVIEW_SUGGESTIONS,
): Promise<SuggestionCollection<TransferPairSuggestion>> {
  const [accounts, linked, rows] = await Promise.all([
    db.accounts.toArray(),
    linkedTransactionIds(db),
    db.transactions.toArray(),
  ]);

  const free = rows.filter((row) => !linked.has(row.id));
  const { groups, truncated: groupsTruncated } = groupBounded(free, (row) =>
    String(row.amountCents),
  );

  const byId = new Map(rows.map((row) => [row.id, row]));
  const found: TransferPairSuggestion[] = [];
  let truncated = groupsTruncated;

  // Numeric amount order, then id order inside each group: a total order, so
  // the same workspace always produces the same list in the same sequence.
  const amounts = [...groups.keys()].sort((a, b) => Number(a) - Number(b));

  for (const amount of amounts) {
    const bucket = groups.get(amount)!;
    if (bucket.length < 2) continue;

    for (const row of bucket) {
      if (row.direction !== 'debit') continue;

      for (const match of suggestTransferPairs({
        transaction: row,
        candidates: bucket,
        accounts,
        linkedTransactionIds: linked,
      })) {
        const counterpart = byId.get(match.counterpartId);
        if (!counterpart) continue;

        if (found.length >= limit) {
          truncated = true;
          return { suggestions: found, truncated };
        }

        found.push({
          outgoing: row,
          incoming: counterpart,
          proposedKind: match.proposedKind,
          daysApart: match.daysApart,
          reason: match.reason,
        });
      }
    }
  }

  return { suggestions: found, truncated };
}

/**
 * Credits that may be refunds, each with its exact-match candidates.
 *
 * **Reads only**, for the same reason as transfers.
 *
 * Bucketed on the three things the matcher demands be identical — account,
 * amount, merchant — so a credit is only ever compared against purchases that
 * could actually match it. A credit with no candidates is omitted rather than
 * listed as an empty question.
 */
export async function collectRefundSuggestions(
  db: WorkspaceDatabase,
  limit: number = MAX_REVIEW_SUGGESTIONS,
): Promise<SuggestionCollection<RefundSuggestionGroup>> {
  const [linked, rows] = await Promise.all([linkedTransactionIds(db), db.transactions.toArray()]);

  const free = rows.filter((row) => !linked.has(row.id));
  // JSON rather than a delimiter: the three parts have to combine into one
  // unambiguous key, and any printable separator could occur inside a merchant
  // name and merge two groups that are not the same. An earlier version used a
  // control character to avoid that, which put a raw 0x01 byte in this file --
  // exactly the hazard that made Git treat a Phase 4C source file as binary.
  const keyOf = (row: Transaction) =>
    JSON.stringify([row.accountId, row.amountCents, row.merchantNormalized]);
  const { groups, truncated: groupsTruncated } = groupBounded(free, keyOf);

  const found: RefundSuggestionGroup[] = [];
  let truncated = groupsTruncated;

  // Newest refund first: the one a user just noticed is the one they came here
  // to resolve. Id breaks the tie so the order is total.
  const refunds = free
    .filter((row) => row.direction === 'credit' && REFUND_REVIEW_KINDS.has(row.kind))
    .sort((a, b) => b.postedDate.localeCompare(a.postedDate) || a.id.localeCompare(b.id));

  for (const refund of refunds) {
    const candidates = groups.get(keyOf(refund)) ?? [];

    const matches = suggestRefundMatches({
      refund,
      candidates,
      linkedTransactionIds: linked,
    });
    if (matches.length === 0) continue;

    if (found.length >= limit) {
      truncated = true;
      break;
    }

    const byId = new Map(candidates.map((row) => [row.id, row]));
    const resolved: RefundCandidate[] = [];
    for (const match of matches) {
      const purchase = byId.get(match.purchaseId);
      if (purchase) {
        resolved.push({ purchase, daysApart: match.daysApart, reason: match.reason });
      }
    }
    if (resolved.length === 0) continue;

    found.push({ refund, candidates: resolved, ambiguous: resolved.length > 1 });
  }

  return { suggestions: found, truncated };
}

export interface UnmatchedRefundOptions {
  /**
   * Refund groups already collected, so the scan is not repeated.
   *
   * Optional purely so this function still works on its own; the review hook
   * always has them by the time it asks.
   */
  readonly matched?: SuggestionCollection<RefundSuggestionGroup>;
  /**
   * Ids already offered elsewhere on the page.
   *
   * A credit that is one side of a suggested transfer is not a refund waiting
   * for a purchase, and listing it under "nothing matched" alongside a transfer
   * suggestion for the same row tells the user two contradictory things about
   * one transaction.
   */
  readonly exclude?: ReadonlySet<string>;
}

/**
 * Credits awaiting review that no purchase matches.
 *
 * Listed separately and honestly: "nothing matched" is a real answer, and the
 * only correct next step is a manual decision rather than a link. Without this,
 * a refund with no candidate would simply be absent and look reviewed.
 */
export async function collectUnmatchedRefunds(
  db: WorkspaceDatabase,
  limit: number = MAX_REVIEW_SUGGESTIONS,
  options: UnmatchedRefundOptions = {},
): Promise<SuggestionCollection<Transaction>> {
  const matched = options.matched ?? (await collectRefundSuggestions(db, limit));
  const withCandidates = new Set(matched.suggestions.map((group) => group.refund.id));
  const exclude = options.exclude ?? new Set<string>();

  const [linked, rows] = await Promise.all([linkedTransactionIds(db), db.transactions.toArray()]);

  const unmatched = rows
    .filter(
      (row) =>
        !linked.has(row.id) &&
        row.direction === 'credit' &&
        REFUND_REVIEW_KINDS.has(row.kind) &&
        !withCandidates.has(row.id) &&
        !exclude.has(row.id),
    )
    .sort((a, b) => b.postedDate.localeCompare(a.postedDate) || a.id.localeCompare(b.id));

  return {
    suggestions: unmatched.slice(0, limit),
    truncated: unmatched.length > limit,
  };
}

/** A confirmed relationship with both of its rows, for display and unlinking. */
export interface ConfirmedRelationship {
  readonly link: TransactionLink;
  readonly from: Transaction;
  readonly to: Transaction;
}

/**
 * Relationships the user has already confirmed.
 *
 * A link whose endpoints are missing is skipped rather than rendered half
 * empty — the cascade in `importHistory` removes links with their rows, so this
 * should not happen, and quietly tolerating it is better than crashing the page
 * if it ever does.
 */
export async function listConfirmedRelationships(
  db: WorkspaceDatabase,
  limit: number = MAX_REVIEW_SUGGESTIONS,
): Promise<SuggestionCollection<ConfirmedRelationship>> {
  const links = await db.transactionLinks.toArray();
  const ordered = [...links].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
  );

  const needed = new Set<string>();
  for (const link of ordered) {
    needed.add(link.fromTransactionId);
    needed.add(link.toTransactionId);
  }
  const rows = await db.transactions.bulkGet([...needed]);
  const byId = new Map(
    rows.filter((row): row is Transaction => Boolean(row)).map((r) => [r.id, r]),
  );

  const resolved: ConfirmedRelationship[] = [];
  for (const link of ordered) {
    const from = byId.get(link.fromTransactionId);
    const to = byId.get(link.toTransactionId);
    if (!from || !to) continue;
    if (resolved.length >= limit) return { suggestions: resolved, truncated: true };
    resolved.push({ link, from, to });
  }

  return { suggestions: resolved, truncated: false };
}

/* ------------------------------------------------------------ commands - */

export type LinkRejectionReason =
  'not-found' | 'already-linked' | 'same-transaction' | 'invalid-pair' | 'workspace-write-failed';

export interface LinkRejection {
  readonly ok: false;
  readonly reason: LinkRejectionReason;
  readonly message: string;
}

const LINK_MESSAGES: Record<LinkRejectionReason, string> = {
  'not-found': 'One of those transactions is no longer in your workspace. Nothing was changed.',
  'already-linked':
    'One of those transactions is already linked to another. Unlink it first. Nothing was changed.',
  'same-transaction': 'A transaction cannot be linked to itself. Nothing was changed.',
  'invalid-pair': 'Those two transactions cannot be linked in that way. Nothing was changed.',
  'workspace-write-failed':
    'That relationship could not be saved. Nothing was changed — your workspace is exactly as it was.',
};

function rejectLink(reason: LinkRejectionReason): LinkRejection {
  return { ok: false, reason, message: LINK_MESSAGES[reason] };
}

export interface LinkOptions {
  readonly clock?: Clock;
  readonly newId?: () => string;
}

/** Both endpoints must be free before a relationship may be recorded. */
async function endpointsAreFree(db: WorkspaceDatabase, ids: readonly string[]): Promise<boolean> {
  const taken = await db.transactionLinks
    .filter((link) => ids.includes(link.fromTransactionId) || ids.includes(link.toTransactionId))
    .count();
  return taken === 0;
}

/**
 * Confirms that two transactions are two sides of one movement.
 *
 * Writes the link *and* both kind changes in one command, so the pair can never
 * end up half-classified — one row a transfer and its counterpart still a
 * purchase would double-count in exactly the direction that hides money.
 */
export async function confirmTransferPair(
  db: WorkspaceDatabase,
  outgoingId: string,
  incomingId: string,
  kind: Extract<TransactionKind, 'transfer' | 'payment'>,
  options: LinkOptions = {},
): Promise<CommandResult | LinkRejection> {
  if (outgoingId === incomingId) return rejectLink('same-transaction');

  const generateId = options.newId ?? newId;
  const clock = options.clock ?? systemClock;

  const [outgoing, incoming] = await db.transactions.bulkGet([outgoingId, incomingId]);
  if (!outgoing || !incoming) return rejectLink('not-found');
  if (outgoing.accountId === incoming.accountId) return rejectLink('invalid-pair');
  if (outgoing.direction === incoming.direction) return rejectLink('invalid-pair');
  if (!(await endpointsAreFree(db, [outgoingId, incomingId]))) return rejectLink('already-linked');

  const link: TransactionLink = {
    id: generateId(),
    kind: 'transfer',
    fromTransactionId: outgoing.direction === 'debit' ? outgoingId : incomingId,
    toTransactionId: outgoing.direction === 'debit' ? incomingId : outgoingId,
    createdAt: clock(),
  };
  if (!transactionLinkSchema.safeParse(link).success) return rejectLink('invalid-pair');

  // Both rows get the same kind. `editTransactions` reconciles each row's
  // exclusion fields, so the pair leaves spending totals together.
  const patch: TransactionPatch = { kind };

  return editTransactions(db, [outgoingId, incomingId], patch, {
    clock,
    newId: generateId,
    label: kind === 'payment' ? 'link card payment' : 'link transfer',
    beforeCommit: async () => {
      await db.transactionLinks.add(link);
      return { createdLinkIds: [link.id] };
    },
  });
}

/**
 * Confirms that a credit is a refund of an earlier purchase.
 *
 * The refund inherits the purchase's reviewed merchant and category, which is
 * the point of linking: a refund filed under a different category than the
 * purchase it reverses would leave both figures wrong. It stays `kind: refund`
 * and remains visibly a refund.
 */
export async function confirmRefundLink(
  db: WorkspaceDatabase,
  refundId: string,
  purchaseId: string,
  options: LinkOptions = {},
): Promise<CommandResult | LinkRejection> {
  if (refundId === purchaseId) return rejectLink('same-transaction');

  const generateId = options.newId ?? newId;
  const clock = options.clock ?? systemClock;

  const [refund, purchase] = await db.transactions.bulkGet([refundId, purchaseId]);
  if (!refund || !purchase) return rejectLink('not-found');
  if (refund.direction !== 'credit' || purchase.direction !== 'debit') {
    return rejectLink('invalid-pair');
  }
  if (!(await endpointsAreFree(db, [refundId, purchaseId]))) return rejectLink('already-linked');

  const link: TransactionLink = {
    id: generateId(),
    kind: 'refund',
    fromTransactionId: refundId,
    toTransactionId: purchaseId,
    createdAt: clock(),
  };
  if (!transactionLinkSchema.safeParse(link).success) return rejectLink('invalid-pair');

  return editTransactions(
    db,
    [refundId],
    {
      kind: 'refund',
      categoryId: purchase.categoryId,
      merchantNormalized: purchase.merchantNormalized,
    },
    {
      clock,
      newId: generateId,
      label: 'link refund',
      beforeCommit: async () => {
        await db.transactionLinks.add(link);
        return { createdLinkIds: [link.id] };
      },
    },
  );
}

/**
 * Removes a confirmed relationship.
 *
 * Kinds are deliberately left alone. The user confirmed that a row is a
 * transfer or a refund; unlinking says the *pairing* was wrong, not the
 * classification, and silently reverting a kind would change spending totals
 * as a side effect of a bookkeeping correction. Changing the kind back is a
 * separate, visible edit.
 */
export async function unlinkTransactions(
  db: WorkspaceDatabase,
  linkId: string,
  options: LinkOptions = {},
): Promise<CommandResult | LinkRejection> {
  const existing = await db.transactionLinks.get(linkId);
  if (!existing) return rejectLink('not-found');

  const anchorId = existing.fromTransactionId;
  const anchor = await db.transactions.get(anchorId);
  if (!anchor) return rejectLink('not-found');

  // Routed through `editTransactions` with a no-op-shaped patch so the unlink
  // gets the same atomicity and the same undo machinery as everything else.
  return editTransactions(
    db,
    [anchorId],
    { kind: anchor.kind },
    {
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.newId ? { newId: options.newId } : {}),
      label: 'unlink',
      beforeCommit: async () => {
        await db.transactionLinks.delete(linkId);
        return { removedLinks: [existing] };
      },
    },
  );
}

/** Every transaction id currently spoken for by a confirmed relationship. */
export async function linkedTransactionIds(db: WorkspaceDatabase): Promise<Set<string>> {
  const ids = new Set<string>();
  await db.transactionLinks.each((link) => {
    ids.add(link.fromTransactionId);
    ids.add(link.toTransactionId);
  });
  return ids;
}

/** The relationship a transaction takes part in, if any. */
export async function linkFor(
  db: WorkspaceDatabase,
  transactionId: string,
): Promise<{ readonly link: TransactionLink; readonly counterpartId: string } | null> {
  const links = await db.transactionLinks
    .filter(
      (link) => link.fromTransactionId === transactionId || link.toTransactionId === transactionId,
    )
    .toArray();

  const link = links[0];
  if (!link) return null;

  return {
    link,
    counterpartId:
      link.fromTransactionId === transactionId ? link.toTransactionId : link.fromTransactionId,
  };
}

export type { TransactionLinkKind };
