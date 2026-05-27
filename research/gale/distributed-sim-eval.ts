/**
 * At-scale evaluation of GALE window-coupled leasing via the discrete-event simulator
 * (test/gale/discrete-event-sim.ts) — the part of the distributed eval that is doable locally (a real
 * multi-region cluster still needs cloud VMs; this is the credible simulator anticipating it). Four
 * sweeps, all seeded/reproducible:
 *
 *   A. safety & coordination vs N → hundreds (windowCoupled): overshoot stays 0, round-trip cost scales.
 *   B. windowCoupled vs carryover overshoot vs N: window-coupling holds 0; carryover leaks within C·(B−1).
 *   C. latency sensitivity (fixed N): overshoot stays 0; utilisation degrades gracefully as RTT grows.
 *   D. partition: a fraction of nodes cut from L2 — safety holds, the cut nodes are starved (fail-closed).
 *
 * Run: npx tsx research/gale/distributed-sim-eval.ts   (writes distributed-sim-eval.json + prints a table)
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Partition,
  genPoissonArrivals,
  runDistributedSim,
} from "../../test/gale/discrete-event-sim";

const L = 1000;
const W = 100; // window ms
const WIN = 20; // windows
const HORIZON = W * WIN;

/** Aggregate ≈ `overload`·L arrivals/window with 4:1 even/odd skew (mean factor 1). */
const skewed =
  (n: number, overload: number) =>
  (i: number): number =>
    ((overload * L) / (W * n)) * (i % 2 === 0 ? 1.6 : 0.4);

const arrivalsFor = (n: number, overload: number, seed: number) =>
  genPoissonArrivals({ nodes: n, horizonMs: HORIZON, rateOf: skewed(n, overload), seed });

const r3 = (x: number): number => Math.round(x * 1000) / 1000;

// ---- A. safety & coordination vs N (windowCoupled) -----------------------------------------------
const NS = [2, 8, 32, 128, 256, 512] as const;
const sweepA = NS.map((n) => {
  const r = runDistributedSim(arrivalsFor(n, 3, 42 + n), {
    nodes: n,
    budget: L,
    windowMs: W,
    windows: WIN,
    leaseBatch: 20,
    latencyMs: 5,
    latencyJitterMs: 3,
    seed: 1,
    mode: "windowCoupled",
  });
  return {
    n,
    maxOvershoot: r.maxOvershoot,
    utilization: r3(r.utilization),
    roundTrips: r.leaseRoundTrips,
    rtPerWindow: Math.round(r.leaseRoundTrips / WIN),
  };
});

// ---- B. windowCoupled vs carryover overshoot vs N (carry-inducing: demand < batch) ---------------
// Deterministic: each node demands `d < B` per window so leasers end the window holding leftover.
const buildDet = (n: number, d: number) => {
  const arr: { node: number; time: number }[] = [];
  for (let i = 0; i < n; i++)
    for (let w = 0; w < WIN; w++)
      for (let k = 0; k < d; k++) arr.push({ node: i, time: w * W + 1 });
  arr.sort((a, b) => a.time - b.time || a.node - b.node);
  return arr;
};
const B_B = 50;
const sweepB = [8, 32, 128, 256].map((n) => {
  const arr = buildDet(n, 30);
  const base = { nodes: n, budget: L, windowMs: W, windows: WIN, leaseBatch: B_B, latencyMs: 0 };
  const wc = runDistributedSim(arr, { ...base, mode: "windowCoupled" });
  const co = runDistributedSim(arr, { ...base, mode: "carryover" });
  return {
    n,
    windowCoupledMaxOvershoot: wc.maxOvershoot,
    carryoverMaxOvershoot: co.maxOvershoot,
    carryoverBound: n * (B_B - 1),
  };
});

// ---- C. latency sensitivity (fixed N = 64) -------------------------------------------------------
const sweepC = [0, 5, 20, 50].map((latencyMs) => {
  const r = runDistributedSim(arrivalsFor(64, 3, 777), {
    nodes: 64,
    budget: L,
    windowMs: W,
    windows: WIN,
    leaseBatch: 20,
    latencyMs,
    latencyJitterMs: latencyMs / 4,
    seed: 2,
    mode: "windowCoupled",
  });
  return { latencyMs, maxOvershoot: r.maxOvershoot, utilization: r3(r.utilization) };
});

// ---- D. partition (N = 64; cut a quarter of the nodes for windows 5–12) --------------------------
const arrD = arrivalsFor(64, 3, 555);
const cfgD = {
  nodes: 64,
  budget: L,
  windowMs: W,
  windows: WIN,
  leaseBatch: 20,
  latencyMs: 5,
  latencyJitterMs: 2,
  seed: 3,
  mode: "windowCoupled" as const,
};
const partitions: Partition[] = Array.from({ length: 16 }, (_u, k) => ({
  node: k * 2, // 16 even (hot) nodes
  startMs: 5 * W,
  endMs: 12 * W,
}));
const baseD = runDistributedSim(arrD, cfgD);
const cutD = runDistributedSim(arrD, { ...cfgD, partitions });
const cutNodesAdmitted = partitions.reduce((a, p) => a + (cutD.admittedByNode[p.node] ?? 0), 0);
const baseCutNodesAdmitted = partitions.reduce(
  (a, p) => a + (baseD.admittedByNode[p.node] ?? 0),
  0,
);
const sweepD = {
  nodes: 64,
  cutNodes: partitions.length,
  maxOvershoot: cutD.maxOvershoot,
  fleetUtilizationNoPartition: r3(baseD.utilization),
  fleetUtilizationPartitioned: r3(cutD.utilization),
  cutNodesAdmittedNoPartition: baseCutNodesAdmitted,
  cutNodesAdmittedPartitioned: cutNodesAdmitted,
};

// ---- report --------------------------------------------------------------------------------------
console.log("A. windowCoupled safety & coordination vs N (3× overload, latency 5±3ms, B=20):");
console.log("   N | maxOvershoot | utilization | round trips | rt/window");
for (const a of sweepA)
  console.log(
    `   ${String(a.n).padStart(3)} | ${String(a.maxOvershoot).padStart(12)} | ${a.utilization
      .toFixed(3)
      .padStart(11)} | ${String(a.roundTrips).padStart(11)} | ${a.rtPerWindow}`,
  );

console.log("\nB. windowCoupled vs carryover max overshoot vs N (demand 30 < batch 50):");
console.log("   N | windowCoupled Δ | carryover Δ | C·(B−1) bound");
for (const b of sweepB)
  console.log(
    `   ${String(b.n).padStart(3)} | ${String(b.windowCoupledMaxOvershoot).padStart(15)} | ${String(
      b.carryoverMaxOvershoot,
    ).padStart(11)} | ${b.carryoverBound}`,
  );

console.log("\nC. latency sensitivity (N=64, windowCoupled):");
console.log("   latency ms | maxOvershoot | utilization");
for (const c of sweepC)
  console.log(
    `   ${String(c.latencyMs).padStart(10)} | ${String(c.maxOvershoot).padStart(12)} | ${c.utilization}`,
  );

console.log("\nD. partition (N=64, 16 hot nodes cut from L2 for windows 5–12):");
console.log(`   maxOvershoot = ${sweepD.maxOvershoot}  (safety holds)`);
console.log(
  `   cut nodes admitted: ${sweepD.cutNodesAdmittedNoPartition} → ${sweepD.cutNodesAdmittedPartitioned} (starved)`,
);
console.log(
  `   fleet utilization: ${sweepD.fleetUtilizationNoPartition} → ${sweepD.fleetUtilizationPartitioned} (reachable nodes reclaim the budget)`,
);

const here = dirname(fileURLToPath(import.meta.url));
writeFileSync(
  join(here, "distributed-sim-eval.json"),
  `${JSON.stringify({ L, W, WIN, sweepA, sweepB, sweepC, sweepD }, null, 2)}\n`,
);
console.log("\nwrote distributed-sim-eval.json");
