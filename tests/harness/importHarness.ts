import { createImportWorkerClient } from '../../src/import/importWorkerClient';
import type { ProgressPayload } from '../../src/import/workerProtocol';
import type { FileFormat, FileMapping } from '../../src/import/mapping';

/**
 * Test-only harness exposing the real worker client to Playwright.
 *
 * Built only under `vite build --mode e2e`. Nothing in the production entry
 * graph imports this file, so `npm run build` never emits it.
 */

interface HarnessResult {
  status: string;
  rowCount?: number;
  acceptedRows?: number;
  rejectedRows?: number;
  truncated?: boolean;
  distinctFingerprints?: number;
  failureCode?: string;
  /** Progress percentages, in the order they arrived. */
  progress: number[];
  /** Main-thread animation frames observed while the worker ran. */
  heartbeats: number;
  /** Wall-clock duration, reported for context only — never asserted against. */
  elapsedMs: number;
}

/**
 * Builds a deterministic CSV in memory.
 *
 * Generated rather than committed: a 100,000-row fixture would be several
 * megabytes in the repository forever.
 */
function generateCsv(rows: number): string {
  const merchants = [
    'PINEBROOK MARKET',
    'HARBOR BEAN COFFEE #114',
    'RIVERLINE TRANSIT FARE',
    'BAYSIDE DELI',
    'NORTHFIELD UTILITIES',
  ];

  const parts: string[] = ['Date,Description,Amount'];
  for (let index = 0; index < rows; index += 1) {
    // Deterministic: no Math.random, no Date.now.
    const day = (index % 28) + 1;
    const month = (Math.floor(index / 28) % 12) + 1;
    const cents = 100 + ((index * 37) % 9000);
    const merchant = merchants[index % merchants.length]!;
    const date = `2025-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    parts.push(
      `${date},${merchant} ${index},-${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`,
    );
  }
  return parts.join('\n');
}

const FORMAT: FileFormat = { encoding: 'utf-8', delimiter: ',', headerLineIndex: 0 };

const MAPPING = {
  dateColumn: 0,
  descriptionColumn: 1,
  amount: { kind: 'signed', amountColumn: 2, negativeMeans: 'debit' },
  dateFormat: 'iso',
  account: { kind: 'existing', accountId: 'harness-account' },
} as unknown as FileMapping;

declare global {
  interface Window {
    runImportHarness: (rows: number, maxRows: number) => Promise<HarnessResult>;
    cancelImportHarness: () => Promise<HarnessResult>;
    harnessNetworkCalls: string[];
    harnessConsoleOutput: string[];
  }
}

/* --------------------------------------------------- privacy instrumentation */

// Record every network attempt so a test can assert none carried personal data.
window.harnessNetworkCalls = [];
const originalFetch = window.fetch.bind(window);
window.fetch = ((...args: Parameters<typeof fetch>) => {
  window.harnessNetworkCalls.push(String(args[0]));
  return originalFetch(...args);
}) as typeof fetch;

const originalOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function open(
  this: XMLHttpRequest,
  method: string,
  url: string | URL,
  ...rest: unknown[]
) {
  window.harnessNetworkCalls.push(String(url));
  return (originalOpen as unknown as (...a: unknown[]) => void).call(this, method, url, ...rest);
} as typeof XMLHttpRequest.prototype.open;

// Record console output so a test can assert no cell value was ever logged.
window.harnessConsoleOutput = [];
for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    window.harnessConsoleOutput.push(args.map((a) => String(a)).join(' '));
    original(...args);
  };
}

/* ------------------------------------------------------------------- runs - */

function statusElement(): HTMLElement {
  const element = document.getElementById('status');
  if (!element) throw new Error('status element missing');
  return element;
}

window.runImportHarness = async (rows, maxRows) => {
  const client = createImportWorkerClient();
  const progress: number[] = [];
  let heartbeats = 0;
  let running = true;

  // A main-thread animation frame loop. If parsing were happening on the main
  // thread these would stop entirely while the file was processed.
  const beat = () => {
    heartbeats += 1;
    if (running) requestAnimationFrame(beat);
  };
  requestAnimationFrame(beat);

  const file = new File([generateCsv(rows)], 'harness-generated.csv', { type: 'text/csv' });
  statusElement().textContent = 'running';

  const started = performance.now();
  const outcome = await client.normalize(
    { file, format: FORMAT, mapping: MAPPING, accountId: 'harness-account', maxRows },
    { onProgress: (p: ProgressPayload) => progress.push(p.percent) },
  );
  const elapsedMs = performance.now() - started;

  running = false;
  client.dispose();
  statusElement().textContent = 'done';

  if (outcome.status !== 'ok') {
    return {
      status: outcome.status,
      failureCode: outcome.status === 'failed' ? outcome.failure.code : undefined,
      progress,
      heartbeats,
      elapsedMs,
    };
  }

  const fingerprints = new Set(outcome.result.rows.map((row) => row.fingerprint));

  return {
    status: 'ok',
    rowCount: outcome.result.rowCount,
    acceptedRows: outcome.result.rows.length,
    rejectedRows: outcome.result.rejections.length,
    truncated: outcome.result.truncated,
    distinctFingerprints: fingerprints.size,
    progress,
    heartbeats,
    elapsedMs,
  };
};

window.cancelImportHarness = async () => {
  const client = createImportWorkerClient({ generateRequestId: () => 'harness-cancel' });
  const progress: number[] = [];
  const file = new File([generateCsv(60_000)], 'harness-cancel.csv', { type: 'text/csv' });

  const started = performance.now();
  const pending = client.normalize(
    { file, format: FORMAT, mapping: MAPPING, accountId: 'harness-account', maxRows: 100_000 },
    { onProgress: (p: ProgressPayload) => progress.push(p.percent) },
  );

  // Cancel on the next frame, while the worker is certainly still working.
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  client.cancel('harness-cancel');

  const outcome = await pending;
  const elapsedMs = performance.now() - started;
  client.dispose();

  return { status: outcome.status, progress, heartbeats: 0, elapsedMs };
};

statusElement().textContent = 'ready';
