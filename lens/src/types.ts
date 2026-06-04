/**
 * The wire shapes the Lens transport speaks (`GET /api/snapshot` + the SSE `/api/stream`). All shapes are
 * append-only (add optional fields; never remove/repurpose) — `@experimental`, outside throttlekit's 1.x
 * SemVer freeze. See `research/lens/DESIGN.md`.
 */

import type {
  AdmissionAnalyticsSnapshot,
  AdmissionLane,
  AnalyticsSnapshot,
  UnifiedAxis,
} from "throttlekit";

/** Per-process (one instance) or fleet-merged (an aggregator over many instances). */
export type LensMode = "process" | "fleet";

/** Snapshot envelope metadata. */
export interface LensMeta {
  /** Epoch-ms the snapshot was produced. */
  generatedAt: number;
  /** The analytics window width (ms) the counters are aggregated over. */
  windowMs: number;
  /** `"process"` for a single instance; `"fleet"` for an aggregator merge. */
  mode: LensMode;
  /** The Lens package version. */
  lensVersion: string;
  /** A stable id for this node (set when colocated in a server or pushing to an aggregator). */
  nodeId?: string;
  /** Number of nodes merged (fleet mode only). */
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

/** A generic stats source (e.g. weighted-fair-escrow `stats()`) the UI renders by `kind`. */
export interface LensStatsSnapshot {
  name: string;
  kind: string;
  /** The raw `stats()` value; shape depends on `kind`. */
  value: unknown;
}

/** One row in the live denial feed / click-to-snapshot drawer. */
export interface LensDenialRow {
  at: number;
  policy: string;
  key: string;
  /** The binding lane (admitters only); absent for a plain-limiter denial. */
  lane?: AdmissionLane;
  allowed: boolean;
}

/** One self-fence event in the live concurrency fence feed. */
export interface LensFenceRow {
  at: number;
  guard: string;
}

/** Optional store/fleet health, set by the host (e.g. the server integration). */
export interface LensHealth {
  backend?: string;
  reachable?: boolean;
  failMode?: "open" | "closed";
  leaseTableSize?: number;
  reclaimCount?: number;
}

/** The full snapshot returned by `GET /api/snapshot` and pushed as the SSE `snapshot` event. */
export interface LensSnapshot {
  meta: LensMeta;
  policies: LensPolicySnapshot[];
  guards: LensGuardSnapshot[];
  stats: LensStatsSnapshot[];
  recentDenials: LensDenialRow[];
  recentFences: LensFenceRow[];
  health?: LensHealth;
}
