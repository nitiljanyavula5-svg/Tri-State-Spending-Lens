# Synthetic CSV Fixtures — Tri-State Spending Lens

**Status:** Phase 0 foundation artifact. These fixtures are written **before** the parser exists, per the master plan §16 (Phase 0) and §18 Step 4. They are the specification the import engine must satisfy, not a report of what it currently does.

**Companion documents:** [`../../docs/data-methodology.md`](../../docs/data-methodology.md) · [`../../docs/calculation-contract.md`](../../docs/calculation-contract.md) · [`../../docs/category-rules.md`](../../docs/category-rules.md) · [`../../docs/threat-model.md`](../../docs/threat-model.md)

## Ground rules

1. **Every value in every fixture is fictional.** All merchants, employers, amounts, and dates are invented. No real bank, real institution, real person, or real account appears anywhere in this directory.
2. **Real personal CSV files must never be committed.** Only synthetic transaction fixtures may enter Git ([`data-methodology.md`](../../docs/data-methodology.md) §7.2).
3. **Fixtures are frozen inputs.** Once a fixture has an expectation recorded here, changing its bytes changes the meaning of every test that reads it. Add a new fixture rather than editing an existing one.
4. **Expectations live here, in this file.** A test asserting a total that is not written down here is asserting an undocumented requirement.

## Conventions used by every expectation below

- **Money** is stated in dollars for readability; the implementation stores integer cents ([`calculation-contract.md`](../../docs/calculation-contract.md) §9).
- **Import defaults** apply unless stated otherwise: debits import as `kind: "purchase"`, credits import as `kind: "unknown"` ([`category-rules.md`](../../docs/category-rules.md) §3.1).
- Because unknown credits are excluded from both spending and income, **Money in is $0.00 immediately after import** in every fixture containing a credit. Expectations that depend on income are stated as *"after review"*, meaning the user has confirmed the credit's kind in the review queue.
- **Statement range** must be confirmed at wizard step 4; it — not the earliest transaction date — determines month completeness ([`data-methodology.md`](../../docs/data-methodology.md) §6). Each fixture below states the range to confirm.
- Unless a fixture says otherwise, import everything into a **single account** named `Everyday Checking (fixture)`. Fingerprints are account-scoped, so duplicate expectations only hold when the same account is used.

## Fixture index

| # | File | Layout | Rows | Primary requirement |
| --- | --- | --- | --- | --- |
| 01 | `01-signed-amount-us-dates.csv` | Date, Description, Amount | 12 | Signed single-amount column, US dates |
| 02 | `02-debit-credit-columns.csv` | Date, Description, Debit, Credit, Type | 10 | Separate debit/credit columns, unmapped extra column |
| 03a | `03a-dates-us-format.csv` | Date, Description, Amount | 7 | US date parsing, ambiguity resolution |
| 03b | `03b-dates-iso-format.csv` | Date, Description, Amount | 7 | ISO date parsing; identical normalized output to 03a |
| 04 | `04-refunds.csv` | Date, Description, Amount | 8 | Full, partial, unmatched, and cross-month refunds |
| 05a | `05a-checking-transfers-payments.csv` | Date, Description, Amount | 6 | Transfers and card payments excluded |
| 05b | `05b-credit-card-statement.csv` | Date, Description, Debit, Credit | 6 | Card side of the same payment — no double counting |
| 06 | `06-identical-same-day-purchases.csv` | Date, Description, Amount | 6 | Legitimate identical same-day repeats survive |
| 07a | `07a-reimport-exact-copy.csv` | Date, Description, Amount | 12 | Exact duplicate file reimport |
| 07b | `07b-reimport-partial-overlap.csv` | Date, Description, Amount | 7 | Overlapping statement re-download |
| 08a | `08a-missing-and-invalid-fields.csv` | Date, Description, Amount | 17 | Rejection rules; no silent zero-filling |
| 08b | `08b-encoding-bom-crlf.csv` | Date, Description, Amount | 4 | UTF-8 BOM + CRLF line endings |
| 08c | `08c-invalid-utf8.csv` | Date, Description, Amount | 3 | Invalid UTF-8 byte inside a description |
| 09 | `09-formula-and-malicious-descriptions.csv` | Date, Description, Amount | 15 | Formula injection, HTML/script, control and bidi characters, oversized field |
| 10 | `generated/generate-large-fixture.mjs` | Date, Description, Amount | 100,000 | Deterministic large-file performance fixture |

---

## 01 — Signed single-amount column, US dates

**File:** `01-signed-amount-us-dates.csv` · **Statement range:** 2026-01-01 → 2026-01-31 (a complete month)

**What it must test**

- A single `Amount` column where **negative means money out**, confirmed by the user at wizard step 4.
- US `M/D/YYYY` dates, both padded and unpadded, normalize to ISO `YYYY-MM-DD`.
- Keyword classification suggestions: `MONTHLY SERVICE FEE` → `fee`, `ATM WITHDRAWAL MAIN ST` → `cash_withdrawal` (both tier-4, medium confidence — [`category-rules.md`](../../docs/category-rules.md) §7).
- The single credit is **not** silently treated as income.
- This is the baseline workspace that fixtures 07a and 07b are imported on top of.

**Expected outcome**

| Measure | Value |
| --- | --- |
| Accepted / rejected | 12 / 0 |
| Debits / credits | 11 / 1 |
| Gross outflow | $1,244.79 |
| Net spending | **$1,244.79** (no refunds) |
| Money in, before review | $0.00 — hidden, incomplete-income gate |
| Money in, after marking the payroll credit as `income` | $1,450.00 |
| Net cash flow, after review | $205.21 |
| Savings rate, after review | **14.2 %** |

Net spending is identical whether or not the fee and ATM rows are reclassified from `purchase`, because all three kinds add to net spending ([`calculation-contract.md`](../../docs/calculation-contract.md) §3.3). A test that produces a different total under those two paths has a bug.

---

## 02 — Separate debit and credit columns

**File:** `02-debit-credit-columns.csv` · **Statement range:** 2026-02-01 → 2026-02-28 (a complete month)

**What it must test**

- The two-column layout: exactly one of `Debit`/`Credit` is populated per row ([`data-methodology.md`](../../docs/data-methodology.md) §3.4).
- The trailing `Type` column is **optional**: it must be mappable, and when left unmapped it must be **ignored, never guessed at**.
- An **unmatched refund**. `REFUND QUILL AND PAGE BOOKS` and `QUILL AND PAGE BOOKS` are distinct merchant strings, and normalization is forbidden from merging them on shared words ([`category-rules.md`](../../docs/category-rules.md) §6.2). Once the user confirms the credit as `kind: "refund"`, it still reduces net spending and is routed to the review queue for category confirmation.
- **Matching affects attribution, not inclusion.** Net spending is the same whether or not the refund matches a purchase.

**Expected outcome**

| Measure | Value |
| --- | --- |
| Accepted / rejected | 10 / 0 |
| Debits / credits | 8 / 2 |
| Gross outflow | $1,178.89 |
| Total refunds, after review | $19.99 |
| Net spending, after review | **$1,158.90** |
| Money in, after review | $1,450.00 |
| Net cash flow, after review | $291.10 |
| Savings rate, after review | **20.1 %** |
| Refund match | **Unmatched** — attribution goes to the review queue |

---

## 03a / 03b — US and ISO date formats

**Files:** `03a-dates-us-format.csv`, `03b-dates-iso-format.csv` · **Statement range:** 2025-12-01 → 2026-03-31

These two files describe **the same seven transactions** in two date formats.

**What it must test**

- **Cross-format equivalence.** Importing 03a and importing 03b must produce byte-identical normalized rows for every compared field (`postedDate`, `amountCents`, `direction`, `descriptionRaw`, `merchantNormalized`, `fingerprint`). Generated `id` values are excluded from the comparison ([`data-methodology.md`](../../docs/data-methodology.md) §3.2).
- **Padded and unpadded** US components both parse: `1/2/2026` and `02/28/2026`.
- **Ambiguity is resolved by the confirmed file-level format, never per-row.** `3/4/2026` must become `2026-03-04` under the confirmed US format.
- **Format conflict detection.** `3/13/2026` has a day of 13, which is impossible in the month position. If a user confirms a D/M format for this file, the wizard must surface a format conflict **before commit** rather than rejecting the row silently.
- **Year boundary.** `12/31/2025` must land in December 2025, not December 2026.
- Importing both files into one account produces **7 duplicate candidates and 0 new rows** — proof that the fingerprint is format-independent.

**Expected outcome (either file, imported alone)**

| Measure | Value |
| --- | --- |
| Accepted / rejected | 7 / 0 |
| Net spending, total | **$1,154.99** |
| Net spending, Dec 2025 | $41.05 |
| Net spending, Jan 2026 | $4.75 |
| Net spending, Feb 2026 | $91.14 |
| Net spending, Mar 2026 | $1,018.05 |

---

## 04 — Refunds

**File:** `04-refunds.csv` · **Statement range:** 2026-01-01 → 2026-02-28
**Assumption:** all five credits have been reviewed and confirmed as `kind: "refund"`.

**What it must test** — every branch of the refund rule in [`calculation-contract.md`](../../docs/calculation-contract.md) §5.2:

| Row | Case | Expected |
| --- | --- | --- |
| 2026-01-10 QUILL AND PAGE BOOKS $45.00 | **Full match** to the 01-06 purchase | Matched; inherits merchant and category |
| 2026-01-15 SUMMIT OUTDOOR SUPPLY $30.00 | **Partial match** to the 01-07 $120.00 purchase | Matched; refund < purchase is valid |
| 2026-01-20 CEDAR GROVE PHARMACY $12.50 | **Unmatched** — no purchase at that merchant | Still reduces net spending; goes to review |
| 2026-02-03 HARBOR BEAN COFFEE #114 $4.75 | **Cross-month match** to the 01-25 purchase | Matched; reduces **February**, not January |
| 2026-02-08 SUMMIT OUTDOOR SUPPLY $200.00 | **Unmatched** — exceeds the only candidate purchase, which is already matched one-to-one | Still reduces net spending; goes to review |

**Expected outcome**

| Measure | Value |
| --- | --- |
| Accepted / rejected | 8 / 0 |
| Matched / unmatched refunds | 3 / 2 |
| Gross outflow, all periods | $169.75 |
| Total refunds, all periods | $292.25 |
| Net spending, January 2026 | **$82.25** |
| Net spending, February 2026 | **−$204.75** |
| Net spending, both months | −$122.50 |

**The negative February figure is correct and must be displayed honestly**, with the offsetting transactions reachable by drill-down. A February total of $0.00 means the implementation is clamping, and a January total of −$122.50 means it is restating a closed month — both are defects ([`calculation-contract.md`](../../docs/calculation-contract.md) §5.3).

---

## 05a / 05b — Transfers and credit-card payments

**Files:** `05a-checking-transfers-payments.csv`, `05b-credit-card-statement.csv` · **Statement range:** 2026-03-01 → 2026-03-31

Import 05a as `Everyday Checking (fixture)` and 05b as `Rewards Card (fixture)` — **two accounts**. The $325.60 payment appears on both sides.

**What it must test**

- `TRANSFER TO SAVINGS`, `TRANSFER FROM SAVINGS`, `PAYMENT TO REWARDS CARD`, and `PAYMENT RECEIVED - THANK YOU` are all excluded from net spending **by kind, never by category** ([`calculation-contract.md`](../../docs/calculation-contract.md) §8).
- **No double counting**: the payment is counted zero times, not twice and not once.
- `TRANSFER FROM SAVINGS` is **not income**. Moving money between one's own accounts is not earning.
- Transfer and payment classification is a **suggestion requiring confirmation**; until confirmed, those rows must not silently leave net spending ([`category-rules.md`](../../docs/category-rules.md) §7).
- Card purchases are counted once, on the card account, where they occurred.

**Expected outcome (both files imported, March 2026)**

| Measure | Value |
| --- | --- |
| Accepted / rejected | 12 / 0 |
| Net spending, checking only | $1,021.40 |
| Net spending, card only | $203.99 |
| Net spending, combined | **$1,225.39** |
| Money in | $1,450.00 |
| Net cash flow | $224.61 |
| Savings rate | **15.5 %** |

**Known wrong answers this fixture exists to catch**

| Symptom | Bug |
| --- | --- |
| Net spending $1,550.99 | The checking-side payment was counted as spending |
| Net spending $1,750.99 | The transfer out was also counted |
| Money in $1,550.00 | The transfer in was counted as income |
| Net spending $899.79 | The card-side payment credit was netted against card purchases instead of excluded |
| Net spending $1,021.40 | Card purchases were dropped entirely |

---

## 06 — Legitimate identical same-day purchases

**File:** `06-identical-same-day-purchases.csv` · **Statement range:** 2026-01-01 → 2026-01-31

Two identical $4.75 coffees and three identical $2.90 transit fares, all on 2026-01-08.

**What it must test**

- On a first import (`m = 0`), **all six rows are committed with no duplicate prompt** ([`data-methodology.md`](../../docs/data-methodology.md) §4.3).
- Rows sharing a fingerprint receive distinct **occurrence indexes** 0, 1, 2 in source order.
- **Nothing is ever auto-deleted.** Two identical purchases on the same day can be legitimate.

**Expected outcome**

| Measure | Value |
| --- | --- |
| Accepted / rejected | 6 / 0 |
| Duplicate candidates | **0** |
| Net spending | **$51.32** |

A result of 3 rows, or of $41.82 / $43.67, means same-day repeats were collapsed — the single most damaging duplicate-detection defect.

---

## 07a / 07b — Reimport

**Files:** `07a-reimport-exact-copy.csv`, `07b-reimport-partial-overlap.csv`

`07a` is **byte-identical to `01-signed-amount-us-dates.csv`**. A test must assert that equality (SHA-256 of both files) so the fixture cannot silently drift out of sync with fixture 01.

### 07a — exact duplicate file reimport

Import fixture 01, then import 07a into **the same account**.

| Measure | Value |
| --- | --- |
| Incoming rows | 12 |
| Duplicate candidates | **12** |
| Rows committed by default | **0** |
| Workspace rows after | 12 |
| Net spending after | **$1,244.79** — unchanged |

The user may override and commit anyway; that path must also work, producing 24 rows. What must never happen is silent deletion of the original rows.

### 07b — partially overlapping statement re-download

Import fixture 01, then import 07b into the same account. The first four rows of 07b already exist; the last three are new.

| Measure | Value |
| --- | --- |
| Incoming rows | 7 |
| Duplicate candidates | **4** |
| Rows committed by default | **3** |
| Workspace rows after | 15 |
| Net spending, January 2026 | $1,244.79 — unchanged |
| Net spending, February 2026 | **$93.36** |

The February payroll credit imports as `unknown` and contributes to neither spending nor income until reviewed.

### Rollback (both cases)

Rolling back the **second** session must remove only that session's rows and restore the workspace to exactly 12 rows and $1,244.79 ([`data-methodology.md`](../../docs/data-methodology.md) §2.2).

---

## 08a / 08b / 08c — Missing and invalid fields

### 08a — rejection rules

**File:** `08a-missing-and-invalid-fields.csv` · 17 logical records (one spans two physical lines).

**The governing rule: reject invalid dates and nonnumeric amounts rather than silently converting them to zero.** A wrong number in a financial total is worse than a missing row.

**Rejected — 10 rows**

| Row content | Reason |
| --- | --- |
| *(empty date)*, PINEBROOK MARKET | Missing date |
| `2026-02-30` | Not a real calendar date |
| `13/45/2026` | Unparseable date |
| CEDAR GROVE PHARMACY, *(empty amount)* | Missing amount |
| QUILL AND PAGE BOOKS, `N/A` | Non-numeric amount |
| SUMMIT OUTDOOR SUPPLY, `--` | Non-numeric amount |
| NORTHFIELD UTILITIES, `-88.615` | More than two decimal places |
| RIVERLINE TRANSIT PASS *(4 fields)* | Ragged row — too many fields |
| BAYSIDE DELI *(2 fields)* | Ragged row — too few fields |
| EURO MERCHANT EXAMPLE, `€45.00` | Non-USD currency symbol; v1 is USD only |

**Accepted — 7 rows**

| Row content | Normalized result |
| --- | --- |
| `2026-01-05`, *(empty description)*, `-15.00` | Debit $15.00 — **accepted**, flagged questionable |
| `2026-01-10`, PINEBROOK MARKET, `"$1,234.56"` | **Credit** $1,234.56 — `$` and thousands separator stripped |
| `2026-01-11`, ATLAS FITNESS CLUB, `(45.00)` | Debit $45.00 — parenthesized negative |
| `2026-01-14`, `"   "`, `-9.99` | Debit $9.99 — whitespace-only description, flagged questionable |
| `2026-01-15`, HARBOR BEAN COFFEE #114, `0.00` | $0.00, `direction: "debit"` by convention, flagged questionable |
| `2026-01-16`, `"MAPLEWAY INSURANCE, AUTO POLICY"` | Debit $142.00 — quoted comma preserved inside the description |
| `2026-01-17`, `"OAKMONT RENTALS⏎RENT NOTICE"` | Debit $950.00 — quoted embedded newline preserved in `descriptionRaw`, neutralized for display |

**Expected outcome**

| Measure | Value |
| --- | --- |
| Accepted / rejected | **7 / 10** (reconciling to 17) |
| Questionable | ≥ 3 — the empty description, the whitespace-only description, and the $0.00 amount |
| Net spending | **$1,161.99** |
| Money in, before review | $0.00 |

Every rejection must appear in the Import Health Report **with its original row number and a specific reason** ([`data-methodology.md`](../../docs/data-methodology.md) §3.7). A silent 0.00 anywhere in the accepted set is a defect.

### 08b — UTF-8 BOM and CRLF line endings

**File:** `08b-encoding-bom-crlf.csv` — begins with the bytes `EF BB BF`; every line ends `CR LF`.

- The BOM must be stripped from the first header cell. The mapped column name is exactly `Date`, **not** `﻿Date`.
- All four records parse. Expected: **4 accepted / 0 rejected**, net spending **$108.40**, one credit of $1,450.00 at `unknown`.
- The parser must accept `LF`, `CRLF`, **and lone `CR`** line endings. The lone-`CR` variant is asserted by a test that rewrites this fixture's bytes in memory — a file with lone `CR` endings is unreadable in most editors and is deliberately not committed.

### 08c — invalid UTF-8

**File:** `08c-invalid-utf8.csv` — the second record's description contains the byte `0xFF`, which is not valid UTF-8 in any position.

- The invalid byte is **replaced with U+FFFD**, not dropped, and not allowed to corrupt the rest of the line ([`threat-model.md`](../../docs/threat-model.md) §7).
- The affected row is **accepted and flagged questionable** — a mangled character is a data-quality problem, not an integrity failure.
- Expected: **3 accepted / 0 rejected**, 1 questionable, net spending **$75.00**.

---

## 09 — Formula-like and malicious descriptions

**File:** `09-formula-and-malicious-descriptions.csv` · 15 records, all debits.

Note that row 12 (`2026-01-07`) is deliberately **out of chronological order** — real exports are not always sorted, and normalization must not depend on input ordering.

**What each row must test**

| Description | Threat | Requirement |
| --- | --- | --- |
| `=1+1` | Formula injection (`=`) | Neutralized on CSV export ([`threat-model.md`](../../docs/threat-model.md) §4) |
| `=cmd\|' /C calc'!A1` | Classic CSV-injection payload | Neutralized on export; quoting alone is **not** a mitigation |
| `+41 SUPPLY CO` | Formula injection (`+`) | Neutralized on export |
| `-DISCOUNT MERCHANT CO` | Formula injection (`-`) | Neutralized on export; must **not** be confused with a negative amount — it is in the Description column |
| `@SUM(A1:A9)` | Formula injection (`@`) | Neutralized on export |
| *(leading TAB)* `TAB LEADING MERCHANT` | Formula injection (`0x09`) | Neutralized on export |
| `<script>alert('xss')</script>` | Script injection | Rendered as **visible literal text**, never as HTML |
| `<img src=x onerror=alert(1)>` | Event-handler injection | Rendered as literal text; never used to build an attribute |
| `javascript:alert(1)` | Dangerous URL scheme | Never used to build an `href` |
| `DROP TABLE transactions; --` | SQL-looking string | Inert — IndexedDB is not SQL, and the string is only ever data |
| `${process.env.SECRET}` | Template injection | Never interpolated or evaluated |
| `{{constructor.constructor('alert(1)')()}}` | Template-expression injection | Never evaluated |
| `EXAMPLE`+U+202E+`MERCHANT` | Bidi override — can visually reorder a row | Neutralized for display so a description cannot misrepresent an adjacent amount; raw bytes preserved |
| `ZERO`+U+200B+`WIDTH MERCHANT` | Zero-width space — invisible merchant mismatch | Preserved in `descriptionRaw`; must not silently merge with a visually identical merchant |
| 5,000-character `LONG-MERCHANT-NAME-…` | Oversized field | Accepted with **truncation reported**, per the field-length cap ([`threat-model.md`](../../docs/threat-model.md) §6) |

**Expected outcome**

| Measure | Value |
| --- | --- |
| Accepted / rejected | **15 / 0** — hostile content is not an integrity failure |
| Net spending | **$255.00** |
| Rows flagged questionable | ≥ 1 (the truncated 5,000-character description) |

**Round-trip requirement.** Export this workspace to cleaned CSV, then re-import the export. No exported field may begin with `=`, `+`, `-`, `@`, tab, or CR, **and** the re-imported rows must normalize to the same values as the originals. Neutralization is applied at the export boundary only — `descriptionRaw` in storage keeps the original bytes ([`threat-model.md`](../../docs/threat-model.md) §15 item 1).

---

## 10 — Deterministic 100,000-row generated fixture

**Generator:** [`generated/generate-large-fixture.mjs`](generated/generate-large-fixture.mjs) · **Output:** `generated/large-100k.csv` (git-ignored)

A 100,000-row CSV is ~3.8 MB. Committing it would bloat every clone forever, so it is **generated on demand** instead.

```bash
node tests/fixtures/generated/generate-large-fixture.mjs
```

Options: `--rows N` (default 100000), `--seed N` (default 20260731), `--out FILE`, `--manifest FILE`.

**Determinism contract.** Same seed and row count produce byte-identical output on every machine, forever. The generator uses a seeded mulberry32 PRNG and a fixed UTC epoch — no `Math.random()`, no `Date.now()`, no locale- or timezone-dependent formatting.

Verified defaults:

| Property | Value |
| --- | --- |
| Rows | 100,000 |
| Date range | 2024-01-01 → 2025-12-31 (24 complete months) |
| Bytes | 3,781,617 |
| SHA-256 | `25c41227f37597bb2b85079ef44bdb29cfb75dbc3b6384b4c188e0d10cac319d` |

CI must assert that hash. If it changes, the generator changed — update this table in the same commit, deliberately.

**What it must test**

- **Performance:** a 100,000-row import **does not freeze the main UI thread** ([`product-spec.md`](../../docs/product-spec.md) §10.5). Parsing and normalization run in a Web Worker, progress is reported, and the import is cancellable.
- **Row-count limit:** 100,000 is exactly the cap. Running with `--rows 100001` must be refused cleanly, with no partial write.
- **Recurring detection at scale**, with deliberately planted cadences:
  - *Monthly:* rent, three subscriptions, a variable utility, internet.
  - *Semimonthly:* payroll on the 1st and 15th.
  - *Quarterly:* `WESTFIELD DENTAL GROUP`, every third month.
  - *Annual:* `MAPLEWAY INSURANCE AUTO`, each March.
  - *Variable-amount recurring:* `NORTHFIELD UTILITIES` ranges $65–$125 and must land at **medium** confidence, not high.
- **Price-change flags:** rent rises $950.00 → $975.00 in January 2025; `STREAMLY MEDIA MONTHLY` rises $11.99 → $13.99 in April 2025. Both must raise a price-change flag showing the old and new amounts and dates.
- **Annualization by detected cadence:** the quarterly charge must annualize ×4 and the annual charge ×1. Annualizing either at ×12 is the defect this plant exists to catch.
- **Exclusions at scale:** 24 transfers and 24 payments must contribute $0.00 to net spending.
- **Same-day duplicates at scale:** 473 deliberate identical same-day pairs must survive import untouched.
- **Cross-month refunds:** 997 refunds are dated 3–45 days after their source purchase, so many fall in a later month.

**Manifest.** Each run writes `large-100k.manifest.json` beside the CSV with ground-truth counts and gross sums per kind:

| Kind | Count | Gross |
| --- | --- | --- |
| `purchase` | 98,859 | $3,584,790.04 |
| `refund` | 997 | $30,299.09 |
| `income` | 48 | $69,600.00 |
| `transfer` | 24 | $4,800.00 |
| `payment` | 24 | $7,180.67 |
| `cash_withdrawal` | 24 | $1,440.00 |
| `fee` | 24 | $120.00 |

These are **raw ground truth, not calculation-contract figures**. Deriving net spending, cash flow, or savings rate from them is the test's job — the generator deliberately implements none of [`calculation-contract.md`](../../docs/calculation-contract.md).

---

## Coverage matrix

Every scenario required by the master plan §18 Step 4, mapped to the fixture that owns it:

| Required scenario | Owned by | Also exercised in |
| --- | --- | --- |
| 1. Signed single-amount column | 01 | 03a, 03b, 04, 05a, 06, 07a, 07b, 08a, 08b, 08c, 09, 10 |
| 2. Separate debit/credit columns | 02 | 05b |
| 3. US and ISO dates | 03a + 03b | 01, 07a, 07b (US); 02, 04, 05, 06, 08, 09, 10 (ISO) |
| 4. Refunds | 04 | 02, 10 |
| 5. Transfers and credit-card payments | 05a + 05b | 10 |
| 6. Identical legitimate same-day purchases | 06 | 10 |
| 7. Exact duplicate file reimport | 07a | 07b (partial overlap), 03a+03b (cross-format) |
| 8. Missing / invalid fields | 08a | 08b, 08c |
| 9. Formula-like merchant descriptions | 09 | — |
| 10. Large generated file | 10 | — |

## Adding a new fixture

1. Use fictional data only. Never commit real bank data, and never approximate a real institution's export closely enough to identify it.
2. Name it `NN-short-kebab-name.csv`, continuing the numbering.
3. Add a section to this file **before** writing the test: state the layout, the statement range, what it must test, and the exact expected outcome.
4. If it needs bytes a text editor cannot produce reliably (BOM, invalid encoding, control characters), write it with an explicit byte-level script and record what makes it special here.
5. If it would exceed a few hundred kilobytes, write a deterministic generator instead and git-ignore the output.
6. Update the coverage matrix.
