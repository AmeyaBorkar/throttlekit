/**
 * The snapshot shapes the in-process telemetry hub produces and the `--tui` dashboard renders. All shapes
 * are internal to `throttlekit-server` (no wire/HTTP transport) — the hub is read by the terminal renderer
 * in the same process. See `server/src/tui.ts`.
 */

import type {
  AdmissionAnalyticsSnapshot,
  AdmissionLane,
  AnalyticsSnapshot,
  Decision,
  UnifiedAxis,
} from "throttlekit";

/** Per-process (one instance) or fleet-merged (reserved; the TUI renders a single process today). */
export type LensMode = "process" | "fleet";

/** Snapshot envelope metadata. */
export interface LensMeta {
  /** Epoch-ms the snapshot was produced. */
  generatedAt: number;
  /** The analytics window width (ms) the counters are aggregated over. */
  windowMs: number;
  /** `"process"` for a single instance. */
  mode: LensMode;
  /** The hub/dashboard version. */
  lensVersion: string;
  /** A stable id for this node (the server's host:port). */
  nodeId?: string;
  /** Number of nodes merged (reserved). */
  fleetNodes?: number;
}

/**
 * One tracked policy. A `"limiter"` (plain `rateLimit`/`quota`/…) carries the universal
 * {@link AnalyticsSnapshot}; an `"admitter"` (a `unifiedAdmission`) carries the lane-segmented
 * {@link AdmissionAnalyticsSnapshot} that lights up the binding-axis lane.
 */
export interface LensPolicySnapshot {
  name: string;
  kind: "limiter" | "admitter";
  /** The strategy name for a limiter (e.g. `"gcra"`). */
  strategy?: string;
  /** Configured axes for an admitter, when known. */
  axes?: UnifiedAxis[];
  analytics: AnalyticsSnapshot | AdmissionAnalyticsSnapshot;
  /** Most recently observed effective ceiling (drives the headroom / Guarantee readout). */
  limit?: number;
  /** Recent admit-path latency over a small ring (the Latency view); p50/p99 are nearest-rank. */
  latency?: { avgMs: number; p50Ms: number; p99Ms: number; maxMs: number; n: number };
  /**
   * Near-future capacity forecast for the policy's hottest key (the Capacity view). Present only for a
   * limiter on a **synchronous** store (`forecastSync`) with observed traffic — an async store (Redis /
   * Postgres) or an admitter leaves it absent, which the view renders as "n/a". Epoch-ms timestamps.
   */
  forecast?: { key: string; spendableNow: number; nextReplenishAt: number; fullAt: number };
  /**
   * When a limiter has no `forecast` this snapshot, *why* — so the Capacity view labels it honestly
   * instead of conflating distinct causes: `"async"` (an async store has no sync forecast), `"idle"` (no
   * traffic yet, so no hot key), `"unsupported"` (the strategy/limiter exposes no forecast at all).
   */
  forecastUnavailable?: "async" | "idle" | "unsupported";
}

/** A concurrency guard's live health (from `ConcurrencyGuard.stats()`; distributed extras when present). */
export interface LensGuardSnapshot {
  name: string;
  limit: number;
  inflight: number;
  rttNoload: number;
  lastRtt: number;
  /** Distributed guard: this node's share of the global ceiling. */
  share?: number;
  /** Distributed guard: the aggregated global ceiling. */
  lGlobal?: number;
  /** Distributed guard: number of live nodes. */
  nodes?: number;
  /** Distributed guard: whether the node is self-fenced (partitioned). */
  fenced?: boolean;
}

/** A generic stats source (e.g. weighted-fair-escrow `stats()`) the dashboard renders by `kind`. */
export interface LensStatsSnapshot {
  name: string;
  kind: string;
  /** The raw `stats()` value; shape depends on `kind`. */
  value: unknown;
}

/** One row in the live denial feed. */
export interface LensDenialRow {
  at: number;
  policy: string;
  key: string;
  /** The binding lane (admitters only); absent for a plain-limiter denial. */
  lane?: AdmissionLane;
  allowed: boolean;
  /** The decision that produced this denial — the "why, with numbers". */
  decision: Decision;
  /** Per-axis decisions (admitters) for the exact-numbers breakdown. */
  perAxis?: Partial<Record<UnifiedAxis, Decision>>;
}

/** One self-fence event in the live concurrency fence feed. */
export interface LensFenceRow {
  at: number;
  guard: string;
}

/** Optional store/fleet health, set by the host (the server integration). */
export interface LensHealth {
  backend?: string;
  reachable?: boolean;
  failMode?: "open" | "closed";
  leaseTableSize?: number;
  reclaimCount?: number;
}

/** The full snapshot the hub produces each frame; the TUI renders it. */
export interface LensSnapshot {
  meta: LensMeta;
  policies: LensPolicySnapshot[];
  guards: LensGuardSnapshot[];
  stats: LensStatsSnapshot[];
  recentDenials: LensDenialRow[];
  recentFences: LensFenceRow[];
  health?: LensHealth;
}
