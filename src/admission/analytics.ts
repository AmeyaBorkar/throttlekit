/**
 * Built-in, dependency-free **admission analytics** — the multi-axis fork of `withAnalytics`.
 *
 * {@link withAdmissionAnalytics} wraps a {@link UnifiedAdmitter} so every admit is observed in-process,
 * segmenting allow/deny counters AND the bounded-memory top-K heavy hitters **by binding lane**
 * (`rate` / `concurrency` / `cost` / `policy`). The result is a drop-in {@link UnifiedAdmitter} (same
 * `admit`/`admitSync`/`lastDecisions`) plus {@link AdmissionAnalyticsAdmitter.analytics} /
 * {@link AdmissionAnalyticsAdmitter.resetAnalytics}.
 *
 * It is a deliberate fork of `withAnalytics` (same epoch-aligned window, same Space-Saving top-K), not a
 * shared dependency, so this experimental surface stays isolated from the stable analytics module. The
 * lane of a denial is read from the admission's own `bindingAxis` (exact, never racy) — a denied admission
 * with no binding axis is, by the `unifiedAdmission` contract, a joint-LP `"policy"` denial — so the
 * counts are exact even under concurrent admits.
 *
 * @experimental Excluded from the 1.x SemVer guarantee (may change in a minor). See STABILITY.md.
 */

import { systemClock } from "../core/clock";
import type { Clock, Decision } from "../core/types";
import { requireAtLeast, requirePositive } from "../core/validate";
import type { AdmissionLane } from "./tap";
import type {
  UnifiedAdmission,
  UnifiedAdmitOptions,
  UnifiedAdmitter,
  UnifiedAxis,
} from "./unified";

/** The four admission lanes, in display order. `"policy"` = a joint-LP bid-price denial (not an axis). */
const LANES: readonly AdmissionLane[] = ["rate", "concurrency", "cost", "policy"];

/** Configuration for {@link withAdmissionAnalytics}. Mirrors `AnalyticsOptions`. */
export interface AdmissionAnalyticsOptions {
  /** How many heavy hitters each summary tracks (bounds memory). Default 10. */
  topK?: number;
  /** Fixed, epoch-aligned window width in ms. Default 60_000. */
  windowMs?: number;
  /** Injected clock, for deterministic tests. Defaults to the system clock. */
  clock?: Clock;
}

/** One heavy-hitter entry: a key and its (over-)estimated count. Mirrors analytics `HeavyHitter`. */
export interface AdmissionHeavyHitter {
  /** The observed key. */
  key: string;
  /** Space-Saving frequency estimate (an upper bound on the true count). */
  count: number;
}

/**
 * An immutable view of one admitter's traffic over the current window. `deniedByLane` partitions
 * `denied` across the four lanes — **Σ deniedByLane === denied** (exactly one lane per denial).
 */
export interface AdmissionAnalyticsSnapshot {
  /** Epoch-aligned start of the current window (`floor(now / windowMs) * windowMs`). */
  windowStartedAt: number;
  /** The configured window width in ms (echoed for convenience). */
  windowMs: number;
  /** Admits allowed in the current window. */
  allowed: number;
  /** Admits denied in the current window. */
  denied: number;
  /** `allowed + denied`. */
  total: number;
  /** `denied / total`, or `0` when `total` is `0`. */
  denyRate: number;
  /** Denials partitioned by binding lane; every lane present, `Σ === denied`. */
  deniedByLane: Record<AdmissionLane, number>;
  /** Keys driving the most admits this window, count-descending. At most `topK`. */
  topRequested: AdmissionHeavyHitter[];
  /** Keys driving the most denials this window (any lane), count-descending. At most `topK`. */
  topDenied: AdmissionHeavyHitter[];
  /** Per-lane top denied keys — the Sankey's axis → top-denied-keys flow. At most `topK` per lane. */
  topDeniedByLane: Record<AdmissionLane, AdmissionHeavyHitter[]>;
}

/** A drop-in {@link UnifiedAdmitter} that also exposes its own in-process, lane-segmented analytics. */
export interface AdmissionAnalyticsAdmitter extends UnifiedAdmitter {
  /** Snapshot the current window's stats. Cheap; allocates a fresh, detached object each call. */
  analytics(): AdmissionAnalyticsSnapshot;
  /** Clear all counters and summaries (does not touch the inner admitter's state). */
  resetAnalytics(): void;
}

/** A single monitored slot in a Stream-Summary: a key, its count, and its over-estimate bound. */
interface Slot {
  key: string;
  count: number;
  error: number;
}

/**
 * A fixed-capacity Stream-Summary implementing the Space-Saving update (Metwally, Agrawal & El Abbadi,
 * 2005) — a deliberate copy of the one in `src/analytics` to keep this experimental fork self-contained.
 * At most `capacity` slots are ever held, so memory is `O(capacity)` regardless of key cardinality, and
 * `count` only ever over-estimates, so a genuine heavy hitter is never dropped.
 */
class StreamSummary {
  readonly #capacity: number;
  readonly #slots = new Map<string, Slot>();

  constructor(capacity: number) {
    this.#capacity = capacity;
  }

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
    // Summary full: evict the minimum-count slot and reuse it for `key` (count = min + 1, error = min).
    const min = this.#minSlot();
    this.#slots.delete(min.key);
    min.key = key;
    min.error = min.count;
    min.count += 1;
    this.#slots.set(key, min);
  }

  get size(): number {
    return this.#slots.size;
  }

  clear(): void {
    this.#slots.clear();
  }

  top(): AdmissionHeavyHitter[] {
    const out: AdmissionHeavyHitter[] = [];
    for (const slot of this.#slots.values()) out.push({ key: slot.key, count: slot.count });
    out.sort((a, b) => (b.count !== a.count ? b.count - a.count : a.key < b.key ? -1 : 1));
    return out;
  }

  #minSlot(): Slot {
    let min: Slot | undefined;
    for (const slot of this.#slots.values()) {
      if (min === undefined || slot.count < min.count) min = slot;
    }
    return min as Slot;
  }
}

/** The lane a denied admission is attributed to (exact; from the admission's own binding axis). */
function laneOf(admission: UnifiedAdmission): AdmissionLane | undefined {
  if (admission.decision.allowed) return undefined;
  return admission.bindingAxis ?? "policy";
}

/** A fresh `{ rate:0, concurrency:0, cost:0, policy:0 }`. */
function zeroLaneCounts(): Record<AdmissionLane, number> {
  return { rate: 0, concurrency: 0, cost: 0, policy: 0 };
}

/** A fresh `{ rate:[], concurrency:[], cost:[], policy:[] }`. */
function emptyLaneTops(): Record<AdmissionLane, AdmissionHeavyHitter[]> {
  return { rate: [], concurrency: [], cost: [], policy: [] };
}

/**
 * Wrap `admitter` so its traffic is tracked in-process, segmented by binding lane. The returned
 * {@link AdmissionAnalyticsAdmitter} delegates `admit`/`admitSync`/`lastDecisions` to the inner admitter
 * and records each completed admit against the current epoch-aligned window.
 *
 * @experimental Excluded from the 1.x SemVer guarantee (may change in a minor). See STABILITY.md.
 */
export function withAdmissionAnalytics(
  admitter: UnifiedAdmitter,
  options: AdmissionAnalyticsOptions = {},
): AdmissionAnalyticsAdmitter {
  const topK = options.topK ?? 10;
  const windowMs = options.windowMs ?? 60_000;
  const clock = options.clock ?? systemClock;

  requirePositive("withAdmissionAnalytics.windowMs", windowMs);
  requireAtLeast("withAdmissionAnalytics.topK", topK, 1);

  let windowStart = -1;
  let allowed = 0;
  let denied = 0;
  let deniedByLane = zeroLaneCounts();
  const requested = new StreamSummary(topK);
  const denials = new StreamSummary(topK);
  const denialsByLane: Record<AdmissionLane, StreamSummary> = {
    rate: new StreamSummary(topK),
    concurrency: new StreamSummary(topK),
    cost: new StreamSummary(topK),
    policy: new StreamSummary(topK),
  };

  const clear = (): void => {
    allowed = 0;
    denied = 0;
    deniedByLane = zeroLaneCounts();
    requested.clear();
    denials.clear();
    for (const lane of LANES) denialsByLane[lane].clear();
  };

  /** Roll forward to the window containing `now`, epoch-aligned like `fixedWindow`; resets on a roll. */
  const roll = (now: number): void => {
    const start = Math.floor(now / windowMs) * windowMs;
    if (start !== windowStart) {
      windowStart = start;
      clear();
    }
  };

  /** Record one completed admit against the current window. `key` is observed after the decision. */
  const record = (key: string, admission: UnifiedAdmission): void => {
    roll(clock.now());
    requested.observe(key);
    if (admission.decision.allowed) {
      allowed += 1;
      return;
    }
    denied += 1;
    // laneOf never returns undefined on a denied admission; the `?? "policy"` keeps the
    // Σ deniedByLane === denied invariant unbreakable even if a future backend produced an odd shape.
    const lane = laneOf(admission) ?? "policy";
    deniedByLane[lane] += 1;
    denials.observe(key);
    denialsByLane[lane].observe(key);
  };

  return {
    async admit(opts?: UnifiedAdmitOptions): Promise<UnifiedAdmission> {
      const admission = await admitter.admit(opts);
      record(opts?.key ?? "", admission);
      return admission;
    },

    admitSync(opts?: UnifiedAdmitOptions): UnifiedAdmission {
      const admission = admitter.admitSync(opts);
      record(opts?.key ?? "", admission);
      return admission;
    },

    lastDecisions(): Readonly<Partial<Record<UnifiedAxis, Decision | undefined>>> {
      return admitter.lastDecisions();
    },

    analytics(): AdmissionAnalyticsSnapshot {
      // Snapshotting rolls the window too, so a read after a boundary (no intervening admit) reflects
      // the fresh, empty window rather than stale counts.
      roll(clock.now());
      const total = allowed + denied;
      const topDeniedByLane = emptyLaneTops();
      for (const lane of LANES) topDeniedByLane[lane] = denialsByLane[lane].top();
      return {
        windowStartedAt: windowStart,
        windowMs,
        allowed,
        denied,
        total,
        denyRate: total === 0 ? 0 : denied / total,
        deniedByLane: { ...deniedByLane },
        topRequested: requested.top(),
        topDenied: denials.top(),
        topDeniedByLane,
      };
    },

    resetAnalytics(): void {
      windowStart = -1;
      clear();
    },
  };
}
