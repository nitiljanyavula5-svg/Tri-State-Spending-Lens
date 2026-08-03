# Tri-State Spending Lens

A privacy-first financial analysis and budgeting website for students and young adults in New
Jersey, New York, and Pennsylvania. Users import bank CSV files, review and categorize transactions,
understand spending and recurring costs, create a monthly plan, and explore regional economic
context — all without connecting a bank account or uploading financial data to a server.

> **See where your money goes — without sending it anywhere.**

## Current status: Phase 2 — local database and demo workspace

- **Phase 0 (complete)** — the six specification documents in [`docs/`](./docs) and the synthetic
  CSV fixtures in [`tests/fixtures/`](./tests/fixtures).
- **Phase 1 (complete)** — React/TypeScript/Vite shell, route structure, responsive navigation,
  Tailwind v4 design tokens, accessible UI primitives, empty states for every route, and CI.
- **Phase 2 (this build)** — Dexie/IndexedDB schema and its first versioned migration, typed
  repositories, the shared calculation *interfaces*, a deterministic fictional demo workspace, and
  working reset-demo, delete-all, backup, and restore controls.

**Not implemented yet:** CSV parsing and the import wizard (Phase 3), the transaction grid and
merchant rules (Phase 4), every calculated figure — net spending, money in, cash flow, savings rate,
budget progress (Phase 5), recurring detection and insights (Phase 6), and regional public data
(Phase 7).

The workspace stores real records, but the interface deliberately shows **record counts only** —
never a financial total — until the shared calculation layer lands in Phase 5. Any figure currently
visible in the interface is fictional and labelled as such.

There is no backend, no authentication, and no analytics — by design, not by omission.

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
| `npm test` | Vitest component and route tests |
| `npm run test:e2e` | Playwright navigation and accessibility smoke tests (builds first) |
| `npm run test:e2e:install` | One-time Playwright browser download |
| `npm run check` | Everything except the end-to-end suite |

## Layout

```text
docs/            Phase 0 specifications — requirements, not marketing copy
src/app/         Router, layout shell, navigation config, workspace provider
src/calculations/ Shared selector interfaces (Phase 5 implements them)
src/components/  UI primitives, brand mark, demo and workspace components
src/data/demo/   Deterministic fictional demo workspace
src/db/          Dexie schema, migrations, repositories, backup and restore
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
