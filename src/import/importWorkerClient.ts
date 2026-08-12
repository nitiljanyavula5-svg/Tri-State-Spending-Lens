import type { ImportFailure } from './errors';
import type { FileFormat, FileMapping } from './mapping';
import type { NormalizedFileResult } from './normalizeFile';
import {
  buildFailure,
  IMPORT_PROTOCOL_VERSION,
  parseWorkerResponse,
  type InspectionResult,
  type ProgressPayload,
} from './workerProtocol';

/**
 * Main-thread client for the import worker.
 *
 * Framework-independent on purpose: it holds no React state and touches no
 * IndexedDB, so the wizard can wrap it later without this module knowing
 * anything about either.
 *
 * ARCHITECTURE — one worker per request.
 *
 * Cancellation of a CPU-bound worker cannot rely on the worker noticing a
 * message: it may be inside a tight normalization loop and never reach its
 * message queue. So cancel *terminates*. Giving each request its own worker
 * makes that safe and makes an entire class of bug impossible — a terminated
 * worker has no queue left to deliver a stale result from, and no second
 * request shares a port with a first. requestId checks remain as
 * defence-in-depth rather than as the only line of defence.
 */

export type InspectOutcome =
  | { readonly status: 'ok'; readonly result: InspectionResult }
  | { readonly status: 'cancelled' }
  | { readonly status: 'failed'; readonly failure: ImportFailure };

export type NormalizeOutcome =
  | { readonly status: 'ok'; readonly result: NormalizedFileResult }
  | { readonly status: 'cancelled' }
  | { readonly status: 'failed'; readonly failure: ImportFailure };

export interface NormalizeArgs {
  readonly file: File;
  readonly format: FileFormat;
  readonly mapping: FileMapping;
  readonly accountId: string;
  readonly maxRows: number;
}

export interface RequestOptions {
  readonly requestId?: string;
  readonly onProgress?: (progress: ProgressPayload) => void;
}

export interface ImportWorkerClient {
  inspect(file: File, options?: RequestOptions): Promise<InspectOutcome>;
  normalize(args: NormalizeArgs, options?: RequestOptions): Promise<NormalizeOutcome>;
  /** Terminates the request's worker. Safe to call for an unknown id. */
  cancel(requestId: string): void;
  /** Terminates everything in flight. Idempotent. */
  dispose(): void;
  /** Ids currently in flight. Exposed for tests and for leak assertions. */
  readonly activeRequestIds: readonly string[];
}

export interface ClientOptions {
  /** Injectable for tests. Production builds the real Vite module worker. */
  readonly createWorker?: () => Worker;
  readonly generateRequestId?: () => string;
}

function defaultCreateWorker(): Worker {
  // The Vite-supported module-worker pattern. The URL must be a static literal
  // so Vite can find and bundle the worker at build time.
  return new Worker(new URL('./importWorker.ts', import.meta.url), { type: 'module' });
}

function defaultRequestId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  return random ?? `req-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
}

interface InFlight {
  readonly worker: Worker;
  /** Settles this request as cancelled and tears its worker down. */
  readonly settle: () => void;
  settled: boolean;
  cleanup: () => void;
}

export function createImportWorkerClient(options: ClientOptions = {}): ImportWorkerClient {
  const createWorker = options.createWorker ?? defaultCreateWorker;
  const generateRequestId = options.generateRequestId ?? defaultRequestId;

  const inFlight = new Map<string, InFlight>();
  let disposed = false;

  /**
   * Runs one request on its own worker.
   *
   * `settleOnce` is the single gate every terminal path goes through, so a
   * request can resolve exactly once no matter how many terminal messages,
   * errors, or cancellations arrive.
   */
  function run<T>(
    requestId: string,
    buildRequest: () => unknown,
    interpret: (kind: string, message: Record<string, unknown>) => T | null,
    onProgress?: (progress: ProgressPayload) => void,
  ): Promise<T | { status: 'cancelled' } | { status: 'failed'; failure: ImportFailure }> {
    return new Promise((resolve) => {
      if (disposed) {
        resolve({ status: 'failed', failure: buildFailure('worker-failed') });
        return;
      }

      let worker: Worker;
      try {
        worker = createWorker();
      } catch {
        // Construction can fail when workers are blocked by policy.
        resolve({ status: 'failed', failure: buildFailure('worker-failed') });
        return;
      }

      let settled = false;

      const cleanup = () => {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('messageerror', onMessageError);
        worker.removeEventListener('error', onError);
        worker.terminate();
        inFlight.delete(requestId);
      };

      const settleOnce = (
        value: T | { status: 'cancelled' } | { status: 'failed'; failure: ImportFailure },
      ) => {
        if (settled) return;
        settled = true;
        const entry = inFlight.get(requestId);
        if (entry) entry.settled = true;
        cleanup();
        resolve(value);
      };

      function onMessage(event: MessageEvent) {
        const response = parseWorkerResponse(event.data);
        if (!response) {
          settleOnce({ status: 'failed', failure: buildFailure('worker-failed') });
          return;
        }

        // Defence in depth: this worker serves exactly one request, so a
        // mismatched id means something is badly wrong. Ignore rather than act.
        if (response.requestId !== requestId) return;

        if (response.kind === 'progress') {
          // Progress after settlement is dropped: a request that has already
          // finished must never appear to move again.
          if (settled) return;
          onProgress?.({
            stage: response.stage,
            processed: response.processed,
            total: response.total,
            percent: response.percent,
          });
          return;
        }

        if (response.kind === 'cancelled') {
          settleOnce({ status: 'cancelled' });
          return;
        }

        if (response.kind === 'failed') {
          settleOnce({ status: 'failed', failure: response.failure });
          return;
        }

        const interpreted = interpret(
          response.kind,
          response as unknown as Record<string, unknown>,
        );
        if (interpreted === null) {
          settleOnce({ status: 'failed', failure: buildFailure('worker-failed') });
          return;
        }
        settleOnce(interpreted);
      }

      function onMessageError() {
        settleOnce({ status: 'failed', failure: buildFailure('worker-failed') });
      }

      function onError(event: Event) {
        // The worker's own error text can quote file content, so it is never
        // read — only the fact that it happened.
        event.preventDefault?.();
        settleOnce({ status: 'failed', failure: buildFailure('worker-failed') });
      }

      worker.addEventListener('message', onMessage);
      worker.addEventListener('messageerror', onMessageError);
      worker.addEventListener('error', onError);

      inFlight.set(requestId, {
        worker,
        settle: () => settleOnce({ status: 'cancelled' }),
        settled: false,
        cleanup,
      });

      try {
        worker.postMessage(buildRequest());
      } catch {
        // Structured-clone failures land here.
        settleOnce({ status: 'failed', failure: buildFailure('worker-failed') });
      }
    });
  }

  return {
    get activeRequestIds() {
      return [...inFlight.keys()];
    },

    async inspect(file, requestOptions = {}) {
      const requestId = requestOptions.requestId ?? generateRequestId();
      return run<InspectOutcome>(
        requestId,
        () => ({
          protocol: IMPORT_PROTOCOL_VERSION,
          kind: 'inspect',
          requestId,
          file,
        }),
        (kind, message) =>
          kind === 'inspected'
            ? { status: 'ok', result: message.result as InspectionResult }
            : null,
        requestOptions.onProgress,
      ) as Promise<InspectOutcome>;
    },

    async normalize(args, requestOptions = {}) {
      const requestId = requestOptions.requestId ?? generateRequestId();
      return run<NormalizeOutcome>(
        requestId,
        () => ({
          protocol: IMPORT_PROTOCOL_VERSION,
          kind: 'normalize',
          requestId,
          file: args.file,
          format: args.format,
          mapping: args.mapping,
          accountId: args.accountId,
          maxRows: args.maxRows,
        }),
        (kind, message) =>
          kind === 'normalized'
            ? { status: 'ok', result: message.result as NormalizedFileResult }
            : null,
        requestOptions.onProgress,
      ) as Promise<NormalizeOutcome>;
    },

    cancel(requestId) {
      const entry = inFlight.get(requestId);
      if (!entry || entry.settled) return;
      // Terminate rather than ask: a worker inside a normalization loop will
      // not reach its message queue in time to honour a polite request.
      entry.settle();
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const entry of [...inFlight.values()]) {
        if (!entry.settled) entry.settle();
        else entry.cleanup();
      }
      inFlight.clear();
    },
  };
}
