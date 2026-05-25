/**
 * A single-level timing wheel for O(1) amortized TTL expiry.
 *
 * Keys are bucketed into `wheelSize` slots by their expiry tick (`floor(expiresAt / tickMs)`
 * modulo the wheel size). Advancing the wheel processes only the slots that have come due —
 * never the whole key space — so expiry costs O(due keys) instead of O(all keys). A full
 * rotation's worth of steps (`wheelSize`) visits every slot exactly once, so even after a long
 * idle gap a single `advance` cleans everything. Lazy expiry on read (via {@link isExpired})
 * covers the sub-tick precision the wheel itself does not promise.
 *
 * The wheel is *driven by access* (callers invoke {@link advance} with the current time); it owns
 * no timer of its own, which keeps it allocation-free on the hot path and friendly to edge
 * runtimes that discourage background timers.
 */
export interface TimingWheelOptions {
  /** Tick resolution in ms (cleanup granularity, not decision precision). Default 1000. */
  tickMs?: number;
  /** Number of slots. `tickMs * wheelSize` is the span before TTLs "lap". Default 512. */
  wheelSize?: number;
}

interface WheelEntry {
  exp: number;
  slot: number;
}

export class TimingWheel {
  readonly #tickMs: number;
  readonly #n: number;
  readonly #slots: Set<string>[];
  readonly #entries = new Map<string, WheelEntry>();
  #lastTick: number;

  constructor(now: number, opts: TimingWheelOptions = {}) {
    this.#tickMs = Math.max(1, Math.floor(opts.tickMs ?? 1000));
    this.#n = Math.max(2, Math.floor(opts.wheelSize ?? 512));
    this.#slots = Array.from({ length: this.#n }, () => new Set<string>());
    this.#lastTick = Math.floor(now / this.#tickMs);
  }

  /** Number of scheduled keys. */
  get size(): number {
    return this.#entries.size;
  }

  #slotForTick(tick: number): number {
    const m = tick % this.#n;
    return m < 0 ? m + this.#n : m;
  }

  /** Schedule or reschedule `key` to expire at `expiresAt` (epoch-ms). */
  set(key: string, expiresAt: number): void {
    const prev = this.#entries.get(key);
    if (prev !== undefined) {
      this.#slots[prev.slot]?.delete(key);
    }
    // Place at least one tick ahead of the hand so short TTLs are swept on the next tick
    // rather than lingering a full rotation. The authoritative expiry lives in `exp`.
    const tick = Math.max(this.#lastTick + 1, Math.floor(expiresAt / this.#tickMs));
    const slot = this.#slotForTick(tick);
    this.#slots[slot]?.add(key);
    this.#entries.set(key, { exp: expiresAt, slot });
  }

  /** Remove `key` from the wheel. */
  delete(key: string): void {
    const e = this.#entries.get(key);
    if (e === undefined) return;
    this.#slots[e.slot]?.delete(key);
    this.#entries.delete(key);
  }

  /** True when `key` is absent or its TTL has elapsed at `now`. */
  isExpired(key: string, now: number): boolean {
    const e = this.#entries.get(key);
    return e === undefined || e.exp <= now;
  }

  /** True when `key` is scheduled (regardless of whether its TTL has elapsed). */
  has(key: string): boolean {
    return this.#entries.has(key);
  }

  /**
   * Advance to `now`, calling `onExpire(key)` for every key whose TTL has elapsed. Processes at
   * most one full rotation, so it never scans more than the wheel even after a long pause.
   */
  advance(now: number, onExpire: (key: string) => void): void {
    const curTick = Math.floor(now / this.#tickMs);
    let steps = curTick - this.#lastTick;
    if (steps <= 0) return;
    if (steps > this.#n) steps = this.#n;
    for (let i = 1; i <= steps; i++) {
      const slot = this.#slots[this.#slotForTick(this.#lastTick + i)];
      if (slot === undefined || slot.size === 0) continue;
      // Deleting the current element during Set iteration is safe per spec.
      for (const key of slot) {
        const e = this.#entries.get(key);
        if (e !== undefined && e.exp <= now) {
          slot.delete(key);
          this.#entries.delete(key);
          onExpire(key);
        }
        // Otherwise: a longer-TTL key that maps to this slot on a future lap — leave it.
      }
    }
    this.#lastTick = curTick;
  }
}
