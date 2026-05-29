/**
 * TK-1403a GATE — demand-proportional allocation under skew.
 *
 * Question the gate must answer before any production code:
 *   1. How big is equal-split's utilization gap under skewed demand? (quantify the "no")
 *   2. Does a demand-proportional TARGET recover it — without regressing the no-skew case,
 *      without starving idle nodes, and converging (no thrash)?
 *   3. Confirm empirically what §6/§9.4 prove analytically: the cap keeps Σshare≤L and
 *      Σinflight≤L on EVERY heartbeat for ANY target (safety is target-independent).
 *
 * This is a faithful, self-contained model of the heartbeat-aggregate-CAP protocol
 * (copied from TestConcurrencyCoordinator.heartbeat, §10.1), with the equal-split TARGET
 * (step 4) swapped for a pluggable rule. Staggered heartbeats: nodes reallocate one at a
 * time in sorted order, each seeing peers' currently-committed shares (the real protocol).
 *
 * Run:  npx tsx research/bigger-bets/distributed-adaptive-concurrency/skew-gate.ts
 */

type TargetRule = (ctx: {
  selfId: string;
  liveIds: string[]; // sorted ascending
  lGlobal: number;
  inflightById: Record<string, number>;
  shareById: Record<string, number>; // currently-committed shares
}) => number;

// ── TARGET rules ─────────────────────────────────────────────────────────────

/** The shipped 0.10.0 rule: equal-split, base + 1 for the first `rem` by sorted id. */
const equalSplit: TargetRule = ({ selfId, liveIds, lGlobal }) => {
  const n = liveIds.length;
  const base = Math.floor(lGlobal / n);
  const rem = lGlobal - base * n;
  const rank = liveIds.indexOf(selfId);
  return base + (rank < rem ? 1 : 0);
};

/**
 * Demand-proportional (R3): a node is HUNGRY if it filled its current grant
 * (inflight ≥ share — saturated; a new node with share 0 is hungry). SATISFIED nodes
 * (inflight < share) only aspire to their occupancy + 1 probe slot, RELEASING the rest.
 * Hungry nodes equal-split the released budget (deterministic id tiebreak), floor 1.
 * Everything is integer + a pure function of the snapshot the coordinator already has,
 * so it ports verbatim to the Lua twin.
 */
const demandProportional: TargetRule = ({ selfId, liveIds, lGlobal, inflightById, shareById }) => {
  const hungry: string[] = [];
  let reservedForSatisfied = 0;
  for (const id of liveIds) {
    const inf = inflightById[id] ?? 0;
    const sh = shareById[id] ?? 0;
    if (inf >= sh)
      hungry.push(id); // saturated (incl. brand-new share-0 nodes)
    else reservedForSatisfied += inf + 1; // occupancy + 1 probe slot of growth headroom
  }
  const selfInf = inflightById[selfId] ?? 0;
  const selfSh = shareById[selfId] ?? 0;
  const selfHungry = selfInf >= selfSh;
  if (!selfHungry) return selfInf + 1; // satisfied: drain toward occupancy + probe slot
  const H = hungry.length;
  if (H === 0) return selfInf + 1;
  const spare = Math.max(0, lGlobal - reservedForSatisfied);
  const base = Math.floor(spare / H);
  const rem = spare - base * H;
  const rank = hungry.indexOf(selfId); // already sorted (liveIds sorted)
  return Math.max(1, base + (rank < rem ? 1 : 0));
};

// ── Faithful coordinator (heartbeat + occupancy cap), target pluggable ──────────

interface Rec {
  lLocal: number;
  inflight: number;
  share: number;
}

class Coord {
  readonly state = new Map<string, Rec>();
  constructor(
    readonly target: TargetRule,
    readonly aggregate: "min" | "median" = "median",
  ) {}

  lGlobalOf(ids: string[]): number {
    const v = ids.map((id) => this.state.get(id)!.lLocal).sort((a, b) => a - b);
    return this.aggregate === "min" ? v[0]! : v[Math.floor((v.length - 1) / 2)]!;
  }

  /** One node's heartbeat. Returns its new share. Mutates committed state in place. */
  heartbeat(selfId: string, lLocal: number, inflight: number): number {
    const prior = this.state.get(selfId);
    this.state.set(selfId, { lLocal, inflight, share: prior?.share ?? 0 });
    const liveIds = [...this.state.keys()].sort();
    const lGlobal = this.lGlobalOf(liveIds);
    const inflightById: Record<string, number> = {};
    const shareById: Record<string, number> = {};
    for (const id of liveIds) {
      inflightById[id] = this.state.get(id)!.inflight;
      shareById[id] = this.state.get(id)!.share;
    }
    const target = this.target({ selfId, liveIds, lGlobal, inflightById, shareById });
    // THE CAP (§6 / D-DAC-17 share term + D-DAC-18 inflight term) — unchanged.
    let others = 0;
    for (const id of liveIds) {
      if (id === selfId) continue;
      others += Math.max(shareById[id]!, inflightById[id]!);
    }
    const share = Math.max(0, Math.min(target, lGlobal - others));
    this.state.get(selfId)!.share = share;
    return share;
  }

  sums(): { lGlobal: number; sumShare: number; sumInflight: number } {
    const ids = [...this.state.keys()].sort();
    let sumShare = 0;
    let sumInflight = 0;
    for (const id of ids) {
      sumShare += this.state.get(id)!.share;
      sumInflight += this.state.get(id)!.inflight;
    }
    return { lGlobal: this.lGlobalOf(ids), sumShare, sumInflight };
  }
}

// ── Simulation ──────────────────────────────────────────────────────────────

interface Node {
  id: string;
  lLocal: number;
  demand: number; // desired concurrency this round (offered load)
}

interface SimResult {
  utilization: number; // Σinflight / lGlobal at steady state (mean over last rounds)
  shedHot: number; // demand the hottest node couldn't admit (lost throughput)
  maxSumShare: number; // worst-case Σshare seen (safety)
  maxSumInflight: number; // worst-case Σinflight seen (safety)
  lGlobal: number;
  finalShares: Record<string, number>;
  finalInflight: Record<string, number>;
}

/** demand(round, nodeId) → desired concurrency, so scenarios can be time-varying. */
type DemandFn = (round: number, id: string) => number;

function simulate(
  nodeIds: string[],
  lLocal: Record<string, number>,
  demandFn: DemandFn,
  rule: TargetRule,
  opts: { rounds?: number; measureLast?: number } = {},
): SimResult {
  const rounds = opts.rounds ?? 60;
  const measureLast = opts.measureLast ?? 15;
  const coord = new Coord(rule);
  const inflight: Record<string, number> = {};
  const share: Record<string, number> = {};
  for (const id of nodeIds) {
    inflight[id] = 0;
    share[id] = 0;
  }

  let maxSumShare = 0;
  let maxSumInflight = 0;
  let utilAccum = 0;
  let shedAccum = 0;
  let measured = 0;
  let lastLGlobal = 0;

  for (let r = 0; r < rounds; r++) {
    // Heartbeats are STAGGERED: each node reallocates once, in sorted order, seeing
    // peers' currently-committed shares + last-reported inflight (the real protocol).
    for (const id of [...nodeIds].sort()) {
      const newShare = coord.heartbeat(id, lLocal[id]!, inflight[id]!);
      share[id] = newShare;
      // The guard fills to min(demand, share, lLocal) — synchronous steady state within
      // the round (service fast vs heartbeat). Idle node → inflight 0; hot node → share.
      inflight[id] = Math.min(demandFn(r, id), share[id]!, lLocal[id]!);
      // Safety check on EVERY heartbeat (belt-and-suspenders vs the proof).
      const s = coord.sums();
      maxSumShare = Math.max(maxSumShare, s.sumShare);
      maxSumInflight = Math.max(maxSumInflight, s.sumInflight);
      lastLGlobal = s.lGlobal;
    }
    if (r >= rounds - measureLast) {
      const s = coord.sums();
      utilAccum += s.sumInflight / s.lGlobal;
      // Throughput the hottest node lost = its demand minus what it could run.
      let shed = 0;
      for (const id of nodeIds)
        shed += Math.max(0, Math.min(demandFn(r, id), lLocal[id]!) - inflight[id]!);
      shedAccum += shed;
      measured++;
    }
  }

  return {
    utilization: utilAccum / measured,
    shedHot: shedAccum / measured,
    maxSumShare,
    maxSumInflight,
    lGlobal: lastLGlobal,
    finalShares: { ...share },
    finalInflight: { ...inflight },
  };
}

// ── Scenarios ─────────────────────────────────────────────────────────────────

function n(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `n${i}`);
}
function uniformL(ids: string[], L: number): Record<string, number> {
  return Object.fromEntries(ids.map((id) => [id, L]));
}

const BIG = 10_000; // "wants everything" demand

function row(label: string, eq: SimResult, dp: SimResult): void {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const safe = (r: SimResult) =>
    r.maxSumShare <= r.lGlobal && r.maxSumInflight <= r.lGlobal ? "SAFE" : "*** VIOLATED ***";
  console.log(
    `${label.padEnd(34)} util eq=${pct(eq.utilization).padStart(6)}  dp=${pct(dp.utilization).padStart(6)}` +
      `   Δ=${pct(dp.utilization - eq.utilization).padStart(7)}` +
      `   safety eq=${safe(eq)} dp=${safe(dp)}`,
  );
}

console.log(
  "=== TK-1403a GATE: demand-proportional vs equal-split (L per node, median aggregate) ===\n",
);

// 1. Static extreme skew: 1 hot node, rest idle.
for (const N of [2, 4, 8]) {
  const ids = n(N);
  const L = 12;
  const lLocal = uniformL(ids, L);
  const hotOnly: DemandFn = (_r, id) => (id === "n0" ? BIG : 0);
  row(
    `static skew 1 hot / ${N - 1} idle (L=${L})`,
    simulate(ids, lLocal, hotOnly, equalSplit),
    simulate(ids, lLocal, hotOnly, demandProportional),
  );
}

// 2. Partial skew: half hot, half idle.
{
  const ids = n(8);
  const L = 16;
  const half: DemandFn = (_r, id) => (Number(id.slice(1)) < 4 ? BIG : 0);
  row(
    "half hot / half idle (N=8,L=16)",
    simulate(ids, uniformL(ids, L), half, equalSplit),
    simulate(ids, uniformL(ids, L), half, demandProportional),
  );
}

// 3. Moderate skew: one node wants 2, others want a little.
{
  const ids = n(4);
  const L = 12;
  const moderate: DemandFn = (_r, id) => (id === "n0" ? BIG : 1);
  row(
    "moderate skew (n0 hot, rest want 1)",
    simulate(ids, uniformL(ids, L), moderate, equalSplit),
    simulate(ids, uniformL(ids, L), moderate, demandProportional),
  );
}

// 4. NO skew (regression guard): everyone slammed — DP must match equal-split (~100%).
{
  const ids = n(4);
  const L = 12;
  const allHot: DemandFn = () => BIG;
  row(
    "no skew, all hot (regression guard)",
    simulate(ids, uniformL(ids, L), allHot, equalSplit),
    simulate(ids, uniformL(ids, L), allHot, demandProportional),
  );
}

// 5. L < N edge: more nodes than budget.
{
  const ids = n(6);
  const L = 3;
  const hotOnly: DemandFn = (_r, id) => (id === "n0" ? BIG : 0);
  row(
    "L<N edge (N=6, L=3, 1 hot)",
    simulate(ids, uniformL(ids, L), hotOnly, equalSplit),
    simulate(ids, uniformL(ids, L), hotOnly, demandProportional),
  );
}

// 6. DYNAMIC: load shifts — n0 hot for first half, then goes idle while n3 heats up.
//    Tests reclamation + ramp + convergence (no thrash).
{
  const ids = n(4);
  const L = 12;
  const shifting: DemandFn = (r, id) => {
    if (r < 30) return id === "n0" ? BIG : 0;
    return id === "n3" ? BIG : 0;
  };
  const eq = simulate(ids, uniformL(ids, L), shifting, equalSplit, { rounds: 60, measureLast: 15 });
  const dp = simulate(ids, uniformL(ids, L), shifting, demandProportional, {
    rounds: 60,
    measureLast: 15,
  });
  row("dynamic: hot node moves n0→n3", eq, dp);
  console.log(
    `    └ after shift, DP shares: ${JSON.stringify(dp.finalShares)}  inflight: ${JSON.stringify(dp.finalInflight)}`,
  );
  console.log(
    `    └ after shift, EQ shares: ${JSON.stringify(eq.finalShares)}  inflight: ${JSON.stringify(eq.finalInflight)}`,
  );
}

console.log(
  "\nReading: util = Σinflight/L_global at steady state (higher = less stranded capacity).",
);
console.log("Both rules MUST stay SAFE (Σshare≤L and Σinflight≤L on every heartbeat).");
