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

/**
 * One tenant's row in a {@link LensCostRoomSnapshot}: the work-conserving fair-share ledger plus a
 * window-aware burn rate and a within-window ETA, for the cost axis (#282). Computed once per frame at
 * `snapshot()` time as a pure projection of `WeightedFairEscrowStats` — never a decision-path read. All
 * values describe the CURRENT window: `used` is cumulative-this-window and resets at the window roll.
 */
export interface LensTenantBurnRow {
  /**
   * The tenant key. For a `fairEscrow` policy the request key IS the tenant (#291 P0). PII: this is the
   * single point an optional `redactKey` hook is applied. The hook is OFF by default (identity), so the
   * posture is honestly "not redacted" — never claimed otherwise.
   */
  tenant: string;
  /** Most-recent observed weight `wᵢ`. A live value — the ledger below is "at current weights". */
  weight: number;
  /** Cumulative consumption this window (`used`), in the policy's declared {@link LensCostRoomSnapshot.unit}. */
  used: number;
  /** Fair-share floor `gᵢ = ⌊wᵢ·L_eff/ΣW⌋` for the current active set (recomputed each frame). */
  guaranteed: number;
  /** Work-conserving borrow `max(0, used − guaranteed)`, surfaced as `+N` — never folded into `used`. */
  borrowed: number;
  /**
   * Burn rate in `unit`/second over the retained sample span (Prometheus-style `rate()`), or `null`
   * when not yet projectable — `< 2` samples, span too short, a window too short to sample, or a
   * same-window `used` decrease (a tenant reset, not a window roll). See {@link burnReason}.
   */
  burnPerSec: number | null;
  /**
   * Epoch-ms this tenant is projected to reach its guarantee floor at the current burn (borrowing NOT
   * counted), or `null` when not projectable (no burn / idle / unbounded headroom). Absolute, like every
   * other snapshot timestamp; the renderer derives "in Ns" against `meta.generatedAt`. Honestly scoped:
   * WFE is work-conserving, so a tenant can borrow past its floor — the only TRUE exhaustion number is
   * the shared pool ETA ({@link LensCostRoomSnapshot.poolEtaToExhaustAt}).
   */
  etaToExhaustAt: number | null;
  /**
   * `true` when `etaToExhaustAt` lands BEYOND the window edge (`windowStart + windowMs`) — the budget
   * refills first, so the raw ETA is false. The load-bearing honesty clamp: the renderer prints
   * "(resets in Ns)" instead of the raw ETA. Always `false` when `etaToExhaustAt` is `null`.
   */
  etaCappedByWindow: boolean;
  /** Why `burnPerSec` / `etaToExhaustAt` is `null`, when it is — so the view labels the cause honestly. */
  burnReason?: "warming" | "window-too-short" | "idle";
}

/**
 * One `fairEscrow` policy's **Cost Room** panel: the per-tenant cost-axis burn-down ledger, computed at
 * `snapshot()` time off `WeightedFairEscrowStats` (the one server source with a real per-tenant roster).
 * Optional + additive on {@link LensSnapshot.costRooms} — absent unless a policy opts in (default-on for
 * `fairEscrow`, explicit opt-out), so every existing consumer is untouched. Single-node + L1-only in v1;
 * the `scope` literal and `fairShareReliable` flag are the seams that make fleet (#283) and L2 additive.
 *
 * Design: `research/dashboard/designs/282-token-budget-control-room.md`. P0 confirmation: `…/282-P0-confirmation.md`.
 */
export interface LensCostRoomSnapshot {
  /** The policy name. */
  policy: string;
  /** Window start (epoch-ms, `floor(now/windowMs)·windowMs`); `-Infinity` before the first check. */
  windowStart: number;
  /** Configured per-window budget `L`. */
  limit: number;
  /** Effective budget visible to this process (= `limit` in L1-only; lazily-leased in L2). */
  effectiveLimit: number;
  /** Unallocated pool: `effectiveLimit − totalUsed`. */
  pool: number;
  /** Total used across all tenants this window (in this process). */
  totalUsed: number;
  /**
   * Declared unit label, echoed verbatim from config; default `"units (cost)"`. Free-form so an operator
   * metering tokens / requests / credits / USD labels it honestly — never hard-coded "tokens".
   */
  unit: string;
  /** Always the literal `"single-node"` in v1; widened to add `"fleet"` (#283) purely additively. */
  scope: "single-node";
  /** `false` whenever fair-share is process-local (L1-only — always in v1). The L2 seam. */
  fairShareReliable: boolean;
  /** `true` — a `fairEscrow` policy IS enforcing on cost (it denies on its own `check`). */
  enforced: boolean;
  /**
   * Epoch-ms the shared pool is projected to hit zero at the aggregate burn (`pool / Σ burnPerSec`) — the
   * only TRUE exhaustion number (the shared budget genuinely empties). Absent when not projectable.
   */
  poolEtaToExhaustAt?: number;
  /**
   * Cost-lane denials this window. ABSENT today: the server wires no cost axis into its admitter
   * (`buildAdmitter` passes no `cost:`), so the cost lane is structurally dark (#291 P0). Present only if
   * a paired cost-axis admitter is ever wired (a separately-authorized follow-up); rendered as "cost lane
   * not configured" while absent — never a zeroed panel dressed as a feature.
   */
  costDenied?: number;
  /** Per-key cost-lane heavy hitters — absent for the same reason as {@link costDenied}. */
  topCostKeys?: Array<{ key: string; count: number }>;
  /** The per-tenant ledger rows (bounded to the render candidate set + headroom). */
  tenants: LensTenantBurnRow[];
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
  /**
   * Cost Room panels — one per opted-in `fairEscrow` policy (the cost-axis burn-down view, #282).
   * Optional + additive: absent when no policy opts in, so older renderers/consumers ignore it.
   */
  costRooms?: LensCostRoomSnapshot[];
}
