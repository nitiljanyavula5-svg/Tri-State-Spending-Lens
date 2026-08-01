# Category and Classification Rules — Tri-State Spending Lens

**Status:** Phase 0 foundation document — treated as a requirement, not marketing copy.
**Source:** Split from `Tri-State-Spending-Lens-Master-Plan.md` (revision July 31, 2026), primarily §7.4 (Permanent category system), §10 (Categorization logic, merchant normalization), §7.3 (edit vs. rule), and the `MerchantRule` shape in §9.
**Companion documents:** [`product-spec.md`](./product-spec.md) · [`privacy-model.md`](./privacy-model.md) · [`data-methodology.md`](./data-methodology.md) · [`calculation-contract.md`](./calculation-contract.md) · [`threat-model.md`](./threat-model.md)

## 1. Scope and ownership boundaries

This document owns the **classification vocabulary and the order in which classification decisions are made**: the permanent category list, transaction kinds, the essential/discretionary and fixed/variable axes, merchant-string normalization and aliasing, and the exact rule precedence.

It does **not** own field-level normalization (dates, money, direction) or duplicate fingerprints — those belong to [`data-methodology.md`](./data-methodology.md). It does **not** define which kinds count toward a total — that belongs to [`calculation-contract.md`](./calculation-contract.md).

**Three independent axes.** A transaction is classified along three axes that never collapse into one another:

| Axis | Question it answers | Field |
| --- | --- | --- |
| **Category** | What was this for? | `categoryId` |
| **Kind** | What sort of money movement was this? | `kind` |
| **Budget behavior** | How should a plan treat it? | `essentiality`, `variability` |

Keeping them separate is what allows "Dining" to be discretionary for one user and near-fixed for another, and what allows a transfer to have a category without ever being counted as spending.

## 2. Permanent categories

These sixteen categories are **stable and permanent** for v1.0. They are neutral by design: the master plan explicitly replaced a "Luxury" category with **Shopping** and **Personal Care** to avoid subjective or judgmental classification.

| Category ID | Label |
| --- | --- |
| `housing` | Housing |
| `utilities_bills` | Utilities & Bills |
| `groceries` | Groceries |
| `dining` | Dining |
| `transportation` | Transportation |
| `subscriptions_memberships` | Subscriptions & Memberships |
| `shopping` | Shopping |
| `personal_care` | Personal Care |
| `entertainment` | Entertainment |
| `health` | Health |
| `education` | Education |
| `travel` | Travel |
| `fees_interest` | Fees & Interest |
| `gifts_donations` | Gifts & Donations |
| `cash_atm` | Cash & ATM |
| `other` | Other |

Rules:

- **The set is closed in v1.0.** User-created custom categories are a Version 2 idea, explicitly not a commitment, and require safe migration behavior when they arrive ([`product-spec.md`](./product-spec.md) §9.3).
- Category IDs are stable strings and are what gets persisted. Labels are display text and may be reworded without a migration; IDs may not.
- `other` doubles as the **uncategorized review destination**. A transaction sitting in `other` with `categorySource: "uncategorized"` is awaiting review; one placed there deliberately by the user has `categorySource: "user"`. The Import Health Report and the review queue must distinguish these two states.
- Category labels are neutral descriptions of purpose, never judgments of the user's behavior.

## 3. Transaction kinds

Kind is classified **separately** from category:

| Kind | Meaning |
| --- | --- |
| `purchase` | Ordinary spending |
| `refund` | Money returned for a prior purchase |
| `income` | Money earned or received from outside the user's own accounts |
| `transfer` | Movement between the user's own accounts |
| `payment` | Credit-card payment |
| `fee` | Bank, card, or service fee |
| `cash_withdrawal` | Cash taken out (ATM or cash back) |
| `unknown` | Not yet determined; awaiting review |

### 3.1 Default kind on import

- **Debits default to `purchase`.**
- **Credits default to `unknown`**, because a credit can be income, a refund, a transfer in, or a card-payment credit, and the product must not guess.

These defaults and their rationale are recorded in [`data-methodology.md`](./data-methodology.md) §3.5. Rules (§5) may override them; the user always may.

### 3.2 Category for non-spending kinds

`transfer`, `payment`, and `income` transactions still carry a `categoryId`, because every transaction has one. They default to `other`.

**They are excluded from spending by kind, never by category.** No calculation may rely on a category value to decide whether money moved or was spent — see [`calculation-contract.md`](./calculation-contract.md) §3.

### 3.3 Kind-implied category defaults

Where a kind has an unambiguous purpose, the default category follows it:

| Kind | Default category |
| --- | --- |
| `fee` | `fees_interest` |
| `cash_withdrawal` | `cash_atm` |
| `refund` | inherited from the matched purchase; otherwise `other` pending review ([`calculation-contract.md`](./calculation-contract.md) §5.2) |
| `transfer`, `payment`, `income` | `other` |
| `purchase`, `unknown` | resolved by the precedence chain in §5 |

## 4. Budget behavior: essential/discretionary and fixed/variable

Two independent classifications describe how a plan should treat a transaction:

- **Essential** or **discretionary**
- **Fixed** or **variable**

**The behavior classification must be editable, because the same category can mean different things for different people.** A car payment is fixed and essential for a commuter and neither for someone who rarely drives.

### 4.1 Default seed values

Defaults are seeded per category and are a **starting point, not a claim about the user**. The user may change them per transaction, and per category as a persisted preference.

| Category | Default essentiality | Default variability |
| --- | --- | --- |
| Housing | essential | fixed |
| Utilities & Bills | essential | variable |
| Groceries | essential | variable |
| Dining | discretionary | variable |
| Transportation | essential | variable |
| Subscriptions & Memberships | discretionary | fixed |
| Shopping | discretionary | variable |
| Personal Care | discretionary | variable |
| Entertainment | discretionary | variable |
| Health | essential | variable |
| Education | essential | variable |
| Travel | discretionary | variable |
| Fees & Interest | essential | variable |
| Gifts & Donations | discretionary | variable |
| Cash & ATM | discretionary | variable |
| Other | discretionary | variable |

Rules:

- Both fields are optional on `Transaction` (`essentiality?`, `variability?`). A transaction with neither set is reported as unclassified in the Essential-vs-Discretionary and Fixed-vs-Variable panels rather than being silently bucketed.
- A user edit to either field is a persisted `UserEdit` and survives re-categorization, alias changes, and reimport.
- These labels **never** appear in judgmental language. "Discretionary" is a planning term, not a criticism.
- Changing a default seed value in a future release must not overwrite transactions the user has already classified.

## 5. Rule precedence — exact order

Classification walks this chain and **stops at the first match**:

1. **Explicit per-transaction user edit**
2. **User-created merchant rule**
3. **Exact built-in merchant alias**
4. **Built-in keyword rule**
5. **Uncategorized / Other review queue**

This order is absolute. A lower-numbered source always wins; nothing later in the chain may override an earlier decision, and re-running classification must never demote a user decision.

### 5.1 Mapping to `categorySource` and confidence

| Precedence | `categorySource` | `classificationConfidence` |
| --- | --- | --- |
| 1. Per-transaction user edit | `user` | `high` |
| 2. User-created merchant rule | `user_rule` | `high` |
| 3. Exact built-in merchant alias | `merchant_rule` | `high` |
| 4. Built-in keyword rule | `keyword_rule` | `medium` (exact token match) or `low` (partial/substring match) |
| 5. No match | `uncategorized` | `none` |

**Use confidence labels, not unexplained decimals.** The `/methodology` page must show, for any transaction, which rule matched and why it applied.

### 5.2 Rule shape

```ts
interface MerchantRule {
  id: string;
  matchType: "exact" | "contains" | "starts_with";
  pattern: string;
  normalizedMerchant?: string;
  categoryId?: string;
  kind?: TransactionKind;
  priority: number;
  createdByUser: boolean;
}
```

- A rule may set the normalized merchant, the category, the kind, or any combination. Unset fields leave the existing value alone.
- Rules are matched against `merchantNormalized` (§6), not against `descriptionRaw`, so alias behavior stays predictable.
- Within one precedence tier, ties break by `priority` (higher first), then by **most specific match type** (`exact` > `starts_with` > `contains`), then by **longest pattern**, then by `id`. The result is deterministic.
- `createdByUser: true` places the rule in tier 2; built-in rules are tiers 3–4.
- Patterns are matched literally. **User-supplied patterns are never compiled as regular expressions** ([`threat-model.md`](./threat-model.md)).

### 5.3 Edit this one vs. create a rule

When a user changes a merchant or category, the product offers **two distinct actions**:

- **Change this transaction only** → writes a per-transaction `UserEdit` (tier 1). Affects exactly one row.
- **Create a rule for similar future transactions** → writes a `MerchantRule` with `createdByUser: true` (tier 2).

**This prevents one edit from unexpectedly rewriting the full history.** When a user chooses to create a rule, the app must show how many existing transactions the rule would match and let the user decide whether to apply it retroactively — as an explicit, undoable action.

Rule application is never silent and always reversible: bulk edits and rule applications are undoable ([`product-spec.md`](./product-spec.md) §8.3).

### 5.4 Re-running classification

Re-running classification after an alias-table improvement must:

- preserve every tier-1 and tier-2 decision untouched;
- only recompute rows whose `categorySource` is `merchant_rule`, `keyword_rule`, or `uncategorized`;
- leave `descriptionRaw` and `fingerprint` unchanged (fingerprints do not depend on aliases — [`data-methodology.md`](./data-methodology.md) §4.2).

## 6. Merchant normalization

### 6.1 What normalization may do

- Trim whitespace and normalize casing
- Remove known card-network prefixes
- Remove store numbers **only when a rule is safe**
- **Preserve the raw description permanently**
- Apply **versioned** aliases

### 6.2 What normalization must not do

**Normalization must not guess aggressively.** Shared words are not evidence of a shared merchant.

> `SQ *GREEN HOUSE` and `GREEN HOUSE RENTALS` must not be merged merely because they share words.

Binding consequences:

- No fuzzy/edit-distance merging of distinct merchant strings in v1.0.
- No token-overlap heuristics that combine two merchants without an explicit alias entry.
- Store-number stripping applies only where an explicit, reviewed alias rule declares it safe for that merchant family — never as a blanket regex over all descriptions.
- When normalization cannot confidently produce a merchant, `merchantNormalized` falls back to the canonicalized description (trim, collapse whitespace, uppercase) and the transaction is routed to review. **A fallback is always preferable to an invented merchant.**

### 6.3 Versioned aliases

- The built-in alias table carries a version number, stored alongside affected transactions so a later improvement is an explicit, migrated event.
- Alias changes never rewrite `descriptionRaw`, never change `fingerprint`, and never override tier-1 or tier-2 user decisions (§5.4).
- The raw description remains permanently accessible in the transaction detail view.

### 6.4 Safety

Merchant strings are hostile input. They are stored and rendered as **text, never HTML**, length-capped, and escaped on CSV export against spreadsheet formula injection. Full handling is defined in [`threat-model.md`](./threat-model.md).

## 7. Kind classification rules

Kind follows the same five-tier precedence as category (§5). Built-in rules propose; the user disposes.

| Kind | Typical built-in signals | Confidence |
| --- | --- | --- |
| `fee` | Fee/interest/service-charge keywords on a debit | `medium` |
| `cash_withdrawal` | ATM/cash-withdrawal keywords on a debit | `medium` |
| `payment` | Card-payment keywords, and the account is a credit card or the counterparty is | `medium` |
| `transfer` | Transfer keywords, or a matching opposite-direction movement between two of the user's own accounts | `low` — always confirmed by the user |
| `income` | Payroll/deposit keywords on a credit | `low` — always confirmed by the user |
| `refund` | Refund/return/credit-adjustment keywords on a credit | `low` — always confirmed by the user |

Binding rules:

- **Transfer and payment detection may only suggest.** Because `transfer` and `payment` are excluded from net spending, an incorrect automatic assignment would silently hide real spending. Both require user confirmation before they take effect on totals; until confirmed, the row remains a credit at `unknown` (excluded) or a debit at `purchase` (included), with the suggestion shown in the review queue.
- A transfer-pair suggestion may be raised when two transactions in different accounts share a date within a small window, have equal `amountCents`, and have opposite directions. This is a **prompt**, never an automatic reclassification, and never a deletion.
- Users can mark any transaction as transfer, refund, income, card payment, fee, or cash withdrawal directly ([`product-spec.md`](./product-spec.md) §8.3).
- `excludedFromSpending` is a separate, explicit user control with an `exclusionReason`. It is not a substitute for setting the right kind, and the two are evaluated independently ([`calculation-contract.md`](./calculation-contract.md) §3.3).

## 8. Test obligations

- Precedence: a user edit survives re-running classification, an alias-table update, and a reimport.
- Precedence: a user rule beats a built-in alias; a built-in alias beats a keyword rule.
- Determinism: identical input plus identical rules produces identical `categoryId`, `kind`, `merchantNormalized`, and `categorySource`.
- Non-merging: `SQ *GREEN HOUSE` and `GREEN HOUSE RENTALS` remain distinct merchants.
- Kind defaults: debits import as `purchase`; credits import as `unknown`.
- Kind safety: an unconfirmed transfer/payment suggestion does not change net spending.
- Rule creation: "change this transaction only" modifies exactly one row.
- Behavior axes: a user-set essentiality/variability value survives re-categorization.

## 9. Decisions recorded in Phase 0

The master plan states the requirement; this document records the specific value chosen. Revisions belong here, not in code.

1. **Stable category IDs** for the sixteen permanent categories (§2), separating persisted identity from display labels.
2. **`other` serves as the uncategorized destination**, distinguished from deliberate placement by `categorySource` (§2).
3. **Default essentiality/variability seed table** (§4.1) — a starting point, fully editable, and explicitly not a claim about any user.
4. **Kind-implied default categories** for `fee` and `cash_withdrawal` (§3.3).
5. **Deterministic within-tier tie-break order** for merchant rules (§5.2).
6. **Transfer/payment auto-detection may only suggest**, never silently reclassify, because those kinds remove money from net spending (§7).
7. **Fallback merchant** is the canonicalized raw description rather than a guessed merchant (§6.2).

## 10. Open product decisions

None. The category list, kinds, behavior axes, precedence order, and normalization limits are fully specified for v1.0. The default seed table in §4.1 is the item most likely to be revised after real usage, and is safe to revise because it never overwrites a user's own classification.
