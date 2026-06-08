/**
 * The **telemetry hub** — a zero-dependency, in-process aggregator of ThrottleKit traffic.
 *
 * Register the limiters / unified admitters / concurrency guards the server serves and the hub returns
 * *tapped* wrappers to use in their place; it then maintains a rolling per-window snapshot (allow/deny,
 * per-axis denials for admitters, top-K heavy hitters, observed ceiling + admit-path latency, guard
 * health) plus a bounded live feed of recent denials (each with its exact per-axis decision) and
 * self-fence events. `snapshot()` is what the `--tui` dashboard renders each frame; `subscribe()` feeds
 * the live denial / fence feed.
 *
 * Universal by design: a plain `rateLimit()` feeds the full board via {@link tapDecisions} + `withAnalytics`;
 * a `unifiedAdmission` additionally lights up the binding-axis lane via `admissionTap` +
 * `withAdmissionAnalytics`. The taps are synchronous, exception-swallowing, and O(1), so the dashboard can
 * never perturb the control path.
 */

import {
  type AdmissionAnalyticsAdmitter,
  type AdmissionEvent,
  type AnalyticsLimiter,
  type Clock,
  type ConcurrencyGuard,
  type Decision,
  type DecisionEvent,
  type Limiter,
  type UnifiedAdmitter,
  type UnifiedAxis,
  admissionTap,
  systemClock,
  tapDecisions,
  withAdmissionAnalytics,
  withAnalytics,
} from "throttlekit";
import { isCostRoomSnapshot } from "./burn.js";
import { RingBuffer } from "./ring.js";
import type {
  LensCostRoomSnapshot,
  LensDenialRow,
  LensFenceRow,
  LensGuardSnapshot,
  LensHealth,
  LensPolicySnapshot,
  LensSnapshot,
  LensStatsSnapshot,
} from "./types.js";

/** The hub/dashboard version, stamped into every snapshot's `meta.lensVersion`. */
export const MONITOR_VERSION = "0.3.0";

/** How many recent admit-path latencies to retain per policy for the latency readout. */
const LATENCY_RING = 256;
/** The unified axes, for cleaning a per-axis snapshot down to its defined entries. */
const AXES: readonly UnifiedAxis[] = ["rate", "concurrency", "cost"];

/** Options for {@link createLensHub}. */
export interface LensHubOptions {
  /** Analytics window width (ms) for the rolling counters. Default 60_000. */
  windowMs?: number;
  /** Heavy-hitter top-K depth per summary. Default 10. */
  topK?: number;
  /** Max recent denial / fence rows retained for the live feed. Default 200. */
  recentLimit?: number;
  /** Injected clock (deterministic tests). Default the system clock. */
  clock?: Clock;
  /** A stable id for this node, surfaced in `meta.nodeId`. */
  nodeId?: string;
}

/** A live subscriber to the hub's denial / fence feed. */
export interface LensListener {
  onDenial?: (row: LensDenialRow) => void;
  onFence?: (row: LensFenceRow) => void;
}

/** The in-process telemetry hub. Register sources, read `snapshot()`, `subscribe()` for live events. */
export interface LensHub {
  /** Track a plain limiter; returns the tapped limiter to use in its place. */
  trackLimiter(name: string, limiter: Limiter): Limiter;
  /** Track a unified admitter (lights up the binding-axis lane); returns the tapped admitter. */
  trackAdmitter(name: string, admitter: UnifiedAdmitter): UnifiedAdmitter;
  /** Track a concurrency guard for the health panel; returns it unchanged. */
  trackGuard(name: string, guard: ConcurrencyGuard): ConcurrencyGuard;
  /** Track an arbitrary `stats()`-style source (e.g. weighted-fair-escrow) rendered by `kind`. */
  trackStats(name: string, kind: string, read: () => unknown): void;
  /** Record a self-fence event (wire a distributed guard's `onFenced` to this). */
  recordFence(guard: string): void;
  /** Set the store/fleet health block (e.g. from the server integration). */
  setHealth(health: LensHealth): void;
  /** Build the current snapshot (cheap; a fresh detached object). */
  snapshot(): LensSnapshot;
  /** Subscribe to the live denial / fence feed; returns an unsubscribe function. */
  subscribe(listener: LensListener): () => void;
}

/** Per-policy side metrics the analytics snapshot doesn't carry (the observed ceiling + latency ring). */
interface PolicyMeta {
  lastLimit: number;
  lat: RingBuffer<number>;
}

/** Create an in-process telemetry hub. */
export function createLensHub(options: LensHubOptions = {}): LensHub {
  const windowMs = options.windowMs ?? 60_000;
  const topK = options.topK ?? 10;
  const recentLimit = options.recentLimit ?? 200;
  const clock = options.clock ?? systemClock;

  // `source` is the original (pre-analytics) limiter, forecast via `forecastSync` for the Capacity view.
  // The analytics/tap wrappers DO forward `forecastSync` (forwardIntrospection) as of throttlekit 1.1.0;
  // using `source` is just the canonical, wrapper-independent choice — not a workaround for a dropped method.
  const limiters: Array<{
    name: string;
    analytics: AnalyticsLimiter;
    meta: PolicyMeta;
    source: Limiter;
  }> = [];
  const admitters: Array<{
    name: string;
    analytics: AdmissionAnalyticsAdmitter;
    meta: PolicyMeta;
  }> = [];
  const guards: Array<{ name: string; guard: ConcurrencyGuard }> = [];
  const customStats: Array<{ name: string; kind: string; read: () => unknown }> = [];
  const recentDenials = new RingBuffer<LensDenialRow>(recentLimit);
  const recentFences = new RingBuffer<LensFenceRow>(recentLimit);
  const listeners = new Set<LensListener>();
  let health: LensHealth | undefined;

  const emitDenial = (row: LensDenialRow): void => {
    recentDenials.push(row);
    // Isolate each subscriber: a throwing listener must never break the feed for the others — and, since
    // this runs inside the tap, never reach the control path.
    for (const l of listeners) {
      try {
        l.onDenial?.(row);
      } catch {
        // observer-only: swallow.
      }
    }
  };

  return {
    trackLimiter(name, limiter) {
      const analytics = withAnalytics(limiter, { windowMs, topK, clock });
      const meta: PolicyMeta = { lastLimit: 0, lat: new RingBuffer<number>(LATENCY_RING) };
      limiters.push({ name, analytics, meta, source: limiter });
      // tapDecisions feeds the live denial stream + side metrics; withAnalytics holds the snapshot.
      return tapDecisions(analytics, (e: DecisionEvent) => {
        meta.lastLimit = e.decision.limit;
        meta.lat.push(e.durationMs);
        if (!e.decision.allowed) {
          emitDenial({
            at: clock.now(),
            policy: name,
            key: e.key,
            allowed: false,
            decision: e.decision,
          });
        }
      });
    },

    trackAdmitter(name, admitter) {
      const analytics = withAdmissionAnalytics(admitter, { windowMs, topK, clock });
      const meta: PolicyMeta = { lastLimit: 0, lat: new RingBuffer<number>(LATENCY_RING) };
      admitters.push({ name, analytics, meta });
      return admissionTap(analytics, (e: AdmissionEvent) => {
        meta.lastLimit = e.decision.limit;
        meta.lat.push(e.durationMs);
        if (e.decision.allowed) return;
        const row: LensDenialRow = {
          at: clock.now(),
          policy: name,
          key: e.key,
          allowed: false,
          decision: e.decision,
        };
        if (e.lane !== undefined) row.lane = e.lane;
        const perAxis = cleanPerAxis(e.perAxis);
        if (Object.keys(perAxis).length > 0) row.perAxis = perAxis;
        emitDenial(row);
      });
    },

    trackGuard(name, guard) {
      guards.push({ name, guard });
      return guard;
    },

    trackStats(name, kind, read) {
      customStats.push({ name, kind, read });
    },

    recordFence(guard) {
      const row: LensFenceRow = { at: clock.now(), guard };
      recentFences.push(row);
      for (const l of listeners) {
        try {
          l.onFence?.(row);
        } catch {
          // observer-only: swallow.
        }
      }
    },

    setHealth(h) {
      health = h;
    },

    snapshot(): LensSnapshot {
      const policies: LensPolicySnapshot[] = [];
      for (const { name, analytics, meta, source } of limiters) {
        const a = analytics.analytics();
        const policy = withMeta(
          { name, kind: "limiter", strategy: analytics.strategy.name, analytics: a },
          meta,
        );
        const fc = forecastHot(source, a);
        if ("unavailable" in fc) policy.forecastUnavailable = fc.unavailable;
        else policy.forecast = fc;
        policies.push(policy);
      }
      for (const { name, analytics, meta } of admitters) {
        policies.push(withMeta({ name, kind: "admitter", analytics: analytics.analytics() }, meta));
      }
      const guardSnaps: LensGuardSnapshot[] = guards.map(({ name, guard }) =>
        guardSnapshot(name, guard),
      );
      // A "cost-room" source's read returns a fully-built LensCostRoomSnapshot (it owns its own burn
      // accumulator); route those into `costRooms`. Every other custom stat feeds the generic `stats`
      // array as before. A throwing/unavailable source is dropped honestly (safeRead → `{error}`).
      const stats: LensStatsSnapshot[] = [];
      const costRooms: LensCostRoomSnapshot[] = [];
      for (const { name, kind, read } of customStats) {
        const value = safeRead(read);
        if (kind === "cost-room") {
          if (isCostRoomSnapshot(value)) costRooms.push(value);
        } else {
          stats.push({ name, kind, value });
        }
      }
      const snap: LensSnapshot = {
        meta: { generatedAt: clock.now(), windowMs, mode: "process", lensVersion: MONITOR_VERSION },
        policies,
        guards: guardSnaps,
        stats,
        recentDenials: recentDenials.toArray(),
        recentFences: recentFences.toArray(),
      };
      if (costRooms.length > 0) snap.costRooms = costRooms;
      if (options.nodeId !== undefined) snap.meta.nodeId = options.nodeId;
      if (health !== undefined) snap.health = health;
      return snap;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Attach the observed ceiling + latency summary to a policy snapshot. */
function withMeta(policy: LensPolicySnapshot, meta: PolicyMeta): LensPolicySnapshot {
  if (meta.lastLimit > 0) policy.limit = meta.lastLimit;
  const lat = meta.lat.toArray();
  if (lat.length > 0) {
    let sum = 0;
    let max = 0;
    for (const v of lat) {
      sum += v;
      if (v > max) max = v;
    }
    const sorted = [...lat].sort((a, b) => a - b);
    policy.latency = {
      avgMs: sum / lat.length,
      p50Ms: percentile(sorted, 50),
      p99Ms: percentile(sorted, 99),
      maxMs: max,
      n: lat.length,
    };
  }
  return policy;
}

/** Nearest-rank percentile of an ascending-sorted sample (empty → 0). */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

/**
 * Forecast the hottest key's near-future capacity for the Capacity view, or — when no sync forecast is
 * available — *why*, so the view can label it honestly: `"async"` (an async store has no sync forecast),
 * `"idle"` (no traffic yet, hence no hot key), `"unsupported"` (the limiter exposes no forecast at all).
 */
function forecastHot(
  limiter: Limiter,
  snap: { topDenied: ReadonlyArray<{ key: string }>; topRequested: ReadonlyArray<{ key: string }> },
): NonNullable<LensPolicySnapshot["forecast"]> | { unavailable: "async" | "idle" | "unsupported" } {
  if (limiter.forecastSync === undefined) return { unavailable: "unsupported" };
  // The throttled key (top-denied) is the most useful capacity readout; fall back to the busiest key.
  const key = snap.topDenied[0]?.key ?? snap.topRequested[0]?.key;
  if (key === undefined) return { unavailable: "idle" };
  try {
    const f = limiter.forecastSync(key);
    return {
      key,
      spendableNow: f.spendableNow,
      nextReplenishAt: f.nextReplenishAt,
      fullAt: f.fullAt,
    };
  } catch (err) {
    // forecastSync throws on an async store ("requires a synchronous store") or a strategy with no
    // forecast — distinguish them so the view never tells a busy async-store operator "no traffic".
    const msg = err instanceof Error ? err.message : "";
    return { unavailable: /synchronous store|async/i.test(msg) ? "async" : "unsupported" };
  }
}

/** Drop the `undefined` per-axis entries so the row's `perAxis` only carries real decisions. */
function cleanPerAxis(
  p: Readonly<Partial<Record<UnifiedAxis, Decision | undefined>>>,
): Partial<Record<UnifiedAxis, Decision>> {
  const out: Partial<Record<UnifiedAxis, Decision>> = {};
  for (const axis of AXES) {
    const d = p[axis];
    if (d !== undefined) out[axis] = d;
  }
  return out;
}

/** Read a concurrency guard's `stats()`, copying the distributed extras when present. */
function guardSnapshot(name: string, guard: ConcurrencyGuard): LensGuardSnapshot {
  let s: Record<string, unknown>;
  try {
    s = guard.stats() as Record<string, unknown>;
  } catch {
    // A guard whose stats() throws must never crash snapshot() — which is also called from the render
    // loop, where an uncaught throw would take down the host process.
    s = {};
  }
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  const snap: LensGuardSnapshot = {
    name,
    limit: num(s.limit),
    inflight: num(s.inflight),
    rttNoload: num(s.rttNoload),
    lastRtt: num(s.lastRtt),
  };
  if (typeof s.share === "number") snap.share = s.share;
  if (typeof s.lGlobal === "number") snap.lGlobal = s.lGlobal;
  if (typeof s.nodes === "number") snap.nodes = s.nodes;
  if (typeof s.fenced === "boolean") snap.fenced = s.fenced;
  return snap;
}

/** Invoke a custom stats reader, never letting a throwing source break the snapshot. */
function safeRead(read: () => unknown): unknown {
  try {
    return read();
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
