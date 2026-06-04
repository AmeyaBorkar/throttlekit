/**
 * The Lens **telemetry hub** — a zero-dependency, in-process aggregator of ThrottleKit traffic.
 *
 * Register the limiters / unified admitters / concurrency guards your app uses and the hub returns
 * *tapped* wrappers to use in their place; it then maintains a rolling per-window snapshot (allow/deny,
 * per-axis denials for admitters, top-K heavy hitters, guard health) plus a bounded live feed of recent
 * denials and self-fence events. `snapshot()` is what `GET /api/snapshot` serves; `subscribe()` is what the
 * SSE stream pushes.
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
  type DecisionEvent,
  type Limiter,
  type UnifiedAdmitter,
  admissionTap,
  systemClock,
  tapDecisions,
  withAdmissionAnalytics,
  withAnalytics,
} from "throttlekit";
import type {
  LensDenialRow,
  LensFenceRow,
  LensGuardSnapshot,
  LensHealth,
  LensPolicySnapshot,
  LensSnapshot,
  LensStatsSnapshot,
} from "./types.js";

/** The Lens package version, stamped into every snapshot's `meta.lensVersion`. */
export const LENS_VERSION = "0.1.0-experimental.0";

/** Options for {@link createLensHub}. */
export interface LensHubOptions {
  /** Analytics window width (ms) for the rolling counters. Default 60_000. */
  windowMs?: number;
  /** Heavy-hitter top-K depth per summary. Default 10. */
  topK?: number;
  /** Max recent denial / fence rows retained for the live feed + drawer. Default 200. */
  recentLimit?: number;
  /** Injected clock (deterministic tests). Default the system clock. */
  clock?: Clock;
  /** A stable id for this node, surfaced in `meta.nodeId` (server / fleet mode). */
  nodeId?: string;
}

/** A live subscriber to the hub's denial / fence feed (drives the SSE stream). */
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
  /** Track an arbitrary `stats()`-style source (e.g. weighted-fair-escrow) the UI renders by `kind`. */
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

/** Create an in-process Lens telemetry hub. */
export function createLensHub(options: LensHubOptions = {}): LensHub {
  const windowMs = options.windowMs ?? 60_000;
  const topK = options.topK ?? 10;
  const recentLimit = options.recentLimit ?? 200;
  const clock = options.clock ?? systemClock;

  const limiters: Array<{ name: string; analytics: AnalyticsLimiter }> = [];
  const admitters: Array<{ name: string; analytics: AdmissionAnalyticsAdmitter }> = [];
  const guards: Array<{ name: string; guard: ConcurrencyGuard }> = [];
  const customStats: Array<{ name: string; kind: string; read: () => unknown }> = [];
  const recentDenials: LensDenialRow[] = [];
  const recentFences: LensFenceRow[] = [];
  const listeners = new Set<LensListener>();
  let health: LensHealth | undefined;

  /** Append to a bounded ring (oldest dropped past `recentLimit`). */
  const pushBounded = <T>(arr: T[], row: T): void => {
    arr.push(row);
    if (arr.length > recentLimit) arr.shift();
  };

  const emitDenial = (row: LensDenialRow): void => {
    pushBounded(recentDenials, row);
    for (const l of listeners) l.onDenial?.(row);
  };

  return {
    trackLimiter(name, limiter) {
      const analytics = withAnalytics(limiter, { windowMs, topK, clock });
      limiters.push({ name, analytics });
      // tapDecisions feeds the live denial stream; withAnalytics holds the rolling snapshot.
      return tapDecisions(analytics, (e: DecisionEvent) => {
        if (!e.decision.allowed)
          emitDenial({ at: clock.now(), policy: name, key: e.key, allowed: false });
      });
    },

    trackAdmitter(name, admitter) {
      const analytics = withAdmissionAnalytics(admitter, { windowMs, topK, clock });
      admitters.push({ name, analytics });
      return admissionTap(analytics, (e: AdmissionEvent) => {
        if (e.decision.allowed) return;
        const row: LensDenialRow = { at: clock.now(), policy: name, key: e.key, allowed: false };
        if (e.lane !== undefined) row.lane = e.lane;
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
      pushBounded(recentFences, row);
      for (const l of listeners) l.onFence?.(row);
    },

    setHealth(h) {
      health = h;
    },

    snapshot(): LensSnapshot {
      const policies: LensPolicySnapshot[] = [];
      for (const { name, analytics } of limiters) {
        policies.push({
          name,
          kind: "limiter",
          strategy: analytics.strategy.name,
          analytics: analytics.analytics(),
        });
      }
      for (const { name, analytics } of admitters) {
        policies.push({ name, kind: "admitter", analytics: analytics.analytics() });
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
        meta: { generatedAt: clock.now(), windowMs, mode: "process", lensVersion: LENS_VERSION },
        policies,
        guards: guardSnaps,
        stats,
        recentDenials: [...recentDenials],
        recentFences: [...recentFences],
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

/** Read a concurrency guard's `stats()`, copying the distributed extras when present. */
function guardSnapshot(name: string, guard: ConcurrencyGuard): LensGuardSnapshot {
  const s = guard.stats() as Record<string, unknown>;
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
