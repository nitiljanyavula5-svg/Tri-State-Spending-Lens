# Product Specification — Tri-State Spending Lens

**Status:** Phase 0 foundation document — approved before any application code is written.
**Source:** Split from `Tri-State-Spending-Lens-Master-Plan.md` (revision July 31, 2026). This document does not introduce, weaken, or reinterpret any requirement from the master plan; it reorganizes the master plan's product-definition content into one authoritative spec.
**Companion documents:** [`privacy-model.md`](./privacy-model.md) · [`data-methodology.md`](./data-methodology.md) · [`calculation-contract.md`](./calculation-contract.md) · [`category-rules.md`](./category-rules.md) · [`threat-model.md`](./threat-model.md)

## 1. Product definition

> Tri-State Spending Lens is a privacy-first financial analysis and budgeting website for students and young adults in New Jersey, New York, and Pennsylvania. Users import bank CSV files, review and categorize transactions, understand spending and recurring costs, create a monthly plan, and explore regional economic context—all without connecting a bank account or uploading financial data to a server.

Tri-State Spending Lens is built as a **local-first financial analysis and budgeting website** for students and young adults in New Jersey, New York, and Pennsylvania. It is not just a CSV dashboard and not a generic budgeting app. It combines three things:

1. **Personal analysis:** clean and understand bank transactions.
2. **Practical planning:** create monthly category budgets and savings targets.
3. **Regional context:** explore trustworthy NJ, NY, and PA cost and spending data without presenting state averages as personal rules.

The personal transaction pipeline and the public economic-data pipeline must remain technically separate. Personal files never leave the browser. Government data is collected during development, converted to versioned static JSON, and shipped with the site. (See [`privacy-model.md`](./privacy-model.md) and [`data-methodology.md`](./data-methodology.md) for the technical boundaries that enforce this separation.)

## 2. Product loop

> **Import → Clean → Understand → Plan → Review**

Every core feature exists to serve one step of this loop. Features that do not map onto Import, Clean, Understand, Plan, or Review should be questioned before being added.

## 3. Primary audience

- Students and young adults, approximately ages 16–25
- People with one or several checking or credit-card CSV exports
- People who want a simple view of their money without granting bank access
- NJ, NY, and PA residents interested in local economic context

## 4. Jobs to be done

- "Show me where my money actually went."
- "Help me clean up confusing bank descriptions."
- "Tell me which subscriptions and repeated payments I may be overlooking."
- "Help me set a realistic monthly spending plan."
- "Show whether I am on pace to exceed that plan."
- "Explain how price levels and inflation differ around the tri-state region."

## 5. Product principles

1. **Private by architecture:** personal data stays in the browser.
2. **Trust before cleverness:** every total must be explainable and reproducible.
3. **Review before analysis:** questionable imports must be surfaced before charts appear.
4. **Neutral language:** describe behavior without shaming the user.
5. **Context, not commands:** regional statistics inform; they do not prescribe a personal budget.
6. **Useful without an account:** demo mode and local persistence provide the full core experience.

## 6. Non-goals for version 1.0

Do not add any of the following to the first release:

- Plaid or bank-account connections
- User accounts, authentication, Supabase, or a server database
- AI or LLM access to transaction descriptions
- Credit scores, investments, brokerage data, or tax calculations
- Personalized financial-product recommendations
- Claims that a state average is the "correct" amount for a user to spend
- Multi-currency support; v1 supports USD only
- Household collaboration or syncing across devices
- A full zero-based/envelope accounting system

## 7. Information architecture

### 7.1 Public routes

| Route | Purpose |
| --- | --- |
| `/` | Landing page, privacy promise, product preview, demo/import calls to action |
| `/context` | NJ/NY/PA economic context |
| `/methodology` | Calculation, categorization, recurring, and public-data methods |
| `/privacy` | Technical privacy model and local-data controls |

### 7.2 Application routes

| Route | Purpose |
| --- | --- |
| `/import` | Import wizard and import history |
| `/app/overview` | Financial overview and current-month status |
| `/app/transactions` | Search, review, categorize, and exclude transactions |
| `/app/budget` | Monthly overall/category budgets and savings target |
| `/app/recurring` | Possible recurring charges, annualized cost, and expected dates |
| `/app/insights` | Transparent rule-based observations and month-in-review |
| `/app/settings` | Accounts, merchant rules, backup/restore, storage, and delete controls |

### 7.3 Main navigation

- **Overview**
- **Transactions**
- **Budget**
- **Recurring**
- **Insights**
- **Tri-State Context**

Import and Settings are utility actions, not permanent primary-navigation competitors.

## 8. Core user experience

### 8.1 Landing and onboarding

The landing page must answer four questions within the first screen:

1. What does this do?
2. Is my bank data uploaded?
3. What will I learn?
4. Can I try it without using my real data?

Recommended headline:

> **See where your money goes—without sending it anywhere.**

Primary actions: **Try the demo** and **Import a bank CSV**.

Demo mode uses obviously fictional, realistic transactions spanning at least four complete months. It supports every core feature, including budgets and recurring charges. A "Reset demo" action restores the original synthetic dataset.

On first real import, ask only for information needed to improve the experience:

- Optional home state: NJ, NY, PA, or none
- Preferred week start
- Whether credits in the file represent income/refunds

Never use IP geolocation or hidden location detection.

### 8.2 Import wizard

The import wizard uses six steps:

1. **Choose files:** one or more `.csv` files; show privacy reminder and size limit.
2. **Identify format:** detect delimiter, encoding, header row, and likely bank layout.
3. **Map columns:** date, description, amount or debit/credit, optional account and type.
4. **Confirm conventions:** sign direction, date format, account label/type, and statement range.
5. **Review preview:** show normalized rows and all warnings before saving.
6. **Import Health Report:** summarize accepted, rejected, duplicated, questionable, and uncategorized rows.

Required formats:

```text
Date | Description | Amount
```

```text
Date | Description | Debit | Credit
```

Initial limits, explicit and easy to revise:

- CSV only
- 10 MB maximum per file
- 100,000 rows maximum per import session
- USD only

The full technical behavior of the import pipeline (atomic sessions, rollback, duplicate detection, rejection rules, Web Worker parsing) is defined in [`data-methodology.md`](./data-methodology.md).

### 8.3 Transaction review

The transaction table supports:

- Search by raw description or normalized merchant
- Date, account, kind, category, tag, and inclusion filters
- Sort and accessible pagination or virtualization
- Category and merchant edits
- Mark as transfer, refund, income, card payment, fee, or cash withdrawal
- Include/exclude from spending totals
- Optional note and user tags
- Multi-select bulk edits
- Undo for recent edits
- Export filtered or full cleaned CSV
- Permanent access to the original description

When a user changes a merchant or category, the product offers two distinct actions:

- **Change this transaction only**
- **Create a rule for similar future transactions**

This prevents one edit from unexpectedly rewriting the full history. The full category, kind, and rule-precedence system is defined in [`category-rules.md`](./category-rules.md).

### 8.4 Overview dashboard

The default view is the current month, with an easy switch to previous month, last 90 days, year to date, or custom range.

Summary cards:

- Net spending
- Money in
- Net cash flow
- Budget remaining
- Savings rate, when valid income data exists
- Largest category
- Possible recurring monthly cost
- Transactions analyzed

Charts and panels:

- Monthly net-spending trend
- Category breakdown
- Budget versus actual by category
- Top merchants
- Fixed versus variable spending
- Essential versus discretionary spending
- Weekday or calendar pattern
- Recent large or unusual purchases
- Data-quality status

All cards and charts must use a single shared calculation/selector layer so totals cannot disagree. The exact formulas behind every card are defined in [`calculation-contract.md`](./calculation-contract.md) and must not be reimplemented per-component.

### 8.5 Budgeting — MVP scope

Budgeting is intentionally simple:

- Overall monthly spending limit
- Optional category limits
- Optional monthly income target
- Optional monthly savings target
- Copy the previous month's plan
- Edit a future month before it begins
- Budget-versus-actual progress bars
- Spending-pace indicator based on elapsed days
- Alerts shown inside the product only; no push notifications or email
- Rollover is **off** in v1.0

The budget still works if no income data is imported. In that case, hide cash-flow and savings-rate claims and focus on spending limits.

Useful budget messages:

- "You have used 62% of your Dining budget with 48% of the month elapsed."
- "At your current pace, this category may exceed its plan by about $34."
- "Your plan leaves $210 between expected income and planned spending."

Avoid moral language such as "bad spending" or "wasteful."

### 8.6 Recurring expenses

A recurring series is a **suggestion, not a fact**. Displayed fields:

- Merchant
- Likely cadence
- Typical amount or amount range
- Last charge
- Expected next charge
- Estimated annualized cost
- Price-change flag
- Confidence label: high, medium, or low

User controls:

- Confirm recurring
- Mark not recurring
- Merge or split a detected series
- Change category
- Exclude from recurring totals

Do not label every recurring expense a subscription. Rent, insurance, and utilities are recurring but not subscriptions. The detection algorithm and confidence model are defined in [`data-methodology.md`](./data-methodology.md).

### 8.7 Transparent insights

The Insights page uses deterministic local rules, not AI. Every insight must include a "Why am I seeing this?" explanation and a link to the supporting transactions.

High-value insight cards:

- **Spending pace:** current spending versus elapsed portion of the month
- **Category shift:** change versus the previous complete month
- **Recurring annualizer:** estimated yearly cost of confirmed and likely recurring payments
- **Price change:** a recurring merchant's typical charge appears to have increased
- **Concentration:** unusually large share of spending at one merchant/category
- **Unusual purchase:** amount is far above that merchant/category's recent typical range
- **Month in Review:** concise summary after a full month closes
- **Data warning:** conclusions may be incomplete because the import covers only part of a month

Minimum evidence rules matter. For example, do not show a month-over-month percentage when either month is incomplete, and do not call a transaction unusual without a sufficient comparison history. (See data-quality warnings in [`data-methodology.md`](./data-methodology.md).)

### 8.8 Tri-State context

The context section is explanatory and must never silently blend into personal totals. Version 1.0 contains four focused views:

1. **Spending by state:** per-capita personal consumption expenditures for NJ, NY, and PA.
2. **Category mix:** selected state PCE categories with a documented crosswalk.
3. **Price-level lens:** Regional Price Parities for the three states.
4. **Inflation trend:** New York–Newark–Jersey City and Philadelphia–Camden–Wilmington CPI trends, labeled by their actual metro geographies.

One memorable educational feature — **"What does $100 feel like?"** — uses BEA RPP values to illustrate relative purchasing power:

```text
National-price-equivalent purchasing power = $100 × (100 / RPP)
```

This is an educational approximation, not a quote for a specific basket or city. The interface must explain that state RPP includes broad consumption prices and housing rents.

Do not present New Jersey as having a standalone statewide CPI; it does not. Do not compare a single user's category share to BEA PCE as if the definitions and households are equivalent.

Source-metadata display requirements and the current source plan (BEA/BLS series as of July 31, 2026) are defined in [`data-methodology.md`](./data-methodology.md).

## 9. Version scope

### 9.1 Version 1.0 MVP (this release)

- Browser-local CSV import and IndexedDB storage
- Import Health Report and rollback
- Transaction review and saved merchant rules
- Dashboard and complete calculation contract
- Monthly overall/category budgets
- Optional income and savings targets
- Recurring detection and annualized cost
- Rule-based insights and month-in-review
- NJ/NY/PA PCE, RPP, and metro CPI context
- Demo mode
- Cleaned CSV export
- Workspace JSON backup/restore
- Delete-all control
- Responsive and accessible design

### 9.2 Version 1.1 (explicitly deferred, not MVP)

- Optional password-encrypted backup export
- Long-term savings goals with target dates
- What-if budget simulator
- More bank-specific mapping presets
- PWA/offline installation after cache/privacy review
- Multiple separate local profiles
- Improved recurring-series editing
- Additional official indicators, only when they answer a clear user question

### 9.3 Version 2 ideas — not commitments

- Aggregate-only shareable monthly report
- User-created custom categories with safe migration behavior
- Local-only anomaly-model experimentation
- Optional device-to-device transfer without server storage

## 10. MVP acceptance criteria

Version 1.0 is ready only when all of the following are true. This is the canonical, complete acceptance list; other documents may reference it but should not restate a conflicting subset.

### 10.1 Import and data integrity

- Both amount-column and debit/credit-column CSVs import correctly.
- The user confirms sign interpretation before commit.
- Invalid rows are counted and explained.
- Duplicate candidates are surfaced without automatically deleting legitimate repeats.
- Rolling back an import removes only that session's transactions.
- Reimporting the same fixture produces identical normalized results.

### 10.2 Calculations

- Transfers and card payments are excluded by default.
- Refunds reduce net spending correctly.
- Checking and credit-card imports do not double count payments.
- Every dashboard value matches the calculation contract.
- Partial-month and incomplete-income warnings appear when required.

### 10.3 Budget and recurring

- Overall and category budgets persist locally.
- Budget progress reacts immediately to transaction edits.
- Copy-previous-month works without linking the two plans.
- Recurring results display confidence and can be corrected by the user.
- Annualized recurring totals use the detected cadence correctly.

### 10.4 Privacy and resilience

- No personal value appears in network requests or logs during the complete E2E flow.
- Delete all data clears transactions, budgets, rules, and settings.
- Backup then restore reproduces the workspace totals.
- Corrupt or future-version backups fail safely without changing current data.
- The app explains local-storage limitations.

### 10.5 Quality

- Keyboard navigation works through import, transaction review, and budgeting.
- Automated accessibility testing finds no serious or critical violations.
- Core flows work at phone, tablet, and desktop widths.
- A 100,000-row synthetic import does not freeze the main UI thread.
- Empty, loading, error, partial-data, and demo states are designed.

## 11. Design direction (summary)

The visual target is a calm financial-research tool—not a neon fintech app and not a childish budgeting game: deep navy ink, warm off-white canvas, NJ teal / NY blue / PA amber accents, green/red reserved for positive/negative financial states, tabular numerals for money, medium-radius cards, subtle shadows, restrained motion, self-hosted legible typeface. Charts never rely on color alone, always offer an accessible data-table alternative, and respect `prefers-reduced-motion`. Full detail lives in the master plan §13 and should be extracted into a design-tokens reference during Phase 1.

## 12. Open product decisions

None. Per the Phase 0 exit condition, there are no unresolved decisions about sign conventions, inclusion/exclusion, refunds, duplicate handling, or budget formulas — these are fully specified in [`calculation-contract.md`](./calculation-contract.md) and [`data-methodology.md`](./data-methodology.md).
