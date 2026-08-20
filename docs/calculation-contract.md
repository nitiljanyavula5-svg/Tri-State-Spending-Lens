# Calculation Contract — Tri-State Spending Lens

**Status:** Phase 0 foundation document — a **contract**, not marketing copy. Calculation rules are documented and unit-tested **before** any chart is built.
**Source:** Split from `Tri-State-Spending-Lens-Master-Plan.md` (revision July 31, 2026), primarily §8 (Calculation contract), plus the summary cards in §7.5, the budgeting scope in §7.6, and the calculation acceptance criteria in §15.
**Companion documents:** [`product-spec.md`](./product-spec.md) · [`privacy-model.md`](./privacy-model.md) · [`data-methodology.md`](./data-methodology.md) · [`category-rules.md`](./category-rules.md) · [`threat-model.md`](./threat-model.md)

## 1. Binding rules

1. **One shared layer.** All cards, charts, tables, budget bars, and insights read from a single shared calculation/selector module. **Totals cannot disagree**, because there is only one implementation. A component that computes its own total is a defect.
2. **Pure and tested.** Selectors are pure functions of (transactions, budgets, settings, selected period). They are unit-tested against the fixtures in [`../tests/fixtures/README.md`](../tests/fixtures/README.md) before the dashboard is built.
3. **Explainable.** Every total must be explainable and reproducible: a user must be able to drill from any figure to the exact transactions that produced it.
4. **Integer cents.** Every monetary computation is performed in integer cents. No intermediate value is stored or aggregated as a floating-point dollar amount.
5. **Honest absence.** When a value is undefined, it is **hidden with an explanation** — never rendered as `0`, `—`, or `0%` as if it were a measured result.

## 2. Vocabulary

| Term | Meaning |
| --- | --- |
| **Included** | `excludedFromSpending === false` and the transaction's `kind` is eligible for the total being computed |
| **Excluded** | Removed by the user, or removed by kind per §3.2 |
| **Selected period** | The date range the user is viewing (current month by default; also previous month, last 90 days, year to date, or custom) |
| **Complete calendar month** | A month whose full calendar span is covered by imported data |
| **Debit / credit** | Direction of money movement, per [`data-methodology.md`](./data-methodology.md) §3.4. `amountCents` is an unsigned magnitude |

## 3. Net spending

### 3.1 Included in net spending

- Included purchase debits
- Included fee debits
- Included cash withdrawals
- Minus included refunds

### 3.2 Excluded from net spending by default

- Income
- Transfers between accounts
- Credit-card payments
- Transactions explicitly excluded by the user
- Unknown credits until reviewed

### 3.3 Expressed as kinds

| `kind` | Direction | In net spending? |
| --- | --- | --- |
| `purchase` | debit | **Yes**, adds |
| `fee` | debit | **Yes**, adds |
| `cash_withdrawal` | debit | **Yes**, adds |
| `refund` | credit | **Yes**, subtracts |
| `income` | credit | No |
| `transfer` | either | No |
| `payment` | either | No |
| `unknown` | credit | No — excluded until reviewed |
| `unknown` | debit | No — excluded and surfaced in the review queue |

Any transaction with `excludedFromSpending === true` is out, regardless of kind. Exclusion by kind and exclusion by user flag are independent gates; both must pass.

## 4. Core formulas

These are reproduced exactly as specified in the master plan §8 and must not be restated in any other form elsewhere in the codebase:

```text
Net spending = included purchase/fee/cash debits − included refunds

Net cash flow = included income − net spending

Savings rate = (included income − net spending) / included income

Budget remaining = budget limit − budget-period net spending
```

### 4.1 Money in

**"Money in"** is the Overview card label for **included income** — the same quantity that appears as `included income` in the formulas above. There is one underlying selector; the card is a presentation of it.

```text
Money in = Σ amountCents of included credits where kind = "income"
```

Consequences:

- Refunds are **not** money in. A refund reduces net spending (§3.1); counting it as income as well would double-count it.
- Transfers in are **not** money in. Moving money between the user's own accounts is not earning.
- Unknown credits are **not** money in until the user reviews them and assigns `kind: "income"`.

### 4.2 Net cash flow

```text
Net cash flow = Money in − Net spending
```

A negative net cash flow is a valid, displayable result. It is shown plainly, without moral language.

Net cash flow is **hidden** — not shown as zero — when the incomplete-income condition in §6 holds.

### 4.3 Savings rate

```text
Savings rate = (included income − net spending) / included income
```

- **Savings rate is undefined when included income is zero, or when the user marks the imported income data as incomplete.** In those cases the card is hidden with an explanation; it is never rendered as `0%`.
- **A negative savings rate is allowed and must be displayed honestly.** Spending more than income in a period is a real result, not an error state.
- Savings rate is never clamped to a 0–100% range.

### 4.4 Budget remaining

```text
Budget remaining = budget limit − budget-period net spending
```

- Applies to the overall monthly limit and, independently and identically, to each category limit against that category's net spending.
- The "budget period" is the budget plan's month (`YYYY-MM`), not the user's currently selected view range. A user browsing "last 90 days" does not change what a monthly budget measures.
- A negative budget remaining (over plan) is a valid, displayable result.
- When no limit is set, budget remaining is **undefined and hidden**, not zero.
- **Rollover is off in v1.0.** An unspent balance never carries into the next month, and no calculation may imply that it does.

### 4.5 Spending pace

The pace indicator compares elapsed time to spend:

```text
Elapsed fraction = days elapsed in budget month / total days in budget month
Spent fraction   = budget-period net spending / budget limit
Projected spend  = budget-period net spending / elapsed fraction
```

- `days elapsed` counts the current day as elapsed; for a month already complete, elapsed fraction is 1.
- Pace is only computed for the **current, in-progress** month. For a past month, the actual result is shown instead of a projection.
- Projection is undefined when elapsed fraction is 0 or the limit is unset.
- Messages follow the neutral phrasing in [`product-spec.md`](./product-spec.md) §8.5 ("You have used 62% of your Dining budget with 48% of the month elapsed"). Avoid moral language such as "bad spending" or "wasteful."

## 5. Refunds

### 5.1 Policy

**When possible, a refund inherits the matched purchase's merchant and category and reduces net spending inside the selected period. If a refund cannot be matched, the user reviews its category.**

**The dashboard must allow inspection of both gross outflow and refunds even when the main card shows net spending.** Net spending is the headline; gross outflow and total refunds must remain available for that period so the netting is never opaque.

```text
Gross outflow = included purchase/fee/cash debits
Total refunds = included refunds
Net spending  = Gross outflow − Total refunds
```

### 5.2 Deterministic matching rule

Matching is a **one-to-one, deterministic** pass so results never depend on evaluation order:

A refund `R` matches an unmatched purchase `P` when all of the following hold:

1. Same `accountId`.
2. Same `merchantNormalized`.
3. `P.direction = "debit"`, `P.kind = "purchase"`, `R.direction = "credit"`, `R.kind = "refund"`.
4. `R.amountCents ≤ P.amountCents` (full or partial refund).
5. `P.postedDate ≤ R.postedDate` and the gap is within the **match window of 120 days**.

Among the candidates, the match is the purchase with the **latest `postedDate` at or before the refund**; ties break by the **largest `amountCents`**, then by the lowest `originalRow`. Each purchase can absorb at most one refund match; each refund matches at most one purchase.

- A matched refund inherits the purchase's `merchantNormalized` and `categoryId` unless the user has explicitly set them.
- An **unmatched refund** keeps `kind: "refund"`, still reduces net spending, and is routed to the review queue for category confirmation. It is never dropped and never converted to income.
- Matching affects attribution (which category the refund reduces), **not** whether the refund counts. A refund always reduces net spending.

### 5.3 Cross-period refunds

A refund reduces net spending **in the period in which the refund posted**, not the period of the original purchase. Restating a closed month would silently change a number the user has already seen.

Consequence: a period can show a negative net spending figure for a category — for example a January purchase refunded in February leaves February's category total negative. That is displayed honestly, with the offsetting transactions reachable by drill-down.

## 6. Data-completeness gates

Calculations must refuse to produce misleading precision. These gates are binding on the selector layer, not merely on the UI:

| Gate | Condition | Effect |
| --- | --- | --- |
| **Incomplete income** | No `kind: "income"` transactions in the period (`no-income-data`), the user confirmed income data incomplete (`income-data-incomplete`), or completeness was never confirmed (`income-completeness-unconfirmed`) — see §14.1 | Money in, net cash flow, and savings rate are hidden with an explanation naming which of the three applies |
| **Partial month** | The selected month is not fully covered by imported data **for every account in scope** (§14.11) | Month-over-month percentages are suppressed; averages are relabeled per §7 |
| **Insufficient history** | Fewer than two complete calendar months | Comparison and "unusual purchase" outputs are withheld |
| **Unreviewed credits** | Credits still at `kind: "unknown"` | Excluded from both spending and income; a review prompt is shown |

Detection conditions for these warnings are defined in [`data-methodology.md`](./data-methodology.md) §6; this document defines what the calculation layer does about them.

**The budget must still work if no income data is imported.** In that case cash-flow and savings-rate claims are hidden and the product focuses on spending limits.

## 7. Monthly averages

- **Default monthly averages use complete calendar months only.**
- **If the user explicitly selects a custom range, the result is labeled a selected-period average.**
- **Never silently treat a partial month as complete.**

```text
Monthly average (default) = Σ net spending over complete calendar months / count of complete calendar months
Selected-period average   = Σ net spending over the selected range / count of periods in that range
```

When zero complete calendar months exist, the monthly-average card is hidden with an explanation rather than computed from a partial month.

## 8. Double-counting: checking and credit-card imports

**Checking and credit-card imports must not double count payments.** ([`product-spec.md`](./product-spec.md) §10.2)

The mechanism is exclusion by kind:

- A purchase appears once, on the credit-card account, as `kind: "purchase"` → counted in net spending.
- The payment from checking to the card appears as `kind: "payment"` on checking and, if present in the card export, as `kind: "payment"` (a credit) on the card → **both excluded** from net spending.
- Transfers between the user's own accounts appear on both sides as `kind: "transfer"` → both excluded.

Therefore money spent is counted where it was spent, and money moved is never counted as spending or as income. Classification of `payment` and `transfer` kinds is defined in [`category-rules.md`](./category-rules.md).

When only one side of a payment pair has been imported, the **single account** data-quality warning ([`data-methodology.md`](./data-methodology.md) §6) qualifies cash-flow claims.

## 9. Precision and rounding

- All sums, differences, and comparisons occur in **integer cents**. There is no intermediate rounding inside an aggregation.
- Division-producing values (savings rate, budget percentage, elapsed and spent fractions, pace projections) are computed from integer-cent inputs and rounded **only at the point of display**.
- Display rounding: currency to whole cents; percentages to **one decimal place**; projected overspend amounts to the nearest cent.
- Rounded display values are never fed back into a further calculation.
- **Integer-cent breakdowns reconcile exactly.** Category, account, and time-bucket amounts each sum to net spending with no difference, and `gross outflow − refunds = net spending`. There is no generic cent residual, and no field exists in which one could be reported: a mismatch is a defect, not a disclosure.
- **A truncated visual carries an explicit `Other` amount bucket.** Where a chart shows only a top-N, the remaining cents are gathered into a named `Other` entry so the visible chart is itself exact. That is a real bucket with real transactions behind it, not a rounding residual.
- **Percentage display rounding may prevent displayed percentages from totalling exactly 100%.** That is disclosed in copy. It never changes a cent total, and the difference is never distributed across the parts to force the display to add up.

## 10. Overview summary cards — canonical definitions

| Card | Definition | Hidden when |
| --- | --- | --- |
| **Net spending** | §3 / §4 | Never (0 is a valid result) |
| **Money in** | §4.1 | Incomplete-income gate (§6) |
| **Net cash flow** | §4.2 | Incomplete-income gate (§6) |
| **Budget remaining** | §4.4 | No limit set for the budget month |
| **Savings rate** | §4.3 — shown only "when valid income data exists" | Income = 0, or income marked incomplete |
| **Largest category** | Category with the greatest net spending in the period | No included spending in the period |
| **Possible recurring monthly cost** | Σ monthly-equivalent cost of confirmed and likely recurring series, per [`data-methodology.md`](./data-methodology.md) §5.5 | No detected series |
| **Transactions analyzed** | Count of included transactions in the period | Never |

"Possible" is load-bearing in the recurring card's label: recurring series are suggestions, not facts.

## 11. Test obligations

These must exist as unit tests over the fixtures before any chart is built:

- Transfers and card payments are excluded by default.
- Refunds reduce net spending correctly, including partial and unmatched refunds.
- Cross-period refunds land in the refund's period (§5.3).
- Checking + credit-card fixtures do not double count payments (§8).
- Savings rate is undefined at zero income and negative when spending exceeds income.
- Budget remaining is negative when over plan and hidden when no limit exists.
- Monthly averages use complete months only; custom ranges are labeled as selected-period averages.
- Every dashboard value matches this contract — cards, charts, and tables reconcile exactly under every test fixture.
- Partial-month and incomplete-income warnings appear when required.

## 12. Decisions recorded in Phase 0

The master plan states the requirement; this document records the specific mechanism chosen. Revisions belong here, not in code.

1. **"Money in" ≡ "included income."** The card label and the formula term name the same selector (§4.1).
2. **Refund matching rule and 120-day match window**, including the deterministic tie-break order (§5.2). The master plan requires matching "when possible" but does not fix the window; this is the chosen value.
3. **Refunds attribute to the refund's period**, not the original purchase's period (§5.3).
4. **Unknown debits are excluded** from net spending and surfaced for review, mirroring the master plan's explicit treatment of unknown credits (§3.3).
5. **Rounding policy:** integer cents throughout, display-only rounding, percentages to one decimal (§9).
6. **Pace formula and its undefined cases** (§4.5).
7. **Budget period is the plan's month**, independent of the user's selected view range (§4.4).

## 13. Open product decisions

None. Per the Phase 0 exit condition, there are no unresolved decisions about sign conventions, inclusion/exclusion, refunds, duplicate handling, or budget formulas. The 120-day refund window (§12 item 2) is the value most likely to be re-examined once real fixture behavior is observed in Phase 5.

## 14. Decisions recorded in Phase 5B-1

Phase 5 implements §1–§11 as pure selectors. Building them forced nine questions the Phase 0 text left underdetermined. Each is settled here, before the corresponding code, so the mechanism lives in this document rather than in a function nobody re-reads.

### 14.1 (D1) Income completeness is tri-state

The `incomeDataComplete` setting has three states, not two. A **missing** setting is not the same as a confirmed `true`.

| State | Meaning | Money in / net cash flow / savings rate | `incomeCompletenessWarning` |
| --- | --- | --- | --- |
| `true` | The user confirmed imported income data is complete | Available | `null` |
| `false` | The user confirmed it is incomplete | Unavailable, reason `income-data-incomplete` | `"income-data-incomplete"` |
| absent | Completeness has never been confirmed | Unavailable, reason `income-completeness-unconfirmed` | `"income-completeness-unconfirmed"` |

The two unavailable reasons are distinct and must not be collapsed: one is a statement the user made, the other is the absence of one. Net spending is unaffected in every state, because it does not read income.

**`incomeCompletenessWarning` is the authoritative field for new UI.** The pre-existing boolean `incompleteIncome` is retained for compatibility, but it is strictly narrower: it is true for *both* non-confirmed states and therefore cannot distinguish them. No interface may infer the distinction from that boolean.

There are exactly two income-completeness reasons — `income-data-incomplete` and `income-completeness-unconfirmed`. No alias or competing identifier for either exists anywhere in the codebase.

This supersedes any reading of §6 that would treat an unset flag as a confirmation. Defaulting absence to "complete" would let the product publish a savings rate the user never vouched for.

### 14.2 (D2) Statement coverage alone determines month completeness

A calendar month is complete **only** when confirmed statement ranges collectively cover every calendar date in that month. Month completeness is never inferred from the earliest and latest transaction dates (§6, `data-methodology.md` §6).

Absent range metadata means completeness is **unknown**, which is treated as not complete. Unknown is never promoted to complete.

### 14.3 (D3) Coverage unions, and what counts as a committed session

Ranges are unioned before completeness is tested:

- Only successfully committed import sessions contribute.
- Both endpoints are required; a session missing either contributes nothing.
- A malformed or reversed range (`start > end`, or a non-calendar date) contributes nothing and is counted as a data-quality signal.
- Endpoints are inclusive on both sides.
- Overlapping and adjacent ranges merge into one span; overlap is never counted twice.
- Month ends, year boundaries, and leap days are handled by calendar arithmetic, not by fixed day counts.

**Mapping to this repository's real state.** `ImportSession` has no `status` field, and there is no draft, failed, or canceled session record. `commitImportSession` (`src/db/repositories/transactions.ts`) writes the session row and its transactions inside a single Dexie `rw` transaction, and `data-methodology.md` §2.2 requires that commit to complete fully or leave the workspace unchanged. **A session row's presence in the `importSessions` table is therefore exactly equivalent to "successfully committed."** No additional status check exists or is needed; a rolled-back import leaves no row behind to establish coverage.

### 14.4 (D4) Unknown debits are reported alongside unknown credits

Both unknown credits and unknown debits stay out of every financial aggregate until reviewed (§3.3). Data-quality output must report them **separately**. An unknown debit understates spending, which is the opposite failure from an unknown credit understating income, and a single combined count would hide which way a total is wrong.

`DataQualityFlags` gains `unreviewedDebits` alongside the existing `unreviewedCredits`. The extension is additive; no existing field changes meaning.

### 14.5 (D5) Budget and recurring calculations remain Phase 6

Phase 5 implements no budget or recurring arithmetic. `budgetProgress` is **not** part of the Phase 5 selector surface, and `BudgetProgress` remains an unimplemented Phase 6 contract type. Budget remaining, budget versus actual, possible recurring monthly cost, recurring detection, forecasts, and generalized insights are all out of scope.

A future dashboard may keep an explanatory unavailable card shell for these, but no Phase 6 quantity may be computed or presented as zero.

### 14.6 (D6) Exact reconciliation, with no residual escape hatch

For full, untruncated breakdowns these equalities hold **exactly**, in integer cents:

```text
Σ category amounts   = net spending
Σ account amounts    = net spending
Σ time-bucket amounts = net spending
gross outflow − refunds = net spending
```

There is no general `residualCents` field, because a residual field is a licence for the sums to disagree. A mismatch is a defect, surfaced as a typed reconciliation failure, not absorbed as metadata.

§9 states the same three rules normatively — exact integer-cent reconciliation, an explicit `Other` bucket for truncated visuals, and percentage-only display drift. This section records why they were settled; §9 governs. The two do not disagree, and no superseded clause remains in force.

### 14.7 (D7) Data-quality status is a required Phase 5 output

The Overview's missing data-quality region is a genuine gap. Phase 5B-1 implements the complete data-quality **selector** covering every warning in §6 plus §14.1 and §14.4. The UI region is built in a later wave.

### 14.8 (D8) Month comparison requires two adjacent complete months

A current-versus-prior comparison is available only when **both** hold:

1. The selected period is exactly one complete calendar month.
2. The **immediately preceding** calendar month is also complete.

An incomplete prior month is never skipped in order to compare against an older one — that would silently change which months a percentage describes. Any other selected range yields an unavailable `Measured` result with a specific reason.

### 14.9 (D9) Calendar dates are not instants

Stored `YYYY-MM-DD` values are calendar dates with no time and no zone (`data-methodology.md` §3.3). Period arithmetic operates on the calendar directly and must produce identical results in every local time zone.

Constructs that reinterpret a date string as an instant — notably an unguarded `new Date('YYYY-MM-DD')`, which parses as UTC midnight and then renders in local time — are forbidden in the calculation layer. Date bounds are inclusive at both ends. Correctness is tested at month boundaries, year boundaries, February 29 2028, and DST-adjacent dates.

### 14.10 User exclusion and income

§2 defines **Included** as `excludedFromSpending === false` *and* a kind eligible for the total being computed, and §3.3 states that a transaction with `excludedFromSpending === true` is out **regardless of kind**. §4.1 builds money in from *included* credits. Read together, an income row carrying the user-exclusion flag is therefore **not** money in.

That reading is retained. It is also nearly unreachable through the product: `userExclusionApplies` returns `false` for `income`, so the review interface never offers the control, and `reconcileExclusionForKind` clears the flag on any change to `income`. Such a row can only arrive through CSV import or a restored backup.

Because the suppression is invisible in the totals themselves, it must not be silent: `DataQualityFlags` gains **`excludedIncomeTransactionCount`**, an integer count of income transactions in the selected population suppressed from money in by the exclusion contract. Zero is a valid count.

The field is deliberately **not** named for a user action. `excludedFromSpending` can arrive through CSV import or backup restoration as easily as through the review interface, and the data model stores no provenance for it — there is no `exclusionSource` field, and `exclusionReason` is free-form display text, not evidence. Naming the count after a user would assert an attribution the schema cannot prove. The contract's arithmetic is unchanged; the condition is merely made visible.

### 14.11 (D10) Statement coverage is account-scoped

Coverage is evaluated **per account**, never as one global union. Ranges from different accounts must never be stitched together to manufacture completeness.

Given:

```text
Account A coverage: January 1–15
Account B coverage: January 16–31
```

the global union covers January and **neither account does**. January is therefore **not** complete. A figure spanning both accounts would otherwise claim a whole month while missing half of each account's activity.

**The rule.** A calendar month is complete for a dashboard calculation only when **every account in scope independently** has that month fully covered by its own merged statement ranges.

**Scope.**

- With an explicit account filter, scope is exactly the filtered accounts. An explicit selection is respected even if an account is archived — the user asked for it by name.
- With no account filter, scope is every **non-archived** account in the workspace. `Account.archived` is the domain's existing activity state (`listActiveAccounts`); no new activity concept is invented.
- **Category filters never change scope.** Filtering to Dining does not reduce which accounts must be covered, because a missing statement still hides Dining rows.
- **An empty scope is never complete.** A workspace with no accounts in scope has no evidence of coverage, and vacuous truth must not be reported as a measured month.
- The current and immediately preceding comparison months must **each** satisfy this rule for the same scope (§14.8).

**Account identity.** `ImportSession.accountIds` is the sole source. It is explicit and lossless: `buildImportSession` derives it from every accepted row's `accountId` plus every account the session created, commit validation rejects any transaction whose account is not declared (`session-reference-mismatch`), and backup validation rejects unknown account references. Account identity is never inferred from transaction dates, merchant text, file names, or ordering.

**Identity is lossless; a shared range is not per-account evidence.** These are two different claims and only the first holds unconditionally.

`accountIds` reliably answers *which accounts a session touched*. It does not establish *what period each of those accounts' statements covered*, because a session stores one `statementRangeStart`/`statementRangeEnd` pair no matter how many accounts it names — the wizard confirms one statement period per import, not one per file. An import combining a checking statement for January 1–31 with a card statement for January 12–31 stores a single range, and nothing in the schema records which account each endpoint came from.

**A session-level range naming exactly one unique account is usable per-account evidence.** There is only one account it can describe, so the attribution is unambiguous.

**A session-level range naming more than one unique account is insufficient per-account coverage evidence under the current schema.** Such a range is *ambiguous* and is excluded from completeness entirely. It establishes coverage for none of the accounts it names, cannot complete a month for any of them, cannot fill a gap left by another session, and cannot enable a current-month or prior-month comparison.

This is deliberately conservative. The selector must never declare a month complete on evidence it knows to be ambiguous, and the two failure directions are not symmetric: **false incompleteness withholds a comparison the user can still reach by importing per-account statements, while false completeness publishes a financial comparison built on a period half the data may not cover.** Until a migration exists, the first is preferable.

**A future schema may store ranges keyed by `(importSessionId, accountId)`.** That is the smallest correction that would make a multi-account import usable per account, and it would retire this rule rather than amend it. It is a schema change and is out of scope for Phase 5.

**Ambiguity is reported, never silent.** `DataQualityFlags` carries `ambiguousMultiAccountStatementRangeCount` and `accountsWithAmbiguousStatementCoverage` so the interface can explain why a month reads as incomplete. The condition describes stored data granularity, not a mistake anyone made, and must not be worded as user error.

**Normalization and precedence.** Each range's `accountIds` is deduplicated and sorted before evaluation, so `["acct-a", "acct-a"]` is one unique account and remains usable evidence. Every range is then classified into **exactly one** bucket, in this order, and counted once:

1. **Missing endpoint** — either endpoint absent or empty → `sessionsMissingStatementRange`.
2. **Malformed dates** — a non-calendar date or `start > end` → `sessionsWithMalformedStatementRange`.
3. **Unattributed** — zero unique account ids → `sessionsWithUnattributedStatementRange`.
4. **Ambiguous** — more than one unique account id → `ambiguousMultiAccountStatementRangeCount`, and its accounts join `accountsWithAmbiguousStatementCoverage`.
5. **Usable** — exactly one unique account id and valid dates → establishes coverage for that account.

**Date validation takes precedence over ambiguity.** A range whose dates are unusable carries no period at all, so its account attribution is moot; it is counted as malformed only and never also as ambiguous. This ordering is what keeps the counts non-overlapping. None of buckets 1–4 establishes any coverage.

Commit validation makes an unattributed range unreachable in persisted data — a session names every account its rows landed in — but the selector is a pure function over supplied input and must fail safely on malformed input regardless of what the writer guarantees.
