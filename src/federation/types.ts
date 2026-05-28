/**
 * Cross-cluster federation — public types.
 *
 * See `research/bigger-bets/federation/DESIGN.md` for the full design and
 * the lift argument from `GaleWindowCoupledLeasing` to a federated quorum.
 *
 * At this commit (TK-902) the types are public + frozen; the behavior lands
 * in TK-903 (static partition baseline) and TK-904 (window-coupled federated
 * leasing). `FederatedStore.apply` throws `NotImplementedError` until then.
 *
 * TK-1306 (0.8.5) adds {@link RegionalEscrow} — the L2 layer between the
 * per-process engine L1 cache and the cross-region {@link GlobalCoordinator}
 * (L3). Mirrors GlobalCoordinator one layer down (see
 * `research/regional-escrow/DESIGN.md`).
 */

import type { Clock, Store, Strategy } from "../core/types";

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
 * Regional escrow — the L2 of the recursive twoTier federation stack, sitting
 * between the per-process in-process L1 cache and the cross-region L3
 * {@link GlobalCoordinator}. Mirrors the GlobalCoordinator surface one layer
 * down: a shared atomic store of "tokens-this-region-has-leased-from-L3-but-
 * not-yet-served". Multiple processes within a region share a single
 * `RegionalEscrow` (typically backed by regional Redis) so the in-flight
 * escrow per region is bounded by what L3 has actually granted to the region
 * — instead of `M × batch` (M independent processes each holding their own
 * lease) the bound becomes `≤ perKeyBudget` per window per region.
 *
 * It also enables {@link CoordinatorOutageMode}=`"regional-only"`: when L3
 * is unreachable, the engine continues serving from the L2 escrow until
 * depleted (availability-over-precision opt-in; the federation bound
 * degrades to the regional sub-bound during the outage).
 *
 * Implementations: {@link RedisRegionalEscrow} for production (atomic Lua
 * mirroring `RedisCoordinator`), {@link TestRegionalEscrow} for deterministic
 * unit tests (no I/O; injected clock).
 *
 * See `research/regional-escrow/DESIGN.md` for the full design.
 */
export interface RegionalEscrow {
  /**
   * Lease `tokens` units of L2 escrow for the active window. Returns the
   * granted amount in `[0, tokens]` — partial grants are legitimate (L2
   * was partially drained by other processes since the last refill).
   *
   * Returns `0` if the active window has expired OR no refill has happened
   * yet OR the L2 balance is empty. The caller (engine) is responsible for
   * topping L2 up from L3 via {@link refill} when LEASE returns 0.
   *
   * MAY throw `StoreUnavailableError` on regional store unreachability —
   * the caller treats this as L2 missing, falling back to direct L3 leasing
   * (so a regional Redis outage degrades to the existing 0.8.4 behavior).
   */
  lease(key: string, tokens: number): Promise<number>;

  /**
   * Refill L2 escrow from an L3 grant. `granted` is the tokens the L3
   * coordinator just returned to this process; `sourceWindowStart` is the
   * coordinator window the grant applies to.
   *
   * Semantics:
   * - If L2 has no entry OR L2's `source_lease ≠ sourceWindowStart`: replace
   *   (initialize a fresh entry with `balance = granted` for `sourceWindowStart`).
   * - If L2's `source_lease == sourceWindowStart`: add (`balance += granted`)
   *   so multiple processes' coord-grants accumulate in the shared L2.
   *
   * Window-coupled: if `sourceWindowStart + windowMs` is in the past at the
   * regional store's clock, the refill is dropped (a grant for a stale
   * window can't be applied — the formal window-coupling boundary). Returns
   * `false` in that case; `true` on successful refill.
   */
  refill(key: string, granted: number, sourceWindowStart: number): Promise<boolean>;

  /**
   * Release the L2's remaining balance back to the caller at the
   * `sourceWindowStart` window boundary. Returns the captured balance (≥ 0);
   * subsequent calls for the same `(key, sourceWindowStart)` return 0
   * (idempotency at the regional layer). The caller forwards this amount
   * to `coordinator.reconcile()` so L3's accounting picks up the unused
   * regional capacity.
   *
   * MAY throw `StoreUnavailableError` on regional store unreachability;
   * the caller drops the reconcile (best-effort — failure cannot violate
   * the federation bound; it only loses next-window capacity).
   */
  release(key: string, sourceWindowStart: number): Promise<number>;

  /**
   * Optional liveness probe. Returns `true` when the regional store is
   * reachable. Used by the engine's failure-mode detector (when present)
   * to skip the L2 path during a regional outage. Absence is treated as
   * "assume healthy until a `lease()` fails".
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
  /**
   * The federated strategy — `strategy.limit` defines the global per-window
   * budget; `strategy.windowMs` defines the window boundary the escrow
   * couples to. The strategy MUST have `windowMs` defined; pure-rate
   * strategies (gcra, tokenBucket) are unsupported at this commit.
   *
   * Added in TK-904 (was absent in the TK-902 skeleton): the federation
   * engine needs window/limit semantics for the synthesized Decisions and
   * for the window-coupling rule.
   */
  strategy: Strategy<unknown>;
  /**
   * The region's local Store. Used for the `Store.reset()` plumbing that
   * `FederatedStore.reset()` delegates to. As of 0.8.5 the engine itself
   * no longer consults this — pass {@link FederatedStoreOptions.regionalEscrow}
   * for the new multi-process per-region escrow path (TK-1306).
   */
  regional: Store;
  /**
   * Regional escrow (L2) for multi-process per-region atomicity (TK-1306,
   * 0.8.5). See {@link FederateOptions.regionalEscrow} for full semantics.
   * When undefined, the engine uses in-process escrow only.
   */
  regionalEscrow?: RegionalEscrow;
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
  /** Injected clock for deterministic tests. Defaults to the system clock. */
  clock?: Clock;
  /** Key namespace. */
  prefix?: string;
}
