/**
 * Built-in, dependency-free analytics.
 *
 * {@link withAnalytics} wraps a {@link Limiter} so every check is observed in-process — no
 * OpenTelemetry backend, no peer dependency, zero config. The returned object is a drop-in
 * {@link Limiter} (same `strategy`/`check`/`checkSync`/`reset`, delegating to the inner limiter)
 * augmented with two methods:
 *
 * - {@link AnalyticsLimiter.analytics} — a snapshot of the current window's traffic: allow/deny
 *   counts and bounded-memory top-K "heavy hitters" (the keys driving the most requests and the
 *   most denials).
 * - {@link AnalyticsLimiter.resetAnalytics} — clear counters and summaries.
 *
 * The window is fixed and epoch-aligned exactly like {@link fixedWindow}
 * (`floor(now / windowMs) * windowMs`); rolling into a new window resets counts and summaries, so a
 * snapshot always reflects the *current* window to date.
 *
 * Top-K uses the **Space-Saving** algorithm (Metwally, Agrawal & El Abbadi, "Efficient Computation
 * of Frequent and Top-k Elements in Data Streams", 2005). It tracks at most `topK` entries
 * regardless of how many distinct keys are observed, so memory is bounded by `topK` even under a
 * flood of unique keys — and it over-estimates only, never under-counts a true heavy hitter.
 */

import { systemClock } from "../core/clock";
import { forwardIntrospection } from "../core/limiter";
import type { Clock, Decision, Limiter, Strategy } from "../core/types";
import { requireAtLeast, requirePositive } from "../core/validate";

/** Configuration for {@link withAnalytics}. All fields optional; sensible zero-config defaults. */
export interface AnalyticsOptions {
  /** How many heavy hitters each summary tracks (bounds memory). Default 10. */
  topK?: number;
  /** Fixed, epoch-aligned window width in ms. Default 60_000. */
  windowMs?: number;
  /** Injected clock, for deterministic tests. Defaults to the system clock. */
  clock?: Clock;
}

/** One heavy-hitter entry surfaced in a snapshot: a key and its (over-)estimated count. */
export interface HeavyHitter {
  /** The observed key. */
  key: string;
  /** Space-Saving frequency estimate (an upper bound on the true count). */
  count: number;
}

/**
 * An immutable view of one limiter's traffic over the current window.
 *
 * `topRequested`/`topDenied` are sorted by `count` descending and never exceed the configured
 * `topK`. `denyRate` is `denied / total`, or `0` when `total` is `0`.
 */
export interface AnalyticsSnapshot {
  /** Epoch-aligned start of the current window (`floor(now / windowMs) * windowMs`). */
  windowStartedAt: number;
  /** The configured window width in ms (echoed for convenience). */
  windowMs: number;
  /** Requests admitted in the current window. */
  allowed: number;
  /** Requests denied in the current window. */
  denied: number;
  /** `allowed + denied`. */
  total: number;
  /** `denied / total`, or `0` when `total` is `0`. */
  denyRate: number;
  /** Keys driving the most requests this window, count-descending. At most `topK` entries. */
  topRequested: HeavyHitter[];
  /** Keys driving the most denials this window, count-descending. At most `topK` entries. */
  topDenied: HeavyHitter[];
}

/** A drop-in {@link Limiter} that also exposes its own in-process analytics. */
export interface AnalyticsLimiter extends Limiter {
  /** Snapshot the current window's stats. Cheap; allocates a fresh, detached object each call. */
  analytics(): AnalyticsSnapshot;
  /** Clear all counters and both summaries (does not touch the inner limiter's state). */
  resetAnalytics(): void;
}

/** A single monitored slot in a Stream-Summary: a key, its count, and its over-estimate bound. */
interface Slot {
  key: string;
  count: number;
  /** The over-estimation bound: `count - error` is a guaranteed lower bound on the true count. */
  error: number;
}

/**
 * A fixed-capacity Stream-Summary implementing the Space-Saving update.
 *
 * Invariant: at most `capacity` slots are ever held, so memory is `O(capacity)` no matter how many
 * distinct keys flow through. Observing a key:
 *
 * - if already monitored, increment its count;
 * - else if there is spare capacity, admit it with `count = 1`, `error = 0`;
 * - else evict the *minimum-count* slot and reuse it for the new key with `count = min + 1` and
 *   `error = min` — the new key inherits the evicted minimum as its over-estimation bound.
 *
 * `count` is therefore always an upper bound on a key's true frequency (over-estimates only), which
 * is what guarantees Space-Saving never drops a genuine heavy hitter.
 */
class StreamSummary {
  readonly #capacity: number;
  /** key -> slot, for O(1) hit detection and increment. */
  readonly #slots = new Map<string, Slot>();

  constructor(capacity: number) {
    this.#capacity = capacity;
  }

  /** Observe one occurrence of `key`, applying the Space-Saving update. */
  observe(key: string): void {
    const existing = this.#slots.get(key);
    if (existing !== undefined) {
      existing.count += 1;
      return;
    }

    if (this.#slots.size < this.#capacity) {
      this.#slots.set(key, { key, count: 1, error: 0 });
      return;
    }

    // Summary full: evict the slot with the minimum count and reuse it for `key`.
    const min = this.#minSlot();
    // `min` is defined: capacity is >= 1 and the map is at capacity, so it is non-empty.
    this.#slots.delete(min.key);
    min.key = key;
    min.error = min.count; // the evicted minimum becomes the new key's over-estimate bound
    min.count += 1; // count = min + 1
    this.#slots.set(key, min);
  }

  /** The number of monitored slots — never exceeds the capacity (used to assert bounded memory). */
  get size(): number {
    return this.#slots.size;
  }

  /** Drop every monitored slot. */
  clear(): void {
    this.#slots.clear();
  }

  /** The monitored entries as `{ key, count }`, sorted by count descending (ties: key ascending). */
  top(): HeavyHitter[] {
    const out: HeavyHitter[] = [];
    for (const slot of this.#slots.values()) {
      out.push({ key: slot.key, count: slot.count });
    }
    out.sort((a, b) => (b.count !== a.count ? b.count - a.count : a.key < b.key ? -1 : 1));
    return out;
  }

  /** Find the monitored slot with the smallest count (the eviction candidate). */
  #minSlot(): Slot {
    let min: Slot | undefined;
    for (const slot of this.#slots.values()) {
      if (min === undefined || slot.count < min.count) min = slot;
    }
    // Non-null: only called when the map is at capacity (>= 1), so it is non-empty.
    return min as Slot;
  }
}

/**
 * Wrap `limiter` so its traffic is tracked in-process. The returned {@link AnalyticsLimiter} is a
 * thin delegate: `strategy` and `reset` pass straight through, `check` awaits the inner async check
 * and records when the {@link Decision} resolves, and `checkSync` delegates to the inner sync check
 * (so it still throws when the inner store is async-only) and records only after it returns.
 *
 * A request is counted exactly once per *successful* inner check, against the window the check
 * lands in. Each observation feeds the requested summary; denials additionally feed the denied
 * summary.
 */
export function withAnalytics(limiter: Limiter, options: AnalyticsOptions = {}): AnalyticsLimiter {
  const topK = options.topK ?? 10;
  const windowMs = options.windowMs ?? 60_000;
  const clock = options.clock ?? systemClock;

  requirePositive("withAnalytics.windowMs", windowMs);
  requireAtLeast("withAnalytics.topK", topK, 1);

  let windowStart = -1;
  let allowed = 0;
  let denied = 0;
  const requested = new StreamSummary(topK);
  const denials = new StreamSummary(topK);

  /** Reset every counter and summary to an empty window. */
  const clear = (): void => {
    allowed = 0;
    denied = 0;
    requested.clear();
    denials.clear();
  };

  /**
   * Roll forward to the window containing `now` if we have crossed a boundary. Epoch-aligned
   * exactly like {@link fixedWindow}. Resets counters and summaries on every roll.
   */
  const roll = (now: number): void => {
    const start = Math.floor(now / windowMs) * windowMs;
    if (start !== windowStart) {
      windowStart = start;
      clear();
    }
  };

  /** Record one completed inner check against the current window. */
  const record = (decision: Decision): void => {
    // Read the clock once here so the window a check is attributed to matches when it completed.
    roll(clock.now());
    if (decision.allowed) {
      allowed += 1;
    } else {
      denied += 1;
    }
  };

  // `key` is observed after the decision so the summaries only ever reflect successful checks.
  const observe = (key: string, decision: Decision): void => {
    requested.observe(key);
    if (!decision.allowed) denials.observe(key);
  };

  return {
    get strategy(): Strategy {
      return limiter.strategy;
    },

    async check(key: string, cost?: number): Promise<Decision> {
      const decision = await limiter.check(key, cost);
      record(decision);
      observe(key, decision);
      return decision;
    },

    checkSync(key: string, cost?: number): Decision {
      // If the inner store is async-only, checkSync throws here; let it propagate untouched and
      // record nothing.
      const decision = limiter.checkSync(key, cost);
      record(decision);
      observe(key, decision);
      return decision;
    },

    async checkMany(keys: readonly string[], cost?: number): Promise<Decision[]> {
      const decisions = await limiter.checkMany(keys, cost);
      for (let i = 0; i < decisions.length; i++) {
        const d = decisions[i] as Decision;
        record(d);
        observe(keys[i] as string, d);
      }
      return decisions;
    },

    checkManySync(keys: readonly string[], cost?: number): Decision[] {
      const decisions = limiter.checkManySync(keys, cost);
      for (let i = 0; i < decisions.length; i++) {
        const d = decisions[i] as Decision;
        record(d);
        observe(keys[i] as string, d);
      }
      return decisions;
    },

    reset(key: string): Promise<void> {
      return limiter.reset(key);
    },

    // Forward non-consuming introspection + disposal so wrapping never hides them.
    ...forwardIntrospection(limiter),

    analytics(): AnalyticsSnapshot {
      // Snapshotting must observe a window roll too, so stats read after a boundary (with no
      // intervening check) reflect the fresh, empty window rather than stale counts.
      roll(clock.now());
      const total = allowed + denied;
      return {
        windowStartedAt: windowStart,
        windowMs,
        allowed,
        denied,
        total,
        denyRate: total === 0 ? 0 : denied / total,
        topRequested: requested.top(),
        topDenied: denials.top(),
      };
    },

    resetAnalytics(): void {
      // Force the next observation/snapshot to re-establish the window, then clear all state.
      windowStart = -1;
      clear();
    },
  };
}
