/**
 * Cryptographically strong random identifiers (threat-model.md §12).
 *
 * `crypto.randomUUID` is unavailable in some test environments and in
 * non-secure browsing contexts, so a `getRandomValues` fallback builds the
 * same RFC 4122 v4 shape from the same CSPRNG. There is no `Math.random`
 * path: a weak fallback would silently downgrade a security property.
 */
export function newId(): string {
  const webCrypto = globalThis.crypto;

  if (typeof webCrypto?.randomUUID === 'function') {
    return webCrypto.randomUUID();
  }

  if (typeof webCrypto?.getRandomValues !== 'function') {
    throw new Error('A cryptographically strong random source is required but is unavailable.');
  }

  const bytes = webCrypto.getRandomValues(new Uint8Array(16));
  // Set the version (4) and variant (RFC 4122) bits.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex: string[] = [];
  for (const byte of bytes) {
    hex.push(byte.toString(16).padStart(2, '0'));
  }

  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-');
}
