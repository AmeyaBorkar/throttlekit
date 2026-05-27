/**
 * Discrete-event simulator for GALE distributed window-coupled leasing under a REALISTIC async model:
 * continuous-time Poisson arrivals with per-node skew, lease round-trip LATENCY, and network
 * PARTITIONS, across N → hundreds of nodes. It stress-tests the proven Pillar-1 result
 * (`test/gale/leasing-variants.test.ts`, `spec/GaleWindowCoupledLeasing.tla`) beyond its single-window
 * synchronous model: that the overshoot bound (windowCoupled ⇒ admitted ≤ L per window, INDEPENDENT of
 * the node count N) survives asynchrony, latency, skew, and partitions — which degrade *utilisation*
 * and *coordination*, never *safety* — and it measures the coordination cost (lease round trips) and
 * the lease-batch tradeoff.
 *
 * Why latency/partitions can't leak overshoot: the single shared L2 budget is decremented ATOMICALLY
 * on each grant (one event processed at a time), so concurrent in-flight lease requests serialise
 * through L2 and the total granted per window never exceeds L. Latency only delays grants (some land in
 * the next window — where, under windowCoupled, they draw the fresh budget); partitions only stop a
 * node from leasing (it fails closed: serves its existing credits, then sheds). At leaseBatch = 1, zero
 * latency, and no partition the sim is work-conserving (admitted = min(demand, L) per window) — the
 * synchronous `test/cost/distributed-budget.ts` result recovered as a special case.
 *
 * Pure and deterministic given the arrival list and seed. Design: research/gale/PROPOSAL.md (Pillar 1/2).
 */

export type LeaseMode = "windowCoupled" | "carryover";

/** A request arrival: `node` offers a unit of demand at continuous time `time` (ms). */
export interface Arrival {
  readonly node: number;
  readonly time: number;
}

/** A node is unreachable from L2 during `[startMs, endMs)` (a network partition). */
export interface Partition {
  readonly node: number;
  readonly startMs: number;
  readonly endMs: number;
}

export interface SimConfig {
  /** Node count N. */
  readonly nodes: number;
  /** Shared budget L per window (the L2 budget / global limit). */
  readonly budget: number;
  /** Window length in ms (epoch-aligned from 0). */
  readonly windowMs: number;
  /** Number of windows to simulate. */
  readonly windows: number;
  /** Tokens/credits leased per L2 round trip (the coordination batch B). */
  readonly leaseBatch: number;
  /** windowCoupled (credits expire at the boundary) or carryover (persist). */
  readonly mode: LeaseMode;
  /** Mean lease round-trip latency in ms (0 = instant grants). */
  readonly latencyMs: number;
  /** Uniform ± jitter on the latency (seeded), default 0. */
  readonly latencyJitterMs?: number;
  /** Network partitions: each node unreachable from L2 for an interval. */
  readonly partitions?: readonly Partition[];
  /** Seed for latency jitter (only used when jitter > 0). Default 1. */
  readonly seed?: number;
}

export interface WindowOutcome {
  readonly admitted: number;
  readonly demand: number;
  readonly shed: number;
  /** Global admissions beyond the budget this window (Δ = max(0, admitted − L)). */
  readonly overshoot: number;
  /** Lease round trips issued this window (the coordination cost). */
  readonly leaseRoundTrips: number;
}

export interface SimResult {
  readonly perWindow: readonly WindowOutcome[];
  readonly totalAdmitted: number;
  readonly totalDemand: number;
  readonly totalShed: number;
  /** Max per-window overshoot over the run (the headline safety number). */
  readonly maxOvershoot: number;
  /** Total lease round trips over the run. */
  readonly leaseRoundTrips: number;
  /** Σ admitted / min(Σ demand, L · windows) ∈ [0,1]. */
  readonly utilization: number;
  /** Admissions per node over the whole run (exposes skew and a partitioned node's starvation). */
  readonly admittedByNode: readonly number[];
}

/** mulberry32 PRNG — deterministic uniform in [0,1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Per-node homogeneous-Poisson arrivals over `[0, horizonMs)`, seeded; sorted by time then node. */
export function genPoissonArrivals(spec: {
  readonly nodes: number;
  readonly horizonMs: number;
  /** Arrivals per ms for node `i` (skew lives here). */
  readonly rateOf: (node: number) => number;
  readonly seed: number;
}): Arrival[] {
  const rng = mulberry32(spec.seed);
  const arrivals: Arrival[] = [];
  for (let i = 0; i < spec.nodes; i++) {
    const rate = spec.rateOf(i);
    if (!(rate > 0)) continue;
    let t = 0;
    for (;;) {
      // Exponential inter-arrival time: −ln(U)/rate.
      const u = Math.max(1e-12, rng());
      t += -Math.log(u) / rate;
      if (t >= spec.horizonMs) break;
      arrivals.push({ node: i, time: t });
    }
  }
  arrivals.sort((a, b) => a.time - b.time || a.node - b.node);
  return arrivals;
}

// ---- event queue ---------------------------------------------------------------------------------

// Event kinds, ordered so that at an identical timestamp we ROLL the window, then settle partition
// state, then apply grants (against the fresh budget), then admit arrivals into the new window.
const ROLL = 0;
const PART_START = 1;
const PART_END = 2;
const GRANT = 3;
const ARRIVAL = 4;

interface Ev {
  readonly time: number;
  readonly kind: number;
  readonly node: number;
  readonly seq: number;
}

const cmpEv = (x: Ev, y: Ev): number => x.time - y.time || x.kind - y.kind || x.seq - y.seq;

/** Minimal binary min-heap over events (cmpEv order). */
class Heap {
  private a: Ev[] = [];
  get size(): number {
    return this.a.length;
  }
  push(e: Ev): void {
    const a = this.a;
    a.push(e);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (cmpEv(a[i] as Ev, a[p] as Ev) < 0) {
        const tmp = a[i] as Ev;
        a[i] = a[p] as Ev;
        a[p] = tmp;
        i = p;
      } else break;
    }
  }
  pop(): Ev | undefined {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0 && last !== undefined) {
      a[0] = last;
      let i = 0;
      const n = a.length;
      for (;;) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let m = i;
        if (l < n && cmpEv(a[l] as Ev, a[m] as Ev) < 0) m = l;
        if (r < n && cmpEv(a[r] as Ev, a[m] as Ev) < 0) m = r;
        if (m === i) break;
        const tmp = a[i] as Ev;
        a[i] = a[m] as Ev;
        a[m] = tmp;
        i = m;
      }
    }
    return top;
  }
}

/**
 * Run the distributed leasing simulation over `arrivals` (sorted by time). Each node serves an arrival
 * from local credits; with none it leases `min(B, l2)` from the shared budget after `latencyMs`. Under
 * windowCoupled, credits expire at each boundary and the budget refreshes to L; under carryover credits
 * persist. A partitioned node cannot lease (its in-flight grant is lost) and sheds once its credits run
 * out. Safety is structural: l2 is decremented atomically per grant and never goes below 0, so
 * admitted-per-window ≤ L + (carried credits), with carried = 0 under windowCoupled.
 */
export function runDistributedSim(arrivals: readonly Arrival[], config: SimConfig): SimResult {
  const { nodes: N, budget: L, windowMs: W, windows: WIN, leaseBatch: B, mode } = config;
  const jitter = config.latencyJitterMs ?? 0;
  const rng = mulberry32(config.seed ?? 1);
  const latency = (): number =>
    Math.max(0, config.latencyMs + (jitter > 0 ? (rng() * 2 - 1) * jitter : 0));

  const credits = new Array<number>(N).fill(0);
  const waiting = new Array<number>(N).fill(0);
  const leasePending = new Array<boolean>(N).fill(false);
  const partitioned = new Array<boolean>(N).fill(false);
  const admittedByNode = new Array<number>(N).fill(0);

  let l2 = L;
  let admittedW = 0;
  let demandW = 0;
  let shedW = 0;
  let rtW = 0;
  let totalAdmitted = 0;
  let totalDemand = 0;
  let totalShed = 0;
  let totalRt = 0;
  const perWindow: WindowOutcome[] = [];

  const heap = new Heap();
  let seq = 0;
  const at = (time: number, kind: number, node: number): void => {
    heap.push({ time, kind, node, seq: seq++ });
  };

  for (const a of arrivals) at(a.time, ARRIVAL, a.node);
  for (let w = 1; w <= WIN; w++) at(w * W, ROLL, -1);
  for (const p of config.partitions ?? []) {
    at(p.startMs, PART_START, p.node);
    at(p.endMs, PART_END, p.node);
  }

  /** Issue a lease round trip for node `i`: a grant lands after the latency. */
  const requestLease = (i: number, now: number): void => {
    leasePending[i] = true;
    rtW++;
    totalRt++;
    at(now + latency(), GRANT, i);
  };

  /** Try to serve one arrival at node `i` from local credits; returns whether it was admitted. */
  const serveFromCredits = (i: number): boolean => {
    if ((credits[i] ?? 0) >= 1) {
      credits[i] = (credits[i] as number) - 1;
      admittedByNode[i] = (admittedByNode[i] as number) + 1;
      admittedW++;
      totalAdmitted++;
      return true;
    }
    return false;
  };

  while (heap.size > 0) {
    const e = heap.pop();
    if (e === undefined) break;
    const i = e.node;

    if (e.kind === ROLL) {
      // Requests still waiting at the boundary time out (counted as shed for the window that ended).
      for (let k = 0; k < N; k++) {
        if (waiting[k] !== undefined && (waiting[k] as number) > 0) {
          shedW += waiting[k] as number;
          totalShed += waiting[k] as number;
          waiting[k] = 0;
        }
      }
      perWindow.push({
        admitted: admittedW,
        demand: demandW,
        shed: shedW,
        overshoot: Math.max(0, admittedW - L),
        leaseRoundTrips: rtW,
      });
      admittedW = 0;
      demandW = 0;
      shedW = 0;
      rtW = 0;
      l2 = L; // fresh shared budget
      if (mode === "windowCoupled") credits.fill(0); // leased-but-unspent credits expire
      // In-flight leases (leasePending) survive the roll; their grants draw the new window's budget.
      continue;
    }

    if (e.kind === PART_START) {
      partitioned[i] = true;
      continue;
    }
    if (e.kind === PART_END) {
      partitioned[i] = false;
      // Resume any backlog accumulated during the partition with a fresh lease.
      if ((waiting[i] ?? 0) > 0 && !leasePending[i]) requestLease(i, e.time);
      continue;
    }

    if (e.kind === GRANT) {
      leasePending[i] = false;
      if (partitioned[i]) {
        // Partition dropped the grant: budget preserved for reachable nodes (fail-closed).
        continue;
      }
      const grant = Math.min(B, l2); // ATOMIC check-and-decrement against the shared budget
      if (grant >= 1) {
        l2 -= grant;
        credits[i] = (credits[i] as number) + grant;
      }
      // Serve as much of the node's backlog as the new credits cover.
      while ((waiting[i] ?? 0) > 0 && serveFromCredits(i)) waiting[i] = (waiting[i] as number) - 1;
      if ((waiting[i] ?? 0) > 0) {
        if (grant >= 1) {
          requestLease(i, e.time); // got some budget, still backed up ⇒ lease again
        } else {
          // Budget exhausted this window ⇒ shed the rest of this node's backlog now.
          shedW += waiting[i] as number;
          totalShed += waiting[i] as number;
          waiting[i] = 0;
        }
      }
      continue;
    }

    // ARRIVAL
    demandW++;
    totalDemand++;
    if (serveFromCredits(i)) continue; // local credit ⇒ admit immediately, no round trip
    if (partitioned[i]) {
      // Cannot lease while partitioned and no local credit ⇒ shed (fail closed).
      shedW++;
      totalShed++;
      continue;
    }
    waiting[i] = (waiting[i] as number) + 1;
    if (!leasePending[i]) requestLease(i, e.time);
  }

  // Any leases still in flight (or backlog) past the final roll are not counted; the last ROLL at
  // WIN·W finalised the last window, and all arrivals fall in [0, WIN·W).
  const cap = L * WIN;
  return {
    perWindow,
    totalAdmitted,
    totalDemand,
    totalShed,
    maxOvershoot: perWindow.reduce((m, w) => Math.max(m, w.overshoot), 0),
    leaseRoundTrips: totalRt,
    utilization: totalAdmitted / Math.max(1, Math.min(totalDemand, cap)),
    admittedByNode,
  };
}
