# Privacy Model — Tri-State Spending Lens

**Status:** Phase 0 foundation document — treated as a requirement, not marketing copy.
**Source:** Split from `Tri-State-Spending-Lens-Master-Plan.md` (revision July 31, 2026), primarily §5 (Privacy and trust model) and related privacy-relevant statements in §7.1, §9, and §12.
**Companion documents:** [`product-spec.md`](./product-spec.md) · [`data-methodology.md`](./data-methodology.md) · [`threat-model.md`](./threat-model.md)

## 1. Why this document exists

Tri-State Spending Lens's core promise is: **see where your money goes—without sending it anywhere.** Every engineering decision about storage, network calls, and logging must be checked against this document before it ships. If a proposed feature cannot be described honestly in terms of this document, the feature is wrong, not the document.

## 2. Non-negotiable requirements

These requirements apply to every phase of the build, starting with Phase 1 (application shell), even before CSV import exists:

- CSV parsing, normalization, categorization, and calculations occur in the browser.
- The original CSV file is not stored as a blob after import.
- Normalized transactions are stored only in IndexedDB for the site's origin.
- No transaction descriptions, amounts, categories, budgets, or account labels are sent in network requests.
- No third-party advertising, session replay, crash-reporting, or behavioral analytics scripts run inside the app.
- Fonts and icons are bundled or self-hosted.
- Personal transaction data never appears in URL parameters, page titles, console logs, or error reports.
- A visible **Delete all data** control requires confirmation and reports completion.
- A **Download workspace backup** control exports the local database in a versioned JSON format.
- A **Restore workspace backup** flow validates the schema before changing existing data.
- The app warns that clearing site data, using private browsing, or changing domains can remove locally stored data.
- The app honestly states that IndexedDB is local storage, not encrypted vault storage. Anyone with access to the same unlocked browser profile may be able to inspect it.

## 3. Browser-local architecture

### 3.1 Where personal data lives

- **Source of truth:** IndexedDB (via Dexie), scoped to the site's origin. This is the only place normalized personal financial data is persisted.
- **Not persisted as a blob:** the original uploaded CSV file. Once parsed, normalized, and committed as an `ImportSession`, the raw file content is discarded; only the normalized rows (and their original row number/raw description, for auditability — see [`data-methodology.md`](./data-methodology.md)) remain.
- **Component/UI state:** transient only (current filter, open modal, in-progress form). It is never the source of truth and never independently persisted outside IndexedDB.
- **Public economic data:** static, versioned JSON shipped with the app bundle. It is read-only, contains no personal information, and is technically and conceptually separate from the personal workspace (see §6).

### 3.2 Why IndexedDB

IndexedDB is appropriate because it supports structured browser-local data and is isolated by origin. Browser storage is still subject to quotas and possible eviction, so backup/restore and an optional persistent-storage request are part of the product from v1.0 — not an afterthought.

References:
- [MDN: IndexedDB API](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)
- [MDN: Storage quotas and eviction criteria](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)

### 3.3 IndexedDB boundaries

- IndexedDB storage is scoped to this site's origin only; it is not shared across domains, subdomains on a different registrable domain, or browser profiles.
- IndexedDB is **not encrypted at rest** by the browser in a way that protects against another person with access to the same unlocked browser profile/OS user account. The product must say this plainly in the `/privacy` route and in Settings — never imply "vault," "encrypted," or "secure storage" without that qualification. (Password-encrypted backup export is explicitly deferred to v1.1; see [`product-spec.md`](./product-spec.md) §9.2.)
- Every IndexedDB schema change requires a versioned migration (`SchemaMigration` table). Migrations must not silently drop or reinterpret existing user data. (See also [`threat-model.md`](./threat-model.md) §"Schema versions and corrupted backups.")
- User edits and merchant rules are stored distinctly enough that re-running a better normalization algorithm later does not erase manual user decisions.

## 4. Network boundary

The deployed app must work under a restrictive Content Security Policy. The application pages should not need external API calls at runtime. Static economic JSON and application assets are served from the same origin as the app itself — there is no runtime call to BEA, BLS, or any third party from a visitor's browser (that retrieval happens only in development scripts; see [`data-methodology.md`](./data-methodology.md) §"Public-data pipeline").

**Test requirement:** a network-boundary test must import a synthetic CSV, edit transactions, create a budget, and verify that no outgoing request contains personal data. This test must exist in development and CI before release (see [`threat-model.md`](./threat-model.md)).

The specific technical enforcement (CSP headers, forbidden script sources) is defined in [`threat-model.md`](./threat-model.md); this document defines the behavioral guarantee that enforcement exists to protect.

## 5. Backup, restore, and deletion

### 5.1 Download workspace backup

- A visible control exports the local database (transactions, accounts, budgets, merchant rules, recurring series, settings) as a single versioned JSON file.
- The export happens entirely client-side; the file is written to the user's device via a browser download, never uploaded anywhere by the app.
- Filenames are escaped/neutralized on download (see [`threat-model.md`](./threat-model.md)).

### 5.2 Restore workspace backup

- The restore flow validates the schema and version of the uploaded JSON **before** changing any existing data.
- A corrupt file or a file from a future, unrecognized schema version must fail safely: the current workspace is left unchanged, and the user is told why the restore did not proceed.
- A successful restore must reproduce the workspace's calculated totals exactly (this is part of the MVP acceptance criteria in [`product-spec.md`](./product-spec.md) §10.4).

### 5.3 Delete all data

- A visible **Delete all data** control is reachable from Settings.
- It requires explicit confirmation (a user cannot trigger permanent deletion with a single accidental click).
- On completion, it clears transactions, budgets, merchant rules, recurring series, and settings, and reports completion to the user.
- Deletion is local only — there is nothing to delete "on a server," and the UI should not imply otherwise.

### 5.4 Storage limitations users must be told about

The app must honestly and visibly explain, at minimum on `/privacy`:

- Clearing site data, using private browsing, or changing domains can remove locally stored data.
- IndexedDB is local storage, not encrypted vault storage.
- Storage is subject to browser quotas and possible eviction; users should back up periodically, especially before large imports or browser/OS changes.
- An optional persistent-storage permission request may reduce (but does not eliminate) eviction risk, and the app should explain what it does and does not guarantee.

## 6. Personal data vs. public economic data — a hard separation

The personal transaction pipeline and the public economic-data pipeline must remain technically separate:

- Personal data: user-imported, browser-local, IndexedDB, mutable, never leaves the device.
- Public data: BEA/BLS-sourced, retrieved by development scripts (never by a visitor's browser), converted to versioned static JSON, shipped read-only with the site, and rendered with full source metadata (see [`data-methodology.md`](./data-methodology.md)).
- The Tri-State Context section is explanatory and must never silently blend into personal totals — a user's category share must never be presented as directly comparable to BEA PCE definitions without the documented crosswalk and limitation notes.

## 7. Privacy messaging in the product

Privacy is not only a backend property — it must be visible and understandable in the UI:

- The landing page (`/`) answers, within the first screen: What does this do? Is my bank data uploaded? What will I learn? Can I try it without using my real data?
- The `/privacy` route documents the technical privacy model described in this file, in plain language, including the honest IndexedDB/local-storage caveat from §3.3 and §5.4.
- Demo mode exists specifically so a user can evaluate the full product without importing real financial data.
- Onboarding on first real import asks only for information that improves the experience (optional home state, preferred week start, whether credits represent income/refunds) and never uses IP geolocation or hidden location detection.

## 8. Open product decisions

None outstanding. The privacy model is fully specified for v1.0. Encrypted backup export is a known, intentionally deferred v1.1 item (see [`product-spec.md`](./product-spec.md) §9.2) and must not be implied as available in v1.0 messaging.
