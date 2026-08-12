/**
 * Minimal, deterministic text handling.
 *
 * Phase 3 deliberately does **no** merchant cleanup. category-rules.md §6.2
 * defines the fallback this uses — "trim, collapse whitespace, uppercase" — and
 * §6.1/§6.2 reserve card-network prefix stripping, store-number removal, and
 * versioned aliases for the Phase 4 rule engine. Guessing at merchants here
 * would bake an un-versioned alias table into fingerprints, which
 * data-methodology.md §4.2 explicitly forbids.
 */

/**
 * Code-point ranges for characters that must never survive into canonical text
 * or into anything rendered.
 *
 * Declared as numbers and assembled at runtime on purpose. Writing these
 * characters literally makes the source file unreviewable — and a literal NUL
 * makes Git classify the file as binary, which has already happened once in
 * this codebase.
 */
const STRIPPED_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f], // C0 controls
  [0x007f, 0x009f], // DEL and C1 controls
  [0x200b, 0x200f], // zero-width space/joiners, LRM, RLM
  [0x202a, 0x202e], // bidi embedding and override
  [0x2066, 0x2069], // bidi isolates
];

function rangeToEscape([low, high]: readonly [number, number]): string {
  const hex = (value: number) => `\\u${value.toString(16).padStart(4, '0')}`;
  return `${hex(low)}-${hex(high)}`;
}

const STRIPPED = new RegExp(`[${STRIPPED_RANGES.map(rangeToEscape).join('')}]`, 'g');

/**
 * Collapses whitespace, then removes control, zero-width, and bidi characters.
 *
 * Order matters: `\s` covers tab, newline, and non-breaking space, so
 * collapsing first turns a tab between two words into a space. Stripping first
 * would silently join them into one word.
 */
function collapse(raw: string): string {
  return raw.replace(/\s+/g, ' ').replace(STRIPPED, '').replace(/\s+/g, ' ').trim();
}

/**
 * The canonical form used for `merchantNormalized` and for fingerprints.
 *
 * Stable by construction: it depends only on the characters in the cell, never
 * on a lookup table that a later release might improve. That is what lets
 * fingerprints survive Phase 4's alias work unchanged.
 */
export function canonicalizeText(raw: string): string {
  return collapse(raw).toUpperCase();
}

/**
 * Strips characters that could make displayed text lie about its neighbours
 * (threat-model.md §5). The raw bytes stay in `descriptionRaw`; this is only
 * for rendering.
 *
 * Note this is *not* HTML escaping — React escapes text nodes already, and
 * nothing in this product renders a CSV field as markup.
 */
export function sanitizeForDisplay(raw: string): string {
  return collapse(raw);
}

/** The Unicode replacement character, produced when decoding hits bytes it cannot read. */
const REPLACEMENT_CHARACTER = String.fromCharCode(0xfffd);

/** True when decoding replaced bytes it could not interpret. */
export function hasReplacementCharacters(text: string): boolean {
  return text.includes(REPLACEMENT_CHARACTER);
}
