# Phase 4 Service Layer — Transaction Review and Rules

**Status:** Phase 4 complete — the data, persistence, classification, relationship, and export services are implemented and tested, and every one of them has an application surface: the review grid and editor at `/app/transactions`, the rule manager in Settings, and transfer, card-payment, and refund review at `/app/transactions/relationships`. Component and browser coverage exists for all three.

This document describes the **service contract**. The interfaces built on it are described in the [README](../README.md#reviewing-your-transactions); where the two disagree, this document is the requirement.

**Companion documents:** [`category-rules.md`](./category-rules.md) owns the classification vocabulary and precedence · [`calculation-contract.md`](./calculation-contract.md) owns what counts as spending · [`data-methodology.md`](./data-methodology.md) owns normalization and import sessions · [`threat-model.md`](./threat-model.md) owns limits and hostile input.

## 1. The classification boundary

One pure function, `classify()` in `src/classification/classify.ts`, implements the whole precedence chain from `category-rules.md` §5. It reads no database, no clock, and no randomness: the same row and the same rules always produce the same decision.

| Tier | Source | `categorySource` | Confidence |
| --- | --- | --- | --- |
| 1 | Explicit per-transaction user edit | `user` | `high` |
| 2 | User-created rule | `user_rule` | `high` |
| 3 | Built-in exact merchant alias | `merchant_rule` | `high` |
| 4 | Built-in keyword rule | `keyword_rule` | `medium` / `low` |
| 5 | No match | `uncategorized` | `none` |

Provenance is exposed as a readable label — "You set this", "Your rule", "Built-in keyword rule" — never as an unexplained decimal score.

### 1.1 What imports apply

**An import applies tiers 1–2 only.** Built-in aliases and keywords run inside `classify()`, but `buildStagedImport` uses the result only when it came from a user rule; otherwise the row keeps the Phase 3 defaults.

This is deliberate. `category-rules.md` §7 says built-in rules *propose* and the user disposes, and a row committed without anyone looking at it has had no such disposal. It also makes a guarantee mechanical rather than hopeful: with no matching user rule, an import produces byte-identical output to Phase 3, whatever the built-in keyword table happens to contain.

Import defaults are unchanged: **debits `purchase`, credits `unknown`** (`data-methodology.md` §3.5).

### 1.2 One rules snapshot per import run

The caller reads the user's rules once and passes them through `BuildStagedImportInput.userRules`. Preview and commit therefore classify against the same rules; a rule saved after the preview cannot silently change what the commit writes.

## 2. Rules

### 2.1 Deterministic ordering

Within tier 2, `sortRulesByPrecedence` gives a total order: **priority** (higher first) → **match specificity** (`exact` > `starts_with` > `contains`) → **longer pattern** → **id**. Nothing depends on database iteration order.

Patterns are matched **literally against `merchantNormalized`**, never compiled as regular expressions, and never matched against the raw description.

### 2.2 Validation

| Constraint | Value |
| --- | --- |
| Pattern length | 1 … 200 characters, canonicalized |
| Minimum `contains` pattern | 3 characters (refused below) |
| Broad-pattern warning | under 5 characters |
| Priority | integer, −1000 … 1000 |
| Outputs | at least one of merchant, category, kind |
| Rules per workspace | 500 |

A `contains` rule two characters long would match nearly every transaction and silently recategorize a whole workspace on the next import, so it is refused rather than warned about.

### 2.3 Rules are never retroactive

Creating, editing, or deleting a rule **does not modify stored transactions**. Deleting a rule never deletes a transaction and never recategorizes history.

Applying a rule to existing rows is a separate, explicit action — `applyRuleToTransactions` — which changes only the ids the user selected and is one undo unit.

`category-rules.md` §5.3 requires that action to be reachable: on creating a rule the product must show how many stored transactions it matches and let the user decide whether to apply it retroactively. The rule manager does both — it offers the choice as soon as a rule is created, and keeps an "Apply to existing" control on every rule afterwards. The work list comes from `collectMatchingTransactionIds`, bounded by `MAX_BULK_TRANSACTIONS`, and the confirmation states the count, warns that those rows will change, and discloses truncation when more match than one command may cover.

### 2.4 Edit plus future rule

`editTransactionAndCreateRule` is one Dexie transaction: the edit applies to the selected row only, the rule is written alongside it, and either both land or neither does. Undoing it removes both — leaving the rule behind would undo the visible half while the invisible half kept classifying future imports.

## 3. Relationships

Schema version 3 adds `transactionLinks` (`id, kind, fromTransactionId, toTransactionId, createdAt`).

### 3.1 Suggestions never mutate

`suggestTransferPairs` and `suggestRefundMatches` are pure functions over rows. They return a bounded (20), deterministically ordered list and write nothing. The default is always **no relationship**.

| Relationship | Requires |
| --- | --- |
| Transfer / card payment | different accounts, equal `amountCents`, opposite directions, ≤ 4 days apart; `payment` proposed when a credit-card account is involved |
| Refund | credit direction, an earlier debit in the **same** account, exactly equal amount, the same reviewed merchant, ≤ 120 days |

`transfer` and `payment` are excluded from net spending, so an incorrect automatic assignment would silently hide real spending. Nothing is applied without explicit confirmation.

### 3.2 Confirmation and unlinking

Confirming a transfer writes the link **and** both kind changes in one command, so a pair can never be half-classified. Confirming a refund makes the credit inherit the purchase's reviewed merchant and category while remaining `kind: refund`. Each endpoint may take part in at most one relationship; a second attempt is refused.

Unlinking removes the relationship and **leaves the kinds alone**. Unlinking says the pairing was wrong, not the classification; silently reverting a kind would change spending totals as a side effect of a bookkeeping correction.

### 3.3 Integrity

Deleting a transaction deletes every link containing it, in the same transaction, via `deleteLinksTouching`. This applies to `deleteImportSession` and `rollbackImportSession`; whole-workspace paths (`replaceWorkspace`, `deleteAllData`, demo replacement) clear the table because it is in `TABLE_NAMES`.

An orphaned link would not merely be untidy — backup validation refuses a document whose link endpoints are missing, so an orphan would make the workspace un-exportable. Restore also rejects self-links, double-paired endpoints, and unknown link kinds.

## 4. Querying

`queryTransactions` is the only read path the review interface uses; components never query Dexie.

Filters: search (matched against **both** the raw description and the normalized merchant), date range, account, kind, category, tag, spending treatment, and needs-review.

**Default order is posting date descending, then id ascending.** The id tie-break is what makes paging trustworthy — without a total order, two rows sharing a date can swap between pages, so the user sees one twice and never sees the other. The tie-break stays ascending regardless of the primary direction.

Page size is clamped to 100; an out-of-range page is clamped rather than returning nothing; `totalCount` always describes the full filtered set. `requestId` is echoed back so a caller can drop a stale answer — a slow response for `PIN` must not overwrite the results for `PINEBROOK`.

Filter and search state is transient: nothing in the module writes, persists, or serializes it.

## 5. Undo

Bounded, **session-local**, maximum **20** commands, oldest evicted first.

**Session-local means the browser session, not the page.** One stack is owned by the workspace provider, above the router, so moving between the transactions grid, the relationship review, and Settings keeps the history intact — transaction, bulk, rule-application, and relationship commands share one chronological twenty. A stack created inside a review page would be destroyed by ordinary navigation, which is not a boundary any specification names.

**Undo history does not survive a reload; the edits themselves always do.** Reloading loses the ability to reverse a recent change, never the change itself. The interface must say so rather than showing a control that quietly disappears.

It is also dropped when the workspace it describes is replaced or deleted — demo load, demo reset, restore, and delete-all. An entry holds whole previous transaction rows, so leaving one behind after "Delete all data" would keep a recoverable copy of exactly what that control promised to remove.

Keeping the stack in memory is also the privacy-preserving choice: an entry holds whole previous transaction rows, and persisting that would create a second growing copy of personal financial data whose only purpose is regret. `UserEdit` already records *that* a field changed, in a bounded field-level form.

One bulk command, one relationship confirmation, or one edit-plus-rule is **one** undo entry. A stale undo — any affected row changed since — is refused and the entry discarded rather than offered again to fail identically. A pending undo cannot be started twice. There is no redo.

## 6. Cleaned CSV export

Column order is fixed: Posted date, Account, Raw description, Merchant, Amount, Direction, Kind, Category, Spending treatment, Exclusion reason, Essentiality, Variability, Tags, Note, Import session.

Rows are ordered by posting date then id, so two exports of the same data are byte-identical. Amounts are converted from integer cents with integer arithmetic — never `cents / 100`, which would reintroduce the floating-point error the calculation contract forbids.

### 6.1 Formula-injection protection

User-controlled cells — Account, Raw description, Merchant, Tags, Note — are prefixed with an apostrophe when they begin with `=`, `+`, `-`, `@`, tab, carriage return, or line feed, **checked after leading spaces**, because a spreadsheet trims before deciding whether a cell is a formula.

Tab is checked **before** trimming, because tab is both whitespace and a trigger; trimming all whitespace first would consume the very character being defended against.

Application-generated cells — amounts, dates, enum values — are **not** prefixed. A negative amount legitimately begins with `-`, and prefixing it would turn a number into text in every spreadsheet.

Fields are quoted per RFC 4180 when they contain a comma, quote, or line break, with internal quotes doubled.

### 6.2 Download

Construction (`buildCsvExport`) is separate from delivery (`downloadCsv`), so the produced bytes are testable without a DOM. The object URL is revoked in a `finally` — a leaked blob URL keeps every exported transaction alive in memory for the lifetime of the document. The CSV is never stored, logged, or transmitted. The filename carries no personal value: `tri-state-spending-lens-transactions-YYYY-MM-DD.csv`.

## 7. Bounds

| Item | Limit |
| --- | --- |
| Merchant | 200 characters |
| Note | 1,000 characters |
| Tags per transaction | 20 |
| Tag length | 40 characters |
| Rows per bulk command | 2,000 |
| Rule pattern | 200 characters |
| User rules | 500 |
| Undo history | 20 |
| Page size | 25 / 50 / 100 |
| Rule match preview | 500 |
| Relationship suggestions | 20 |

## 8. Schema and backup

**Schema version 3.** Migrations 1 and 2 are unchanged; version 3 adds `transactionLinks` only. Adding a table cannot lose data: existing stores are untouched and every Phase 2 and Phase 3 row survives the upgrade unread.

`transactionLinks` is included in backups, restores, and delete-all. In a backup document both `mappingPresets` and `transactionLinks` counts are optional, so a Phase 2 or Phase 3 backup with neither key still restores; the missing table becomes an empty one.

## 9. What is still future work

- **Account editing after import** — accounts are created during import and cannot yet be relabelled or retyped from Settings.
- **Phase 5** — dashboards, charts, and the calculation selectors.
- **Phase 6** — budgets, recurring detection, and insights.
