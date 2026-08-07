import type { ImportFailure } from './errors';

/**
 * Byte-level decoding for imported files.
 *
 * threat-model.md §7: a byte-order mark is stripped rather than becoming part
 * of a column name; bytes that are not valid UTF-8 are replaced and the rows
 * are flagged, never dropped without explanation; and a misdetection is a
 * visible question rather than a silent decision.
 */

export type Encoding = 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be' | 'windows-1252';

export const ENCODING_LABELS: Record<Encoding, string> = {
  'utf-8': 'UTF-8',
  'utf-8-bom': 'UTF-8 with byte-order mark',
  'utf-16le': 'UTF-16 little-endian',
  'utf-16be': 'UTF-16 big-endian',
  'windows-1252': 'Windows-1252 (Western European)',
};

export type DetectionConfidence = 'high' | 'medium' | 'low';

export interface EncodingDetection {
  readonly encoding: Encoding;
  readonly confidence: DetectionConfidence;
  /** Constant explanation, safe to display. Never contains file content. */
  readonly reason: string;
  /** Number of leading bytes consumed by a byte-order mark. */
  readonly bomLength: number;
}

const BOMS: ReadonlyArray<{
  bytes: readonly number[];
  encoding: Encoding;
  reason: string;
}> = [
  {
    bytes: [0xef, 0xbb, 0xbf],
    encoding: 'utf-8-bom',
    reason: 'The file begins with a UTF-8 byte-order mark.',
  },
  {
    bytes: [0xff, 0xfe],
    encoding: 'utf-16le',
    reason: 'The file begins with a UTF-16 little-endian byte-order mark.',
  },
  {
    bytes: [0xfe, 0xff],
    encoding: 'utf-16be',
    reason: 'The file begins with a UTF-16 big-endian byte-order mark.',
  },
];

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((byte, index) => bytes[index] === byte);
}

/** True when this runtime can decode the given label. */
export function isEncodingSupported(label: string): boolean {
  try {
    // Constructing is the only reliable feature test; TextDecoder throws a
    // RangeError for labels the runtime does not implement.
    void new TextDecoder(label);
    return true;
  } catch {
    return false;
  }
}

function decoderLabel(encoding: Encoding): string {
  switch (encoding) {
    case 'utf-8':
    case 'utf-8-bom':
      return 'utf-8';
    case 'utf-16le':
      return 'utf-16le';
    case 'utf-16be':
      return 'utf-16be';
    case 'windows-1252':
      return 'windows-1252';
  }
}

/** True when the bytes decode as UTF-8 with no invalid sequence at all. */
export function isStrictUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Proposes an encoding.
 *
 * A byte-order mark is conclusive. Without one, strict UTF-8 that decodes
 * cleanly is taken as UTF-8; otherwise the file is *probably* a Windows-1252
 * export, which is offered at medium confidence so the user sees a question
 * rather than a silent guess.
 */
export function detectEncoding(bytes: Uint8Array): EncodingDetection {
  for (const bom of BOMS) {
    if (startsWith(bytes, bom.bytes)) {
      return {
        encoding: bom.encoding,
        confidence: 'high',
        reason: bom.reason,
        bomLength: bom.bytes.length,
      };
    }
  }

  if (isStrictUtf8(bytes)) {
    return {
      encoding: 'utf-8',
      confidence: 'high',
      reason: 'Every byte in the sample is valid UTF-8.',
      bomLength: 0,
    };
  }

  if (isEncodingSupported('windows-1252')) {
    return {
      encoding: 'windows-1252',
      confidence: 'medium',
      reason:
        'Some bytes are not valid UTF-8. Windows-1252 is the usual encoding for exports like this, but please confirm.',
      bomLength: 0,
    };
  }

  return {
    encoding: 'utf-8',
    confidence: 'low',
    reason:
      'Some bytes are not valid UTF-8 and this browser cannot decode Windows-1252. Unreadable characters will be replaced.',
    bomLength: 0,
  };
}

export type DecodeResult =
  | { readonly ok: true; readonly text: string; readonly hadInvalidBytes: boolean }
  | { readonly ok: false; readonly failure: ImportFailure };

/**
 * Decodes bytes to text.
 *
 * Never fatal: undecodable bytes become U+FFFD and `hadInvalidBytes` is set, so
 * the affected rows can be flagged questionable rather than silently dropped
 * (threat-model.md §7). Only an encoding this runtime cannot construct at all
 * is an outright failure.
 */
export function decodeBytes(bytes: Uint8Array, encoding: Encoding, fileName: string): DecodeResult {
  const label = decoderLabel(encoding);

  if (!isEncodingSupported(label)) {
    return {
      ok: false,
      failure: {
        code: 'encoding-unsupported',
        fileName,
        message: `This browser cannot decode ${ENCODING_LABELS[encoding]} files.`,
      },
    };
  }

  // `ignoreBOM` defaults to false, which makes TextDecoder drop a leading BOM
  // for us. That is what keeps a BOM out of the first column's name.
  const text = new TextDecoder(label).decode(bytes);
  return { ok: true, text, hadInvalidBytes: !isStrictUtf8OrLossless(bytes, encoding) };
}

/**
 * Whether decoding was lossless.
 *
 * For UTF-8 that means strict decoding succeeds. Single-byte encodings such as
 * Windows-1252 map every byte to some character, so decoding is lossless by
 * construction, and UTF-16 is checked by the decoder itself.
 */
function isStrictUtf8OrLossless(bytes: Uint8Array, encoding: Encoding): boolean {
  if (encoding === 'utf-8' || encoding === 'utf-8-bom') return isStrictUtf8(bytes);
  if (encoding === 'windows-1252') return true;

  // UTF-16: an odd byte length cannot be well-formed.
  return bytes.length % 2 === 0;
}
