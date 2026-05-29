/**
 * `TestConcurrencyCoordinator` — an in-memory, deterministic
 * `ConcurrencyCoordinator` for tests + examples. Models the same
 * heartbeat-aggregate-split semantics the `RedisConcurrencyCoordinator`
 * implements (TK-1315): each node reports its locally-inferred `lLocal`; the
 * coordinator folds all live reports into `L_global = aggregate(...)` and grants
 * the node a BUDGET-CAPPED equal-split share. Expired leases are evicted by
 * comparing the node-supplied `expiresAt` against an injected `clock`.
 *
 * The event-release sibling of `TestCoordinator` (federation): same
 * "central authority leases sub-budgets to N participants" shape, but the
 * lease is renewed by heartbeat (liveness) and reclaimed by TTL, not reset by
 * a wall-clock window. See DESIGN §3 + §9; the reference algorithm is §10.1,
 * implemented here literally.
 *
 * **Why the cap (D-DAC-17 + D-DAC-18).** Stateless equal-split (`⌊L/N⌋` computed
 * independently per node) is UNSAFE under staggered heartbeats: a freshly-joined
 * node would compute its small share while an incumbent still holds its larger
 * pre-join share, so `Σ share` transiently exceeds `L_global` with `L_global`
 * constant. We therefore track each node's currently-granted `share` AND its
 * last-reported `inflight`, and cap every grant at the budget no other live node
 * is currently *holding*: `L_global − Σ_other max(share, inflight)`.
 *   - The `share` term makes `Σ share ≤ L_global` a hard invariant under ANY
 *     interleaving at constant `L_global` (D-DAC-17 — over-*commitment* safety).
 *   - The `inflight` term ELIMINATES the *synchronous* rebalance overshoot
 *     (D-DAC-18): a peer's in-flight is non-revocable, so until it physically
 *     drains that capacity is occupied and is NOT re-granted to a joiner —
 *     converting the protocol-level overshoot (joiner ramps while an incumbent
 *     drains, up to 1.5×) into a ramp *delay*. `Σ inflight ≤ L_global` is thereby
 *     a hard invariant of the SYNCHRONOUS model (spec + BFS twin) and holds
 *     end-to-end in the common low-latency case. It is NOT a hard *instantaneous*
 *     bound under async grant/report lag: a bounded (~1.5–2×), self-draining
 *     residual remains because a guard admits against its CACHED grant while a
 *     reduction is still in flight, and the cap reserves a peer's LAST-REPORTED
 *     inflight (a hard instantaneous bound would need acknowledged handoff —
 *     deferred). Steady state (`inflight == share`) collapses `max` to `share`, so
 *     D-DAC-17, the equal-split target, and convergence are unchanged. See DESIGN §6.
 *
 * No timers; no I/O. Deterministic under an injected clock.
 */

import { systemClock } from "../core/clock";
import { StoreUnavailableError } from "../core/errors";
import type { Clock } from "../core/types";
import type { ConcurrencyCoordinator, ConcurrencyGrant, ConcurrencyReport } from "./coordinator";

/** Options for {@link TestConcurrencyCoordinator}. */
export interface TestConcurrencyCoordinatorOptions {
  /**
   * Fleet-wide aggregation policy (§7). `"median"` is the lower median of the
   * live nodes' `lLocal`; `"min"` is the most-stressed node's view. NEVER
   * `sum` (§7 / D-DAC-10). Defaults to `"median"`.
   */
  aggregate?: "min" | "median";
  /**
   * Injected clock. Expiry is compared against `clock.now()`. Defaults to
   * {@link systemClock}.
   */
  clock?: Clock;
}

/** One node's last report + currently-granted share, retained per key. */
interface NodeRecord {
  lLocal: number;
  inflight: number;
  expiresAt: number;
  /** The share this node currently holds (the value its last grant returned). */
  share: number;
}

export class TestConcurrencyCoordinator implements ConcurrencyCoordinator {
  #healthy = true;
  readonly #aggregate: "min" | "median";
  readonly #clock: Clock;
  /** key -> (nodeId -> last report + granted share). */
  readonly #state = new Map<string, Map<string, NodeRecord>>();

  constructor(options: TestConcurrencyCoordinatorOptions = {}) {
    this.#aggregate = options.aggregate ?? "median";
    this.#clock = options.clock ?? systemClock;
  }

  /** Simulate a coordinator partition. `heartbeat()` throws until `setHealthy(true)`. */
  setHealthy(healthy: boolean): void {
    this.#healthy = healthy;
  }

  /**
   * For tests: snapshot the current aggregate + the per-node shares the
   * coordinator has actually granted (NOT a fresh stateless re-split). The
   * invariant `Σ shares ≤ lGlobal` holds whenever `lGlobal` has been stable; it
   * is the budget the global bound is checked against.
   */
  peek(key: string): { lGlobal: number; nodes: number; shares: Record<string, number> } {
    const perKey = this.#state.get(key);
    const now = this.#clock.now();
    const live: NodeRecord[] = [];
    const shares: Record<string, number> = {};
    if (perKey !== undefined) {
      for (const [id, rec] of perKey) {
        if (rec.expiresAt >= now) {
          live.push(rec);
          shares[id] = rec.share;
        }
      }
    }
    if (live.length === 0) return { lGlobal: 0, nodes: 0, shares };
    const lGlobal = this.#aggregateOf(live.map((r) => r.lLocal));
    return { lGlobal, nodes: live.length, shares };
  }

  async heartbeat(report: ConcurrencyReport): Promise<ConcurrencyGrant> {
    if (!this.#healthy) {
      throw new StoreUnavailableError(
        `TestConcurrencyCoordinator partitioned (heartbeat "${report.key}")`,
      );
    }

    const now = this.#clock.now();
    let perKey = this.#state.get(report.key);
    if (perKey === undefined) {
      perKey = new Map<string, NodeRecord>();
      this.#state.set(report.key, perKey);
    }

    // 1. upsert self, carrying forward any share we already granted it (0 if new).
    const prior = perKey.get(report.nodeId);
    perKey.set(report.nodeId, {
      lLocal: report.lLocal,
      inflight: report.inflight,
      expiresAt: report.expiresAt,
      share: prior?.share ?? 0,
    });

    // 2. evict expired (expiresAt < now). Self always survives (it just renewed);
    //    an evicted node's share leaves the live sum, reclaiming its budget.
    for (const [id, rec] of perKey) {
      if (rec.expiresAt < now) perKey.delete(id);
    }

    // 3. aggregate live nodes' lLocal (§7). Self is always live.
    const liveIds = [...perKey.keys()];
    const lGlobal = this.#aggregateOf(liveIds.map((id) => perKey.get(id)!.lLocal));

    // 4. equal-split TARGET for self (§6): base + 1 for the first `rem` by sorted id.
    const n = liveIds.length;
    const base = Math.floor(lGlobal / n);
    const rem = lGlobal - base * n;
    const sorted = [...liveIds].sort();
    const rank = sorted.indexOf(report.nodeId);
    const target = base + (rank < rem ? 1 : 0);

    // 5. CAP the grant at the budget no OTHER live node is currently HOLDING —
    //    reserve each peer's max(share, inflight), not just its share (D-DAC-18).
    //    A peer's in-flight is non-revocable: until it physically drains, that
    //    capacity is occupied and MUST NOT be re-granted here. Reserving only
    //    `share` lets a joiner ramp into capacity an incumbent still occupies
    //    (the Σ inflight rebalance overshoot — up to 1.5× on a 1→2 scale-up);
    //    reserving max(share, inflight) eliminates that SYNCHRONOUS overshoot —
    //    the joiner ramps only as fast as the incumbent drains. (Hard in the
    //    synchronous model; in the async system a bounded ~1.5× residual remains
    //    from grant/report lag — see DESIGN §9.3 / D-DAC-18.) Steady state
    //    (inflight == share) is identical to the share-only cap, so
    //    `Σ share ≤ lGlobal` (D-DAC-17) is preserved and convergence is unchanged.
    let otherReserved = 0;
    for (const id of liveIds) {
      if (id === report.nodeId) continue;
      const rec = perKey.get(id)!;
      otherReserved += Math.max(rec.share, rec.inflight);
    }
    const share = Math.max(0, Math.min(target, lGlobal - otherReserved));

    // 6. record the grant so subsequent heartbeats by other nodes see it committed.
    perKey.get(report.nodeId)!.share = share;

    return { share, lGlobal, nodes: n };
  }

  async leave(args: { key: string; nodeId: string }): Promise<void> {
    this.#state.get(args.key)?.delete(args.nodeId);
  }

  async isHealthy(): Promise<boolean> {
    return this.#healthy;
  }

  /** Aggregate the live `lLocal` list per the configured policy (§7). */
  #aggregateOf(values: number[]): number {
    if (this.#aggregate === "min") {
      return Math.min(...values);
    }
    // "median": ascending-sort, take the lower median at index floor((N-1)/2).
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) / 2)]!;
  }
}
