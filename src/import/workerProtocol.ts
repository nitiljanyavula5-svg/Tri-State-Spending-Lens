import { z } from 'zod';
import type { ImportFailure, ImportFailureCode } from './errors';
import type { EncodingDetection } from './decode';
import type { DelimiterDetection, HeaderDetection } from './detectFormat';
import { MAX_COLUMNS, MAX_PREVIEW_ROWS, MAX_SESSION_ROWS } from './limits';
import { fileMappingSchema } from './mapping';
import type { NormalizedFileResult } from './normalizeFile';

/**
 * The message contract between the main thread and the import worker.
 *
 * Both directions are validated. The worker treats anything arriving on its
 * port as untrusted, and the client treats anything arriving from the worker
 * the same way — a malformed message must produce a typed failure, never an
 * unhandled exception or a half-settled request.
 *
 * threat-model.md §8: nothing crossing this boundary in the *response*
 * direction may carry a raw cell value in an error. Failures are bounded codes
 * with constant messages; only the structured result carries data, and only on
 * the success path.
 */

export const IMPORT_PROTOCOL_VERSION = 1;

/* -------------------------------------------------------------- requests - */

/**
 * `File` is sent rather than a pre-read ArrayBuffer.
 *
 * A `File` is structured-cloneable, so the *reading* happens inside the worker
 * via `file.arrayBuffer()`. Reading on the main thread first would put the one
 * genuinely large synchronous cost back where we are trying to remove it, and
 * would also mean the main thread briefly holds the whole file's bytes.
 */
function isFileLike(value: unknown): value is File {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { name?: unknown; size?: unknown; arrayBuffer?: unknown };
  return (
    typeof candidate.name === 'string' &&
    typeof candidate.size === 'number' &&
    typeof candidate.arrayBuffer === 'function'
  );
}

const fileSchema = z.custom<File>(isFileLike, { message: 'not a file' });

const requestIdSchema = z.string().min(1).max(128);

const formatSchema = z.object({
  encoding: z.enum(['utf-8', 'utf-8-bom', 'utf-16le', 'utf-16be', 'windows-1252']),
  delimiter: z.enum([',', ';', '\t', '|']),
  headerLineIndex: z.number().int().min(0).max(1000),
});

export const inspectRequestSchema = z.object({
  protocol: z.literal(IMPORT_PROTOCOL_VERSION),
  kind: z.literal('inspect'),
  requestId: requestIdSchema,
  file: fileSchema,
});

export const normalizeRequestSchema = z.object({
  protocol: z.literal(IMPORT_PROTOCOL_VERSION),
  kind: z.literal('normalize'),
  requestId: requestIdSchema,
  file: fileSchema,
  format: formatSchema,
  mapping: fileMappingSchema,
  accountId: z.string().min(1).max(200),
  /** Remaining row budget for the session. Re-checked in the worker. */
  maxRows: z.number().int().min(0).max(MAX_SESSION_ROWS),
});

export const cancelRequestSchema = z.object({
  protocol: z.literal(IMPORT_PROTOCOL_VERSION),
  kind: z.literal('cancel'),
  requestId: requestIdSchema,
});

export const workerRequestSchema = z.discriminatedUnion('kind', [
  inspectRequestSchema,
  normalizeRequestSchema,
  cancelRequestSchema,
]);

export type InspectRequest = z.infer<typeof inspectRequestSchema>;
export type NormalizeRequest = z.infer<typeof normalizeRequestSchema>;
export type CancelRequest = z.infer<typeof cancelRequestSchema>;
export type WorkerRequest = z.infer<typeof workerRequestSchema>;

/* ------------------------------------------------------------- responses - */

export type ProgressStage = 'reading' | 'parsing' | 'normalizing';

export interface ProgressPayload {
  readonly stage: ProgressStage;
  /** Rows handled so far. 0 while the stage has no row concept yet. */
  readonly processed: number;
  /** Total rows, or 0 when not yet known. */
  readonly total: number;
  /** Integer 0..100. Monotonic across the whole request. */
  readonly percent: number;
}

/** What the Identify-format step needs. Bounded: no full file contents. */
export interface InspectionResult {
  readonly fileName: string;
  readonly byteLength: number;
  readonly encoding: EncodingDetection;
  readonly delimiter: DelimiterDetection;
  readonly header: HeaderDetection | null;
  /** A few decoded rows for the on-screen preview, already bounded. */
  readonly sampleRows: readonly (readonly string[])[];
  /** Date cells sampled from the mapped-looking columns, for format detection. */
  readonly sampleLineCount: number;
}

export const progressSchema = z.object({
  protocol: z.literal(IMPORT_PROTOCOL_VERSION),
  kind: z.literal('progress'),
  requestId: requestIdSchema,
  stage: z.enum(['reading', 'parsing', 'normalizing']),
  processed: z.number().int().min(0).max(MAX_SESSION_ROWS),
  total: z.number().int().min(0).max(MAX_SESSION_ROWS),
  percent: z.number().int().min(0).max(100),
});

/**
 * Result payloads are validated structurally rather than field-by-field.
 *
 * Re-running the full row schema over 100,000 rows on the main thread would
 * undo the point of the worker. The worker is our own code and the *engine*
 * already validated every row; what this boundary must catch is a malformed or
 * foreign message, which the envelope check does.
 */
const inspectedSchema = z.object({
  protocol: z.literal(IMPORT_PROTOCOL_VERSION),
  kind: z.literal('inspected'),
  requestId: requestIdSchema,
  result: z.object({
    fileName: z.string().max(1024),
    byteLength: z.number().int().min(0),
    encoding: z.object({
      encoding: z.enum(['utf-8', 'utf-8-bom', 'utf-16le', 'utf-16be', 'windows-1252']),
      confidence: z.enum(['high', 'medium', 'low']),
      reason: z.string().max(500),
      bomLength: z.number().int().min(0).max(8),
    }),
    delimiter: z.object({
      delimiter: z.enum([',', ';', '\t', '|']),
      confidence: z.enum(['high', 'medium', 'low']),
      reason: z.string().max(500),
      scores: z.array(z.unknown()).max(8),
    }),
    header: z
      .object({
        headerLineIndex: z.number().int().min(0),
        columns: z.array(z.string()).max(MAX_COLUMNS),
        confidence: z.enum(['high', 'medium', 'low']),
        reason: z.string().max(500),
        skippedLines: z.number().int().min(0),
      })
      .nullable(),
    sampleRows: z.array(z.array(z.string())).max(MAX_PREVIEW_ROWS),
    sampleLineCount: z.number().int().min(0),
  }),
});

const normalizedSchema = z.object({
  protocol: z.literal(IMPORT_PROTOCOL_VERSION),
  kind: z.literal('normalized'),
  requestId: requestIdSchema,
  result: z.object({
    fileName: z.string().max(1024),
    rowCount: z.number().int().min(0).max(MAX_SESSION_ROWS),
    rows: z.array(z.unknown()).max(MAX_SESSION_ROWS),
    rejections: z.array(z.unknown()).max(MAX_SESSION_ROWS),
    questions: z.array(z.unknown()).max(MAX_SESSION_ROWS * 4),
    structuralWarnings: z.array(z.string()).max(200),
    truncated: z.boolean(),
    hadInvalidBytes: z.boolean(),
  }),
});

export const FAILURE_CODES = [
  'file-not-csv',
  'file-too-large',
  'file-empty',
  'too-many-files',
  'encoding-unsupported',
  'encoding-undecodable',
  'delimiter-undetectable',
  'header-not-found',
  'too-many-columns',
  'session-row-limit-exceeded',
  'mapping-invalid',
  'cancelled',
  'worker-failed',
] as const satisfies readonly ImportFailureCode[];

const failedSchema = z.object({
  protocol: z.literal(IMPORT_PROTOCOL_VERSION),
  kind: z.literal('failed'),
  requestId: requestIdSchema,
  failure: z.object({
    code: z.enum(FAILURE_CODES),
    /** Constant text chosen from a fixed table. Never interpolated with data. */
    message: z.string().max(500),
    fileName: z.string().max(1024).optional(),
  }),
});

const cancelledSchema = z.object({
  protocol: z.literal(IMPORT_PROTOCOL_VERSION),
  kind: z.literal('cancelled'),
  requestId: requestIdSchema,
});

export const workerResponseSchema = z.discriminatedUnion('kind', [
  progressSchema,
  inspectedSchema,
  normalizedSchema,
  failedSchema,
  cancelledSchema,
]);

export type WorkerResponse =
  | ({ protocol: number; kind: 'progress'; requestId: string } & ProgressPayload)
  | { protocol: number; kind: 'inspected'; requestId: string; result: InspectionResult }
  | { protocol: number; kind: 'normalized'; requestId: string; result: NormalizedFileResult }
  | { protocol: number; kind: 'failed'; requestId: string; failure: ImportFailure }
  | { protocol: number; kind: 'cancelled'; requestId: string };

/** Terminal messages settle a request. Progress never does. */
export const TERMINAL_KINDS = ['inspected', 'normalized', 'failed', 'cancelled'] as const;

export function isTerminalKind(kind: string): boolean {
  return (TERMINAL_KINDS as readonly string[]).includes(kind);
}

/* -------------------------------------------------------------- messages - */

/**
 * Constant failure text.
 *
 * Every message here is a fixed string. Nothing is built by interpolating a
 * filename, a description, or an amount, which is what makes "no personal value
 * in a failure" a property of the type rather than a habit.
 */
export const FAILURE_MESSAGES: Record<(typeof FAILURE_CODES)[number], string> = {
  'file-not-csv': 'Only .csv files can be imported.',
  'file-too-large': 'That file is larger than the import size limit.',
  'file-empty': 'That file is empty.',
  'too-many-files': 'Too many files were selected for one import.',
  'encoding-unsupported': 'This browser cannot decode that file encoding.',
  'encoding-undecodable': 'That file could not be decoded as text.',
  'delimiter-undetectable': 'No delimiter separated that file into columns.',
  'header-not-found': 'No header row could be found in that file.',
  'too-many-columns': 'That file has more columns than this product will read.',
  'session-row-limit-exceeded': 'That import would exceed the maximum number of rows.',
  'mapping-invalid': 'The column mapping is not valid.',
  cancelled: 'The import was cancelled.',
  'worker-failed': 'The import could not be processed. Nothing was changed.',
};

export function buildFailure(
  code: (typeof FAILURE_CODES)[number],
  fileName?: string,
): ImportFailure {
  return {
    code,
    message: FAILURE_MESSAGES[code],
    ...(fileName === undefined ? {} : { fileName }),
  };
}

/** Parses an inbound request inside the worker. Returns null when malformed. */
export function parseWorkerRequest(data: unknown): WorkerRequest | null {
  const parsed = workerRequestSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

/** Parses an inbound response on the main thread. Returns null when malformed. */
export function parseWorkerResponse(data: unknown): WorkerResponse | null {
  const parsed = workerResponseSchema.safeParse(data);
  return parsed.success ? (parsed.data as unknown as WorkerResponse) : null;
}
