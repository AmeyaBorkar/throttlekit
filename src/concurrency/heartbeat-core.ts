/**
 * `heartbeat-core` — the PURE heartbeat-aggregate-cap compute shared by
 * {@link TestConcurrencyCoordinator} and `PostgresConcurrencyCoordinator` (TK-1402).
 *
 * Extracting it makes those two coordinators STRUCTURALLY conformant — one source of truth,
 * not two transcriptions kept honest by a test. (`RedisConcurrencyCoordinator` keeps its own
 * Lua transcription — it necessarily runs server-side — and is held to this reference by the
 * dual-path conformance test.) All the safety machinery lives here: the occupancy CAP that
 * makes `GlobalCap` (Σ share ≤ L_global) a hard invariant and `InflightCap`
 * (Σ inflight ≤ L_global) a synchronous one (D-DAC-17/18), the acknowledged-handoff reserve
 * floor (D-DAC-19), and the allocation TARGET — equal-split or demand-proportional
 * (D-DAC-9 / D-DAC-22). See research/.../distributed-adaptive-concurrency/DESIGN.md §6/§9.
 *
 * `applyHeartbeat` is a pure function of `(state, report, now, opts)`: it upserts self,
 * evicts expired, aggregates `L_global`, computes the TARGET, applies the CAP, records the
 * grant + handoff bookkeeping, and returns the grant — MUTATING `state` in place (so the
 * caller can persist exactly the post-state: in-memory for Test, a txn upsert for Postgres).
 */

import type { ConcurrencyGrant, ConcurrencyReport } from "./coordinator";

export type Aggregate = "min" | "median";
export type Allocation = "equal-split" | "demand-proportional";

/** One node's last report + currently-granted share + handoff bookkeeping, retained per key. */
export interface NodeRecord {
  lLocal: number;
  inflight: number;
  expiresAt: number;
  /** The share this node currently holds (the value its last grant returned). */
  share: number;
  /** Acknowledged handoff (D-DAC-19): generation of `share` — bumped only on a VALUE change. */
  committedGen: number;
  /** Acknowledged handoff: the freshest heartbeat `seq` processed (stale-report gate). */
  maxSeq: number;
  /** Acknowledged handoff: the MAX share granted since the peer last caught up (reserve floor). */
  unackedHigh: number;
}

/** Fleet-wide aggregation + allocation + handoff policy (all nodes on a key MUST agree). */
export interface HeartbeatOptions {
  aggregate: Aggregate;
  allocation: Allocation;
  handoff: boolean;
}

/** Aggregate the live `lLocal` list per the configured policy (§7). */
export function aggregateOf(values: number[], aggregate: Aggregate): number {
  if (aggregate === "min") return Math.min(...values);
  // "median": ascending-sort, take the lower median at index floor((N-1)/2).
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
}

/**
 * Per-node equal-split or demand-proportional TARGET (§6 step 4 / D-DAC-9 / D-DAC-22). The
 * CAP enforces both safety bounds for ANY target, so this is purely a utilization/fairness
 * policy. `sortedIds` is the live set sorted ascending; `state` holds each live node's carried
 * `share` + reported `inflight`. MUST stay bit-identical to the Lua twin.
 */
function targetFor(
  selfId: string,
  sortedIds: string[],
  lGlobal: number,
  state: Map<string, NodeRecord>,
  allocation: Allocation,
): number {
  if (allocation === "equal-split") {
    const nn = sortedIds.length;
    const base = Math.floor(lGlobal / nn);
    const rem = lGlobal - base * nn;
    const rank = sortedIds.indexOf(selfId);
    return base + (rank < rem ? 1 : 0);
  }
  // demand-proportional (TK-1403): a SATISFIED node (inflight < share) aspires only to its
  // occupancy + 1 probe slot, releasing the rest; HUNGRY nodes (inflight ≥ share — saturated,
  // incl. a new share-0 node) equal-split the released budget; floor 1 keeps every node able
  // to reveal demand. Iterating the SORTED ids makes the hungry-rank tiebreak deterministic.
  const hungry: string[] = [];
  let reservedForSatisfied = 0;
  for (const id of sortedIds) {
    const rec = state.get(id)!;
    if (rec.inflight >= rec.share) hungry.push(id);
    else reservedForSatisfied += rec.inflight + 1;
  }
  const self = state.get(selfId)!;
  if (self.inflight < self.share) return self.inflight + 1; // satisfied → drain + probe
  const H = hungry.length;
  if (H === 0) return self.inflight + 1; // (self is hungry ⇒ H ≥ 1; defensive)
  const spare = Math.max(0, lGlobal - reservedForSatisfied);
  const base = Math.floor(spare / H);
  const rem = spare - base * H;
  const rank = hungry.indexOf(selfId);
  return Math.max(1, base + (rank < rem ? 1 : 0));
}

/**
 * One node's heartbeat: upsert self, evict expired, aggregate, TARGET, CAP, record grant.
 * MUTATES `state` in place (upserts self, deletes expired, writes self's new share + handoff
 * bookkeeping) and returns the grant. The post-mutation `state` is the live set the caller
 * should persist.
 */
export function applyHeartbeat(
  state: Map<string, NodeRecord>,
  report: ConcurrencyReport,
  now: number,
  opts: HeartbeatOptions,
): ConcurrencyGrant {
  const { aggregate, allocation, handoff } = opts;

  // 1. upsert self, carrying forward prior grant state (0 if new). In handoff mode, a
  //    REORDERED/stale heartbeat (seq ≤ maxSeq) must not regress committed state nor pull
  //    reported inflight backward, so state advance is gated on `fresh`.
  const prior = state.get(report.nodeId);
  const priorShare = prior?.share ?? 0;
  const priorGen = prior?.committedGen ?? 0;
  const priorMaxSeq = prior?.maxSeq ?? 0;
  const priorUnackedHigh = prior?.unackedHigh ?? 0;
  const seq = report.seq ?? -1; // absent ⇒ sentinel; treated as always-fresh below
  const fresh = !handoff || seq < 0 || seq > priorMaxSeq;
  state.set(report.nodeId, {
    lLocal: report.lLocal,
    inflight: fresh ? report.inflight : (prior?.inflight ?? report.inflight),
    expiresAt: report.expiresAt,
    share: priorShare,
    committedGen: priorGen,
    maxSeq: handoff ? Math.max(priorMaxSeq, seq) : 0,
    unackedHigh: priorUnackedHigh,
  });

  // 2. evict expired (expiresAt < now). Self ALWAYS survives — it just heartbeated, so it is
  //    alive regardless of the lease instant it reported (a node that stops heartbeating is
  //    evicted by a peer's later heartbeat). Skipping self also avoids a self-eviction crash
  //    when a node reports an already-past expiresAt (clock skew / degenerate report).
  for (const [id, rec] of state) {
    if (id !== report.nodeId && rec.expiresAt < now) state.delete(id);
  }

  // 3. aggregate live nodes' lLocal (§7). Self is always live.
  const liveIds = [...state.keys()];
  const lGlobal = aggregateOf(
    liveIds.map((id) => state.get(id)!.lLocal),
    aggregate,
  );

  // 4. TARGET for self (§6): equal-split or demand-proportional. The CAP (step 5) enforces
  //    both safety bounds for ANY target — this choice only affects utilization under skew.
  const n = liveIds.length;
  const sorted = [...liveIds].sort();
  const target = targetFor(report.nodeId, sorted, lGlobal, state, allocation);

  // 5. CAP at the budget no OTHER live node is currently HOLDING — max(share, inflight)
  //    (D-DAC-18) or max(unackedHigh, inflight) under acknowledged handoff (D-DAC-19).
  let otherReserved = 0;
  for (const id of liveIds) {
    if (id === report.nodeId) continue;
    const rec = state.get(id)!;
    otherReserved += handoff
      ? Math.max(rec.unackedHigh, rec.inflight)
      : Math.max(rec.share, rec.inflight);
  }
  const share = Math.max(0, Math.min(target, lGlobal - otherReserved));

  // 6. record the grant so subsequent heartbeats by other nodes see it committed.
  const self = state.get(report.nodeId)!;
  if (handoff) {
    if (fresh) {
      self.share = share;
      if (share !== priorShare) self.committedGen = priorGen + 1;
      self.unackedHigh = Math.max(priorUnackedHigh, share);
      // catch-up reset: once the peer confirms the current generation, drop the floor.
      const appliedGen = report.appliedGen ?? -1;
      if (appliedGen >= self.committedGen) self.unackedHigh = share;
    }
    // a stale heartbeat returns the current committed grant without advancing state.
    return { share: self.share, lGlobal, nodes: n, gen: self.committedGen };
  }
  self.share = share;
  return { share, lGlobal, nodes: n };
}
