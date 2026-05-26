import { carryoverBound, simulateDistributedBudget } from "../../test/cost/distributed-budget";
import { heavyTailLengths } from "../../test/cost/token-budget";
/**
 * Calibration + cross-validation for the distributed TALE×GALE result. Prints the seeded numbers
 * asserted by test/cost/distributed-budget.test.ts, and checks that the windowCoupled token budget is
 * byte-identical to GALE's request-granular window-coupled leasing.
 * Run: `npx tsx research/cost-uncertainty/explore-distributed.ts`.
 */
import type { LeaseSizer } from "../../test/gale/lease-sizer";
import { simulateWindowCoupled } from "../../test/gale/window-coupled-sim";

const L = 10000;
const B = 200;
const W = 200;
const PERGW_MEDIAN = 4000; // per-gateway per-window token demand (heavy-tailed); aggregate overloads L

const demandsFor = (C: number): number[][] =>
  Array.from({ length: C }, (_u, i) =>
    heavyTailLengths(W, PERGW_MEDIAN, 20 * PERGW_MEDIAN, 100 + i),
  );

const maxMean = (xs: number[]): string =>
  `max=${Math.max(...xs)} mean=${(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1)}`;

console.log(`L=${L} leaseBatch B=${B}  (per-gateway median demand ${PERGW_MEDIAN}/window, W=${W})`);
console.log("\nC   | windowCoupled overshoot | util | carryover overshoot     | C·(B−1)");
for (const C of [1, 2, 4, 8, 16, 32]) {
  const demands = demandsFor(C);
  const wc = simulateDistributedBudget(demands, {
    budget: L,
    gateways: C,
    leaseBatch: B,
    mode: "windowCoupled",
  });
  const co = simulateDistributedBudget(demands, {
    budget: L,
    gateways: C,
    leaseBatch: B,
    mode: "carryover",
  });
  const wcOver = wc.map((r) => r.overshoot);
  const coOver = co.map((r) => r.overshoot);
  const util = wc.reduce((a, r) => a + Math.min(r.produced, L) / L, 0) / wc.length;
  console.log(
    `${String(C).padStart(3)} | ${maxMean(wcOver).padEnd(23)} | ${util.toFixed(3)} | ${maxMean(coOver).padEnd(23)} | ${carryoverBound(C, B)}`,
  );
}

// ---- Un-starved regime (budget scales with fleet): carryover overshoot grows with C --------------
console.log("\n[un-starved: L = 1500·C] carryover overshoot should grow ~ linearly with C:");
console.log("C   | windowCoupled overshoot | carryover overshoot     | C·(B−1)");
for (const C of [2, 4, 8, 16, 32]) {
  const Lc = 1500 * C;
  const demands = Array.from({ length: C }, (_u, i) => heavyTailLengths(W, 2500, 50000, 200 + i));
  const wc = simulateDistributedBudget(demands, {
    budget: Lc,
    gateways: C,
    leaseBatch: B,
    mode: "windowCoupled",
  }).map((r) => r.overshoot);
  const co = simulateDistributedBudget(demands, {
    budget: Lc,
    gateways: C,
    leaseBatch: B,
    mode: "carryover",
  }).map((r) => r.overshoot);
  console.log(
    `${String(C).padStart(3)} | ${maxMean(wc).padEnd(23)} | ${maxMean(co).padEnd(23)} | ${carryoverBound(C, B)}`,
  );
}

// ---- Cross-validation: windowCoupled token budget == GALE window-coupled leasing ------------------
console.log("\n[cross-check] windowCoupled produced == GALE simulateWindowCoupled admitted?");
const fixedSizer = (b: number): LeaseSizer => ({ size: () => b, observe: () => {}, continuous: b });
for (const C of [2, 8, 32]) {
  const demands = demandsFor(C);
  const mine = simulateDistributedBudget(demands, {
    budget: L,
    gateways: C,
    leaseBatch: B,
    mode: "windowCoupled",
  }).map((r) => r.produced);
  const gale = simulateWindowCoupled(
    demands,
    demands.map(() => fixedSizer(B)),
    L,
  ).map((r) => r.admitted);
  const identical = mine.length === gale.length && mine.every((v, i) => v === gale[i]);
  console.log(
    `  C=${String(C).padStart(2)}: identical=${identical} (sample mine=${mine[0]} gale=${gale[0]})`,
  );
}
