import { describe, expect, it } from 'vitest';
import {
  backupFilename,
  buildBackupDocument,
  parseBackup,
  sanitizeFilename,
  serializeBackup,
} from '../../../src/db/backup';
import { BACKUP_FORMAT, MAX_TEXT_FIELD_LENGTH } from '../../../src/db/backupSchema';
import { SCHEMA_VERSION } from '../../../src/db/schema';
import { emptySnapshot } from '../../../src/db/workspace';
import { buildDemoWorkspace } from '../../../src/data/demo/dataset';
import { fixedClock } from '../../../src/lib/clock';

const CLOCK = fixedClock('2026-08-01T12:00:00.000Z');

function demoBackupText(): string {
  return serializeBackup(buildBackupDocument(buildDemoWorkspace(), CLOCK));
}

describe('building a backup', () => {
  it('stamps the format, versions, and declared counts', () => {
    const document = buildBackupDocument(buildDemoWorkspace(), CLOCK);

    expect(document.format).toBe(BACKUP_FORMAT);
    expect(document.formatVersion).toBe(1);
    expect(document.schemaVersion).toBe(SCHEMA_VERSION);
    expect(document.exportedAt).toBe(CLOCK());
    expect(document.counts.transactions).toBe(document.data.transactions.length);
  });

  it('round-trips an empty workspace', () => {
    const text = serializeBackup(buildBackupDocument(emptySnapshot(), CLOCK));
    const parsed = parseBackup(text);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.document.data.transactions).toHaveLength(0);
  });

  it('round-trips the demo workspace without losing a record', () => {
    const original = buildDemoWorkspace();
    const parsed = parseBackup(demoBackupText());

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    for (const table of Object.keys(original) as (keyof typeof original)[]) {
      expect(parsed.document.data[table]).toHaveLength(original[table].length);
    }
    expect(parsed.document.data.transactions[0]).toEqual(original.transactions[0]);
  });
});

describe('rejecting a backup', () => {
  it('refuses text that is not JSON', () => {
    const result = parseBackup('this is not json {');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('not-json');
      expect(result.message).toMatch(/nothing was changed/i);
    }
  });

  it('refuses a JSON document that is not one of our backups', () => {
    const result = parseBackup(JSON.stringify({ hello: 'world' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unrecognized-format');
  });

  it('refuses a newer schema version outright instead of guessing a conversion', () => {
    const document = JSON.parse(demoBackupText()) as Record<string, unknown>;
    document.schemaVersion = SCHEMA_VERSION + 1;

    const result = parseBackup(JSON.stringify(document));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('future-schema-version');
      expect(result.message).toMatch(/newer version/i);
    }
  });

  it('refuses a newer backup format version', () => {
    const document = JSON.parse(demoBackupText()) as Record<string, unknown>;
    document.formatVersion = 99;

    const result = parseBackup(JSON.stringify(document));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('future-format-version');
  });

  it('refuses a truncated document whose declared counts no longer match', () => {
    const document = JSON.parse(demoBackupText()) as {
      data: { transactions: unknown[] };
      counts: Record<string, number>;
    };
    document.data.transactions = document.data.transactions.slice(0, 5);

    const result = parseBackup(JSON.stringify(document));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('count-mismatch');
      expect(result.problemPaths).toContain('counts.transactions');
    }
  });

  it('refuses a row with the wrong field types', () => {
    const document = JSON.parse(demoBackupText()) as {
      data: { transactions: Record<string, unknown>[] };
    };
    document.data.transactions[0]!.amountCents = 'not a number';

    const result = parseBackup(JSON.stringify(document));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid-shape');
      expect(result.problemPaths.join(' ')).toContain('data.transactions.0.amountCents');
    }
  });

  it('refuses a negative amount, because amountCents is an unsigned magnitude', () => {
    const document = JSON.parse(demoBackupText()) as {
      data: { transactions: Record<string, unknown>[] };
    };
    document.data.transactions[0]!.amountCents = -500;

    const result = parseBackup(JSON.stringify(document));
    expect(result.ok).toBe(false);
  });

  it('refuses an unknown category, because the category set is closed in v1.0', () => {
    const document = JSON.parse(demoBackupText()) as {
      data: { transactions: Record<string, unknown>[] };
    };
    document.data.transactions[0]!.categoryId = 'crypto_moonshots';

    const result = parseBackup(JSON.stringify(document));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid-shape');
  });

  it('refuses a backup that tries to switch rollover on', () => {
    const document = JSON.parse(demoBackupText()) as {
      data: { budgetPlans: Record<string, unknown>[] };
    };
    document.data.budgetPlans[0]!.rolloverEnabled = true;

    expect(parseBackup(JSON.stringify(document)).ok).toBe(false);
  });

  it('refuses an absurdly long text field rather than exhausting memory', () => {
    const document = JSON.parse(demoBackupText()) as {
      data: { transactions: Record<string, unknown>[] };
    };
    document.data.transactions[0]!.descriptionRaw = 'A'.repeat(MAX_TEXT_FIELD_LENGTH + 1);

    expect(parseBackup(JSON.stringify(document)).ok).toBe(false);
  });

  it('never echoes a rejected value back in the error output', () => {
    const secret = 'SUPER-SECRET-MERCHANT-9999';
    const document = JSON.parse(demoBackupText()) as {
      data: { transactions: Record<string, unknown>[] };
    };
    document.data.transactions[0]!.direction = secret;

    const result = parseBackup(JSON.stringify(document));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // threat-model.md §15 item 4: errors carry field names, never values.
      const output = `${result.message} ${result.problemPaths.join(' ')}`;
      expect(output).not.toContain(secret);
      expect(output).toContain('data.transactions.0.direction');
    }
  });
});

describe('unknown fields', () => {
  it('strips keys the schema does not know, so they can never reach storage', () => {
    const document = JSON.parse(demoBackupText()) as {
      data: { transactions: Record<string, unknown>[] };
    };
    document.data.transactions[0]!.smuggledField = 'payload';

    const result = parseBackup(JSON.stringify(document));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.document.data.transactions[0]).not.toHaveProperty('smuggledField');
    }
  });
});

describe('filename neutralization', () => {
  it('strips path separators so a name cannot traverse directories', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('etc-passwd.json');
    expect(sanitizeFilename('C:\\Windows\\System32\\evil')).toBe('C--Windows-System32-evil.json');
  });

  it('replaces reserved Windows device names', () => {
    expect(sanitizeFilename('CON')).toBe('workspace-backup.json');
    expect(sanitizeFilename('lpt1.json')).toBe('workspace-backup.json');
  });

  it('falls back when nothing usable remains', () => {
    expect(sanitizeFilename('...')).toBe('workspace-backup.json');
    expect(sanitizeFilename('   ')).toBe('workspace-backup.json');
  });

  it('always produces a single .json extension', () => {
    expect(sanitizeFilename('backup.json')).toBe('backup.json');
    expect(sanitizeFilename('backup')).toBe('backup.json');
  });

  it('names the download by export date', () => {
    expect(backupFilename('2026-08-01T12:00:00.000Z')).toBe(
      'tri-state-spending-lens-backup-2026-08-01.json',
    );
    expect(backupFilename('nonsense')).toBe('tri-state-spending-lens-backup-export.json');
  });
});
