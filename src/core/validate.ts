/** Tiny argument validators shared by strategy factories. Fail fast on misconfiguration. */

export function requirePositive(name: string, value: number): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number, got ${String(value)}`);
  }
}

export function requireAtLeast(name: string, value: number, min: number): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) {
    throw new RangeError(`${name} must be a finite number >= ${min}, got ${String(value)}`);
  }
}

export function requireAtMost(name: string, value: number, max: number): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value > max) {
    throw new RangeError(`${name} must be a finite number <= ${max}, got ${String(value)}`);
  }
}

export function requireInteger(name: string, value: number): void {
  if (!Number.isInteger(value)) {
    throw new RangeError(`${name} must be an integer, got ${String(value)}`);
  }
}

/**
 * Reject a construction-derived rate or interval (e.g. `periodMs/limit`, `1000/ratePerSec`,
 * `capacity/refillPerMs`) that overflowed to a non-finite value. A subnormal/huge factor can send
 * such a quantity to `Infinity`, which then poisons every `resetAt`/`retryAfterMs` with a non-finite
 * (or `NaN`) value — a malformed decision. Fail at construction so a limiter that builds always emits
 * finite decisions. `name` should describe the derivation for a legible message.
 */
export function requireFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be finite, got ${String(value)}`);
  }
}

/**
 * Reject a window/sub-bucket span so small that epoch-ms boundary math — `floor(now/span)*span` —
 * overflows to a non-finite value for a realistic clock, poisoning `resetAt`/`retryAfterMs`. `span`
 * is expected to be positive and finite already; this additionally rejects the sub-`~1e-292`-ms range
 * (and a `span` that underflowed to `0`, e.g. `windowMs/buckets`). `Number.MAX_SAFE_INTEGER`
 * (~year 285616 in epoch-ms) is the conservative upper bound on any `now`. No real window is affected.
 */
export function requireFiniteWindow(name: string, span: number): void {
  if (span <= 0 || !Number.isFinite(Math.floor(Number.MAX_SAFE_INTEGER / span) * span)) {
    throw new RangeError(
      `${name} is too small: epoch-ms window math overflows for a realistic clock, got ${String(span)}`,
    );
  }
}

/**
 * Validate a per-request `cost`: a positive finite number. The one source of this check and its
 * message, shared by every limiter/shaper (`rateLimit`, `twoTier`, `leakyBucket`, `multiRateLimit`)
 * so the public-facing wording can never drift between them.
 */
export function requireCost(cost: number): void {
  if (!Number.isFinite(cost) || cost <= 0) {
    throw new RangeError(`cost must be a positive finite number, got ${String(cost)}`);
  }
  // Cap at MAX_SAFE_INTEGER: a larger cost overflows the emission-interval strategies' `cost * T`
  // arithmetic to a non-finite retryAfterMs (a malformed decision field). No real budget spends 2^53.
  if (cost > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`cost must be <= ${Number.MAX_SAFE_INTEGER}, got ${String(cost)}`);
  }
}
