import type { Account } from '../../../../src/types/domain';
import type { FingerprintedRow } from '../../../../src/import/normalizeFile';
import type { PresetDraft } from '../../../../src/import/mapping';
import { COMMA_UTF8, signedMapping } from '../../import/helpers/fixtures';

/**
 * Fixtures for the persistence tests.
 *
 * Everything is deterministic: ids, fingerprints, and timestamps are supplied
 * rather than generated, so an assertion can name the exact record it expects
 * instead of matching a shape. That is also what lets these tests prove
 * *persisted outcomes* — the row read back out is comparable to a literal.
 */

/** A 64-character lowercase hex string, the stored fingerprint form. */
export function fingerprintFor(seed: number): string {
  return seed.toString(16).padStart(64, '0');
}

let rowSeed = 0;

/** Resets the fingerprint counter so each test file starts from a known point. */
export function resetRowSeed(): void {
  rowSeed = 0;
}

export function stagedRow(overrides: Partial<FingerprintedRow> = {}): FingerprintedRow {
  rowSeed += 1;
  const description = overrides.descriptionRaw ?? `PINEBROOK MARKET ${rowSeed}`;

  return {
    fileName: 'statement.csv',
    originalRow: rowSeed,
    postedDate: '2026-04-08',
    descriptionRaw: description,
    merchantNormalized: description.toUpperCase(),
    descriptionCanonical: description.toUpperCase(),
    amountCents: 1234,
    direction: 'debit',
    questions: [],
    fingerprint: fingerprintFor(rowSeed),
    occurrenceIndex: 0,
    accountId: 'account-existing',
    ...overrides,
  };
}

export function account(overrides: Partial<Account> = {}): Account {
  return {
    id: 'account-existing',
    label: 'Everyday Checking',
    type: 'checking',
    currency: 'USD',
    archived: false,
    ...overrides,
  };
}

export function presetDraft(overrides: Partial<PresetDraft> = {}): PresetDraft {
  return {
    name: 'Everyday checking export',
    format: COMMA_UTF8,
    mapping: signedMapping(),
    columns: ['Date', 'Description', 'Amount'],
    ...overrides,
  };
}
