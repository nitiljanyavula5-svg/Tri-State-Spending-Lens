/// <reference lib="webworker" />

import { decodeBytes, detectEncoding } from './decode';
import { detectDelimiter, detectHeaderRow, splitLines } from './detectFormat';
import { validateFile } from './fileValidation';
import { DETECTION_SAMPLE_BYTES, MAX_COLUMNS, MAX_PREVIEW_ROWS, MAX_SESSION_ROWS } from './limits';
import { normalizeFile } from './normalizeFile';
import {
  buildFailure,
  IMPORT_PROTOCOL_VERSION,
  parseWorkerRequest,
  type InspectionResult,
  type NormalizeRequest,
  type InspectRequest,
  type ProgressStage,
  type WorkerResponse,
} from './workerProtocol';

/**
 * The import worker.
 *
 * Everything expensive — reading the file, decoding, parsing, normalizing, and
 * hashing — happens here, off the main thread. The worker owns no state beyond
 * the in-flight request, makes no network request, writes to no storage, and
 * logs nothing.
 *
 * It deliberately does **not** reimplement normalization: it calls the same
 * `normalizeFile` the tests drive directly, so there is exactly one pipeline.
 */

const ctx = self as unknown as DedicatedWorkerGlobalScope;

/** Requests the main thread asked us to abandon. */
const cancelled = new Set<string>();

function post(message: WorkerResponse): void {
  ctx.postMessage(message);
}

function fail(
  requestId: string,
  code: Parameters<typeof buildFailure>[0],
  fileName?: string,
): void {
  post({
    protocol: IMPORT_PROTOCOL_VERSION,
    kind: 'failed',
    requestId,
    failure: buildFailure(code, fileName),
  });
}

/**
 * Emits monotonic, bounded progress.
 *
 * Percent never decreases and never repeats, so the client can trust it without
 * tracking history, and a 100,000-row file produces at most ~100 messages
 * rather than 100,000.
 */
function createProgressReporter(requestId: string) {
  let lastPercent = -1;

  return (
    stage: ProgressStage,
    processed: number,
    total: number,
    floor: number,
    ceiling: number,
  ) => {
    const fraction = total > 0 ? Math.min(1, processed / total) : 0;
    const percent = Math.min(100, Math.round(floor + fraction * (ceiling - floor)));
    if (percent <= lastPercent) return;
    lastPercent = percent;

    post({
      protocol: IMPORT_PROTOCOL_VERSION,
      kind: 'progress',
      requestId,
      stage,
      processed: Math.min(processed, MAX_SESSION_ROWS),
      total: Math.min(total, MAX_SESSION_ROWS),
      percent,
    });
  };
}

/** Reads a File into bytes inside the worker, never on the main thread. */
async function readBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

/* -------------------------------------------------------------- inspect - */

async function handleInspect(request: InspectRequest): Promise<void> {
  const { requestId, file } = request;

  // Limits are enforced here, not merely in the UI, so a caller cannot bypass
  // them by talking to the worker directly (threat-model.md §6).
  const invalid = validateFile({ name: file.name, size: file.size, type: '' });
  if (invalid) {
    fail(requestId, invalid.code as Parameters<typeof buildFailure>[0], invalid.fileName);
    return;
  }

  const progress = createProgressReporter(requestId);
  progress('reading', 0, 1, 0, 10);

  let bytes: Uint8Array | null = await readBytes(file);
  if (cancelled.has(requestId)) {
    bytes = null;
    return;
  }

  // Detection only ever looks at a bounded prefix.
  const sample = bytes.subarray(0, DETECTION_SAMPLE_BYTES);
  const encoding = detectEncoding(sample);

  const decoded = decodeBytes(sample, encoding.encoding, file.name);
  if (!decoded.ok) {
    bytes = null;
    fail(requestId, 'encoding-unsupported', file.name);
    return;
  }

  progress('parsing', 1, 2, 10, 60);

  const lines = splitLines(decoded.text);
  const delimiter = detectDelimiter(lines);
  const header = detectHeaderRow(lines, delimiter.delimiter);

  if (header && header.columns.length > MAX_COLUMNS) {
    bytes = null;
    fail(requestId, 'too-many-columns', file.name);
    return;
  }

  const start = header ? header.headerLineIndex + 1 : 0;
  const sampleRows = lines
    .slice(start, start + MAX_PREVIEW_ROWS)
    .filter((line) => line.trim().length > 0)
    .map((line) => line.split(delimiter.delimiter).slice(0, MAX_COLUMNS));

  const result: InspectionResult = {
    fileName: file.name,
    byteLength: file.size,
    encoding,
    delimiter,
    header,
    sampleRows,
    sampleLineCount: lines.length,
  };

  // Release the file's bytes before the (potentially large) message is posted.
  bytes = null;

  if (cancelled.has(requestId)) return;
  progress('parsing', 2, 2, 60, 100);
  post({ protocol: IMPORT_PROTOCOL_VERSION, kind: 'inspected', requestId, result });
}

/* ------------------------------------------------------------ normalize - */

async function handleNormalize(request: NormalizeRequest): Promise<void> {
  const { requestId, file, format, mapping, accountId, maxRows } = request;

  const invalid = validateFile({ name: file.name, size: file.size, type: '' });
  if (invalid) {
    fail(requestId, invalid.code as Parameters<typeof buildFailure>[0], invalid.fileName);
    return;
  }

  if (maxRows <= 0) {
    fail(requestId, 'session-row-limit-exceeded', file.name);
    return;
  }

  const progress = createProgressReporter(requestId);
  progress('reading', 0, 1, 0, 5);

  let bytes: Uint8Array | null = await readBytes(file);
  if (cancelled.has(requestId)) {
    bytes = null;
    return;
  }

  progress('parsing', 1, 1, 5, 15);

  const outcome = await normalizeFile({
    fileName: file.name,
    bytes,
    format,
    mapping,
    accountId,
    // The worker re-applies the session cap rather than trusting the caller.
    maxRows: Math.min(maxRows, MAX_SESSION_ROWS),
    onProgress: (processed, total) => {
      if (cancelled.has(requestId)) return;
      progress('normalizing', processed, total, 15, 99);
    },
  });

  // Drop the bytes as soon as the engine is finished with them, before the
  // result is cloned across the boundary.
  bytes = null;

  if (cancelled.has(requestId)) return;

  if (!outcome.ok) {
    fail(requestId, outcome.failure.code as Parameters<typeof buildFailure>[0], file.name);
    return;
  }

  progress('normalizing', outcome.result.rowCount, outcome.result.rowCount, 99, 100);
  post({
    protocol: IMPORT_PROTOCOL_VERSION,
    kind: 'normalized',
    requestId,
    result: outcome.result,
  });
}

/* ---------------------------------------------------------------- entry - */

ctx.addEventListener('message', (event: MessageEvent) => {
  const request = parseWorkerRequest(event.data);

  if (!request) {
    // A malformed message has no trustworthy requestId, so it is answered on a
    // reserved id the client will ignore rather than guessed at.
    fail('malformed', 'worker-failed');
    return;
  }

  if (request.kind === 'cancel') {
    cancelled.add(request.requestId);
    post({ protocol: IMPORT_PROTOCOL_VERSION, kind: 'cancelled', requestId: request.requestId });
    return;
  }

  const run = request.kind === 'inspect' ? handleInspect(request) : handleNormalize(request);

  void run
    .catch(() => {
      // The caught error is deliberately not inspected: an exception thrown
      // while parsing can carry a cell value in its message, and forwarding it
      // would leak personal data into the UI (threat-model.md §8).
      if (!cancelled.has(request.requestId)) fail(request.requestId, 'worker-failed');
    })
    .finally(() => {
      cancelled.delete(request.requestId);
    });
});

// `messageerror` fires when a message cannot be deserialized at all.
ctx.addEventListener('messageerror', () => {
  fail('malformed', 'worker-failed');
});
