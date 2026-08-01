#!/usr/bin/env node
/**
 * Deterministic large-fixture generator — Tri-State Spending Lens
 * ---------------------------------------------------------------
 * Emits a synthetic bank-export CSV large enough to exercise the import
 * limits in docs/data-methodology.md §2.3 (100,000 rows per session) and the
 * performance requirement in docs/product-spec.md §10.5 (a 100,000-row import
 * must not freeze the main UI thread).
 *
 * WHY A GENERATOR INSTEAD OF A COMMITTED CSV
 *   A 100,000-row CSV is several megabytes. Committing it would bloat every
 *   clone forever. A seeded generator gives the same bytes on every machine
 *   for a fraction of the repository cost.
 *
 * DETERMINISM CONTRACT
 *   Same --seed and --rows => byte-identical CSV, on every machine, forever.
 *   Therefore this file uses NO Math.random(), NO Date.now(), NO locale- or
 *   timezone-dependent formatting. All dates are computed in UTC from a fixed
 *   epoch; all money is integer cents until the moment it is formatted.
 *
 * SCOPE
 *   This script writes fixture data. It does NOT parse CSV, touch IndexedDB,
 *   or implement any rule from docs/calculation-contract.md. The manifest it
 *   emits reports raw ground-truth counts and gross sums per kind only —
 *   deriving contract figures (net spending, cash flow, savings rate) from
 *   those numbers is the test's job, not this generator's.
 *
 * ALL DATA IS FICTIONAL. No real bank, merchant, person, or account appears.
 *
 * Usage:
 *   node tests/fixtures/generated/generate-large-fixture.mjs
 *   node tests/fixtures/generated/generate-large-fixture.mjs --rows 5000 --seed 42
 *   node tests/fixtures/generated/generate-large-fixture.mjs --out /tmp/big.csv
 */

import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GENERATOR_VERSION = '1.0.0';
const HERE = dirname(fileURLToPath(import.meta.url));

// --- arguments -------------------------------------------------------------

function parseArgs(argv) {
  const out = { rows: 100000, seed: 20260731, out: null, manifest: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--rows') { out.rows = Number.parseInt(value, 10); i += 1; }
    else if (flag === '--seed') { out.seed = Number.parseInt(value, 10); i += 1; }
    else if (flag === '--out') { out.out = value; i += 1; }
    else if (flag === '--manifest') { out.manifest = value; i += 1; }
    else if (flag === '--help' || flag === '-h') { out.help = true; }
    else { throw new Error(`Unknown argument: ${flag}`); }
  }
  if (!Number.isInteger(out.rows) || out.rows < 1) throw new Error('--rows must be a positive integer');
  if (!Number.isInteger(out.seed)) throw new Error('--seed must be an integer');
  out.out ??= join(HERE, 'large-100k.csv');
  out.manifest ??= `${out.out.replace(/\.csv$/, '')}.manifest.json`;
  return out;
}

// --- deterministic PRNG (mulberry32) --------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- fixed calendar --------------------------------------------------------

const MS_PER_DAY = 86400000;
const EPOCH = Date.UTC(2024, 0, 1);          // 2024-01-01, first row date
const LAST_OFFSET = 730;                     // 2025-12-31, 24 complete months

function isoDate(dayOffset) {
  return new Date(EPOCH + dayOffset * MS_PER_DAY).toISOString().slice(0, 10);
}

function offsetOf(year, month /* 1-12 */, day) {
  return Math.round((Date.UTC(year, month - 1, day) - EPOCH) / MS_PER_DAY);
}

/** Every (year, month) pair covered by the fixture, in order. */
const MONTHS = [];
for (const year of [2024, 2025]) {
  for (let month = 1; month <= 12; month += 1) MONTHS.push({ year, month });
}

// --- fictional merchants ---------------------------------------------------

/** Discretionary/everyday merchants used to fill the bulk of the file. */
const MERCHANTS = [
  { name: 'PINEBROOK MARKET',        weight: 11, min: 1200, max: 9400 },
  { name: 'GREENLEAF GROCERS',       weight: 7,  min: 1500, max: 8800 },
  { name: 'VALLEY FRESH FOODS',      weight: 5,  min: 900,  max: 6200 },
  { name: 'BAYSIDE DELI',            weight: 8,  min: 700,  max: 2400 },
  { name: 'HARBOR BEAN COFFEE #114', weight: 14, min: 325,  max: 875 },
  { name: 'NOODLE POINT KITCHEN',    weight: 6,  min: 1100, max: 3600 },
  { name: 'STONEWALL PIZZERIA',      weight: 5,  min: 1400, max: 4200 },
  { name: 'RIVERLINE TRANSIT FARE',  weight: 13, min: 290,  max: 290 },
  { name: 'EASTGATE FUEL STOP',      weight: 4,  min: 2200, max: 6800 },
  { name: 'SUMMIT OUTDOOR SUPPLY',   weight: 3,  min: 1800, max: 24000 },
  { name: 'QUILL AND PAGE BOOKS',    weight: 4,  min: 900,  max: 5400 },
  { name: 'NORTHPORT HARDWARE',      weight: 3,  min: 600,  max: 8900 },
  { name: 'CEDAR GROVE PHARMACY',    weight: 4,  min: 500,  max: 7200 },
  { name: 'CEDAR GROVE BARBER',      weight: 2,  min: 2000, max: 3500 },
  { name: 'LUMEN SKIN STUDIO',       weight: 2,  min: 1800, max: 6500 },
  { name: 'ORPHEUM CINEMA HOUSE',    weight: 3,  min: 1200, max: 3400 },
  { name: 'PIXELFORGE GAMES',        weight: 3,  min: 999,  max: 5999 },
  { name: 'CAMPUS BOOKSTORE EXAMPLE',weight: 2,  min: 1500, max: 18500 },
  { name: 'LEARNLOOP COURSES',       weight: 2,  min: 1999, max: 4999 },
  { name: 'HARBORVIEW INN',          weight: 1,  min: 8900, max: 32000 },
  { name: 'TRANSIT AIRLINES EXAMPLE',weight: 1,  min: 12000, max: 48000 },
  { name: 'RIVERBEND FOOD BANK DONATION', weight: 2, min: 500, max: 5000 },
];

const WEIGHT_TOTAL = MERCHANTS.reduce((sum, m) => sum + m.weight, 0);

function pickMerchant(rand) {
  let ticket = rand() * WEIGHT_TOTAL;
  for (const merchant of MERCHANTS) {
    ticket -= merchant.weight;
    if (ticket <= 0) return merchant;
  }
  return MERCHANTS[MERCHANTS.length - 1];
}

function amountBetween(rand, min, max) {
  return min === max ? min : min + Math.floor(rand() * (max - min + 1));
}

// --- row construction ------------------------------------------------------

/** kind values mirror docs/category-rules.md §3. They are ground truth for tests. */
const rows = [];
let sequence = 0;

function push(dayOffset, description, cents, direction, kind) {
  if (/[",\r\n]/.test(description)) {
    throw new Error(`Description would break CSV quoting rules: ${description}`);
  }
  if (dayOffset < 0 || dayOffset > LAST_OFFSET) {
    throw new Error(`Day offset ${dayOffset} outside the fixture calendar`);
  }
  rows.push({ dayOffset, description, cents, direction, kind, seq: sequence++ });
}

/**
 * Scheduled rows: the predictable spine of a real statement. These exist so
 * recurring detection, cadence handling, price-change flags, and the
 * exclusion rules for transfers/payments all have material to work on.
 */
function addScheduledRows(rand) {
  for (const { year, month } of MONTHS) {
    // Housing — a deliberate rent increase in 2025 exercises the price-change flag.
    push(offsetOf(year, month, 1), 'OAKMONT RENTALS RENT', year === 2024 ? 95000 : 97500, 'debit', 'purchase');

    // Income — semimonthly payroll, the basis for money in / savings rate.
    push(offsetOf(year, month, 1), 'PAYROLL DEPOSIT NORTHGATE LABS', 145000, 'credit', 'income');
    push(offsetOf(year, month, 15), 'PAYROLL DEPOSIT NORTHGATE LABS', 145000, 'credit', 'income');

    // Fixed monthly subscriptions — STREAMLY raises its price mid-fixture.
    const streamly = year === 2025 && month >= 4 ? 1399 : 1199;
    push(offsetOf(year, month, 12), 'STREAMLY MEDIA MONTHLY', streamly, 'debit', 'purchase');
    push(offsetOf(year, month, 5), 'ATLAS FITNESS CLUB', 2999, 'debit', 'purchase');
    push(offsetOf(year, month, 22), 'CLOUDNOTE STORAGE', 299, 'debit', 'purchase');

    // Variable utility — recurring merchant, unstable amount (medium confidence).
    push(offsetOf(year, month, 9), 'NORTHFIELD UTILITIES', amountBetween(rand, 6500, 12500), 'debit', 'purchase');
    push(offsetOf(year, month, 18), 'LINKWAVE INTERNET', 7999, 'debit', 'purchase');

    // Money movement — must never reach net spending.
    push(offsetOf(year, month, 3), 'TRANSFER TO SAVINGS', 20000, 'debit', 'transfer');
    push(offsetOf(year, month, 20), 'PAYMENT TO REWARDS CARD', amountBetween(rand, 20000, 45000), 'debit', 'payment');

    // Fee and cash withdrawal — both count toward net spending.
    push(offsetOf(year, month, 26), 'MONTHLY SERVICE FEE', 500, 'debit', 'fee');
    push(offsetOf(year, month, 24), 'ATM WITHDRAWAL MAIN ST', 6000, 'debit', 'cash_withdrawal');

    // Quarterly cadence.
    if (month % 3 === 1) {
      push(offsetOf(year, month, 14), 'WESTFIELD DENTAL GROUP', 12500, 'debit', 'purchase');
    }
    // Annual cadence.
    if (month === 3) {
      push(offsetOf(year, month, 2), 'MAPLEWAY INSURANCE AUTO', 68000, 'debit', 'purchase');
    }
  }
}

/**
 * Fills the file to the requested size with ordinary purchases. Roughly one in
 * two hundred is emitted twice on the same day at the same amount: legitimate
 * identical same-day purchases that duplicate detection must NOT remove
 * (docs/data-methodology.md §4.3).
 */
function addPurchases(rand, target) {
  let twins = 0;
  while (rows.length < target) {
    const merchant = pickMerchant(rand);
    const dayOffset = Math.floor(rand() * (LAST_OFFSET + 1));
    const cents = amountBetween(rand, merchant.min, merchant.max);
    push(dayOffset, merchant.name, cents, 'debit', 'purchase');

    if (rand() < 0.005 && rows.length < target) {
      push(dayOffset, merchant.name, cents, 'debit', 'purchase');
      twins += 1;
    }
  }
  return twins;
}

/**
 * Refunds that reference a real earlier purchase, some full and some partial,
 * some crossing a month boundary (docs/calculation-contract.md §5.3).
 */
function addRefunds(rand, count) {
  const purchases = rows.filter((row) => row.kind === 'purchase' && row.dayOffset < LAST_OFFSET - 3);
  if (purchases.length === 0) return 0;

  let added = 0;
  for (let i = 0; i < count; i += 1) {
    const source = purchases[Math.floor(rand() * purchases.length)];
    const lag = 3 + Math.floor(rand() * 43);
    const dayOffset = Math.min(source.dayOffset + lag, LAST_OFFSET);
    const partial = rand() < 0.35;
    const cents = partial ? Math.max(1, Math.floor(source.cents / 2)) : source.cents;
    push(dayOffset, source.description, cents, 'credit', 'refund');
    added += 1;
  }
  return added;
}

// --- serialization ---------------------------------------------------------

function formatAmount(cents, direction) {
  const dollars = (cents / 100).toFixed(2);
  return direction === 'debit' ? `-${dollars}` : dollars;
}

function toCsv(sorted) {
  const lines = ['Date,Description,Amount'];
  for (const row of sorted) {
    lines.push(`${isoDate(row.dayOffset)},${row.description},${formatAmount(row.cents, row.direction)}`);
  }
  return `${lines.join('\n')}\n`;
}

// --- main ------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write('Usage: generate-large-fixture.mjs [--rows N] [--seed N] [--out FILE] [--manifest FILE]\n');
    return;
  }

  const rand = mulberry32(args.seed);
  addScheduledRows(rand);

  if (rows.length > args.rows) {
    throw new Error(`--rows ${args.rows} is below the ${rows.length} scheduled rows this fixture always emits`);
  }

  const refundTarget = Math.floor((args.rows - rows.length) * 0.01);
  const twins = addPurchases(rand, args.rows - refundTarget);
  const refunds = addRefunds(rand, refundTarget);

  if (rows.length !== args.rows) {
    throw new Error(`Expected ${args.rows} rows, built ${rows.length}`);
  }

  // Stable sort: chronological, ties broken by generation order.
  const sorted = [...rows].sort((a, b) => a.dayOffset - b.dayOffset || a.seq - b.seq);

  const csv = toCsv(sorted);
  const csvBuffer = Buffer.from(csv, 'utf8');
  const sha256 = createHash('sha256').update(csvBuffer).digest('hex');

  // Ground truth only: raw counts and gross sums per kind. Deriving net
  // spending, cash flow, or savings rate from these is the test's job.
  const countsByKind = {};
  const grossCentsByKind = {};
  for (const row of sorted) {
    countsByKind[row.kind] = (countsByKind[row.kind] ?? 0) + 1;
    grossCentsByKind[row.kind] = (grossCentsByKind[row.kind] ?? 0) + row.cents;
  }

  const manifest = {
    generator: 'generate-large-fixture.mjs',
    generatorVersion: GENERATOR_VERSION,
    note: 'Fictional synthetic data. Ground-truth counts and gross sums only — not calculation-contract figures.',
    seed: args.seed,
    rows: args.rows,
    dateRange: { start: isoDate(0), end: isoDate(LAST_OFFSET) },
    countsByKind,
    grossCentsByKind,
    sameDayDuplicatePairs: twins,
    refundRows: refunds,
    csvBytes: csvBuffer.length,
    csvSha256: sha256,
  };

  writeFileSync(resolve(args.out), csvBuffer);
  writeFileSync(resolve(args.manifest), `${JSON.stringify(manifest, null, 2)}\n`);

  process.stdout.write(`Wrote ${args.rows} rows -> ${resolve(args.out)}\n`);
  process.stdout.write(`Manifest              -> ${resolve(args.manifest)}\n`);
  process.stdout.write(`Bytes                 : ${csvBuffer.length}\n`);
  process.stdout.write(`SHA-256               : ${sha256}\n`);
}

main();
