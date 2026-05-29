/**
 * `TestConcurrencyCoordinator` — an in-memory, deterministic `ConcurrencyCoordinator` for
 * tests + examples. The full heartbeat-aggregate-cap compute lives in the shared pure
 * {@link applyHeartbeat} (`heartbeat-core`), so this coordinator and
 * `PostgresConcurrencyCoordinator` are STRUCTURALLY identical (one source of truth);
 * `RedisConcurrencyCoordinator` keeps its own Lua transcription, held to the same reference
 * by the dual-path conformance test.
 *
 * The event-release sibling of `TestCoordinator` (federation): same "central authority leases
 * sub-budgets to N participants" shape, but the lease is renewed by heartbeat (liveness) and
 * reclaimed by TTL, not reset by a wall-clock window. See DESIGN §3 + §9; the safety rationale
 * (the occupancy CAP — D-DAC-17/18, the handoff reserve floor D-DAC-19, and the allocation
 * TARGET D-DAC-9/22) is documented on {@link applyHeartbeat}.
 *
 * No timers; no I/O. Deterministic under an injected clock.
 */

import { systemClock } from "../core/clock";
import { StoreUnavailableError } from "../core/errors";
import type { Clock } from "../core/types";
import type { ConcurrencyCoordinator, ConcurrencyGrant, ConcurrencyReport } from "./coordinator";
import { type NodeRecord, aggregateOf, applyHeartbeat } from "./heartbeat-core";

/** Options for {@link TestConcurrencyCoordinator}. */
export interface TestConcurrencyCoordinatorOptions {
  /**
   * Fleet-wide aggregation policy (§7). `"median"` is the lower median of the live nodes'
   * `lLocal`; `"min"` is the most-stressed node's view. NEVER `sum` (§7 / D-DAC-10).
   * Defaults to `"median"`.
   */
  aggregate?: "min" | "median";
  /**
   * Injected clock. Expiry is compared against `clock.now()`. Defaults to {@link systemClock}.
   */
  clock?: Clock;
  /**
   * ACKNOWLEDGED HANDOFF (D-DAC-19) — opt-in, default `false`. When `true`, the cap reserves
   * each peer's MAX UN-ACKNOWLEDGED grant (via the grant-generation echo) unioned with its
   * reported in-flight — making `Σ inflight ≤ L_global` a HARD instantaneous bound even under
   * async grant-reply + reporting lag (TLA⁺ `GaleHeartbeatHandoff` + BFS twin TK-1330), at the
   * cost of ramp latency. When `false` (default), the cap is the 0.10.0 occupancy cap
   * `max(share, inflight)` (D-DAC-18). All nodes on a key MUST agree (like {@link aggregate}).
   */
  acknowledgedHandoff?: boolean;
  /**
   * Capacity ALLOCATION rule (D-DAC-9 / TK-1403) — how `L_global` is split into per-node
   * TARGETs. `"equal-split"` (**default**, behavior-preserving) gives every live node ≈`L/N`
   * regardless of use; `"demand-proportional"` lets a SATISFIED node (`inflight < share`)
   * drain to its occupancy + 1 probe slot, releasing the rest, which the cap re-grants to
   * HUNGRY nodes (`inflight ≥ share`) — +25–50pp utilization under skew, 0 regression when
   * balanced. SAFETY IS UNAFFECTED: the occupancy cap enforces both bounds for ANY target
   * (§6/§9.4). Starvation-free when `L_global ≥ N`. All nodes on a key MUST agree.
   */
  allocation?: "equal-split" | "demand-proportional";
}

export class TestConcurrencyCoordinator implements ConcurrencyCoordinator {
  #healthy = true;
  readonly #aggregate: "min" | "median";
  readonly #clock: Clock;
  readonly #acknowledgedHandoff: boolean;
  readonly #allocation: "equal-split" | "demand-proportional";
  /** key -> (nodeId -> last report + granted share). */
  readonly #state = new Map<string, Map<string, NodeRecord>>();

  constructor(options: TestConcurrencyCoordinatorOptions = {}) {
    this.#aggregate = options.aggregate ?? "median";
    this.#clock = options.clock ?? systemClock;
    this.#acknowledgedHandoff = options.acknowledgedHandoff ?? false;
    this.#allocation = options.allocation ?? "equal-split";
  }

  /** Simulate a coordinator partition. `heartbeat()` throws until `setHealthy(true)`. */
  setHealthy(healthy: boolean): void {
    this.#healthy = healthy;
  }

  /**
   * For tests: snapshot the current aggregate + the per-node shares the coordinator has
   * actually granted (NOT a fresh stateless re-split). `Σ shares ≤ lGlobal` holds whenever
   * `lGlobal` has been stable; it is the budget the global bound is checked against.
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
    const lGlobal = aggregateOf(
      live.map((r) => r.lLocal),
      this.#aggregate,
    );
    return { lGlobal, nodes: live.length, shares };
  }

  async heartbeat(report: ConcurrencyReport): Promise<ConcurrencyGrant> {
    if (!this.#healthy) {
      throw new StoreUnavailableError(
        `TestConcurrencyCoordinator partitioned (heartbeat "${report.key}")`,
      );
    }
    let perKey = this.#state.get(report.key);
    if (perKey === undefined) {
      perKey = new Map<string, NodeRecord>();
      this.#state.set(report.key, perKey);
    }
    // The full aggregate→target→cap→record compute is the shared pure `applyHeartbeat`
    // (heartbeat-core) — the SAME function PostgresConcurrencyCoordinator runs inside its
    // advisory-lock txn, so the two are structurally conformant. It mutates `perKey` (upsert
    // self, evict expired, write self's grant) and returns the grant.
    return applyHeartbeat(perKey, report, this.#clock.now(), {
      aggregate: this.#aggregate,
      allocation: this.#allocation,
      handoff: this.#acknowledgedHandoff,
    });
  }

  async leave(args: { key: string; nodeId: string }): Promise<void> {
    this.#state.get(args.key)?.delete(args.nodeId);
  }

  async isHealthy(): Promise<boolean> {
    return this.#healthy;
  }
}
