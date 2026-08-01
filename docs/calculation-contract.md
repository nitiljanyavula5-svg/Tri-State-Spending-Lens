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
| **Incomplete income** | No `kind: "income"` transactions in the period, or the user marked income data incomplete | Money in, net cash flow, and savings rate are hidden with an explanation |
| **Partial month** | The selected month is not fully covered by imported data | Month-over-month percentages are suppressed; averages are relabeled per §7 |
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
- Because rounding happens only at display, a rounded parts list may not visibly sum to a rounded total. Where a chart shows parts and a total together, the **total is the sum of the unrounded parts**, and any residual is disclosed rather than distributed silently.

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
