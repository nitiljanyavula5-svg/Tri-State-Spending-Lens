# Tri-State Spending Lens

A privacy-first financial analysis and budgeting website for students and young adults in New
Jersey, New York, and Pennsylvania. Users import bank CSV files, review and categorize transactions,
understand spending and recurring costs, create a monthly plan, and explore regional economic
context — all without connecting a bank account or uploading financial data to a server.

> **See where your money goes — without sending it anywhere.**

## Current status: Phase 4 — transaction review

- **Phase 0 (complete)** — the six specification documents in [`docs/`](./docs) and the synthetic
  CSV fixtures in [`tests/fixtures/`](./tests/fixtures).
- **Phase 1 (complete)** — React/TypeScript/Vite shell, route structure, responsive navigation,
  Tailwind v4 design tokens, accessible UI primitives, empty states for every route, and CI.
- **Phase 2 (complete)** — Dexie/IndexedDB schema and its first versioned migration, typed
  repositories, the shared calculation *interfaces*, a deterministic fictional demo workspace, and
  working reset-demo, delete-all, backup, and restore controls.
- **Phase 3 (complete)** — the CSV import system: a six-step wizard, parsing and normalization in
  a real Web Worker, duplicate-candidate review, the Import Health Report, atomic import commit,
  saved column-mapping presets, import history, and single-session rollback.
- **Phase 4 (this build)** — the transaction review system: the review grid with search, filters,
  sorting and pagination; individual and bulk edits; the merchant-rule manager; transfer, card-
  payment and refund review; session-local undo; and the cleaned CSV export. Schema version 3 adds
  the `transactionLinks` table.

**Not implemented yet:** every calculated figure — net spending, money in, cash flow, savings rate,
budget progress (Phase 5); recurring detection and insights (Phase 6); and regional public data
(Phase 7). Account editing after import also arrives in Phase 5.

Imported rows are stored and reviewable, but the interface still shows **record counts only** —
never a financial total — until the shared calculation layer lands in Phase 5.

There is no backend, no authentication, and no analytics — by design, not by omission.

## Importing a CSV

Your file is read **in your browser**, by a background worker. It is never uploaded, and no part of
it is sent anywhere. The original file is discarded once its rows are normalized.

The wizard has six steps: choose files, identify format, map columns, confirm conventions, review
the preview, and read the Import Health Report before committing.

### What is supported

| Concern | Supported |
| --- | --- |
| File type | `.csv` only |
| Encodings | UTF-8, UTF-8 with BOM, UTF-16LE, UTF-16BE, Windows-1252 |
| Delimiters | comma, semicolon, tab, pipe |
| Amount layouts | one signed amount column, **or** separate debit and credit columns |
| Date formats | year-first (`2026-03-04`), month-first (`3/4/2026`), day-first (`4/3/2026`) |
| Currency | **USD only** |

Detection proposes; you confirm. When a file's dates fit both month-first and day-first, the wizard
**refuses to guess** and asks — guessing would silently misdate every row.

### Limits

| Limit | Value |
| --- | --- |
| Maximum file size | 10 MiB per file |
| Maximum files per import | 10 |
| Maximum rows per import | 100,000 |
| Maximum stored text field | 8,192 characters |
| Preview rows shown | 50 |
| Rejection examples shown | 200 |
| Warnings kept per import | 200 |
| Saved mapping presets | 50 |

### Duplicates are suggestions, never deletions

A duplicate candidate means two rows agree on account, date, direction, amount, and description.
That is **not proof** they are the same transaction — two identical coffees on one day are ordinary.
Nothing is ever removed automatically: you keep or exclude each candidate explicitly, and the safe
default is to keep. A candidate counts as "not imported" only if you exclude it.

### Rollback

Import history lists every import with its counts, and can roll one back. Rollback removes **only
that import session's transactions** — never another session's rows, and never your merchant rules,
budgets, or settings. **Accounts are never deleted**: an account left empty is reported so you can
remove it yourself from Settings, because nothing in the data model can prove the import created it
rather than you.

### Replacing the demo

Importing your own statements into a workspace holding the sample data replaces it. That requires an
explicit confirmation, and the removal and the import happen in **one** database transaction — a
failure leaves the sample data exactly as it was. Your saved column mappings are kept.

### What is stored, and what is not

Mapping presets hold **structural choices only**: column positions, delimiter, encoding, header row,
amount model, date format, and sign convention. They never hold a description, amount, date, account
label, file name, or destination account, and there is no bank-specific preset library.

Raw CSV text, `File` objects, rejected row contents, and wizard state are **never** written to
IndexedDB. Rejected rows are reported by row number and reason, never by content.

Imported rows start deliberately unclassified: `categoryId: other`, `categorySource: uncategorized`,
`classificationConfidence: none`, no tags, and not excluded from spending. The one exception is
`kind`, which follows the direction default in
[`docs/data-methodology.md`](./docs/data-methodology.md) §3.5 — **debits default to `purchase`,
credits to `unknown`** — because the calculation contract excludes unknown debits from net spending,
so a blanket `unknown` would report zero spending for every fresh import. No merchant inference,
keyword rules, or transfer/refund/fee detection is performed at import unless **you** have saved a
rule that matches.

## Reviewing your transactions

`/app/transactions` is the review workspace. Everything on it runs in your browser against local
storage; no transaction, merchant, note, or search term is ever sent anywhere.

### Finding a row

Search matches the **original description and the reviewed merchant**, so typing what you see on the
statement finds the row even after you have renamed it, and vice versa. Filters cover date range,
account, category, kind, spending treatment, tag, and "only rows that need review", and they
combine. The active-filter count and a "clear all" control are always visible.

Sorting is available on date, merchant, amount, and category, and the sorted order is **total** —
ties break by id — so paging can never show you one row twice and hide another. Pages hold 25, 50,
or 100 rows; a page that no longer exists after a filter change is clamped rather than left blank.

Nothing about a filter is persisted. It lives in component state and is gone when you leave — it
never reaches storage, a URL, or a backup.

### Changing one transaction

Opening **Review** on a row shows the statement's own values as facts, not fields:

| Never editable | Editable |
| --- | --- |
| Date, description, amount, direction, account, import row | Merchant, category, kind, tags, note, essential/discretionary, fixed/variable, exclude from spending |

The immutable set is enforced by the type of the edit itself — there is no field on a transaction
patch that could express a change to source information — so it holds on every path, not just in the
dialog.

A manual change is a **tier-1 decision**: it is marked as yours and is never overwritten by a later
rule or alias improvement. Escape cancels and never saves. Every save is atomic; if it fails,
nothing changes and the dialog stays open with your work in it.

Where a kind is **never counted as spending** — transfer, card payment, income — the editor shows no
"include in spending" control at all, and says so. A control that appeared to override the
calculation contract would be a lie.

### Changing many at once

Ticking rows reveals a bulk-action bar. Bulk selection covers **only the rows on the visible page** —
never every filtered result — and the bar says so. A bulk change is one atomic command and one undo
step: either every selected row changes or none does. A selection is reconciled against what is
actually on screen, so rows removed by a filter or page change stop being targets.

### Undo

Undo covers the last **20 commands** of the current session, and it is **session-local by design**.
One history spans the whole session: a transaction edit, a bulk change, a rule application, and a
relationship confirmation all join the same twenty, in the order you made them, and moving between
the transactions grid, the linked-transactions page, and Settings keeps them.

Your changes are saved immediately and permanently; the ability to *reverse* one is held in memory
and disappears when you reload. The interface says this next to the control rather than offering an
undo button that quietly vanishes. It is also dropped when the workspace it describes is replaced —
loading or resetting the demo, restoring a backup, or deleting everything — because an entry holds
whole copies of the rows it would restore. There is no redo, and an undo whose rows have since
changed is refused and discarded rather than silently overwriting newer work.

### Merchant rules

Settings holds the rule manager. A rule matches the cleaned merchant name **literally** — `exact`,
`starts with`, or `contains` — and is never compiled as a regular expression or matched against the
raw description.

- **Rules apply to future imports.** Saving one does not change, recategorize, or rewrite anything
  already stored.
- **Deleting a rule never deletes, reverts, or recategorizes a transaction.** Rows keep the
  classification they were given.
- **Precedence is deterministic:** higher priority first, then the more specific match type
  (`exact` > `starts with` > `contains`), then the longer pattern, then id. Rules are listed in
  exactly that order.
- A `contains` pattern shorter than 3 characters is refused, and one shorter than 5 is flagged,
  because a short `contains` rule would recategorize almost everything on the next import.
- A rule that would set nothing is refused. A workspace holds at most 500 rules.

"Count matching transactions" reports how many **stored** rows a pattern would match, bounded at 500
with the truncation stated. It is awareness only; saving the rule still changes none of them.

**Applying a rule to what you already have is a separate, deliberate action.** As soon as you create
a rule the product tells you how many stored transactions it matches and asks whether to apply it to
them — declining is the default and leaves history untouched. Every rule keeps an **Apply to
existing** control afterwards. That action is the one thing in the rule manager that rewrites stored
rows: it warns you so, states the count, discloses when more rows match than a single change may
cover, runs atomically, and is one undo step.

The Review dialog can create a rule alongside a transaction edit. That is one action, one database
transaction, and one undo step — if either half fails, neither is written. Changing one transaction
and creating a rule remain visibly separate choices.

### Transfers, card payments, and refunds

`/app/transactions/relationships` — reachable from **Review links** on the transactions page — offers
possible relationships. They are **suggestions, not conclusions**, and viewing them changes nothing
at all.

- A **transfer or card payment** is suggested when two rows in *different* accounts share an amount,
  have opposite directions, and posted within 4 days. Which of the two it is remains your choice;
  the credit-card account only sets the default.
- A **refund** is suggested only against an earlier purchase in the **same account, same merchant,
  and exactly the same amount**, within 120 days. Where several purchases fit, every one is listed
  and the group is labelled ambiguous — the product does not guess.
- A credit that nothing matches is listed honestly as unmatched and can be classified by hand.

Confirming is explicit. Transfers and card payments are excluded from spending, so both sides change
together and can never end up half-classified. A confirmed refund inherits the purchase's merchant
and category, stays visibly a **refund**, and reduces spending once. Unlinking removes the *pairing*
only — the kinds you chose are left alone, because reverting them would change your totals as a side
effect of a bookkeeping correction. Both confirming and unlinking are undoable, and an endpoint that
already belongs to a relationship is refused rather than double-counted.

### Exporting a cleaned CSV

Export produces a fixed 15-column CSV of every transaction, or of just the rows matching your current
filters, in a deterministic order. Amounts stay integer cents converted without floating-point
division. Fields are quoted per RFC 4180.

Every cell a person can influence — account label, description, merchant, tags, note — is checked for
a leading `=`, `+`, `-`, `@`, tab, carriage return, or newline **after leading spaces**, and prefixed
with an apostrophe if found. A description reading `=cmd|...` is data here and an executable formula
in a spreadsheet; this is what stops it being one. Application-generated cells such as amounts are
left alone, because prefixing a negative number would corrupt it.

The file is built in your browser and written straight to your device under a fixed, non-personal
name. Nothing is uploaded, no copy is stored, and the object URL is revoked immediately.

### Keyboard and phone

Every review action completes with the keyboard alone. Dialogs trap focus, return it to whatever
opened them, and treat Escape as cancel. The grid becomes a card list below 768px; only the layout in
use is exposed to assistive technology, so nothing is announced or actionable twice.

See [`docs/phase-4-services.md`](./docs/phase-4-services.md) for the full service contract.

## Documentation

Read these before changing behaviour. They are requirements, not background reading.

| Document | Defines |
| --- | --- |
| [`docs/phase-4-services.md`](./docs/phase-4-services.md) | Phase 4 classification, rules, relationships, undo, query, and export services |
| [`docs/product-spec.md`](./docs/product-spec.md) | Audience, product loop, routes, MVP scope, acceptance criteria |
| [`docs/privacy-model.md`](./docs/privacy-model.md) | Browser-local architecture, network boundary, backup, deletion |
| [`docs/data-methodology.md`](./docs/data-methodology.md) | Normalization, import sessions, duplicates, recurring, public data |
| [`docs/calculation-contract.md`](./docs/calculation-contract.md) | Net spending, money in, cash flow, savings rate, refunds, budgets |
| [`docs/category-rules.md`](./docs/category-rules.md) | Categories, kinds, budget-behaviour axes, rule precedence |
| [`docs/threat-model.md`](./docs/threat-model.md) | Hostile CSV content, formula injection, backups, local access |

## Getting started

Requires Node.js 20.19+ or 22.12+ (Vite 8).

```bash
npm install
npm run dev
```

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm run build` | Type check and production build |
| `npm run preview` | Serve the production build locally |
| `npm run typecheck` | `tsc -b` across app, node, and test projects |
| `npm run lint` | Oxlint |
| `npm run format` / `npm run format:check` | Prettier write / verify |
| `npm test` | Vitest unit, component, data-layer, and import tests |
| `npm run test:e2e` | Playwright end-to-end suite — **builds the E2E harness first**, which the real-worker tests require |
| `npm run test:e2e:install` | One-time Playwright browser download |
| `npm run check` | Everything except the end-to-end suite |

## Layout

```text
docs/            Phase 0 specifications — requirements, not marketing copy
src/app/         Router, layout shell, navigation config, workspace provider
src/calculations/ Shared selector interfaces (Phase 5 implements them)
src/classification/ Merchant normalization, the classification chain, spending treatment
src/components/  UI primitives, brand mark, demo, workspace, import, review, rule, and link components
src/data/demo/   Deterministic fictional demo workspace
src/db/          Dexie schema, migrations, repositories, backup, restore, import commit,
                 transaction queries and commands, rule commands, relationships, undo
src/export/      Cleaned CSV construction and the browser download boundary
src/import/      CSV engine: decode, detect, map, normalize, fingerprint, duplicates
src/import/wizard/ Wizard state machine and its side-effect hooks
src/domain/      Permanent categories, seed classifications, and review limits
src/review/      Hooks binding the review surfaces to the Phase 4 services
src/pages/       One component per route
src/lib/         Small shared helpers
src/types/       Domain types transcribed from the specifications
tests/fixtures/  Synthetic CSV fixtures and their expected results
tests/unit/      Vitest component, data-layer, and route tests
tests/e2e/       Playwright navigation, workspace, review, and accessibility tests
```

## Ground rules

- Personal financial data never leaves the browser, and never appears in a URL, page title, console
  log, or error report.
- No remote fonts, icons, chart scripts, analytics, or AI services.
- All fixture and demo data is fictional. **Real bank data is never committed.**
