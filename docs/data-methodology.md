# Data Methodology — Tri-State Spending Lens

**Status:** Phase 0 foundation document — treated as a requirement, not marketing copy.
**Source:** Split from `Tri-State-Spending-Lens-Master-Plan.md` (revision July 31, 2026), primarily §7.2 (Import wizard), §7.7 (Recurring expenses), §7.8 (evidence rules), §7.9 (Tri-State context sourcing), §9 (Data model), §10 (Recurring logic), §11 (Public-data pipeline), and the data-integrity items in §15. This document does not introduce, weaken, or reinterpret any requirement from the master plan.
**Companion documents:** [`product-spec.md`](./product-spec.md) · [`privacy-model.md`](./privacy-model.md) · [`calculation-contract.md`](./calculation-contract.md) · [`category-rules.md`](./category-rules.md) · [`threat-model.md`](./threat-model.md)

## 1. Scope and ownership boundaries

This document owns **how raw CSV rows become trustworthy normalized transactions**, and **how public economic data is produced separately from personal data**.

To prevent two documents from defining the same rule differently, ownership is fixed as follows:

| Concern | Owned by |
| --- | --- |
| Import sessions, atomicity, rollback | this document |
| Field-level normalization (date, money, direction, description) | this document |
| Row rejection rules | this document |
| Duplicate detection and fingerprints | this document |
| Recurring-series detection and confidence | this document |
| Data-quality warnings | this document |
| Public BEA/BLS pipeline and source metadata | this document |
| Category list, transaction kinds, rule precedence, **merchant-string normalization and aliases** | [`category-rules.md`](./category-rules.md) |
| Net spending, money in, cash flow, savings rate, refunds, averages, budget remaining | [`calculation-contract.md`](./calculation-contract.md) |
| Storage location, network boundary, deletion, backup | [`privacy-model.md`](./privacy-model.md) |
| Hostile input handling and limits enforcement | [`threat-model.md`](./threat-model.md) |

**Non-negotiable framing:** normalization happens entirely in the browser (see [`privacy-model.md`](./privacy-model.md) §2). Nothing described in sections 2–7 of this document may involve a network request.

## 2. Import sessions

### 2.1 Definition

Every import is a single atomic **`ImportSession`**. It commits fully or not at all. A partially written import is a defect, not an acceptable outcome.

```ts
interface ImportSession {
  id: string;
  importedAt: string;
  sourceFileNames: string[];
  accountIds: string[];
  mappingVersion: number;
  rowCount: number;
  acceptedCount: number;
  rejectedCount: number;
  duplicateCandidateCount: number;
  warnings: string[];
}
```

Every `Transaction` carries the `importSessionId` that created it and the `originalRow` number it came from. This is what makes rollback and auditability possible.

### 2.2 Atomic commit and rollback

- Parsing, normalization, classification, and duplicate analysis all complete **before** anything is written to IndexedDB.
- The commit writes the `ImportSession` record and all accepted `Transaction` rows in a single IndexedDB transaction.
- If any write fails, the whole transaction aborts and the workspace is unchanged.
- An import session can be rolled back later from import history. **Rolling back a session removes only that session's transactions** — never rows created by a different session, and never user-created merchant rules, budgets, or settings.
- Rollback must report what it removed (count and date range) before and after it runs.

### 2.3 Import limits

These limits are explicit and easy to revise, and must be shown to the user in step 1 of the wizard:

| Limit | Value (v1.0) |
| --- | --- |
| File type | `.csv` only |
| Maximum file size | 10 MB per file |
| Maximum rows | 100,000 per import session |
| Currency | USD only |

Enforcement behavior for oversized, over-row-count, and malformed input is defined in [`threat-model.md`](./threat-model.md). Limits are checked **before** full parsing, not after.

### 2.4 Wizard stages

The wizard is six steps (see [`product-spec.md`](./product-spec.md) §8.2 for the user-facing description). The data responsibilities of each stage are:

1. **Choose files** — enforce type/size limits; show the privacy reminder.
2. **Identify format** — detect delimiter, encoding, header row, and likely layout. Detection is a *suggestion the user can override*, never a silent decision.
3. **Map columns** — map date, description, amount **or** debit/credit, and optional account and type columns.
4. **Confirm conventions** — the user confirms sign direction, date format, account label/type, and statement range. **The app must show how positive and negative values will be interpreted before commit.**
5. **Review preview** — show normalized rows and every warning before saving.
6. **Import Health Report** — summarize accepted, rejected, duplicate-candidate, questionable, and uncategorized rows.

Column mappings may be saved locally as optional presets. **A preset must never identify a bank unless the user names it.** Presets contain column positions and convention choices only — never transaction content.

Parsing and normalization run in a **Web Worker** so the UI thread stays responsive ([MDN: Using Web Workers](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers)). A 100,000-row import must not freeze the main thread.

### 2.5 Supported source layouts

```text
Date | Description | Amount
```

```text
Date | Description | Debit | Credit
```

Both must import correctly. Additional columns may be present and mapped optionally (account, type/memo); unmapped columns are ignored, never guessed at.

## 3. Transaction normalization

### 3.1 Target shape

```ts
type TransactionKind =
  | "purchase"
  | "refund"
  | "income"
  | "transfer"
  | "payment"
  | "fee"
  | "cash_withdrawal"
  | "unknown";

type ClassificationConfidence = "high" | "medium" | "low" | "none";

interface Transaction {
  id: string;
  fingerprint: string;
  importSessionId: string;
  originalRow: number;
  accountId: string;

  postedDate: string;
  descriptionRaw: string;
  merchantNormalized: string;

  amountCents: number;
  direction: "debit" | "credit";
  kind: TransactionKind;

  categoryId: string;
  categorySource: "user_rule" | "merchant_rule" | "keyword_rule" | "user" | "uncategorized";
  classificationConfidence: ClassificationConfidence;

  essentiality?: "essential" | "discretionary";
  variability?: "fixed" | "variable";
  tags: string[];
  note?: string;

  excludedFromSpending: boolean;
  exclusionReason?: string;
  createdAt: string;
  updatedAt: string;
}
```

Supporting records — `Account`, `MerchantRule`, `BudgetPlan`, `BudgetCategoryTarget`, `RecurringSeries`, `UserEdit`, `AppSetting`, and `SchemaMigration` — are defined in the master plan §9 and carried into the Dexie schema in Phase 2. **`UserEdit` and `MerchantRule` are stored distinctly enough that re-running a better normalization algorithm does not erase manual user decisions.**

### 3.2 Determinism requirement

Normalization is a **pure pipeline**: the same input file, the same column mapping, and the same convention choices must produce byte-identical normalized output, every time, on every machine.

Consequences that are binding on the implementation:

- No `Date.now()`, `Math.random()`, locale-dependent parsing, or timezone conversion inside the pipeline.
- Generated `id` values are random (see [`threat-model.md`](./threat-model.md)) and are therefore **excluded** from determinism comparisons; `fingerprint`, `postedDate`, `amountCents`, `direction`, `descriptionRaw`, `merchantNormalized`, `kind`, and `categoryId` are **included**.
- Reimporting the same fixture must produce identical normalized results (MVP acceptance criterion, [`product-spec.md`](./product-spec.md) §10.1).

### 3.3 Date normalization

- Stored as an **ISO calendar date, `YYYY-MM-DD`**, with no time component and no timezone. Bank CSVs generally provide posting dates without reliable time zones, so inventing one would be false precision.
- The date format is **confirmed by the user in wizard step 4**, not silently inferred. Detection proposes; the user confirms.
- Both US (`M/D/YYYY`, `MM/DD/YYYY`) and ISO (`YYYY-MM-DD`) inputs must normalize to the same stored value. Two files describing the same transactions in different date formats must produce identical normalized rows.
- Ambiguous values (for example `03/04/2026`) resolve using the **confirmed format for the whole file**, never per-row guessing. If the file contains rows that are impossible under the confirmed format (for example a `13` in the month position), the wizard must surface this as a format conflict before commit.
- A date that does not exist on the calendar (`2026-02-30`), is unparseable, or is empty is **rejected**, never coerced.
- All period arithmetic (months, weeks, ranges) operates on these calendar dates directly. Week start comes from the user's preference setting.

### 3.4 Money normalization

- Money is always stored as **integer cents** (`amountCents`). Floating-point dollars are never persisted and never used in aggregation.
- `amountCents` is stored as a **non-negative magnitude**; the sign lives in `direction` (`"debit"` or `"credit"`). This keeps sign conventions in exactly one place.
- Accepted input decorations that must be handled rather than rejected: leading/trailing whitespace, `$`, thousands separators, and parenthesized negatives (`(12.34)` = negative).
- Values with more than two decimal places, non-numeric text (`N/A`, `--`, empty), or a currency symbol other than USD are **rejected**, never silently converted to zero.

**Signed single-amount column.** The user confirms which sign means money leaving the account. Under the standard convention, negative → `direction: "debit"`, positive → `direction: "credit"`. The wizard must display this mapping with concrete example rows from the user's own file before commit.

**Separate debit and credit columns.** Exactly one of the two cells must carry a value:

| Debit cell | Credit cell | Result |
| --- | --- | --- |
| value | empty | `direction: "debit"` |
| empty | value | `direction: "credit"` |
| value | value | **rejected** — ambiguous row |
| empty | empty | **rejected** — no amount |

A value of exactly `0.00` is accepted and preserved (banks do emit zero-amount adjustments), but it is reported in the Import Health Report as questionable. Because zero carries no sign, a zero-amount row is assigned `direction: "debit"` by convention; it contributes nothing to any total either way, and the convention exists only so the field is never null.

### 3.5 Direction, kind, and default classification

- **Debits default to `kind: "purchase"`.** This is the ordinary case and it is what makes net spending meaningful immediately after import.
- **Credits default to `kind: "unknown"`.** A credit may be income, a refund, a transfer in, or a card-payment credit, and the product must not guess. Unknown credits are excluded from spending totals until reviewed (see [`calculation-contract.md`](./calculation-contract.md)) and appear in the review queue.
- Onboarding's optional question "whether credits in the file represent income/refunds" only sets a **suggested** default for the review queue; it never bulk-assigns a kind without the user seeing the rows.
- Rules may override these defaults. Rule precedence is defined in [`category-rules.md`](./category-rules.md) and is the single source of truth for classification order.

### 3.6 Description handling

- `descriptionRaw` preserves the original cell content **permanently and unmodified**, apart from the safety limits in [`threat-model.md`](./threat-model.md) (length cap, control-character neutralization). The original description remains visible to the user forever.
- `merchantNormalized` is derived. Its rules live in [`category-rules.md`](./category-rules.md).
- `originalRow` preserves the source row number for auditability.
- Descriptions are rendered as **text, never HTML** (see [`threat-model.md`](./threat-model.md)).

### 3.7 Row rejection

A row is rejected — not imported, not zero-filled, not repaired — when:

- the date is missing, unparseable, or not a real calendar date;
- the amount is missing, non-numeric, or ambiguous per §3.4;
- required mapped columns are absent for that row (ragged row);
- the row exceeds a field-length or field-count limit from [`threat-model.md`](./threat-model.md).

Rejection requirements:

- Every rejected row is **counted and explained** in the Import Health Report, with its original row number and a specific reason.
- Rejections never fail the whole import; they reduce `acceptedCount` and raise `rejectedCount`.
- An empty description is **accepted** (it is not an integrity failure) but is flagged as questionable and routed to the review queue.
- The Import Health Report shows accepted / rejected / duplicate-candidate / questionable / uncategorized counts. These five numbers must reconcile against `rowCount`.

## 4. Duplicate handling

### 4.1 Principle

Duplicate detection is a **suggestion mechanism, not a deletion mechanism**. Two identical purchases on the same day can be legitimate. The pipeline surfaces candidates and asks; it never silently drops a row the user might have genuinely spent.

**Rollback, not deduplication, is the recovery path for a bad import.**

### 4.2 Fingerprint

The fingerprint is the SHA-256 of a **length-prefixed canonical string** built from these seven fields, in exactly this order:

| # | Field | Source |
| --- | --- | --- |
| 1 | `fingerprintVersion` | the constant `fp-v1` |
| 2 | `accountId` | the target account |
| 3 | `postedDate` | normalized `YYYY-MM-DD` |
| 4 | `direction` | `debit` or `credit` |
| 5 | `amountCents` | unsigned integer magnitude, decimal digits |
| 6 | `descriptionCanonical` | canonicalized description (below) |
| 7 | `occurrenceIndex` | repeated-occurrence index (§4.3) |

Each field is serialized as `<byteLength>:<value>` and the seven are concatenated with no separator:

```text
canonical  = join( for each field: `${field.length}:${field}` )
fingerprint = SHA-256(canonical)
```

**Why length-prefixing rather than a delimiter.** A delimiter-joined encoding lets a description containing that delimiter shift the field boundaries, so two genuinely different rows can serialize identically. Length prefixes make the encoding unambiguous for any content whatsoever, including descriptions that contain `:`, `|`, or newlines.

- `descriptionCanonical` is a **stable, version-pinned canonical form** of `descriptionRaw`: collapse whitespace, strip control/zero-width/bidi characters, trim, uppercase. It deliberately does **not** use `merchantNormalized`, because the alias table is expected to improve over time and fingerprints must remain stable across those improvements.
- `fingerprintVersion` is part of the hashed input so a future change to canonicalization is an explicit, migrated event rather than a silent mass re-identification.
- SHA-256 here is a local content fingerprint. It is **not** a claim of encryption (see [`threat-model.md`](./threat-model.md)).
- **A fingerprint nominates a duplicate *candidate*; it never proves two transactions are the same.** Two rows can agree on all seven fields and still be distinct real-world events, which is why §4.1 makes detection a suggestion mechanism and why nothing is ever removed automatically.

### 4.3 Occurrence index and candidate groups

The **occurrence index** is field 7 of the fingerprint itself, not a separate grouping key.

**How it is assigned.** Rows are grouped by fields 1–6 — everything except the index. Within each group, rows receive `0, 1, 2 …` **in source order** (file order, then row order for a multi-file session). Assignment therefore depends only on the ordered input, never on wall-clock time, iteration order, or existing workspace contents.

**Why legitimate identical purchases stay distinct.** Two identical same-day coffees in one file land in the same group and become occurrence `0` and occurrence `1`. Because the index is hashed, they produce **different fingerprints**, so neither can be mistaken for the other and neither can absorb the other. Three identical transit fares become `0`, `1`, `2`. Nothing collapses.

**Why reprocessing the same file is stable.** Assignment is a pure function of the ordered rows, so the same fixture processed twice yields the same indexes, hence the same fingerprints. That is what makes an exact reimport recognizable: every incoming fingerprint already exists in the workspace, so every row is flagged as a candidate. A file re-downloaded with extra rows appended matches on its overlapping prefix and presents only the genuinely new rows as new.

Candidate detection then reduces to a fingerprint lookup, in three scopes:

| Scope | Meaning |
| --- | --- |
| Within one file | Not applicable — the occurrence index makes intra-file rows distinct by construction |
| Across staged files | The same fingerprint appears in two files selected for the same session |
| Against the workspace | The fingerprint already exists in IndexedDB from an earlier import |

Each candidate carries its reason and its source scope so the user can tell "this repeats inside the files you just chose" from "you already imported this".

This produces the required behavior for all three scenarios named in the master plan:

- **Legitimate identical same-day purchases** in a first import are imported in full, with no prompt, because their fingerprints differ.
- **Exact duplicate file reimport** flags every row as a duplicate candidate.
- **Partially overlapping statement re-download** flags the overlap and presents the remainder as new.

**Nothing is ever removed automatically.** Candidates are surfaced with an explicit keep-or-exclude decision, individually or as a group, and the safe default preserves data. Excluding a candidate is a *user decision* recorded separately from an invalid-row rejection (§3.7), and the two are counted separately in the Import Health Report.

### 4.4 User-facing rules

- Duplicate candidates are presented in the preview and in the Import Health Report, grouped, with dates, amounts, and descriptions visible.
- Ambiguous groups (any group where `0 < m` and `k > m`) require an explicit user decision; the app must not resolve them silently.
- Duplicate handling affects **only what the incoming session commits**. It never edits or deletes existing rows.
- Duplicate candidates that the user chooses to import are committed normally and are not re-flagged on later passes.

## 5. Recurring detection

### 5.1 A series is a suggestion, not a fact

Every recurring series is a hypothesis presented with its evidence and a confidence label, and it is always correctable by the user.

### 5.2 Detection inputs

Detection considers, per the master plan §7.7:

- same normalized merchant, or a user-created merchant rule that groups them;
- **at least three occurrences when possible**;
- similar amounts within an explainable tolerance;
- weekly, biweekly, monthly, quarterly, or annual cadence;
- date drift for weekends and billing cycles.

Only included, non-transfer, non-payment transactions participate in detection.

### 5.3 Cadence and tolerance defaults

These are the v1.0 starting values. They are **tunable constants that must be documented on `/methodology`**, and each is recorded in §9 as a Phase 0 decision rather than an unexplained magic number.

| Cadence | Nominal interval | Accepted drift |
| --- | --- | --- |
| Weekly | 7 days | ±2 days |
| Biweekly | 14 days | ±3 days |
| Monthly | same day-of-month | ±4 days |
| Quarterly | 3 calendar months | ±7 days |
| Annual | 12 calendar months | ±10 days |

- **Month-length handling:** monthly cadence is computed on calendar months, not fixed 30-day arithmetic, so Jan 31 → Feb 28/29 → Mar 31 remains one monthly series.
- **Amount tolerance:** amounts within **±5% or ±$1.00, whichever is larger**, count as "similar." Utilities and other variable bills routinely exceed this and are handled by the variable-amount path in §5.4.
- **Missed occurrence:** a single gap of one nominal interval does not break a series; it lowers confidence and is shown as a missed/skipped period.

Tests must cover month lengths, weekends, leap years, variable utilities, annual charges, and missed months.

### 5.4 Confidence

Confidence is a **label (high / medium / low), never an unexplained decimal**, derived from four factors:

1. **Occurrence count** — three or more observed charges is the baseline for "high."
2. **Interval consistency** — how tightly the observed gaps cluster around one nominal cadence.
3. **Merchant match quality** — exact normalized-merchant match or a user rule outranks a fuzzy match.
4. **Amount stability** — amounts inside the §5.3 tolerance outrank a wide range.

| Label | Typical basis |
| --- | --- |
| **High** | ≥3 occurrences, consistent interval, exact merchant match, amounts within tolerance |
| **Medium** | 3 occurrences with one weak factor (drifting interval, or a variable amount range) |
| **Low** | 2 occurrences, or ≥3 with two or more weak factors |

No single mathematical threshold is presented as certainty. The Recurring view must show which evidence produced the label and link to the underlying transactions.

### 5.5 Derived fields

- **Typical amount** — median of the series' amounts; a range is shown when amounts vary beyond tolerance.
- **Last charge** — most recent observed occurrence.
- **Expected next charge** — last charge plus the detected nominal cadence, presented as an estimate.
- **Estimated annualized cost** — typical amount × occurrences per year for the detected cadence (weekly 52, biweekly 26, monthly 12, quarterly 4, annual 1). **The detected cadence must drive the multiplier**; a quarterly charge must never be annualized as if monthly.
- **Price-change flag** — raised when the most recent amount differs from the prior stable typical amount by more than the §5.3 tolerance, with both amounts and both dates shown.

### 5.6 User controls and vocabulary

Users can confirm recurring, mark not recurring, merge or split a series, change its category, and exclude it from recurring totals. Every one of these is a persisted `UserEdit` that survives re-detection.

**Do not label every recurring expense a subscription.** Rent, insurance, and utilities are recurring but are not subscriptions. The UI vocabulary is "recurring charge"; "subscription" is reserved for the Subscriptions & Memberships category.

## 6. Data-quality warnings

Analysis must state when it is standing on incomplete data. Warnings appear on the Overview and are reused by Insights ([`product-spec.md`](./product-spec.md) §8.7).

| Warning | Condition | Effect |
| --- | --- | --- |
| **Partial month** | The selected month's imported data does not cover the full calendar month | Month-over-month percentages are suppressed; monthly averages are labeled as selected-period averages ([`calculation-contract.md`](./calculation-contract.md)) |
| **Incomplete income** | No income transactions exist, or the user has marked income data incomplete | Savings rate and net cash flow are hidden, not shown as zero |
| **Unreviewed credits** | Credits still at `kind: "unknown"` | Review prompt; those rows stay out of spending and income totals |
| **Uncategorized share** | A material share of included spending is uncategorized | Category breakdown is annotated so an "Other" spike is not mistaken for behavior |
| **Coverage gap** | A date gap inside the imported range suggests missing statement rows | Trend charts flag the gap rather than drawing through it |
| **Single account** | Only one account is imported while card payments are present | Cash-flow claims are qualified (see double-counting, [`calculation-contract.md`](./calculation-contract.md)) |
| **Rejected rows present** | The session rejected rows | Health Report link persists after import so totals can be reconciled against the source file |
| **Insufficient history** | Fewer than two complete calendar months exist | Comparison and "unusual purchase" insights are withheld |

Minimum-evidence rules are binding: **do not show a month-over-month percentage when either month is incomplete, and do not call a transaction unusual without sufficient comparison history.**

**Month completeness is determined by the confirmed statement range from wizard step 4, not by the earliest and latest transaction dates.** A month in which the user simply spent nothing on the 1st is complete; a month whose statement range starts on the 12th is not. Inferring coverage from transaction dates alone would mark ordinary quiet days as missing data and would raise a false partial-month warning on almost every import.

## 7. Public BEA/BLS data — separate by construction

### 7.1 The separation

Personal data and public economic data never share a pipeline, a store, or a type:

| | Personal transactions | Public economic data |
| --- | --- | --- |
| Origin | User's CSV, in the browser | BEA / BLS, at development time |
| Storage | IndexedDB, mutable | Static JSON in the bundle, read-only |
| Retrieval | Never leaves the device | Never fetched from a visitor's browser |
| Types/selectors | Personal selectors | Separate `EconomicObservation` types and selectors |

**Do not call BEA or BLS from each visitor's browser.** Static economic JSON is served from the app's own origin ([`privacy-model.md`](./privacy-model.md) §4).

The Tri-State Context section is explanatory and **must never silently blend into personal totals**.

### 7.2 Development pipeline

Update scripts in `scripts/update-economic-data/` must:

1. Retrieve official data.
2. Save the raw response in a temporary, **git-ignored** location.
3. Validate expected series, units, geography, periods, and observation counts.
4. Normalize the required observations.
5. Write small versioned JSON snapshots.
6. Write a metadata file with source URLs, retrieval time, release date, checksums, and script version.
7. Run data-contract tests **before** committing snapshots.

Recommended output files:

```text
src/data/economic/
├── bea-pce-state-2024.json
├── bea-real-pce-state-2024.json
├── bea-rpp-state-2024.json
├── bls-ny-metro-cpi.json
├── bls-philadelphia-metro-cpi.json
├── series-registry.json
└── metadata.json
```

The BLS API returns observations but has metadata limitations, so the project keeps an **explicit reviewed registry of series IDs and human-readable labels** (`series-registry.json`) rather than trusting API-supplied labels. ([BLS Public Data API features](https://www.bls.gov/bls/api_features.htm))

**Only synthetic transaction fixtures may enter Git. Raw personal CSV files must never be committed.**

### 7.3 Observation shape

```ts
interface EconomicObservation {
  geographyCode: string;
  geographyLabel: string;
  geographyType: "state" | "metro" | "region" | "nation";
  measureCode: string;
  measureLabel: string;
  categoryCode?: string;
  categoryLabel?: string;
  frequency: "monthly" | "bimonthly" | "annual";
  period: string;
  value: number;
  unit: string;
  sourceName: "BEA" | "BLS";
  sourceSeriesOrTable: string;
  sourceUrl: string;
  releasedAt: string;
  snapshotGeneratedAt: string;
}
```

Periods are monthly or annual strings, **not a bare numeric year**, so a monthly CPI series and an annual PCE series can never be silently compared as if they had the same frequency.

### 7.4 Required source metadata on every chart

Each public-data chart must display:

- Source organization
- Dataset and series/table identifier
- Geography
- Unit
- Frequency
- Observation period
- Release/update date
- Link to the source
- Short limitation note

### 7.5 Current source plan (as of July 31, 2026)

- **BEA state PCE** currently covers 2024; the next scheduled state PCE release is **September 30, 2026**. ([BEA Consumer Spending by State](https://www.bea.gov/data/consumer-spending/state))
- **BEA RPP** provides comparable state and metro price levels; 2024 is the current annual observation. ([BEA Regional Price Parities](https://www.bea.gov/data/prices-inflation/regional-price-parities-state-and-metro-area))
- **BLS metro CPI** for New York–Newark–Jersey City, NY–NJ–PA and Philadelphia–Camden–Wilmington, PA–NJ–DE–MD. ([BLS CPI by metro area](https://www.bls.gov/charts/consumer-price-index/consumer-price-index-by-metro-area.htm))

### 7.6 Interpretation limits that are binding

- **Do not present New Jersey as having a standalone statewide CPI. It does not.** Metro series must be labeled by their actual metro geographies.
- **Do not compare a single user's category share to BEA PCE** as if the definitions and households were equivalent. Category-mix views require a documented crosswalk and a visible limitation note.
- The "What does $100 feel like?" lens uses `$100 × (100 / RPP)` and is an **educational approximation**, not a quote for a specific basket or city. The interface must explain that state RPP includes broad consumption prices and housing rents.

## 8. Testing obligations created by this document

- Fixture tests for every scenario in [`../tests/fixtures/README.md`](../tests/fixtures/README.md).
- Determinism test: same input → identical normalized output (§3.2).
- Reimport test: exact duplicate file produces zero new committed rows by default (§4.3).
- Same-day-repeat test: legitimate identical purchases are never auto-removed (§4.3).
- Rollback test: removes only the target session's rows (§2.2).
- Recurring tests: month lengths, weekends, leap years, variable utilities, annual charges, missed months (§5.3).
- Public-data contract tests: series, units, geography, periods, and counts validate before snapshots are committed (§7.2).
- Large-file test: a 100,000-row synthetic import does not freeze the main UI thread (§2.4).

## 9. Decisions recorded in Phase 0

The master plan states the requirement; this document records the specific value or mechanism chosen to satisfy it. Each is implementable, testable, and revisable — but must be revised **here** rather than in code.

1. `amountCents` stores an unsigned magnitude; sign is carried solely by `direction` (§3.4).
2. Debits default to `kind: "purchase"`; credits default to `kind: "unknown"` (§3.5) — this is what makes "unknown credits until reviewed" in [`calculation-contract.md`](./calculation-contract.md) coherent.
3. Fingerprints use a version-pinned `descriptionCanonical`, not the mutable `merchantNormalized`, so aliases can improve without re-identifying history (§4.2).
4. The repeated-occurrence index is **field 7 of the fingerprint**, assigned in source order within each group of otherwise-identical rows (§4.3). Duplicate detection is then a fingerprint lookup across staged files and the workspace, with every candidate left for the user to keep or exclude.
5. Recurring cadence drift windows, the ±5%-or-$1.00 amount tolerance, and the three-factor confidence table (§5.3–§5.4).
6. Annualization multipliers 52 / 26 / 12 / 4 / 1 by detected cadence (§5.5).
7. Zero-amount rows are accepted but flagged questionable, and default to `direction: "debit"` (§3.4).
8. Empty descriptions are accepted and flagged; missing dates and amounts are rejected (§3.7).
9. **Month completeness comes from the confirmed statement range**, not from observed transaction dates (§6). This is why wizard step 4 collects the statement range.

## 10. Open product decisions

None blocking Phase 1. The Phase 0 exit condition is met: sign conventions (§3.4), inclusion/exclusion ([`calculation-contract.md`](./calculation-contract.md)), refunds ([`calculation-contract.md`](./calculation-contract.md)), duplicate handling (§4), and budget formulas ([`calculation-contract.md`](./calculation-contract.md)) are all fully specified.

The tunable constants in §9 items 5–6 are expected to be re-examined against real fixture behavior during Phase 6 and are the most likely candidates for revision.
