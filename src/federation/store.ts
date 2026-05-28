/**
 * `FederatedStore` — a `Store` that fronts a regional `Store` with a
 * cross-region `GlobalCoordinator` (the "L3" of the recursive twoTier stack).
 *
 * This commit (TK-902) ships the public surface only. `apply()` throws
 * `NotImplementedError` — the static-partition impl lands in TK-903, and the
 * window-coupled federated leasing in TK-904. Until then this class exists
 * to freeze the constructor + property surface so downstream tests and
 * docs can reference stable types.
 *
 * Behavior summary (committed in DESIGN.md §3.2):
 *
 * 1. Try the regional store (no global coordinator hit).
 *    On admit -> return its Decision verbatim.
 * 2. On regional-store exhaustion -> coordinator.lease(key, batch, expiresAt).
 *    On grant > 0 -> credit the regional store, retry step 1.
 *    On grant = 0 -> return denied (regional Decision).
 *    On coordinator throw -> per `onCoordinatorOutage` (fail-closed default).
 * 3. At each global window boundary -> coordinator.reconcile(key, leftover,
 *    windowStart). Idempotent on windowStart.
 *
 * `applySync` and `resetSync` are deliberately ABSENT: federated coordination
 * always crosses a region boundary, which is intrinsically async (cross-region
 * RTT 80–150 ms). Callers needing sync paths use a non-federated store.
 */

import { NotImplementedError } from "../core/errors";
import type { Store, Transform } from "../core/types";
import type {
  CoordinatorOutageMode,
  FederatedStoreOptions,
  GlobalCoordinator,
  Region,
} from "./types";

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
  readonly #coordinator: GlobalCoordinator;
  readonly #sizer: { recommend(): number } | undefined;

  constructor(options: FederatedStoreOptions) {
    if (options.batch !== undefined && (!Number.isFinite(options.batch) || options.batch < 1)) {
      throw new RangeError(`batch must be a finite number >= 1, got ${String(options.batch)}`);
    }
    this.#regional = options.regional;
    this.#coordinator = options.coordinator;
    this.region = options.region;
    this.batch = options.batch ?? DEFAULT_BATCH;
    this.#sizer = options.sizer;
    this.onCoordinatorOutage = options.onCoordinatorOutage ?? "fail-closed";
  }

  /**
   * Federated apply — runs `transform` atomically against the regional store,
   * drawing fresh escrow from the global coordinator on regional exhaustion.
   *
   * **Not yet implemented.** Throws `NotImplementedError` until TK-903 lands
   * the static-partition baseline and TK-904 lands the window-coupled
   * federated leasing impl.
   */
  apply<S, R>(_key: string, _transform: Transform<S, R>): Promise<R> {
    throw new NotImplementedError(
      `FederatedStore.apply is not yet implemented (lands in TK-903 / TK-904); region="${this.region}"`,
    );
  }

  /**
   * Forget a key in the regional store. The coordinator's global counter is
   * NOT reset by this call — that's an explicit administrative action, not a
   * per-key one, because resetting global state without coordination would
   * race other regions. Forgetting only the regional state is the safe
   * default that matches twoTier semantics.
   */
  async reset(key: string): Promise<void> {
    await this.#regional.reset(key);
  }

  /**
   * Release resources this FederatedStore *owns*. The regional store and
   * coordinator are caller-provided; they are NOT closed here (same rule as
   * twoTier). Today there is nothing to release; TK-904 will add a window-
   * boundary reconcile timer and close() will release it.
   */
  async close(): Promise<void> {
    // No owned resources yet. The window-boundary reconcile timer lands in TK-904.
  }

  // ---- Introspection helpers, used by later subtasks' tests ----

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
   * The current adaptive lease size (or {@link FederatedStore.batch} when no
   * sizer is configured). Used by TK-904 to decide each `lease()` size.
   */
  recommendedBatch(): number {
    if (this.#sizer === undefined) return this.batch;
    const r = this.#sizer.recommend();
    if (!Number.isFinite(r) || r < 1) return this.batch;
    return Math.floor(r);
  }
}
