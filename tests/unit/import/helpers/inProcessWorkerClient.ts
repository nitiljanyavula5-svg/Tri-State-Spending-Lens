import { decodeBytes, detectEncoding } from '../../../../src/import/decode';
import { detectDelimiter, detectHeaderRow, splitLines } from '../../../../src/import/detectFormat';
import {
  DETECTION_SAMPLE_BYTES,
  MAX_COLUMNS,
  MAX_PREVIEW_ROWS,
} from '../../../../src/import/limits';
import { normalizeFile } from '../../../../src/import/normalizeFile';
import { buildFailure, type InspectionResult } from '../../../../src/import/workerProtocol';
import type { ImportWorkerClient } from '../../../../src/import/importWorkerClient';
import { validateFile } from '../../../../src/import/fileValidation';
import { testSha256 } from './fixtures';

/**
 * An import worker client that runs the real engine in-process.
 *
 * jsdom has no Worker, and `FakeWorker` requires pumping protocol messages by
 * hand — fine for lifecycle tests, unusable for driving a six-step wizard. This
 * fakes only the *transport*: detection and normalization go through the same
 * `detectEncoding` / `detectDelimiter` / `detectHeaderRow` / `normalizeFile`
 * calls the real worker makes, in the same order.
 *
 * What it therefore still proves: the wizard's wiring, the mapping it builds,
 * the rows the engine returns, and everything persistence does with them. What
 * it cannot prove — that work genuinely leaves the main thread — is covered by
 * the Playwright suite against the real worker.
 *
 * `testSha256` replaces Web Crypto, which jsdom does not provide. Fingerprints
 * are therefore stable and distinct but not cryptographic, which is exactly
 * what these assertions need.
 */
export function createInProcessWorkerClient(
  options: { readonly onNormalize?: () => void } = {},
): ImportWorkerClient {
  const active = new Set<string>();
  let disposed = false;

  const nextId = (() => {
    let counter = 0;
    return () => {
      counter += 1;
      return `in-process-${counter}`;
    };
  })();

  return {
    get activeRequestIds() {
      return [...active];
    },

    async inspect(file, requestOptions = {}) {
      const requestId = requestOptions.requestId ?? nextId();
      if (disposed) return { status: 'failed', failure: buildFailure('worker-failed') };
      active.add(requestId);

      try {
        const invalid = validateFile({ name: file.name, size: file.size, type: '' });
        if (invalid) {
          return {
            status: 'failed',
            failure: buildFailure(
              invalid.code as Parameters<typeof buildFailure>[0],
              invalid.fileName,
            ),
          };
        }

        const bytes = new Uint8Array(await file.arrayBuffer());
        if (!active.has(requestId)) return { status: 'cancelled' };

        const sample = bytes.subarray(0, DETECTION_SAMPLE_BYTES);
        const encoding = detectEncoding(sample);
        const decoded = decodeBytes(sample, encoding.encoding, file.name);
        if (!decoded.ok) {
          return { status: 'failed', failure: buildFailure('encoding-unsupported', file.name) };
        }

        const lines = splitLines(decoded.text);
        const delimiter = detectDelimiter(lines);
        const header = detectHeaderRow(lines, delimiter.delimiter);

        if (header && header.columns.length > MAX_COLUMNS) {
          return { status: 'failed', failure: buildFailure('too-many-columns', file.name) };
        }

        const start = header ? header.headerLineIndex + 1 : 0;
        const result: InspectionResult = {
          fileName: file.name,
          byteLength: file.size,
          encoding,
          delimiter,
          header,
          sampleRows: lines
            .slice(start, start + MAX_PREVIEW_ROWS)
            .filter((line) => line.trim().length > 0)
            .map((line) => line.split(delimiter.delimiter).slice(0, MAX_COLUMNS)),
          sampleLineCount: lines.length,
        };

        if (!active.has(requestId)) return { status: 'cancelled' };
        return { status: 'ok', result };
      } finally {
        active.delete(requestId);
      }
    },

    async normalize(args, requestOptions = {}) {
      const requestId = requestOptions.requestId ?? nextId();
      if (disposed) return { status: 'failed', failure: buildFailure('worker-failed') };
      active.add(requestId);
      options.onNormalize?.();

      try {
        if (args.maxRows <= 0) {
          return {
            status: 'failed',
            failure: buildFailure('session-row-limit-exceeded', args.file.name),
          };
        }

        const bytes = new Uint8Array(await args.file.arrayBuffer());
        if (!active.has(requestId)) return { status: 'cancelled' };

        const outcome = await normalizeFile({
          fileName: args.file.name,
          bytes,
          format: args.format,
          mapping: args.mapping,
          accountId: args.accountId,
          maxRows: args.maxRows,
          sha256: testSha256,
        });

        if (!active.has(requestId)) return { status: 'cancelled' };
        if (!outcome.ok) {
          return {
            status: 'failed',
            failure: buildFailure(
              outcome.failure.code as Parameters<typeof buildFailure>[0],
              args.file.name,
            ),
          };
        }

        return { status: 'ok', result: outcome.result };
      } finally {
        active.delete(requestId);
      }
    },

    cancel(requestId) {
      active.delete(requestId);
    },

    dispose() {
      disposed = true;
      active.clear();
    },
  };
}
