import { describe, expect, it } from "vitest";
import { simulateDistributedBudget } from "../cost/distributed-budget";
import {
  type Arrival,
  type SimConfig,
  genPoissonArrivals,
  runDistributedSim,
} from "./discrete-event-sim";

/**
 * GALE Pillar 1 under a realistic async model. The TLA⁺/BFS proof is single-window and synchronous;
 * this discrete-event simulator (continuous-time Poisson arrivals + skew, lease latency, partitions,
 * N → hundreds) stress-tests that the overshoot bound survives — windowCoupled keeps admitted ≤ L per
 * window INDEPENDENT of N, while latency/partitions/skew only cost utilisation and coordination. Seeded
 * and deterministic. Design: research/gale/PROPOSAL.md; eval sweep: research/gale/distributed-sim-eval.ts.
 */

const L = 1000;
const W = 100; // window ms
const WIN = 10; // windows
const HORIZON = W * WIN;

/** Aggregate ~`overload`·L arrivals per window, 4:1 skew between even/odd nodes (mean factor 1). */
const skewedRates =
  (n: number, overload: number) =>
  (i: number): number =>
    ((overload * L) / (W * n)) * (i % 2 === 0 ? 1.6 : 0.4);

const baseConfig = (n: number): Omit<SimConfig, "mode"> => ({
  nodes: n,
  budget: L,
  windowMs: W,
  windows: WIN,
  leaseBatch: 20,
  latencyMs: 5,
  latencyJitterMs: 3,
  seed: 1,
});

describe("GALE discrete-event sim — windowCoupled safety is independent of N (latency + skew)", () => {
  it.each([2, 8, 32, 128, 256])(
    "N=%i: max per-window overshoot is 0 under async leasing, and the budget actually binds",
    (n) => {
      const arrivals = genPoissonArrivals({
        nodes: n,
        horizonMs: HORIZON,
        rateOf: skewedRates(n, 3),
        seed: 42 + n,
      });
      const r = runDistributedSim(arrivals, { ...baseConfig(n), mode: "windowCoupled" });
      // SAFETY: no window ever exceeds L — no matter how many nodes lease concurrently through L2.
      expect(r.maxOvershoot).toBe(0);
      for (const w of r.perWindow) expect(w.admitted).toBeLessThanOrEqual(L);
      // NON-VACUOUS: with 3× overload the budget genuinely binds (some window nearly fills L).
      const peak = r.perWindow.reduce((m, w) => Math.max(m, w.admitted), 0);
      expect(peak).toBeGreaterThan(0.7 * L);
      // and there is real shedding (demand > capacity) — the bound is tested under pressure.
      expect(r.totalShed).toBeGreaterThan(0);
    },
  );
});

describe("GALE discrete-event sim — partitions: safety holds, utilisation degrades (fail-closed)", () => {
  it("a partitioned hot node is starved (fail-closed) while the fleet stays safe and compensates", () => {
    const n = 32;
    const arrivals = genPoissonArrivals({
      nodes: n,
      horizonMs: HORIZON,
      rateOf: skewedRates(n, 3),
      seed: 7,
    });
    const cfg = { ...baseConfig(n), mode: "windowCoupled" as const };
    const noPartition = runDistributedSim(arrivals, cfg);
    // Partition node 0 (a hot, even node) for windows 3–6.
    const partitioned = runDistributedSim(arrivals, {
      ...cfg,
      partitions: [{ node: 0, startMs: 3 * W, endMs: 6 * W }],
    });
    expect(partitioned.maxOvershoot).toBe(0); // safety survives the partition
    // The cut node is denied service while partitioned ⇒ it admits strictly fewer requests…
    expect(partitioned.admittedByNode[0] as number).toBeLessThan(
      noPartition.admittedByNode[0] as number,
    );
    // …yet under overload the freed budget is reclaimed by reachable nodes, so global admissions are
    // essentially unchanged: a partition costs the cut node, not the budget (and never safety).
    expect(partitioned.totalAdmitted).toBeGreaterThanOrEqual(noPartition.totalAdmitted * 0.95);
  });
});

describe("GALE discrete-event sim — recovers the synchronous kernel at B=1, zero latency", () => {
  it("admitted per window = min(demand, L), byte-identical to simulateDistributedBudget", () => {
    const n = 6;
    // Deterministic per-node, per-window demand counts (heavy on a couple of nodes).
    const perNodePerWindow = Array.from({ length: n }, (_u, i) =>
      Array.from({ length: WIN }, (_v, w) => 50 + ((i * 37 + w * 13) % 200) + (i === 0 ? 300 : 0)),
    );
    const arrivals: Arrival[] = [];
    for (let i = 0; i < n; i++) {
      for (let w = 0; w < WIN; w++) {
        const c = perNodePerWindow[i]?.[w] ?? 0;
        for (let k = 0; k < c; k++) arrivals.push({ node: i, time: w * W + 1 });
      }
    }
    arrivals.sort((a, b) => a.time - b.time || a.node - b.node);

    const sim = runDistributedSim(arrivals, {
      nodes: n,
      budget: L,
      windowMs: W,
      windows: WIN,
      leaseBatch: 1, // unit leasing ⇒ no stranding ⇒ work-conserving
      latencyMs: 0,
      mode: "windowCoupled",
    });
    const kernel = simulateDistributedBudget(perNodePerWindow, {
      budget: L,
      gateways: n,
      leaseBatch: 1,
      mode: "windowCoupled",
    });

    for (let w = 0; w < WIN; w++) {
      const demandW = perNodePerWindow.reduce((a, row) => a + (row[w] ?? 0), 0);
      const expected = Math.min(demandW, L);
      expect(sim.perWindow[w]?.admitted).toBe(expected); // work-conserving at B=1
      expect(sim.perWindow[w]?.admitted).toBe(kernel[w]?.produced); // == the proven synchronous model
      expect(sim.perWindow[w]?.overshoot).toBe(0);
    }
  });
});

describe("GALE discrete-event sim — carryover leaks, bounded by C·(B−1); windowCoupled does not", () => {
  it("carryover overshoots within C·(B−1) when nodes carry leftover credits; windowCoupled stays 0", () => {
    const n = 8;
    const B = 50;
    const budget = 100;
    const dPerWindow = 30; // < B ⇒ a leaser ends the window holding (B − used) leftover credits
    const win = 8;
    const arrivals: Arrival[] = [];
    for (let i = 0; i < n; i++)
      for (let w = 0; w < win; w++)
        for (let k = 0; k < dPerWindow; k++) arrivals.push({ node: i, time: w * W + 1 });
    arrivals.sort((a, b) => a.time - b.time || a.node - b.node);
    const cfg = {
      nodes: n,
      budget,
      windowMs: W,
      windows: win,
      leaseBatch: B,
      latencyMs: 0,
    } as const;
    const wc = runDistributedSim(arrivals, { ...cfg, mode: "windowCoupled" });
    const co = runDistributedSim(arrivals, { ...cfg, mode: "carryover" });
    expect(wc.maxOvershoot).toBe(0); // window-coupling: zero, always
    expect(co.maxOvershoot).toBeGreaterThan(0); // carryover leaks the carried credits…
    expect(co.maxOvershoot).toBeLessThanOrEqual(n * (B - 1)); // …within the proven C·(B−1) envelope
  });
});

describe("GALE discrete-event sim — coordination cost and determinism", () => {
  it("a larger lease batch costs fewer round trips for the same demand", () => {
    const n = 32;
    const arrivals = genPoissonArrivals({
      nodes: n,
      horizonMs: HORIZON,
      rateOf: skewedRates(n, 2),
      seed: 5,
    });
    const small = runDistributedSim(arrivals, {
      ...baseConfig(n),
      leaseBatch: 5,
      mode: "windowCoupled",
    });
    const large = runDistributedSim(arrivals, {
      ...baseConfig(n),
      leaseBatch: 50,
      mode: "windowCoupled",
    });
    expect(large.leaseRoundTrips).toBeLessThan(small.leaseRoundTrips); // bigger batch ⇒ less coordination
    expect(small.maxOvershoot).toBe(0);
    expect(large.maxOvershoot).toBe(0); // …and both are safe
  });

  it("is deterministic: identical inputs ⇒ identical results", () => {
    const n = 16;
    const arrivals = genPoissonArrivals({
      nodes: n,
      horizonMs: HORIZON,
      rateOf: skewedRates(n, 3),
      seed: 3,
    });
    const a = runDistributedSim(arrivals, { ...baseConfig(n), mode: "windowCoupled" });
    const b = runDistributedSim(arrivals, { ...baseConfig(n), mode: "windowCoupled" });
    expect(a.perWindow).toEqual(b.perWindow);
    expect(a.leaseRoundTrips).toBe(b.leaseRoundTrips);
  });
});
