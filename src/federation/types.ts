/**
 * Cross-cluster federation — public types.
 *
 * See `research/bigger-bets/federation/DESIGN.md` for the full design and
 * the lift argument from `GaleWindowCoupledLeasing` to a federated quorum.
 *
 * At this commit (TK-902) the types are public + frozen; the behavior lands
 * in TK-903 (static partition baseline) and TK-904 (window-coupled federated
 * leasing). `FederatedStore.apply` throws `NotImplementedError` until then.
 */

import type { Store } from "../core/types";

/**
 * A region identity — a short, human-readable string used in coordinator
 * key prefixes, telemetry, and error messages. Examples: `"us-east"`,
 * `"eu-west"`, `"ap-south"`.
 *
 * The federation logic uses this string opaquely; the only contract is
 * that it is stable for the lifetime of a coordinator (so reconcile()
 * and lease() can be attributed to the same region across calls).
 */
export type Region = string;

/**
 * Cross-region lease coordinator — the "L3" of the federated stack.
 *
 * One coordinator instance is shared across all regions for a given key
 * prefix. Implementations include `RedisCoordinator` (TK-906; single global
 * Redis; documented SPOF) and future `PostgresCoordinator` / Raft-via-etcd
 * options.
 *
 * The coordinator MUST be **window-coupled**: leases expire at `expiresAt`
 * (the window boundary for the strategy at `key`). The default Redis
 * implementation enforces this via PEXPIRE on the lease record; alternate
 * implementations must respect the same lifetime contract for the
 * federation bound to hold (see DESIGN.md §3.1 / §4 "What the model
 * deliberately omits").
 */
export interface GlobalCoordinator {
  /**
   * Lease `tokens` units of budget for one window from the global key `key`.
   *
   * Returns the granted amount in `[0, tokens]` — partial grants are
   * legitimate (other regions raced the global budget down before this
   * call landed). `expiresAt` is the window boundary in epoch-ms; the
   * grant is invalid after that instant and the coordinator MUST enforce
   * expiry (this is the load-bearing window-coupling commitment).
   *
   * MAY reject with `StoreUnavailableError` on coordinator unreachability;
   * the caller (FederatedStore) handles this per `onCoordinatorOutage`.
   */
  lease(key: string, tokens: number, expiresAt: number): Promise<number>;

  /**
   * Reconcile `leftover` un-served escrow back to the global budget at
   * the given `windowStart` (epoch-ms of the window's start). Idempotent
   * on `windowStart` — duplicate calls within one window MUST be no-ops,
   * so retries through a partition converge to the correct global state.
   *
   * `leftover` is non-negative. Reconciliation is best-effort: a failure
   * cannot violate the federation bound (it can only LOSE capacity the
   * federation could have admitted next window). Implementations MAY
   * silently drop on persistent failure.
   */
  reconcile(key: string, leftover: number, windowStart: number): Promise<void>;

  /**
   * Optional liveness probe. Returns `true` when the coordinator is
   * reachable and serving leases. Used by FederatedStore's failure-mode
   * detector to switch a region into fail-closed when the coordinator is
   * unreachable across a window boundary.
   *
   * Defaults to `() => Promise.resolve(true)` if not implemented — the
   * caller treats absence as "assume healthy until a `lease()` fails".
   */
  isHealthy?(): Promise<boolean>;
}

/**
 * What FederatedStore does when `coordinator.lease()` throws.
 *
 * - `"fail-closed"` (default, matches twoTier on L2 outage): the region
 *   serves whatever regional escrow it already holds, then denies until
 *   the coordinator returns. The Δ = 0 federation bound is preserved.
 * - `"regional-only"`: fall back to the regional Limit. Δ degrades to the
 *   regional bound, NOT the federation bound — soft-traffic operators
 *   opt into this when availability beats precision.
 *
 * See DESIGN.md §5.1.
 */
export type CoordinatorOutageMode = "fail-closed" | "regional-only";

/**
 * Options for {@link FederatedStore}.
 *
 * Lock notes (see DESIGN.md §9, decisions D-901-2 .. D-901-6):
 * - `regional` is a normal `Store` — typically a regional `RedisStore`. The
 *   federation logic wraps it without changing its contract.
 * - `coordinator` is the cross-region `GlobalCoordinator`; one coordinator
 *   serves all regions for a given key prefix.
 * - `region` is opaque; used in coordinator key prefixes + telemetry.
 * - `batch` defaults to 16; sized adaptively when `sizer` is provided
 *   (the GALE Pillar 2 sizer applies unchanged — see `twotier/sizing.ts`).
 * - `onCoordinatorOutage` defaults to `"fail-closed"` (safety > availability).
 */
export interface FederatedStoreOptions {
  /** The region's local Store (typically a regional RedisStore). */
  regional: Store;
  /** The cross-region lease coordinator. */
  coordinator: GlobalCoordinator;
  /** This region's identity (used in coordinator keys + telemetry). */
  region: Region;
  /**
   * The escrow size each region leases per global window. Default 16.
   *
   * Larger batch = fewer cross-region RTTs at the cost of up to
   * `(batch - 1) * (K - 1)` worst-case unused capacity under uneven load.
   * Under federated window-coupling that unused capacity does NOT contribute
   * to overshoot (Δ = 0) — it is purely a utilization concern.
   */
  batch?: number;
  /**
   * Optional adaptive lease sizer (the existing GALE Pillar 2 sizer applies
   * unchanged). Wiring is added in TK-904; until then the static `batch`
   * is used. Typed loosely here to avoid a hard dep on `twotier/sizing` in
   * the public surface; the `LeaseSizer` shape is the canonical reference.
   */
  sizer?: { recommend(): number };
  /** What to do when the coordinator is unreachable. Default `"fail-closed"`. */
  onCoordinatorOutage?: CoordinatorOutageMode;
}
