/**
 * `FederatedStore` — a `Store` that fronts a regional `Store` with a
 * cross-region `GlobalCoordinator` (the "L3" of the recursive twoTier stack).
 *
 * As of TK-904 this class is a Store wrapper around the same federation
 * engine that backs `federate(...)` — `apply()` runs the engine's lease
 * logic and synthesizes Decisions, ignoring the strategy embedded in the
 * caller's transform (the engine's own strategy, supplied at construction,
 * is authoritative).
 *
 * Two equivalent surfaces:
 * - `federate({ strategy, coordinator, region, batch })` → Limiter
 *   (primary API; parallel to rateLimit / twoTier).
 * - `new FederatedStore({ strategy, coordinator, regional, region, batch })`
 *   → Store (composes with twoTier(leased) for the recursive-twoTier
 *   in-process L1 + regional escrow + global L3 stack).
 *
 * Both share `createFederationEngine` internally so they are bit-identical
 * for any given configuration.
 *
 * `applySync` and `resetSync` are deliberately ABSENT: federated
 * coordination always crosses a region boundary, which is intrinsically
 * async (cross-region RTT 80–150 ms). Callers needing sync use a
 * non-federated store.
 */

import type { Decision, Store, Strategy, Transform } from "../core/types";
import type {
  CoordinatorOutageMode,
  FederatedStoreOptions,
  GlobalCoordinator,
  Region,
  RegionalEscrow,
} from "./types";
import { type FederationEngine, createFederationEngine } from "./window-coupled";

/** Default lease batch size, see {@link FederatedStoreOptions.batch}. */
const DEFAULT_BATCH = 16;

export class FederatedStore implements Store {
  /** This region's identity. Exposed for telemetry + tests. */
  readonly region: Region;
  /** The default escrow lease size (overridden by `sizer.recommend()` when present). */
  readonly batch: number;
  /** Outage mode — what happens when the coordinator is unreachable. */
  readonly onCoordinatorOutage: CoordinatorOutageMode;

  readonly #regional: Store;
  readonly #regionalEscrow: RegionalEscrow | undefined;
  readonly #coordinator: GlobalCoordinator;
  readonly #strategy: Strategy<unknown>;
  readonly #sizer: { recommend(): number } | undefined;
  readonly #engine: FederationEngine;

  constructor(options: FederatedStoreOptions) {
    if (options.batch !== undefined && (!Number.isFinite(options.batch) || options.batch < 1)) {
      throw new RangeError(`batch must be a finite number >= 1, got ${String(options.batch)}`);
    }
    this.#regional = options.regional;
    this.#regionalEscrow = options.regionalEscrow;
    this.#coordinator = options.coordinator;
    this.#strategy = options.strategy;
    this.region = options.region;
    this.batch = options.batch ?? DEFAULT_BATCH;
    this.#sizer = options.sizer;
    this.onCoordinatorOutage = options.onCoordinatorOutage ?? "fail-closed";
    this.#engine = createFederationEngine({
      strategy: options.strategy,
      coordinator: options.coordinator,
      region: options.region,
      batch: this.batch,
      regional: options.regional,
      ...(options.regionalEscrow !== undefined ? { regionalEscrow: options.regionalEscrow } : {}),
      onCoordinatorOutage: this.onCoordinatorOutage,
      ...(options.clock !== undefined ? { clock: options.clock } : {}),
      ...(options.prefix !== undefined ? { prefix: options.prefix } : {}),
    });
  }

  /**
   * Federated apply — runs the federation engine and synthesizes a
   * Decision. The cost is extracted from the caller's transform (its
   * attached `lua.cost`, populated by `decisionTransform(...)`); a transform
   * without that hint is treated as cost = 1.
   *
   * IMPORTANT: the strategy in the caller's transform is ignored — the
   * federation's own strategy (passed at construction) is authoritative
   * for window boundaries and the Decision's `limit`. This is consistent
   * with how the L3 enforces the global bound in DESIGN.md §3.2; the
   * caller-supplied transform is consulted only for the cost.
   */
  async apply<S, R>(key: string, transform: Transform<S, R>): Promise<R> {
    const cost = readCostHint(transform);
    const decision = await this.#engine.check(key, cost);
    // R is `Decision` in every practical caller (rateLimit / twoTier);
    // we cast to satisfy the generic contract.
    return decision as unknown as R;
  }

  /**
   * Forget a key in the federation's per-process state AND in the regional
   * store (when wired). The coordinator's global counter is NOT reset —
   * that's an administrative action, not a per-key one, because resetting
   * global state without coordination would race other regions.
   */
  async reset(key: string): Promise<void> {
    await this.#engine.reset(key);
    await this.#regional.reset(key);
  }

  /**
   * Release resources this FederatedStore *owns*. The regional store and
   * coordinator are caller-provided; they are NOT closed here. The engine's
   * per-key entries are dropped.
   */
  async close(): Promise<void> {
    await this.#engine.close();
  }

  // ---- Introspection helpers, used by tests + telemetry ----

  /**
   * The coordinator instance, for tests + telemetry that need to assert
   * coordinator state. Not part of the `Store` contract.
   */
  get coordinator(): GlobalCoordinator {
    return this.#coordinator;
  }

  /**
   * The regional store, for tests + telemetry. Not part of the `Store` contract.
   */
  get regional(): Store {
    return this.#regional;
  }

  /**
   * The regional escrow (L2), for tests + telemetry. `undefined` when the
   * engine is running in the legacy in-process-only mode. Not part of the
   * `Store` contract.
   */
  get regionalEscrow(): RegionalEscrow | undefined {
    return this.#regionalEscrow;
  }

  /** The federated strategy, for tests + telemetry. */
  get strategy(): Strategy<unknown> {
    return this.#strategy;
  }

  /**
   * The current adaptive lease size (or {@link FederatedStore.batch} when no
   * sizer is configured). The engine reads this at lease time.
   */
  recommendedBatch(): number {
    if (this.#sizer === undefined) return this.batch;
    const r = this.#sizer.recommend();
    if (!Number.isFinite(r) || r < 1) return this.batch;
    return Math.floor(r);
  }
}

/**
 * Pull the cost from a `Transform` that was built via `decisionTransform(...)`.
 * Falls back to 1 for transforms without a `lua` invocation attached (which
 * is the canonical "decision-shaped" carrier of the cost).
 */
function readCostHint<S, R>(transform: Transform<S, R>): number {
  // Transforms built via decisionTransform attach a `lua` invocation that
  // carries the `cost`. We treat absence as "default cost 1".
  const lua = (transform as { lua?: { cost?: number } }).lua;
  const c = lua?.cost;
  if (typeof c === "number" && Number.isFinite(c) && c > 0) return c;
  return 1;
}

// Re-export Decision type to make the strange-but-true "FederatedStore.apply
// returns a Decision" relationship obvious from this file's surface.
export type { Decision };
