import type { IsoTimestamp } from '../types/domain';

/**
 * Injectable clock.
 *
 * Record bookkeeping (`createdAt`, `updatedAt`, `exportedAt`) needs a real
 * time, but the normalization pipeline and the demo dataset must be
 * deterministic (data-methodology.md §3.2). Passing a clock in makes the
 * boundary explicit and lets tests pin it, rather than scattering
 * `new Date()` through the data layer.
 */
export type Clock = () => IsoTimestamp;

export const systemClock: Clock = () => new Date().toISOString();

/** A frozen clock, for tests and for deterministic fixture generation. */
export function fixedClock(timestamp: IsoTimestamp): Clock {
  return () => timestamp;
}
