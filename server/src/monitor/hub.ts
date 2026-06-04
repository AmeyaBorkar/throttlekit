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
import { RingBuffer } from "./ring.js";
import type {
  LensDenialRow,
  LensFenceRow,
  LensGuardSnapshot,
  LensHealth,
  LensPolicySnapshot,
  LensSnapshot,
  LensStatsSnapshot,
} from "./types.js";

/** The hub/dashboard version, stamped into every snapshot's `meta.lensVersion`. */
export const MONITOR_VERSION = "0.2.0-experimental.0";

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

  const limiters: Array<{ name: string; analytics: AnalyticsLimiter; meta: PolicyMeta }> = [];
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
      limiters.push({ name, analytics, meta });
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
      for (const { name, analytics, meta } of limiters) {
        policies.push(
          withMeta(
            {
              name,
              kind: "limiter",
              strategy: analytics.strategy.name,
              analytics: analytics.analytics(),
            },
            meta,
          ),
        );
      }
      for (const { name, analytics, meta } of admitters) {
        policies.push(withMeta({ name, kind: "admitter", analytics: analytics.analytics() }, meta));
      }
      const guardSnaps: LensGuardSnapshot[] = guards.map(({ name, guard }) =>
        guardSnapshot(name, guard),
      );
      const stats: LensStatsSnapshot[] = customStats.map(({ name, kind, read }) => ({
        name,
        kind,
        value: safeRead(read),
      }));
      const snap: LensSnapshot = {
        meta: { generatedAt: clock.now(), windowMs, mode: "process", lensVersion: MONITOR_VERSION },
        policies,
        guards: guardSnaps,
        stats,
        recentDenials: recentDenials.toArray(),
        recentFences: recentFences.toArray(),
      };
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
    policy.latency = { avgMs: sum / lat.length, maxMs: max, n: lat.length };
  }
  return policy;
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
