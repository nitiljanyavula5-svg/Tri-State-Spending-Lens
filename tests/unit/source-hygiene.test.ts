import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The source tree carries no control characters.
 *
 * This has gone wrong twice. A NUL byte reached the query service as a
 * date-bound sentinel in Phase 4C and made Git classify the file as binary; a
 * `0x01` reached the relationship collector in Phase 4E as a composite-key
 * separator. Both were invisible in review and both survived a hand-rolled
 * sweep that silently scanned nothing.
 *
 * So the sweep lives here instead, where it runs on every commit and fails
 * loudly. It also asserts that it actually read files — a scanner that walks an
 * empty set reports a clean tree just as convincingly as one that works.
 */

const ROOTS = ['src', 'tests'] as const;
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'test-results', 'playwright-report']);

/**
 * Bytes that must never appear.
 *
 * Tab, line feed, and carriage return are the three C0 characters source files
 * legitimately contain. Everything else in C0, plus DEL, is either invisible or
 * actively hostile to review and to Git's text/binary detection.
 */
function offendingBytes(bytes: Buffer): Array<{ offset: number; byte: string }> {
  const found: Array<{ offset: number; byte: string }> = [];
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index]!;
    const allowed = byte === 0x09 || byte === 0x0a || byte === 0x0d;
    if (allowed) continue;
    if (byte < 0x20 || byte === 0x7f) {
      found.push({ offset: index, byte: `0x${byte.toString(16).padStart(2, '0')}` });
    }
  }
  return found;
}

function filesUnder(directory: string): string[] {
  const collected: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (SKIP_DIRECTORIES.has(entry)) continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) collected.push(...filesUnder(path));
    else collected.push(path);
  }
  return collected;
}

describe('source hygiene', () => {
  const files = ROOTS.flatMap((root) => filesUnder(root));

  it('reads a real set of files, so a clean result means something', () => {
    // Guards the failure mode that hid both earlier escapes: a path filter that
    // matched nothing and reported success.
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((path) => path.includes('relationshipCommands'))).toBe(true);
  });

  it('contains no control or NUL bytes outside tab, newline, and carriage return', () => {
    const offenders = files
      .map((path) => ({ path, bytes: offendingBytes(readFileSync(path)) }))
      .filter((entry) => entry.bytes.length > 0)
      .map(
        (entry) => `${entry.path} — ${entry.bytes[0]!.byte} at offset ${entry.bytes[0]!.offset}`,
      );

    expect(offenders).toEqual([]);
  });
});
