import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createImportWorkerClient,
  type ImportWorkerClient,
} from '../../../src/import/importWorkerClient';
import { IMPORT_PROTOCOL_VERSION, type ProgressPayload } from '../../../src/import/workerProtocol';
import { FakeWorker, fakeWorkerFactory, throwingWorkerFactory } from './helpers/fakeWorker';

const FILE = new File(['Date,Description,Amount\n2026-01-02,COFFEE,-4.75\n'], 'statement.csv', {
  type: 'text/csv',
});

let client: ImportWorkerClient;

function newClient(overrides: Parameters<typeof createImportWorkerClient>[0] = {}) {
  return createImportWorkerClient({
    createWorker: fakeWorkerFactory(),
    generateRequestId: () => 'req-1',
    ...overrides,
  });
}

/** Builds a well-formed response envelope for the worker under test. */
function envelope(kind: string, requestId: string, extra: Record<string, unknown> = {}) {
  return { protocol: IMPORT_PROTOCOL_VERSION, kind, requestId, ...extra };
}

const INSPECTION = {
  fileName: 'statement.csv',
  byteLength: 42,
  encoding: { encoding: 'utf-8', confidence: 'high', reason: 'valid UTF-8', bomLength: 0 },
  delimiter: { delimiter: ',', confidence: 'high', reason: 'comma', scores: [] },
  header: {
    headerLineIndex: 0,
    columns: ['Date', 'Description', 'Amount'],
    confidence: 'high',
    reason: 'looks like a header',
    skippedLines: 0,
  },
  sampleRows: [['2026-01-02', 'COFFEE', '-4.75']],
  sampleLineCount: 2,
};

const NORMALIZED = {
  fileName: 'statement.csv',
  rowCount: 1,
  rows: [{ id: 'x' }],
  rejections: [],
  questions: [],
  structuralWarnings: [],
  truncated: false,
  hadInvalidBytes: false,
};

beforeEach(() => {
  FakeWorker.reset();
  client = newClient();
});

afterEach(() => {
  client.dispose();
  FakeWorker.reset();
});

describe('successful requests', () => {
  it('resolves an inspection with the worker result', async () => {
    const pending = client.inspect(FILE);
    FakeWorker.last.emitMessage(envelope('inspected', 'req-1', { result: INSPECTION }));

    const outcome = await pending;
    expect(outcome.status).toBe('ok');
    if (outcome.status === 'ok') expect(outcome.result.header?.columns).toHaveLength(3);
  });

  it('resolves a normalization with the worker result', async () => {
    const pending = client.normalize({
      file: FILE,
      format: { encoding: 'utf-8', delimiter: ',', headerLineIndex: 0 },
      mapping: {
        dateColumn: 0,
        descriptionColumn: 1,
        amount: { kind: 'signed', amountColumn: 2, negativeMeans: 'debit' },
        dateFormat: 'iso',
        account: { kind: 'existing', accountId: 'a1' },
      } as never,
      accountId: 'a1',
      maxRows: 100,
    });

    FakeWorker.last.emitMessage(envelope('normalized', 'req-1', { result: NORMALIZED }));

    const outcome = await pending;
    expect(outcome.status).toBe('ok');
    if (outcome.status === 'ok') expect(outcome.result.rowCount).toBe(1);
  });

  it('sends the file itself so reading happens in the worker', async () => {
    const pending = client.inspect(FILE);
    const sent = FakeWorker.last.posted[0] as { file: File; kind: string };

    expect(sent.kind).toBe('inspect');
    expect(sent.file).toBe(FILE);

    FakeWorker.last.emitMessage(envelope('inspected', 'req-1', { result: INSPECTION }));
    await pending;
  });
});

describe('protocol validation', () => {
  it('fails safely on a malformed response', async () => {
    const pending = client.inspect(FILE);
    FakeWorker.last.emitMessage({ not: 'a protocol message' });

    const outcome = await pending;
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.failure.code).toBe('worker-failed');
  });

  it('fails safely when the result payload does not match the schema', async () => {
    const pending = client.inspect(FILE);
    FakeWorker.last.emitMessage(envelope('inspected', 'req-1', { result: { bogus: true } }));

    const outcome = await pending;
    expect(outcome.status).toBe('failed');
  });

  it('ignores a response carrying a different requestId', async () => {
    const pending = client.inspect(FILE);
    const worker = FakeWorker.last;

    worker.emitMessage(envelope('inspected', 'someone-elses-request', { result: INSPECTION }));
    // Still unsettled: the stale message was dropped.
    expect(worker.terminated).toBe(false);

    worker.emitMessage(envelope('inspected', 'req-1', { result: INSPECTION }));
    expect((await pending).status).toBe('ok');
  });
});

describe('progress', () => {
  it('reports monotonic, bounded percentages tied to the request', async () => {
    const seen: ProgressPayload[] = [];
    const pending = client.inspect(FILE, { onProgress: (p) => seen.push(p) });
    const worker = FakeWorker.last;

    for (const percent of [0, 10, 40, 40, 90]) {
      worker.emitMessage(
        envelope('progress', 'req-1', {
          stage: 'normalizing',
          processed: percent,
          total: 100,
          percent,
        }),
      );
    }
    worker.emitMessage(envelope('inspected', 'req-1', { result: INSPECTION }));
    await pending;

    expect(seen.length).toBe(5);
    expect(seen.every((p) => p.percent >= 0 && p.percent <= 100)).toBe(true);
    // The client forwards what it is given; the worker guarantees monotonicity.
    const percents = seen.map((p) => p.percent);
    expect([...percents].sort((a, b) => a - b)).toEqual(percents);
  });

  it('drops progress that arrives after the request settled', async () => {
    const seen: ProgressPayload[] = [];
    const pending = client.inspect(FILE, { onProgress: (p) => seen.push(p) });
    const worker = FakeWorker.last;

    worker.emitMessage(envelope('inspected', 'req-1', { result: INSPECTION }));
    await pending;

    worker.emitMessage(
      envelope('progress', 'req-1', { stage: 'normalizing', processed: 1, total: 1, percent: 100 }),
    );
    expect(seen).toHaveLength(0);
  });

  it('ignores progress with an unknown requestId', async () => {
    const seen: ProgressPayload[] = [];
    const pending = client.inspect(FILE, { onProgress: (p) => seen.push(p) });
    const worker = FakeWorker.last;

    worker.emitMessage(
      envelope('progress', 'other', { stage: 'parsing', processed: 1, total: 2, percent: 50 }),
    );
    expect(seen).toHaveLength(0);

    worker.emitMessage(envelope('inspected', 'req-1', { result: INSPECTION }));
    await pending;
  });
});

describe('cancellation', () => {
  it('cancels before the worker has produced anything', async () => {
    const pending = client.inspect(FILE);
    const worker = FakeWorker.last;

    client.cancel('req-1');

    expect((await pending).status).toBe('cancelled');
    expect(worker.terminated).toBe(true);
  });

  it('cancels mid-flight and terminates rather than waiting politely', async () => {
    const pending = client.inspect(FILE);
    const worker = FakeWorker.last;

    worker.emitMessage(
      envelope('progress', 'req-1', { stage: 'normalizing', processed: 5, total: 100, percent: 5 }),
    );
    client.cancel('req-1');

    expect((await pending).status).toBe('cancelled');
    expect(worker.terminated).toBe(true);
  });

  it('cannot be resolved successfully after cancellation', async () => {
    const pending = client.inspect(FILE);
    const worker = FakeWorker.last;

    client.cancel('req-1');
    // A terminated worker delivers nothing; even if it did, the request is settled.
    worker.emitMessage(envelope('inspected', 'req-1', { result: INSPECTION }));

    expect((await pending).status).toBe('cancelled');
  });

  it('is harmless after completion', async () => {
    const pending = client.inspect(FILE);
    FakeWorker.last.emitMessage(envelope('inspected', 'req-1', { result: INSPECTION }));
    expect((await pending).status).toBe('ok');

    expect(() => client.cancel('req-1')).not.toThrow();
    expect(client.activeRequestIds).toHaveLength(0);
  });

  it('is harmless for an unknown request id', () => {
    expect(() => client.cancel('never-existed')).not.toThrow();
  });

  it('does not affect an unrelated later request', async () => {
    const ids = ['req-a', 'req-b'];
    let index = 0;
    const scoped = newClient({ generateRequestId: () => ids[index++]! });

    const first = scoped.inspect(FILE);
    const firstWorker = FakeWorker.last;
    scoped.cancel('req-a');
    expect((await first).status).toBe('cancelled');

    const second = scoped.inspect(FILE);
    const secondWorker = FakeWorker.last;
    expect(secondWorker).not.toBe(firstWorker);

    secondWorker.emitMessage(envelope('inspected', 'req-b', { result: INSPECTION }));
    expect((await second).status).toBe('ok');

    scoped.dispose();
  });
});

describe('terminal settlement', () => {
  it('settles exactly once when duplicate terminal messages arrive', async () => {
    const pending = client.inspect(FILE);
    const worker = FakeWorker.last;

    worker.emitMessage(envelope('inspected', 'req-1', { result: INSPECTION }));
    // The worker is terminated by settlement, so these cannot even be delivered.
    worker.emitMessage(
      envelope('failed', 'req-1', { failure: { code: 'worker-failed', message: 'x' } }),
    );
    worker.emitMessage(envelope('cancelled', 'req-1'));

    expect((await pending).status).toBe('ok');
  });

  it('forwards a typed worker failure', async () => {
    const pending = client.inspect(FILE);
    FakeWorker.last.emitMessage(
      envelope('failed', 'req-1', {
        failure: {
          code: 'file-too-large',
          message: 'That file is larger than the import size limit.',
        },
      }),
    );

    const outcome = await pending;
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.failure.code).toBe('file-too-large');
  });
});

describe('failure paths', () => {
  it('fails when the worker cannot be constructed', async () => {
    const blocked = createImportWorkerClient({
      createWorker: throwingWorkerFactory(),
      generateRequestId: () => 'req-1',
    });

    const outcome = await blocked.inspect(FILE);
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.failure.code).toBe('worker-failed');
    blocked.dispose();
  });

  it('fails when postMessage throws', async () => {
    const scoped = newClient();
    const original = FakeWorker.prototype.postMessage;
    FakeWorker.prototype.postMessage = function throwing() {
      throw new Error('structured clone failed');
    };

    const outcome = await scoped.inspect(FILE);
    FakeWorker.prototype.postMessage = original;

    expect(outcome.status).toBe('failed');
    scoped.dispose();
  });

  it('fails on a worker error event', async () => {
    const pending = client.inspect(FILE);
    FakeWorker.last.emitError();
    expect((await pending).status).toBe('failed');
  });

  it('fails on messageerror', async () => {
    const pending = client.inspect(FILE);
    FakeWorker.last.emitMessageError();
    expect((await pending).status).toBe('failed');
  });
});

describe('cleanup', () => {
  it('removes every listener and terminates the worker on success', async () => {
    const pending = client.inspect(FILE);
    const worker = FakeWorker.last;
    expect(worker.listenerCount).toBeGreaterThan(0);

    worker.emitMessage(envelope('inspected', 'req-1', { result: INSPECTION }));
    await pending;

    expect(worker.listenerCount).toBe(0);
    expect(worker.terminated).toBe(true);
    expect(client.activeRequestIds).toHaveLength(0);
  });

  it('removes every listener and terminates on failure', async () => {
    const pending = client.inspect(FILE);
    const worker = FakeWorker.last;

    worker.emitError();
    await pending;

    expect(worker.listenerCount).toBe(0);
    expect(worker.terminated).toBe(true);
  });

  it('dispose settles and terminates everything in flight', async () => {
    const ids = ['a', 'b'];
    let index = 0;
    const scoped = newClient({ generateRequestId: () => ids[index++]! });

    const first = scoped.inspect(FILE);
    const firstWorker = FakeWorker.last;
    const second = scoped.inspect(FILE);
    const secondWorker = FakeWorker.last;

    scoped.dispose();

    expect((await first).status).toBe('cancelled');
    expect((await second).status).toBe('cancelled');
    expect(firstWorker.terminated).toBe(true);
    expect(secondWorker.terminated).toBe(true);
    expect(scoped.activeRequestIds).toHaveLength(0);
  });

  it('dispose is idempotent', () => {
    const scoped = newClient();
    expect(() => {
      scoped.dispose();
      scoped.dispose();
      scoped.dispose();
    }).not.toThrow();
  });

  it('refuses new work after disposal instead of leaking a worker', async () => {
    const scoped = newClient();
    scoped.dispose();

    const before = FakeWorker.instances.length;
    const outcome = await scoped.inspect(FILE);

    expect(outcome.status).toBe('failed');
    expect(FakeWorker.instances.length).toBe(before);
  });
});

describe('sanitized failures carry no personal values', () => {
  it('never echoes the filename or file content into a generic failure', async () => {
    const secretFile = new File(
      ['Date,Description,Amount\n2026-01-02,CANARY-MERCHANT-9137,-42.00\n'],
      'CANARY-FILENAME-9137.csv',
      { type: 'text/csv' },
    );

    const scoped = newClient();
    const pending = scoped.inspect(secretFile);
    FakeWorker.last.emitError();

    const outcome = await pending;
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      const text = JSON.stringify(outcome.failure);
      expect(text).not.toContain('CANARY-MERCHANT-9137');
      expect(text).not.toContain('CANARY-FILENAME-9137');
      expect(text).not.toContain('42.00');
    }
    scoped.dispose();
  });

  it('logs nothing to the console during a full request cycle', async () => {
    const spies = {
      log: vi.spyOn(console, 'log').mockImplementation(() => {}),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
      info: vi.spyOn(console, 'info').mockImplementation(() => {}),
      debug: vi.spyOn(console, 'debug').mockImplementation(() => {}),
    };

    const scoped = newClient();
    const pending = scoped.inspect(FILE);
    FakeWorker.last.emitMessage(envelope('inspected', 'req-1', { result: INSPECTION }));
    await pending;
    scoped.dispose();

    for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
  });
});
