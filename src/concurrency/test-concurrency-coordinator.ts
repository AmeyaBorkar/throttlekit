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
  /**
   * ACKNOWLEDGED HANDOFF (D-DAC-19) — opt-in, default `false`. When `true`, the
   * cap reserves each peer's MAX UN-ACKNOWLEDGED grant (the largest share the
   * coordinator has issued that the peer has not yet confirmed superseding, via
   * the grant-generation echo) unioned with its reported in-flight — making
   * `Σ inflight ≤ L_global` a HARD instantaneous bound even under async
   * grant-reply + reporting lag (the residual D-DAC-18 leaves; TLA⁺
   * `GaleHeartbeatHandoff` + the BFS twin TK-1330). The cost is RAMP LATENCY: a
   * node gaining share waits for incumbents' lowered grants to land AND be
   * reported (≈1–2 extra heartbeats). When `false` (default), the cap is the
   * 0.10.0 occupancy cap `max(share, inflight)` (D-DAC-18) — faster ramp, a
   * bounded ~1.5× self-draining async overshoot. All nodes on a key MUST agree
   * (like {@link aggregate}); enable only once every guard echoes `appliedGen`.
   */
  acknowledgedHandoff?: boolean;
  /**
   * Capacity ALLOCATION rule (D-DAC-9 / TK-1403) — how `L_global` is split into
   * per-node TARGETs. `"equal-split"` (**default**, behavior-preserving) gives every
   * live node ≈`L/N` regardless of use: simple and fair, but under skew an idle node's
   * share is stranded — a busy peer is capped below what idle nodes waste, and the cap
   * can't re-grant it (§6 "Known limitation"). `"demand-proportional"` lets a SATISFIED
   * node (`inflight < share`) drain to its occupancy + 1 probe slot, RELEASING the rest,
   * which the cap then re-grants to HUNGRY nodes (`inflight ≥ share` — saturated, incl. a
   * new share-0 node). The TK-1403a gate measured +25–50pp utilization under skew with
   * ZERO regression when load is balanced. SAFETY IS UNAFFECTED: the occupancy cap (step
   * 5) enforces `Σ share ≤ L_global` and (synchronously) `Σ inflight ≤ L_global` for ANY
   * target — only the cap matters (§6, §9.4: "neither bound depends on the exact target").
   * Every node keeps a ≥1 probe slot so it can always reveal demand (starvation-free); the
   * cost is `N_idle` reserved slots, visible only when `L_global < N`. All nodes on a key
   * MUST agree (like {@link aggregate}). Default `"equal-split"`.
   */
  allocation?: "equal-split" | "demand-proportional";
}

/** One node's last report + currently-granted share, retained per key. */
interface NodeRecord {
  lLocal: number;
  inflight: number;
  expiresAt: number;
  /** The share this node currently holds (the value its last grant returned). */
  share: number;
  /** Acknowledged handoff (D-DAC-19): generation of `share` — bumped only when the
   *  granted VALUE changes, so the guard's echoed `appliedGen` reaching it means
   *  "caught up to the current value". 0 when handoff is off. */
  committedGen: number;
  /** Acknowledged handoff: the freshest heartbeat `seq` processed for this node
   *  (reordered/stale heartbeats with `seq ≤ maxSeq` don't advance committed state). */
  maxSeq: number;
  /** Acknowledged handoff: the MAX share value granted to this node since it last
   *  caught up — the reserve floor that defends a late-landing higher grant. Reset
   *  to `share` when the peer's `appliedGen` reaches `committedGen`. */
  unackedHigh: number;
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

    const handoff = this.#acknowledgedHandoff;
    const now = this.#clock.now();
    let perKey = this.#state.get(report.key);
    if (perKey === undefined) {
      perKey = new Map<string, NodeRecord>();
      this.#state.set(report.key, perKey);
    }

    // 1. upsert self, carrying forward prior grant state (0 if new). In handoff
    //    mode, a REORDERED/stale heartbeat (seq ≤ maxSeq) must not regress committed
    //    state nor pull reported inflight backward (an out-of-order, possibly lower,
    //    sample would under-reserve), so state advance is gated on `fresh`.
    const prior = perKey.get(report.nodeId);
    const priorShare = prior?.share ?? 0;
    const priorGen = prior?.committedGen ?? 0;
    const priorMaxSeq = prior?.maxSeq ?? 0;
    const priorUnackedHigh = prior?.unackedHigh ?? 0;
    const seq = report.seq ?? -1; // absent ⇒ sentinel; treated as always-fresh below
    const fresh = !handoff || seq < 0 || seq > priorMaxSeq;
    perKey.set(report.nodeId, {
      lLocal: report.lLocal,
      inflight: fresh ? report.inflight : (prior?.inflight ?? report.inflight),
      expiresAt: report.expiresAt,
      share: priorShare,
      committedGen: priorGen,
      maxSeq: handoff ? Math.max(priorMaxSeq, seq) : 0,
      unackedHigh: priorUnackedHigh,
    });

    // 2. evict expired (expiresAt < now). Self always survives (it just renewed);
    //    an evicted node's share leaves the live sum, reclaiming its budget.
    for (const [id, rec] of perKey) {
      if (rec.expiresAt < now) perKey.delete(id);
    }

    // 3. aggregate live nodes' lLocal (§7). Self is always live.
    const liveIds = [...perKey.keys()];
    const lGlobal = this.#aggregateOf(liveIds.map((id) => perKey.get(id)!.lLocal));

    // 4. TARGET for self (§6): equal-split (default) or demand-proportional (D-DAC-9 /
    //    TK-1403). The CAP (step 5) enforces Σshare≤L / Σinflight≤L for ANY target — this
    //    choice only affects utilization/fairness under skew, never the safety bound.
    const n = liveIds.length;
    const sorted = [...liveIds].sort();
    const target = this.#targetFor(report.nodeId, sorted, lGlobal, perKey);

    // 5. CAP the grant at the budget no OTHER live node is currently HOLDING.
    //    Default (D-DAC-18): max(share, inflight) — reserve a peer's committed share
    //    and its non-revocable in-flight, eliminating the SYNCHRONOUS rebalance
    //    overshoot but leaving a bounded ~1.5× async residual (grant/report lag).
    //    Acknowledged handoff (D-DAC-19): max(unackedHigh, inflight) — reserve the
    //    MAX UN-ACKED grant (the largest share the peer could still apply, incl. a
    //    higher grant the coordinator issued that the peer has not confirmed
    //    superseding) unioned with its reported occupancy. This makes
    //    `Σ inflight ≤ lGlobal` a HARD instantaneous bound (TLA⁺ GaleHeartbeatHandoff
    //    + BFS twin TK-1330) at the cost of ramp latency. Steady state collapses both
    //    to max(share, inflight), so `Σ share ≤ lGlobal` (D-DAC-17) and convergence hold.
    let otherReserved = 0;
    for (const id of liveIds) {
      if (id === report.nodeId) continue;
      const rec = perKey.get(id)!;
      otherReserved += handoff
        ? Math.max(rec.unackedHigh, rec.inflight)
        : Math.max(rec.share, rec.inflight);
    }
    const share = Math.max(0, Math.min(target, lGlobal - otherReserved));

    // 6. record the grant so subsequent heartbeats by other nodes see it committed.
    const self = perKey.get(report.nodeId)!;
    if (handoff) {
      if (fresh) {
        self.share = share;
        // generation bumps ONLY when the granted VALUE changes — so a stable value
        // lets the peer's echoed appliedGen catch up (no per-heartbeat ratchet that
        // would pin the reserve floor high forever).
        if (share !== priorShare) self.committedGen = priorGen + 1;
        // the new grant joins the un-acked set — reserve at least it…
        self.unackedHigh = Math.max(priorUnackedHigh, share);
        // …then CATCH-UP RESET: once the peer confirms enforcing the current
        // generation, drop the floor to the current share (no superseded higher
        // grant can still be in flight). Absent appliedGen ⇒ never resets (the SAFE,
        // over-reserving direction — a not-yet-upgraded guard).
        const appliedGen = report.appliedGen ?? -1;
        if (appliedGen >= self.committedGen) self.unackedHigh = share;
      }
      // a stale heartbeat returns the current committed grant without advancing state.
      return { share: self.share, lGlobal, nodes: n, gen: self.committedGen };
    }
    self.share = share;
    return { share, lGlobal, nodes: n };
  }

  async leave(args: { key: string; nodeId: string }): Promise<void> {
    this.#state.get(args.key)?.delete(args.nodeId);
  }

  async isHealthy(): Promise<boolean> {
    return this.#healthy;
  }

  /**
   * Per-node equal-split or demand-proportional TARGET (§6 step 4 / D-DAC-9). The CAP
   * (step 5) enforces both safety bounds for ANY target this returns, so this method is
   * purely a utilization/fairness policy. `sortedIds` is the live set sorted ascending;
   * `perKey` holds each live node's carried `share` + reported `inflight` (the demand
   * signal). MUST stay bit-identical to the Lua twin (RedisConcurrencyCoordinator §10.2).
   */
  #targetFor(
    selfId: string,
    sortedIds: string[],
    lGlobal: number,
    perKey: Map<string, NodeRecord>,
  ): number {
    if (this.#allocation === "equal-split") {
      const nn = sortedIds.length;
      const base = Math.floor(lGlobal / nn);
      const rem = lGlobal - base * nn;
      const rank = sortedIds.indexOf(selfId);
      return base + (rank < rem ? 1 : 0);
    }
    // demand-proportional (TK-1403): a SATISFIED node (inflight < share) aspires only to
    // its occupancy + 1 probe slot, releasing the rest; HUNGRY nodes (inflight ≥ share —
    // saturated, incl. a new share-0 node) equal-split the released budget; floor 1 keeps
    // every node able to reveal demand (starvation-free). Iterating the SORTED ids makes
    // the hungry-rank tiebreak deterministic and matches the Lua single-pass.
    const hungry: string[] = [];
    let reservedForSatisfied = 0;
    for (const id of sortedIds) {
      const rec = perKey.get(id)!;
      if (rec.inflight >= rec.share) hungry.push(id);
      else reservedForSatisfied += rec.inflight + 1;
    }
    const self = perKey.get(selfId)!;
    if (self.inflight < self.share) return self.inflight + 1; // satisfied → drain + probe
    const H = hungry.length;
    if (H === 0) return self.inflight + 1; // (self is hungry ⇒ H ≥ 1; defensive)
    const spare = Math.max(0, lGlobal - reservedForSatisfied);
    const base = Math.floor(spare / H);
    const rem = spare - base * H;
    const rank = hungry.indexOf(selfId);
    return Math.max(1, base + (rank < rem ? 1 : 0));
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
