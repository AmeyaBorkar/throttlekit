/** Shared numeric helpers. */

/**
 * Clamp `value` into the closed interval `[lo, hi]`. Value-first by convention — the single
 * definition, so call sites cannot disagree on argument order.
 */
export function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}
