import type { Clock } from "./types";

/** The real wall clock. The only place `Date.now()` is allowed to live. */
export const systemClock: Clock = {
  now(): number {
    return Date.now();
  },
};

/**
 * A clock you control, for deterministic tests. Time only moves when you move it, so every
 * limit is reproducible to the millisecond.
 *
 * @example
 * const clock = new ManualClock(0);
 * clock.advance(500); // now === 500
 */
export class ManualClock implements Clock {
  #t: number;

  constructor(start = 0) {
    this.#t = start;
  }

  now(): number {
    return this.#t;
  }

  /** Move time forward by `ms` (must be non-negative; time is monotonic). */
  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError(`ManualClock.advance: ms must be a non-negative number, got ${ms}`);
    }
    this.#t += ms;
  }

  /** Jump to an absolute epoch-ms (may move backwards; algorithms are jump-safe). */
  set(ms: number): void {
    if (!Number.isFinite(ms)) {
      throw new RangeError(`ManualClock.set: ms must be finite, got ${ms}`);
    }
    this.#t = ms;
  }
}
