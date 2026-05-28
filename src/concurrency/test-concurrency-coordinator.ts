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
 * **Why the cap (D-DAC-17).** Stateless equal-split (`⌊L/N⌋` computed
 * independently per node) is UNSAFE under staggered heartbeats: a freshly-joined
 * node would compute its small share while an incumbent still holds its larger
 * pre-join share, so `Σ share` transiently exceeds `L_global` with `L_global`
 * constant. We therefore track each node's currently-granted `share` and cap
 * every grant at the remaining budget `L_global − Σ(other live shares)`. That
 * makes `Σ share ≤ L_global` a hard invariant under ANY heartbeat interleaving
 * when `L_global` is constant; the equal-split target is the value the fleet
 * *converges* to as nodes re-heartbeat. The only residual over-grant is a true
 * `L_global` shrink (backend degraded), bounded by one heartbeat and covered by
 * the guard's `min(share, local.limit)` fast-shrink (D-DAC-6). See DESIGN §6.
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

    // 5. CAP the grant at the budget not currently committed to OTHER live nodes,
    //    so Σ share ≤ lGlobal holds under any heartbeat interleaving (D-DAC-17).
    let otherShares = 0;
    for (const id of liveIds) {
      if (id !== report.nodeId) otherShares += perKey.get(id)!.share;
    }
    const share = Math.max(0, Math.min(target, lGlobal - otherShares));

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
