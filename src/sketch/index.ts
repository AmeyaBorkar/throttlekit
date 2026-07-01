import { randomInt } from "node:crypto";
import { systemClock } from "../core/clock";
import type { Clock, Decision } from "../core/types";
import { requireCost, requireInteger } from "../core/validate";

/** Bytes of fixed header in {@link CountMinSketch.toBytes}: width(u32) + depth(u32) + total(f64). */
const HEADER_BYTES = 16;

/**
 * Counter ceiling. Counters are a `Uint32Array`, so an unguarded `counters[i] = x` with `x > 2³²−1`
 * wraps modulo 2³² and the stored value drops BELOW the true count — breaking the never-underestimate
 * guarantee (a heavy hitter could then read as small and slip past threshold shedding / over-admit).
 * Saturating at the ceiling can only ever over-estimate, the safe direction.
 */
const MAX_U32 = 0xffffffff;

/**
 * A detached, transportable copy of a Count-Min Sketch's state — the counter table plus the total
 * mass added. Produced by {@link CountMinSketch.snapshot} (in-process) or
 * {@link sketchSnapshotFromBytes} (decoded from the wire), and folded into another sketch with
 * {@link CountMinSketch.mergeSnapshot}.
 */
export interface SketchSnapshot {
  /** Columns per row. Must match the target sketch to merge. */
  readonly width: number;
  /** Rows (independent hashes). Must match the target sketch to merge. */
  readonly depth: number;
  /** Total mass added into the source sketch (the `N` in the `epsilon·N` error bound). */
  readonly total: number;
  /** A flat `depth*width` counter table — a copy, safe to transfer or own. */
  readonly counters: Uint32Array;
}

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
 * Each of the `depth` rows uses its OWN independent hash: `h_i(x) = fnv1a(x, rowSeed[i]) mod width`,
 * where the `depth` per-row seeds are derived from a single 32-bit base `seed`. Per-row independence
 * is what the Cormode–Muthukrishnan error bound rests on, and it is also a security property: under
 * the older Kirsch–Mitzenmacher double-hash form `(h1 + i*h2) mod width`, a key colliding with a
 * victim on any TWO rows necessarily collided on ALL rows (only 2 degrees of freedom), so a targeted
 * full-column collision cost ~`width²` to forge instead of ~`width^depth` — cheap enough to grief a
 * victim key into false denial. Independent rows restore the ~`width^depth` cost.
 *
 * The base `seed` defaults to a per-instance random value (so colliders cannot be precomputed
 * offline); pass an explicit `seed` for reproducible tests or to share hashing across nodes (a merge
 * is only meaningful between sketches with the same seed, as it already requires the same dimensions).
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
  /** The 32-bit base seed the per-row hash seeds are derived from. */
  readonly seed: number;

  /** Total mass added across all keys (the `N` in the `epsilon * N` error term). */
  #total = 0;
  /** Reused scratch for {@link CountMinSketch.#indexes}; length is fixed at {@link depth}. */
  readonly #cols: Int32Array;
  /** One independent FNV-1a seed per row, derived from {@link CountMinSketch.seed}. */
  readonly #rowSeeds: Uint32Array;

  constructor(epsilon: number, delta: number, conservative: boolean, seed?: number) {
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
    // A per-instance random base seed by default so an attacker cannot precompute colliders offline.
    this.seed = seed === undefined ? randomInt(0, 0x1_0000_0000) : seed >>> 0;
    // Derive one independent FNV-1a seed per row by hashing the row index under the base seed, so the
    // rows are truly independent (no shared linear structure to collapse) yet fully reproducible.
    this.#rowSeeds = new Uint32Array(this.depth);
    for (let i = 0; i < this.depth; i++) {
      this.#rowSeeds[i] = fnv1a(`row:${i}`, this.seed);
    }
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
   * Compute the per-row column indices for `key`: each row uses an INDEPENDENT FNV-1a hash under its
   * own seed (not a linear `h1 + i*h2`), so a collision on some rows leaks nothing about the others —
   * a full-column collision can't be forged cheaply. Writes into the reused {@link CountMinSketch.#cols}
   * scratch buffer to avoid a per-call allocation on the hot path.
   */
  #indexes(key: string): Int32Array {
    const cols = this.#cols;
    const width = this.width;
    const rowSeeds = this.#rowSeeds;
    for (let i = 0; i < this.depth; i++) {
      cols[i] = fnv1a(key, rowSeeds[i]!) % width;
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
      const target = Math.min(m + count, MAX_U32); // saturate so the store can't wrap below the true count
      for (let i = 0; i < this.depth; i++) {
        const idx = i * width + cols[i]!;
        if (counters[idx]! < target) counters[idx] = target;
      }
      return target;
    }

    let min = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.depth; i++) {
      const idx = i * width + cols[i]!;
      const v = Math.min(counters[idx]! + count, MAX_U32); // saturate (never wrap below true count)
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

  /**
   * Fold another sketch's counts into this one by element-wise addition. CMS counters are linear, so
   * for **plain** (non-conservative) sketches that share identical dimensions and hash seeds this is
   * *exact*: the result is counter-for-counter identical to a single sketch that had processed both
   * streams. (Conservative-update sketches still merge to a valid never-underestimate sketch, just
   * without that exactness.) Throws on a dimension mismatch.
   */
  mergeSnapshot(snap: SketchSnapshot): void {
    if (snap.width !== this.width || snap.depth !== this.depth) {
      throw new Error(
        `cannot merge a ${snap.width}x${snap.depth} sketch into a ${this.width}x${this.depth} one`,
      );
    }
    // Fail closed on a malformed counters array: the merge loop iterates the TARGET length, so a
    // too-short source would dereference past its end (undefined) and `a[i] + undefined = NaN` stored
    // into a Uint32Array silently zeroes the tail counter — an underestimate, the unsafe direction.
    if (snap.counters.length !== this.counters.length) {
      throw new Error(
        `sketch snapshot has ${snap.counters.length} counters, expected ${this.counters.length}`,
      );
    }
    const a = this.counters;
    const b = snap.counters;
    // Saturate each merged counter: a plain element-wise add of two near-ceiling Uint32 counters would
    // wrap below the true union count and hide a heavy hitter from threshold shedding.
    for (let i = 0; i < a.length; i++)
      a[i] = Math.min((a[i] as number) + (b[i] as number), MAX_U32);
    // Defense in depth for a snapshot built outside sketchSnapshotFromBytes: never fold a non-finite or
    // negative total into the running count (a poisoned peer total would corrupt the epsilon*N bound).
    if (Number.isFinite(snap.total) && snap.total >= 0) this.#total += snap.total;
  }

  /** A detached copy of this sketch's table and total, for transport or in-process merge. */
  snapshot(): SketchSnapshot {
    return {
      width: this.width,
      depth: this.depth,
      total: this.#total,
      counters: this.counters.slice(),
    };
  }

  /** Encode {@link CountMinSketch.snapshot} as compact little-endian bytes for cross-node transport. */
  toBytes(): Uint8Array {
    const n = this.counters.length;
    const buf = new ArrayBuffer(HEADER_BYTES + n * 4);
    const dv = new DataView(buf);
    dv.setUint32(0, this.width, true);
    dv.setUint32(4, this.depth, true);
    dv.setFloat64(8, this.#total, true);
    new Uint32Array(buf, HEADER_BYTES).set(this.counters);
    return new Uint8Array(buf);
  }
}

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
  /**
   * 32-bit hash seed. **Defaults to a per-instance random value**, so an attacker cannot precompute
   * keys that collide with a victim and grief it into false denial. Pass a fixed `seed` only for
   * reproducible tests — pinning it re-enables offline collider precomputation.
   */
  seed?: number;
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
 *
 * @experimental Excluded from the 1.x SemVer guarantee (may change in a minor). See STABILITY.md.
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

  // seed omitted ⇒ a per-instance random seed (CountMinSketch's default): colliders can't be
  // precomputed offline against a fixed public seed.
  const sketch = new CountMinSketch(epsilon, delta, conservative, options.seed);
  // -Infinity guarantees the first check (at any finite `now`) is treated as a fresh window.
  let windowStart = Number.NEGATIVE_INFINITY;

  function checkSync(key: string, cost = 1): Decision {
    requireCost(cost);
    // Counts live in a Uint32Array, so a fractional cost would truncate on `add` and let the key
    // admit more than `limit` true units — breaking the never-over-admit guarantee. Require integers.
    requireInteger("sketchRateLimit.cost", cost);
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

/** Decode bytes produced by {@link MergeableSketch.toBytes} back into a {@link SketchSnapshot}. */
export function sketchSnapshotFromBytes(bytes: Uint8Array): SketchSnapshot {
  if (bytes.byteLength < HEADER_BYTES) {
    throw new Error(`sketch bytes too short: ${bytes.byteLength} < ${HEADER_BYTES}`);
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = dv.getUint32(0, true);
  const depth = dv.getUint32(4, true);
  const total = dv.getFloat64(8, true);
  if (!Number.isFinite(total) || total < 0) {
    // Untrusted peer bytes: a poisoned `total` (NaN / Infinity / negative) would corrupt the receiver's
    // cluster-wide count (the N in the epsilon*N shed threshold). Reject the snapshot outright.
    throw new Error(`sketch snapshot has a non-finite or negative total: ${String(total)}`);
  }
  const n = width * depth;
  if (bytes.byteLength !== HEADER_BYTES + n * 4) {
    throw new Error(`sketch bytes length mismatch: expected ${HEADER_BYTES + n * 4}`);
  }
  // Copy counters out element-by-element: `bytes` may be unaligned for a Uint32Array view.
  const counters = new Uint32Array(n);
  for (let i = 0; i < n; i++) counters[i] = dv.getUint32(HEADER_BYTES + i * 4, true);
  return { width, depth, total, counters };
}

/** A fixed default seed for {@link mergeableSketch}, so peers hash identically and merge out of the
 * box (a merge requires the same hashing on every node — same dimensions AND same seed). Override
 * with a shared `seed` to rotate; the cluster-wide estimator's threat model is hiding a heavy hitter
 * (under-estimate), which the never-underestimate guarantee covers, not the single-node over-deny
 * griefing that {@link sketchRateLimit}'s random seed defends against. */
const MERGEABLE_DEFAULT_SEED = 0x9e3779b1;

/** Options for {@link mergeableSketch}. */
export interface MergeableSketchOptions {
  /**
   * Additive accuracy: a key's global estimate exceeds its true global count by at most
   * `epsilon * N` (with `N` the total merged mass) with probability `>= 1 - delta`. Default `0.01`.
   */
  epsilon?: number;
  /** Failure probability for the {@link MergeableSketchOptions.epsilon} bound. Default `0.001`. */
  delta?: number;
  /**
   * 32-bit hash seed shared by every node in the cluster. Defaults to a fixed value so peers merge
   * out of the box; all merging nodes MUST use the same seed (as they already must use the same
   * `epsilon`/`delta`), since a merge of differently-hashed sketches is meaningless.
   */
  seed?: number;
}

/**
 * A mergeable, serializable Count-Min Sketch for **cluster-wide** frequency estimation in fixed
 * memory.
 */
export interface MergeableSketch {
  /** Add `count` (default 1) to `key`'s local tally; returns the new local estimate. */
  add(key: string, count?: number): number;
  /** Current estimate for `key` over everything added or merged so far. Never underestimates. */
  estimate(key: string): number;
  /** Total mass added/merged so far (the `N` in the `epsilon·N` bound). */
  readonly total: number;
  /** Counter count backing the sketch (`depth*width`) — fixed, independent of key count. */
  readonly capacity: number;
  /** A detached copy of this sketch's state, to ship to peers or fold in elsewhere. */
  snapshot(): SketchSnapshot;
  /** Compact little-endian bytes of {@link MergeableSketch.snapshot}, for cross-node transport. */
  toBytes(): Uint8Array;
  /** Fold a peer's snapshot into this sketch (exact element-wise add; throws on dimension mismatch). */
  merge(snapshot: SketchSnapshot): void;
  /** Zero the sketch. */
  reset(): void;
}

/**
 * A **mergeable** Count-Min Sketch for cluster-wide heavy-hitter detection.
 *
 * Each node keeps its own fixed-memory sketch of the traffic it sees ({@link MergeableSketch.add}).
 * Because CMS counters are linear, periodically summing the nodes' sketches
 * ({@link MergeableSketch.merge}, fed by {@link MergeableSketch.snapshot} / {@link MergeableSketch.toBytes}
 * over whatever transport you already have) yields a sketch of the *union* of all their streams —
 * a global per-key frequency estimate in the same fixed footprint, regardless of node count or key
 * cardinality. This sketch is **plain** (non-conservative), so a merge is *exact*: identical to one
 * sketch that had seen every node's stream. The estimate never underestimates, so threshold shedding
 * (e.g. "shed any key whose global estimate exceeds X this window") never misses a true heavy hitter.
 *
 * **Honest scope.** This is an *eventually-consistent* global **estimator** for detection and
 * best-effort shedding — each node acts on its most recent merged view. It is **not** a
 * strongly-consistent global limiter and gives no hard never-over-admit guarantee across the cluster;
 * for an exact shared limit use {@link rateLimit} over a Redis/Postgres store, or `twoTier`. The
 * library provides the mergeable data structure and the math, not the merge schedule or transport —
 * those stay yours (gossip, a periodic push to a coordinator, etc.).
 *
 * @experimental Excluded from the 1.x SemVer guarantee (may change in a minor). See STABILITY.md.
 */
export function mergeableSketch(options: MergeableSketchOptions = {}): MergeableSketch {
  const epsilon = options.epsilon ?? 0.01;
  const delta = options.delta ?? 0.001;
  // Plain (non-conservative) CMS: counters are purely additive, so a merge is the exact union. The
  // seed defaults to a fixed value so peers hash identically and merge without coordination.
  const sketch = new CountMinSketch(epsilon, delta, false, options.seed ?? MERGEABLE_DEFAULT_SEED);
  return {
    add: (key, count = 1) => {
      // A counter is an integer Uint32: a fractional count truncates (desyncing the table from `total`)
      // and a negative count wraps to a huge value — both corrupt the never-underestimate invariant.
      // Require a positive integer, exactly as the sketchRateLimit cost path does.
      requireCost(count);
      requireInteger("mergeableSketch.count", count);
      return sketch.add(key, count);
    },
    estimate: (key) => sketch.estimate(key),
    get total() {
      return sketch.total;
    },
    capacity: sketch.size,
    snapshot: () => sketch.snapshot(),
    toBytes: () => sketch.toBytes(),
    merge: (snap) => sketch.mergeSnapshot(snap),
    reset: () => sketch.clear(),
  };
}
