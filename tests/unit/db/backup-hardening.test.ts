import { describe, expect, it } from 'vitest';
import {
  checkBackupFileSize,
  parseBackup,
  serializeBackup,
  buildBackupDocument,
  type BackupRejectionReason,
} from '../../../src/db/backup';
import { MAX_BACKUP_BYTES, MAX_ROWS } from '../../../src/db/backupSchema';
import { buildDemoWorkspace } from '../../../src/data/demo/dataset';
import { fixedClock } from '../../../src/lib/clock';

const CLOCK = fixedClock('2026-08-01T12:00:00.000Z');

type MutableDocument = {
  format: string;
  formatVersion: number;
  schemaVersion: number;
  exportedAt: string;
  counts: Record<string, number>;
  data: Record<string, Record<string, unknown>[]>;
};

function validDocument(): MutableDocument {
  return JSON.parse(
    serializeBackup(buildBackupDocument(buildDemoWorkspace(), CLOCK)),
  ) as MutableDocument;
}

/** Applies a mutation and returns the rejection reason, or null if accepted. */
function rejectionFor(mutate: (doc: MutableDocument) => void): BackupRejectionReason | null {
  const doc = validDocument();
  mutate(doc);
  const result = parseBackup(JSON.stringify(doc));
  return result.ok ? null : result.reason;
}

describe('the unmodified demo backup still validates', () => {
  it('passes every new check', () => {
    const result = parseBackup(JSON.stringify(validDocument()));
    if (!result.ok) {
      throw new Error(`unexpected rejection: ${result.reason} ${result.problemPaths.join(', ')}`);
    }
    expect(result.ok).toBe(true);
  });
});

describe('file size', () => {
  it('refuses an oversized file from its declared size, before any bytes are read', () => {
    const rejection = checkBackupFileSize(MAX_BACKUP_BYTES + 1);
    expect(rejection?.reason).toBe('file-too-large');
    expect(rejection?.message).toMatch(/nothing was changed/i);
  });

  it('accepts a file at exactly the limit', () => {
    expect(checkBackupFileSize(MAX_BACKUP_BYTES)).toBeNull();
  });

  it('refuses oversized text in parseBackup too, so no caller can bypass the limit', () => {
    const oversized = 'x'.repeat(MAX_BACKUP_BYTES + 1);
    const result = parseBackup(oversized);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('file-too-large');
  });
});

describe('row-count ceilings', () => {
  it('refuses more rows than a table may hold', () => {
    const doc = validDocument();
    const template = doc.data.accounts[0]!;
    doc.data.accounts = Array.from({ length: MAX_ROWS.accounts + 1 }, (_, index) => ({
      ...template,
      id: `account-${index}`,
    }));
    doc.counts.accounts = doc.data.accounts.length;

    const result = parseBackup(JSON.stringify(doc));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid-shape');
  });

  it('refuses an unbounded nested array', () => {
    expect(
      rejectionFor((doc) => {
        doc.data.transactions[0]!.tags = Array.from({ length: 500 }, (_, i) => `tag-${i}`);
      }),
    ).toBe('invalid-shape');
  });
});

describe('real calendar dates, months, and timestamps', () => {
  const impossibleDates = ['2026-02-30', '2026-13-01', '2026-04-31', '2025-02-29', '2026-00-10'];

  it.each(impossibleDates)('refuses %s as a posted date', (value) => {
    expect(rejectionFor((doc) => (doc.data.transactions[0]!.postedDate = value))).toBe(
      'invalid-shape',
    );
  });

  it('accepts a real leap day', () => {
    // 2028 is a leap year; the pattern and the calendar must both agree.
    expect(rejectionFor((doc) => (doc.data.transactions[0]!.postedDate = '2028-02-29'))).toBeNull();
  });

  it('refuses an impossible budget month', () => {
    expect(rejectionFor((doc) => (doc.data.budgetPlans[0]!.month = '2026-13'))).toBe(
      'invalid-shape',
    );
  });

  it.each([
    'not a timestamp',
    '2026-08-01',
    '2026-02-30T00:00:00.000Z',
    '2026-08-01T25:00:00.000Z',
    '2026-08-01T00:00:00+02:00',
  ])('refuses %s as a timestamp', (value) => {
    expect(rejectionFor((doc) => (doc.data.transactions[0]!.createdAt = value))).toBe(
      'invalid-shape',
    );
  });
});

describe('settings are validated per key', () => {
  it('refuses an unrecognized setting key', () => {
    expect(
      rejectionFor((doc) => {
        doc.data.appSettings.push({
          key: 'arbitraryInjectedKey',
          value: 'anything at all',
          updatedAt: '2026-08-01T00:00:00.000Z',
        });
        doc.counts.appSettings = doc.data.appSettings.length;
      }),
    ).toBe('invalid-shape');
  });

  it('refuses a known key carrying the wrong kind of value', () => {
    expect(
      rejectionFor((doc) => {
        const setting = doc.data.appSettings.find((row) => row.key === 'workspaceMode')!;
        setting.value = 'not-a-mode';
      }),
    ).toBe('invalid-shape');
  });

  it('refuses a boolean setting given a string', () => {
    expect(
      rejectionFor((doc) => {
        const setting = doc.data.appSettings.find((row) => row.key === 'incomeDataComplete')!;
        setting.value = 'yes';
      }),
    ).toBe('invalid-shape');
  });
});

describe('counts must be exact', () => {
  it('refuses a missing count', () => {
    expect(rejectionFor((doc) => delete doc.counts.transactions)).toBe('invalid-shape');
  });

  it('refuses an extra count for a table that is not backed up', () => {
    expect(rejectionFor((doc) => (doc.counts.schemaMigrations = 1))).toBe('invalid-shape');
  });

  it('refuses a count that disagrees with the data', () => {
    expect(rejectionFor((doc) => (doc.counts.accounts = 99))).toBe('count-mismatch');
  });
});

describe('referential and semantic consistency', () => {
  it('refuses duplicate primary keys', () => {
    expect(
      rejectionFor((doc) => {
        doc.data.accounts.push({ ...doc.data.accounts[0]! });
        doc.counts.accounts = doc.data.accounts.length;
      }),
    ).toBe('inconsistent-references');
  });

  it('refuses two budget plans claiming the same month', () => {
    expect(
      rejectionFor((doc) => {
        doc.data.budgetPlans.push({ ...doc.data.budgetPlans[0]!, id: 'another-plan' });
        doc.counts.budgetPlans = doc.data.budgetPlans.length;
      }),
    ).toBe('inconsistent-references');
  });

  it('refuses a transaction pointing at an account the file does not contain', () => {
    expect(
      rejectionFor((doc) => (doc.data.transactions[0]!.accountId = 'account-not-in-this-file')),
    ).toBe('inconsistent-references');
  });

  it('refuses a transaction pointing at an unknown import session', () => {
    expect(
      rejectionFor((doc) => (doc.data.transactions[0]!.importSessionId = 'session-not-here')),
    ).toBe('inconsistent-references');
  });

  it('refuses a budget target pointing at an unknown plan', () => {
    expect(
      rejectionFor((doc) => (doc.data.budgetCategoryTargets[0]!.budgetPlanId = 'no-such-plan')),
    ).toBe('inconsistent-references');
  });

  it('refuses a recurring series citing a transaction that is not present', () => {
    expect(
      rejectionFor((doc) => {
        doc.data.recurringSeries[0]!.transactionIds = ['demo-txn-does-not-exist'];
      }),
    ).toBe('inconsistent-references');
  });

  it('refuses a user edit naming a field that entity type does not have', () => {
    expect(rejectionFor((doc) => (doc.data.userEdits[0]!.field = 'amountCents'))).toBe(
      'inconsistent-references',
    );
  });

  it('refuses an import session citing an account the file does not contain', () => {
    expect(
      rejectionFor((doc) => {
        doc.data.importSessions[0]!.accountIds = ['demo-account-checking', 'ghost-account'];
      }),
    ).toBe('inconsistent-references');
  });

  it('refuses a user edit pointing at a recurring series that is absent', () => {
    expect(
      rejectionFor((doc) => {
        doc.data.userEdits[0]!.entityId = 'demo-recurring-does-not-exist';
      }),
    ).toBe('inconsistent-references');
  });

  it('refuses a transaction-scoped user edit pointing at a missing transaction', () => {
    expect(
      rejectionFor((doc) => {
        doc.data.userEdits[0]!.entityType = 'transaction';
        doc.data.userEdits[0]!.field = 'categoryId';
        doc.data.userEdits[0]!.entityId = 'demo-txn-9999';
      }),
    ).toBe('inconsistent-references');
  });

  it('accepts a transaction-scoped user edit that does reference a real transaction', () => {
    expect(
      rejectionFor((doc) => {
        doc.data.userEdits[0]!.entityType = 'transaction';
        doc.data.userEdits[0]!.field = 'categoryId';
        doc.data.userEdits[0]!.entityId = doc.data.transactions[0]!.id as string;
      }),
    ).toBeNull();
  });

  it('refuses a statement range that ends before it starts', () => {
    expect(
      rejectionFor((doc) => {
        doc.data.importSessions[0]!.statementRangeStart = '2026-07-31';
        doc.data.importSessions[0]!.statementRangeEnd = '2026-04-01';
      }),
    ).toBe('inconsistent-references');
  });

  it('refuses a recurring series whose minimum exceeds its maximum', () => {
    expect(
      rejectionFor((doc) => {
        doc.data.recurringSeries[0]!.amountMinCents = 900_000;
      }),
    ).toBe('inconsistent-references');
  });

  it('refuses a typical amount outside the observed range', () => {
    expect(
      rejectionFor((doc) => {
        doc.data.recurringSeries[0]!.typicalAmountCents = 1;
      }),
    ).toBe('inconsistent-references');
  });
});

describe('rejection messages stay value-free', () => {
  it('names paths without echoing the offending content', () => {
    const secret = 'ATTACKER-CONTROLLED-STRING-42';
    const doc = validDocument();
    doc.data.transactions[0]!.accountId = secret;

    const result = parseBackup(JSON.stringify(doc));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const output = `${result.message} ${result.problemPaths.join(' ')}`;
      expect(output).not.toContain(secret);
      expect(output).toContain('data.transactions.0.accountId');
    }
  });
});
