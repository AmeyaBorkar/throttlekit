import { systemClock } from "../core/clock";
import type { Clock, Decision } from "../core/types";

/**
 * A Count-Min Sketch (CMS) — a sublinear, fixed-memory frequency estimator for data streams.
 *
 * Backed by a single `Uint32Array` of `depth × width` counters. The footprint is a function of the
 * accuracy parameters (`epsilon`, `delta`) **only** — never of the number of distinct keys — so it
 * tracks an unbounded key universe (e.g. every source IP in a DDoS) in bounded space.
 *
 * Guarantees (Cormode & Muthukrishnan 2005, "An Improved Data Stream Summary: The Count-Min Sketch
 * and its Applications", J. Algorithms 55(1)):
 * - `estimate(key) >= trueCount(key)` **always** — the sketch never underestimates.
 * - `estimate(key) <= trueCount(key) + epsilon * N` with probability `>= 1 - delta`, where `N` is
 *   the total mass added. Set `width = ceil(e / epsilon)` and `depth = ceil(ln(1 / delta))`.
 *
 * The `depth` independent hashes are derived by double hashing —
 * `h_i(x) = (h1(x) + i * h2(x)) mod width` — from two distinct deterministic 32-bit string hashes
 * (FNV-1a with two seeds). Deterministic across runs, so seeded tests are reproducible.
 *
 * @internal Exposed for testing; the public surface is {@link sketchRateLimit}.
 */
export class CountMinSketch {
  /** Number of rows (independent hash functions). `ceil(ln(1/delta))`. */
  readonly depth: number;
  /** Number of columns per row. `ceil(e/epsilon)`. */
  readonly width: number;
  /** The flat `depth * width` counter table. Row `i` occupies `[i*width, (i+1)*width)`. */
  readonly counters: Uint32Array;
  /** Whether {@link CountMinSketch.add} uses the conservative-update rule. */
  readonly conservative: boolean;

  /** Total mass added across all keys (the `N` in the `epsilon * N` error term). */
  #total = 0;
  /** Reused scratch for {@link CountMinSketch.#indexes}; length is fixed at {@link depth}. */
  readonly #cols: Int32Array;

  constructor(epsilon: number, delta: number, conservative: boolean) {
    if (!Number.isFinite(epsilon) || epsilon <= 0 || epsilon >= 1) {
      throw new RangeError(`epsilon must be a number in (0, 1), got ${String(epsilon)}`);
    }
    if (!Number.isFinite(delta) || delta <= 0 || delta >= 1) {
      throw new RangeError(`delta must be a number in (0, 1), got ${String(delta)}`);
    }
    // w = ceil(e / epsilon), d = ceil(ln(1 / delta)) — Cormode & Muthukrishnan 2005.
    this.width = Math.ceil(Math.E / epsilon);
    this.depth = Math.ceil(Math.log(1 / delta));
    this.conservative = conservative;
    this.counters = new Uint32Array(this.depth * this.width);
    this.#cols = new Int32Array(this.depth);
  }

  /** Number of counters in the table (`depth * width`). Footprint is `4 * size` bytes. */
  get size(): number {
    return this.counters.length;
  }

  /** Total mass added so far (the `N` in the `epsilon * N` error bound). */
  get total(): number {
    return this.#total;
  }

  /**
   * Compute the per-row column indices for `key` via double hashing. Writes into the reused
   * {@link CountMinSketch.#cols} scratch buffer to avoid a per-call allocation on the hot path.
   */
  #indexes(key: string): Int32Array {
    const h1 = fnv1a(key, FNV_OFFSET_BASIS);
    // A second, independent hash from a distinct seed. The `>>> 0` keeps it an unsigned 32-bit int.
    const h2 = fnv1a(key, FNV_SEED_2) >>> 0;
    const cols = this.#cols;
    const width = this.width;
    for (let i = 0; i < this.depth; i++) {
      // (h1 + i*h2) can exceed 2^53 only for absurd depths; depth is tiny (≈7), so this is exact.
      cols[i] = (h1 + i * h2) % width;
    }
    return cols;
  }

  /**
   * Point estimate of `key`'s count: the minimum counter across rows. Never underestimates the
   * true count.
   */
  estimate(key: string): number {
    const cols = this.#indexes(key);
    const counters = this.counters;
    const width = this.width;
    let min = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.depth; i++) {
      // Typed-array indices are in-range by construction (i < depth, cols[i] < width).
      const v = counters[i * width + cols[i]!]!;
      if (v < min) min = v;
    }
    return min;
  }

  /**
   * Add `count` (default 1) to `key` and return the new estimate.
   *
   * With {@link CountMinSketch.conservative} (the default), applies the conservative-update rule of
   * Estan & Varghese ("New Directions in Traffic Measurement and Accounting", SIGCOMM 2002): raise
   * each row's counter only to `max(counter, estimate + count)`. This never decreases accuracy and
   * provably reduces the overestimate, while preserving the never-underestimate guarantee. Plain
   * mode increments every row by `count`.
   */
  add(key: string, count = 1): number {
    const cols = this.#indexes(key);
    const counters = this.counters;
    const width = this.width;
    this.#total += count;

    if (this.conservative) {
      // Conservative update: bump only counters below the post-add floor `m + count`.
      let m = Number.POSITIVE_INFINITY;
      for (let i = 0; i < this.depth; i++) {
        const v = counters[i * width + cols[i]!]!;
        if (v < m) m = v;
      }
      const target = m + count;
      for (let i = 0; i < this.depth; i++) {
        const idx = i * width + cols[i]!;
        if (counters[idx]! < target) counters[idx] = target;
      }
      return target;
    }

    let min = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.depth; i++) {
      const idx = i * width + cols[i]!;
      const v = counters[idx]! + count;
      counters[idx] = v;
      if (v < min) min = v;
    }
    return min;
  }

  /** Zero every counter and reset the total. Reuses the existing buffer (no reallocation). */
  clear(): void {
    this.counters.fill(0);
    this.#total = 0;
  }
}

/** FNV-1a 32-bit offset basis (seed for `h1`). */
const FNV_OFFSET_BASIS = 0x811c9dc5;
/** A distinct 32-bit seed for the second hash `h2`, so `h1` and `h2` are independent. */
const FNV_SEED_2 = 0x9e3779b1;
/** FNV-1a 32-bit prime. */
const FNV_PRIME = 0x01000193;

/**
 * FNV-1a 32-bit hash of a UTF-16 code-unit stream, seeded by `basis`. Deterministic and
 * well-distributed for short keys (IPs, user IDs). Returns an unsigned 32-bit integer.
 */
function fnv1a(str: string, basis: number): number {
  let h = basis;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    // Hash both bytes of each UTF-16 unit so multi-byte code points still mix well.
    h ^= c & 0xff;
    h = Math.imul(h, FNV_PRIME);
    h ^= (c >>> 8) & 0xff;
    h = Math.imul(h, FNV_PRIME);
  }
  return h >>> 0;
}

/** Options for {@link sketchRateLimit}. */
export interface SketchRateLimitOptions {
  /** Maximum requests admitted per key within each window. */
  limit: number;
  /** Window width in ms. Windows are aligned to epoch: `floor(now/windowMs)*windowMs`. */
  windowMs: number;
  /**
   * Additive accuracy: the sketch overestimates a key's count by at most `epsilon * N` (with `N`
   * the total admitted mass in the window) with probability `>= 1 - delta`. Smaller is more
   * accurate but uses more memory (`width = ceil(e/epsilon)`). Default `0.01`.
   */
  epsilon?: number;
  /**
   * Failure probability for the {@link SketchRateLimitOptions.epsilon} bound. Smaller is more
   * reliable but uses more memory (`depth = ceil(ln(1/delta))`). Default `0.001`.
   */
  delta?: number;
  /**
   * Use the Estan–Varghese conservative-update rule (tighter overestimate). Default `true`. The
   * never-over-admit guarantee holds either way.
   */
  conservative?: boolean;
  /** Injected clock. Defaults to the system clock. */
  clock?: Clock;
}

/** A windowed, fixed-memory approximate rate limiter backed by a {@link CountMinSketch}. */
export interface SketchRateLimiter {
  /** Synchronous, zero-`await` check for `key` with the given `cost` (default 1). */
  checkSync(key: string, cost?: number): Decision;
  /** Promise-returning form of {@link SketchRateLimiter.checkSync}; resolves synchronously. */
  check(key: string, cost?: number): Promise<Decision>;
  /** Zero the sketch and drop the current window. */
  reset(): void;
  /** Number of counters backing the sketch (`depth * width`). Independent of key count. */
  readonly capacity: number;
}

/**
 * Approximate, **fixed-memory** rate limiter over an unbounded key universe.
 *
 * Unlike the per-key strategies (which store one record per active key), this keeps a single
 * {@link CountMinSketch} of `O(1/epsilon · ln(1/delta))` counters regardless of how many distinct
 * keys are seen — ideal for shedding load from millions of distinct IPs in a volumetric attack,
 * where per-key state would itself be the memory-exhaustion vector.
 *
 * Windowing is fixed-window, epoch-aligned exactly like {@link fixedWindow}: the first check at or
 * after `windowStart + windowMs` rolls the window — zeroing the counter table and realigning
 * `windowStart` to `floor(now/windowMs)*windowMs`.
 *
 * **Check-before-add** is what makes the safety guarantee hold (and is mandatory, because a CMS
 * cannot be decremented): we read `e = estimate(key)`, admit iff `e + cost <= limit`, and only then
 * `add(key, cost)`. A denial adds nothing.
 *
 * **The guarantee.** Because `estimate >= trueCount` always, `allowed` implies the *true* admitted
 * count for the key (including this request) is `<= limit`: the limiter **never over-admits** — a
 * hard, non-probabilistic property. Its only error is in the safe direction: it may deny a key
 * slightly early once collisions inflate its estimate. By the CMS bound that early-denial slack is
 * `<= epsilon * N` with probability `>= 1 - delta`. Over-denying (never over-admitting) is exactly
 * the right bias for DDoS and abuse protection.
 */
export function sketchRateLimit(options: SketchRateLimitOptions): SketchRateLimiter {
  const limit = options.limit;
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new RangeError(`limit must be a positive finite number, got ${String(limit)}`);
  }
  const windowMs = options.windowMs;
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new RangeError(`windowMs must be a positive finite number, got ${String(windowMs)}`);
  }
  const epsilon = options.epsilon ?? 0.01;
  const delta = options.delta ?? 0.001;
  const conservative = options.conservative ?? true;
  const clock = options.clock ?? systemClock;

  const sketch = new CountMinSketch(epsilon, delta, conservative);
  // -Infinity guarantees the first check (at any finite `now`) is treated as a fresh window.
  let windowStart = Number.NEGATIVE_INFINITY;

  function checkSync(key: string, cost = 1): Decision {
    if (!Number.isFinite(cost) || cost <= 0) {
      throw new RangeError(`cost must be a positive finite number, got ${String(cost)}`);
    }
    const now = clock.now();
    // Roll the window on the first check at/after its end — epoch-aligned, matching fixedWindow.
    if (now >= windowStart + windowMs) {
      sketch.clear();
      windowStart = Math.floor(now / windowMs) * windowMs;
    }
    const resetAt = windowStart + windowMs;

    // Check-before-add: estimate first; only admit (and only then mutate) if it fits under `limit`.
    const estimate = sketch.estimate(key);
    if (estimate + cost <= limit) {
      const used = sketch.add(key, cost);
      return {
        allowed: true,
        limit,
        remaining: Math.max(0, Math.floor(limit - used)),
        resetAt: Math.ceil(resetAt),
        retryAfterMs: 0,
      };
    }
    // Denied: do NOT add (a CMS can't be decremented, and adding would also break the guarantee).
    return {
      allowed: false,
      limit,
      remaining: Math.max(0, Math.floor(limit - estimate)),
      resetAt: Math.ceil(resetAt),
      retryAfterMs: Math.ceil(resetAt - now),
    };
  }

  return {
    capacity: sketch.size,
    checkSync,
    check(key: string, cost = 1): Promise<Decision> {
      return Promise.resolve(checkSync(key, cost));
    },
    reset(): void {
      sketch.clear();
      windowStart = Number.NEGATIVE_INFINITY;
    },
  };
}
