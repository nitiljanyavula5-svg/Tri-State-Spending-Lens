import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FileFormat, FileMapping } from '../../../../src/import/mapping';

/** Reads a frozen Phase 0 fixture as raw bytes, exactly as a File would arrive. */
export function fixtureBytes(name: string): Uint8Array {
  const path = join(process.cwd(), 'tests', 'fixtures', name);
  return new Uint8Array(readFileSync(path));
}

export function fixtureText(name: string): string {
  return new TextDecoder().decode(fixtureBytes(name));
}

/** A deterministic digest, so fingerprint assertions do not depend on Web Crypto. */
export const testSha256 = async (input: string): Promise<string> => {
  // FNV-1a widened to 64 hex characters. Not cryptographic — these tests assert
  // *stability and distinctness*, which any deterministic function demonstrates.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i += 1) {
    h1 = Math.imul(h1 ^ input.charCodeAt(i), 16777619) >>> 0;
    h2 = Math.imul(h2 + input.charCodeAt(i) + i, 2246822519) >>> 0;
  }
  const block = (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).repeat(4);
  return block.slice(0, 64);
};

export const COMMA_UTF8: FileFormat = {
  encoding: 'utf-8',
  delimiter: ',',
  headerLineIndex: 0,
};

/** `Date | Description | Amount`, negative means money out. */
export function signedMapping(overrides: Partial<FileMapping> = {}): FileMapping {
  return {
    dateColumn: 0,
    descriptionColumn: 1,
    amount: { kind: 'signed', amountColumn: 2, negativeMeans: 'debit' },
    dateFormat: 'iso',
    account: { kind: 'existing', accountId: 'account-under-test' },
    ...overrides,
  } as FileMapping;
}

/** `Date | Description | Debit | Credit`. */
export function debitCreditMapping(overrides: Partial<FileMapping> = {}): FileMapping {
  return {
    dateColumn: 0,
    descriptionColumn: 1,
    amount: { kind: 'debit-credit', debitColumn: 2, creditColumn: 3 },
    dateFormat: 'iso',
    account: { kind: 'existing', accountId: 'account-under-test' },
    ...overrides,
  } as FileMapping;
}
