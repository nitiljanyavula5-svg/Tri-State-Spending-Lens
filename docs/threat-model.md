# Threat Model — Tri-State Spending Lens

**Status:** Phase 0 foundation document — treated as a requirement, not marketing copy.
**Source:** Split from `Tri-State-Spending-Lens-Master-Plan.md` (revision July 31, 2026), primarily §14 (Security and data-quality requirements), §5 (Privacy and trust model), §7.2 (import limits), §9 (schema/migrations), and the privacy/resilience acceptance criteria in §15.
**Companion documents:** [`product-spec.md`](./product-spec.md) · [`privacy-model.md`](./privacy-model.md) · [`data-methodology.md`](./data-methodology.md) · [`calculation-contract.md`](./calculation-contract.md) · [`category-rules.md`](./category-rules.md)

## 1. What this document is for

Tri-State Spending Lens has no server, no accounts, and no backend to attack. That removes most of the usual threat surface and concentrates what remains into a small number of places:

- **untrusted file content** that the user hands to the app,
- **data the app writes back out** (CSV export, JSON backup, filenames),
- **anything that could leave the browser**, and
- **the local browser profile itself**, which is the whole security boundary.

Each section below names the threat, states the mitigation as a requirement, and lists the test that proves it.

## 2. Assets and trust boundaries

| Asset | Where it lives | Why it matters |
| --- | --- | --- |
| Normalized transactions, budgets, rules, settings | IndexedDB, this origin | The user's complete financial picture |
| Workspace backup JSON | User's filesystem, by user action | Same data, outside the browser's control |
| Exported cleaned CSV | User's filesystem, by user action | Opened in spreadsheets — an execution context |
| Static economic JSON | App bundle | Read-only, non-personal; integrity matters, confidentiality does not |

| Boundary | Trust |
| --- | --- |
| CSV file contents | **Untrusted.** Attacker-controllable in full, including via a merchant-supplied description string |
| Filenames | **Untrusted** |
| Backup JSON offered for restore | **Untrusted**, even though the app wrote the original |
| Static economic JSON | Trusted, because it is validated and checksummed at build time ([`data-methodology.md`](./data-methodology.md) §7.2) |
| The browser profile | **The security boundary itself** — see §12 |

**Assumed adversaries:** a hostile CSV author (including a merchant who controls a description string that lands in the user's statement); a hostile or corrupted backup file; a malicious dependency; and a person with physical access to an unlocked browser profile.

**Explicitly out of scope for v1.0:** protecting data from someone who already controls the user's OS account or browser profile, and encrypted-at-rest storage. Password-encrypted backup export is a deferred v1.1 item ([`product-spec.md`](./product-spec.md) §9.2) and must not be implied as available in v1.0.

## 3. Malicious CSV content

**Threat.** A CSV cell is an arbitrary attacker-controlled string. It reaches parsing, normalization, storage, rendering, export, and backup.

**Requirements.**

- Treat every field as untrusted text at every stage. No field is ever evaluated, interpolated into markup, or used to construct a selector, URL, or query.
- **User- and file-supplied patterns are never compiled as regular expressions.** Merchant-rule matching is literal (`exact` / `contains` / `starts_with`, [`category-rules.md`](./category-rules.md) §5.2). This removes catastrophic-backtracking denial of service as a class.
- Parsing runs in a **Web Worker**. A hostile file that is slow to parse degrades a worker, not the UI thread.
- Nothing in a CSV may influence the network layer, storage keys outside the workspace, or app configuration.

**Tests.** The malicious-description fixture imports without executing anything, without corrupting neighboring rows, and round-trips through export and backup unchanged.

## 4. Spreadsheet formula injection (CSV export)

**Threat.** The app exports cleaned CSV. If a description begins with a formula-triggering character, opening that file in a spreadsheet can execute it. The user is attacked by their own export of their own data. ([OWASP: CSV Injection](https://owasp.org/www-community/attacks/CSV_Injection))

**Requirements.**

- On export, any field whose first character is one of `=`, `+`, `-`, `@`, tab (`0x09`), or carriage return (`0x0D`) is **defensively neutralized** before being written.
- Neutralization is applied to **every exported text field** — description, normalized merchant, category label, note, tags, account label — not only to descriptions.
- Quoting alone is not a mitigation; a quoted `"=cmd|..."` still evaluates in common spreadsheet applications.
- Neutralization is applied at the **export boundary only**. Stored data keeps `descriptionRaw` exactly as imported ([`data-methodology.md`](./data-methodology.md) §3.6), so the audit trail stays truthful and re-import stays deterministic.
- The workspace **backup JSON** is not CSV and is not formula-escaped; it is JSON-encoded and validated on restore (§9).

**Tests.** Export of the formula-injection fixture produces no field whose first character is a formula trigger; re-importing the exported file yields the same normalized rows as the original import.

## 5. HTML and script content in transaction data

**Threat.** A description containing `<script>`, an `<img onerror=...>`, or a `javascript:` URL is rendered in the transaction grid, in tooltips, in insight text, and in the recurring view.

**Requirements.**

- **Sanitize and render descriptions as text, never HTML.** No `dangerouslySetInnerHTML`, no `innerHTML`, no template that injects a field into markup, anywhere a transaction field is displayed.
- **No dynamic script injection** of any kind, and no remote fonts or remote chart libraries. Fonts and icons are bundled or self-hosted ([`privacy-model.md`](./privacy-model.md) §2).
- Transaction fields are never used to build an `href`, `src`, `style`, or event-handler attribute.
- Control characters and Unicode bidirectional overrides in stored text are neutralized for display so a description cannot visually misrepresent an adjacent amount; the raw bytes remain preserved in `descriptionRaw`.
- A strict **Content Security Policy** and supporting static security headers are served in production. The policy must be strict enough that inline or remote script would fail, and the app must work under it.

**Tests.** The HTML/script fixture renders as visible literal text; automated checks assert no `dangerouslySetInnerHTML` usage in transaction-rendering components; the production build loads and functions under the deployed CSP with no violations.

## 6. Oversized files and resource exhaustion

**Threat.** A very large or pathological file freezes the tab, exhausts memory, or fills the storage quota.

**Requirements.**

| Control | Value | Enforced |
| --- | --- | --- |
| File type | `.csv` only | Before read |
| File size | 10 MB per file | Before parse, from file metadata |
| Rows | 100,000 per import session | During streaming parse; abort past the cap |
| Field length | Capped per field (long values truncated for storage, with the truncation reported) | During normalization |
| Field count per row | Capped; ragged rows rejected | During normalization |

- Limits are checked **before** doing the expensive work, not after.
- Exceeding a limit is a **clean, explained refusal** — never a crash, a hang, or a silent partial import.
- Parsing and normalization run in a Web Worker; a **100,000-row synthetic import must not freeze the main UI thread** ([`product-spec.md`](./product-spec.md) §10.5).
- Progress is reported and the import is cancellable.
- The app handles a storage-quota failure during commit by aborting the whole session atomically ([`data-methodology.md`](./data-methodology.md) §2.2) and telling the user, rather than leaving a half-written workspace.

**Tests.** The generated 100,000-row fixture imports without freezing the main thread; an over-limit file is refused with a specific message and no partial write.

## 7. Malformed data

**Threat.** Ragged rows, wrong delimiters, mismatched quotes, impossible dates, non-numeric amounts, mixed encodings, invalid UTF-8, a byte-order mark, or lone `\r` line endings cause silent corruption of totals — the most damaging failure mode, because it looks like a successful import.

**Requirements.**

- **Reject invalid dates and nonnumeric amounts rather than silently converting them to zero.** A wrong number in a financial total is worse than a missing row.
- Every rejected row is counted and explained with its original row number in the Import Health Report ([`data-methodology.md`](./data-methodology.md) §3.7).
- Encoding, delimiter, and header detection **propose**; the user confirms in the wizard. A misdetection is a visible question, not a silent decision.
- A byte-order mark is stripped from the first header cell rather than becoming part of a column name. `CRLF`, `LF`, and lone `CR` line endings all parse.
- Bytes that are not valid UTF-8 are replaced with the Unicode replacement character; the affected rows are flagged as questionable rather than dropped without explanation.
- The five Health Report counts (accepted, rejected, duplicate-candidate, questionable, uncategorized) must reconcile against the source row count.

**Tests.** The missing/invalid-fields, encoding, and invalid-byte fixtures each produce the exact expected accepted/rejected split documented in [`../tests/fixtures/README.md`](../tests/fixtures/README.md).

## 8. Sensitive logging and incidental leakage

**Threat.** Financial data escapes through channels nobody thinks of as storage: a console log, a thrown error message, the document title, a URL parameter, or a crash reporter.

**Requirements.**

- **Personal transaction data never appears in URL parameters, page titles, console logs, or error reports.**
- Error messages reference row numbers, field names, and counts — **never field values**. `"Row 42: amount is not numeric"` is correct; echoing the offending cell is not.
- Filters, date ranges, and the selected account are held in application state, not encoded into shareable URLs that could carry personal detail.
- **No third-party advertising, session replay, crash-reporting, or behavioral analytics scripts run inside the app.**
- Development-only diagnostics must be compiled out of production builds, not merely disabled by a flag.
- The service worker (if a PWA ships in v1.1) must never cache personal data into a shared or exportable cache without a fresh privacy review.

**Tests.** The end-to-end privacy test asserts that **no personal value appears in network requests or logs during the complete flow** — import, edit, budget, export.

## 9. External requests

**Threat.** A dependency, a font, an icon set, a chart library, or a well-meaning feature makes a request that carries personal data off the device.

**Requirements.**

- **The application pages need no external API calls at runtime.** Static economic JSON and all assets are served from the same origin ([`privacy-model.md`](./privacy-model.md) §4).
- **BEA and BLS are never called from a visitor's browser.** Retrieval happens only in development scripts ([`data-methodology.md`](./data-methodology.md) §7.2).
- A restrictive CSP, with no permissive `connect-src`, `script-src`, or `font-src`, backs this by policy rather than by convention.
- **Dependency discipline:** no analytics SDK, AI SDK, database SDK, or server framework. Foundation dependencies are pinned and reviewed; new dependencies that make network calls require an explicit decision recorded in this document.
- **Network-boundary test:** import a synthetic CSV, edit transactions, create a budget, and verify that **no request contains personal data**. This test exists in development and CI before release.

**Tests.** The network-boundary test above; a build-time check that no remote font, CDN, or analytics origin appears in the bundle.

## 10. Corrupted, hostile, and future-version backups

**Threat.** Restore is the one place where an external file is granted authority over the entire workspace. A corrupt, truncated, hand-edited, or attacker-supplied backup could destroy or poison the user's data.

**Requirements.**

- **Validate the backup's schema and version before changing existing data.** Validation is a Zod (or equivalent runtime) schema over the whole document, not a `typeof` check on a few fields.
- **Corrupt or future-version backups must fail safely without changing current data.** The current workspace is left byte-for-byte untouched and the user is told specifically why the restore did not proceed.
- A backup from a **future, unrecognized schema version** is refused outright. The app must not attempt to guess a forward migration.
- A backup from a **known older version** is migrated through the same versioned migration path as live data (§11), and the user is told a migration occurred.
- Restore is atomic: it either fully replaces the workspace or leaves it entirely unchanged.
- Backup content is untrusted text on restore and is subject to the same field limits, HTML-safety, and formula-escaping rules as imported data (§4, §5, §6).
- **A successful backup-then-restore reproduces the workspace totals exactly** ([`product-spec.md`](./product-spec.md) §10.4).
- **Filenames are escaped or neutralized on download** — path separators, control characters, and reserved device names are stripped so the suggested filename cannot traverse or collide dangerously.

**Tests.** Truncated, malformed-JSON, wrong-schema, and future-version backups each fail safely with the workspace unchanged; backup → delete all → restore reproduces every total.

## 11. Schema versions and migrations

**Threat.** A schema change silently drops or reinterprets existing data — a data-loss bug that ships looking like a successful upgrade.

**Requirements.**

- **Every IndexedDB schema change has a versioned migration**, recorded in the `SchemaMigration` table.
- Migrations must not silently drop or reinterpret user data. A migration that cannot preserve a field must say so and require an explicit decision.
- **Import writes are transactional**; a failed migration or commit leaves the prior state intact.
- User edits and merchant rules are stored distinctly enough that **re-running a better normalization algorithm does not erase manual decisions** ([`category-rules.md`](./category-rules.md) §5.4).
- Fingerprint canonicalization is version-pinned, so improving merchant aliases never silently re-identifies history ([`data-methodology.md`](./data-methodology.md) §4.2).
- The app opened against a **newer** database version than it understands must refuse to write and explain why, rather than downgrading data.

**Tests.** A migration test fixture at each historical schema version upgrades with all totals preserved; an app instance facing a newer DB version refuses to write.

## 12. Local browser access

**Threat.** The browser profile is the entire security boundary. Anyone with access to the same unlocked profile can inspect IndexedDB.

**Requirements.**

- **State this honestly.** IndexedDB is local storage, not encrypted vault storage. The words "vault," "encrypted," or "secure storage" must not be used for v1.0 local storage without that qualification ([`privacy-model.md`](./privacy-model.md) §3.3).
- Warn that clearing site data, private browsing, or changing domains can remove locally stored data, and that storage is subject to quotas and eviction.
- Provide a **Delete all data** control that requires confirmation and reports completion.
- Provide backup/restore so local-first does not mean fragile, and an optional persistent-storage request whose limits are explained.
- **Cryptographically strong random IDs**, and **SHA-256 used only for local fingerprints and checksums — never as a claim of encryption** ([`data-methodology.md`](./data-methodology.md) §4.2).
- Because there is no server session, there is no session to hijack and no token to steal; the mitigations here are honesty, deletion, and backup — not access control the app cannot actually provide.

**Tests.** Delete-all clears transactions, budgets, rules, and settings; the `/privacy` route and Settings both surface the storage-limitation text.

## 13. Required security fixtures

Synthetic malicious fixtures are kept permanently and run in CI ([`../tests/fixtures/README.md`](../tests/fixtures/README.md)):

- HTML and script strings in descriptions
- Very long descriptions (field-length limits)
- Formula-like fields (`=`, `+`, `-`, `@`, tab, CR)
- Invalid Unicode and byte-order marks
- Malformed CSV (ragged rows, unbalanced quotes, mixed line endings)
- Missing and invalid dates and amounts
- A deterministic 100,000-row file for performance limits

**All fixtures are fictional. Real bank data is never committed** ([`data-methodology.md`](./data-methodology.md) §7.2).

## 14. Release checklist

Version 1.0 does not ship until each of these is verified:

- [ ] CSP and static security headers deployed and the app functions under them
- [ ] Network-boundary test passing in CI
- [ ] No personal value in requests or logs during the full E2E flow
- [ ] Formula-injection escaping verified on every exported text field
- [ ] Descriptions render as text everywhere they appear
- [ ] File-size, row-count, and field-length limits enforced before parsing
- [ ] Invalid rows rejected, counted, and explained; counts reconcile
- [ ] 100,000-row import does not freeze the main UI thread
- [ ] Corrupt and future-version backups fail safely with the workspace unchanged
- [ ] Backup → restore reproduces workspace totals
- [ ] Delete all data clears transactions, budgets, rules, and settings
- [ ] Storage-limitation messaging present on `/privacy` and in Settings
- [ ] No analytics, session-replay, crash-reporting, remote font, or remote chart dependency in the bundle

## 15. Decisions recorded in Phase 0

1. **Formula neutralization is applied at export only**, never to stored data, so the audit trail and reimport determinism are preserved (§4).
2. **Neutralization covers every exported text field**, not descriptions alone (§4).
3. **Merchant-rule patterns are literal, never regular expressions**, eliminating ReDoS as a class (§3).
4. **Error messages carry row numbers and field names, never field values** (§8).
5. **Future-version backups are refused rather than guessed at**; older versions migrate through the standard path (§10).
6. **Invalid UTF-8 is replaced and flagged**, not silently dropped (§7).
7. **Encrypted local storage is explicitly out of scope for v1.0**, and the product says so plainly rather than implying protection it does not provide (§2, §12).

## 16. Open security decisions

None blocking Phase 1. The exact numeric field-length and field-count caps in §6 are intentionally left to be fixed alongside the parser in Phase 3, once the fixtures show realistic bank description lengths; they must be recorded here when chosen, not buried as constants in code.
