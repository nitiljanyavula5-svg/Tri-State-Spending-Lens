# Tri-State Spending Lens

A privacy-first financial analysis and budgeting website for students and young adults in New
Jersey, New York, and Pennsylvania. Users import bank CSV files, review and categorize transactions,
understand spending and recurring costs, create a monthly plan, and explore regional economic
context — all without connecting a bank account or uploading financial data to a server.

> **See where your money goes — without sending it anywhere.**

## Current status: Phase 3 — CSV import

- **Phase 0 (complete)** — the six specification documents in [`docs/`](./docs) and the synthetic
  CSV fixtures in [`tests/fixtures/`](./tests/fixtures).
- **Phase 1 (complete)** — React/TypeScript/Vite shell, route structure, responsive navigation,
  Tailwind v4 design tokens, accessible UI primitives, empty states for every route, and CI.
- **Phase 2 (complete)** — Dexie/IndexedDB schema and its first versioned migration, typed
  repositories, the shared calculation *interfaces*, a deterministic fictional demo workspace, and
  working reset-demo, delete-all, backup, and restore controls.
- **Phase 3 (this build)** — the CSV import system: a six-step wizard, parsing and normalization in
  a real Web Worker, duplicate-candidate review, the Import Health Report, atomic import commit,
  saved column-mapping presets, import history, and single-session rollback.

**Not implemented yet:** the transaction review grid, manual recategorization, and merchant/category
rules (Phase 4); every calculated figure — net spending, money in, cash flow, savings rate, budget
progress (Phase 5); recurring detection and insights (Phase 6); and regional public data (Phase 7).

Imported rows are stored, but the interface still shows **record counts only** — never a financial
total — until the shared calculation layer lands in Phase 5.

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
keyword rules, or transfer/refund/fee detection is performed; that is Phase 4.

## Documentation

Read these before changing behaviour. They are requirements, not background reading.

| Document | Defines |
| --- | --- |
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
src/components/  UI primitives, brand mark, demo, workspace, and import wizard components
src/data/demo/   Deterministic fictional demo workspace
src/db/          Dexie schema, migrations, repositories, backup, restore, import commit
src/import/      CSV engine: decode, detect, map, normalize, fingerprint, duplicates
src/import/wizard/ Wizard state machine and its side-effect hooks
src/domain/      Permanent categories and their seed classifications
src/pages/       One component per route
src/lib/         Small shared helpers
src/types/       Domain types transcribed from the specifications
tests/fixtures/  Synthetic CSV fixtures and their expected results
tests/unit/      Vitest component, data-layer, and route tests
tests/e2e/       Playwright navigation, workspace, and accessibility tests
```

## Ground rules

- Personal financial data never leaves the browser, and never appears in a URL, page title, console
  log, or error report.
- No remote fonts, icons, chart scripts, analytics, or AI services.
- All fixture and demo data is fictional. **Real bank data is never committed.**
