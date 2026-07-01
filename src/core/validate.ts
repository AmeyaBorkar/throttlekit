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
