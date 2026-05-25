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

export function requireInteger(name: string, value: number): void {
  if (!Number.isInteger(value)) {
    throw new RangeError(`${name} must be an integer, got ${String(value)}`);
  }
}
