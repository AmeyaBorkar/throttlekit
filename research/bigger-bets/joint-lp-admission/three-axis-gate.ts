/**
 * TK-1405 GATE — 3-axis joint-LP: does a CONCURRENCY shadow price earn its keep?
 *
 * The shipped joint-LP filter prices two FLOW budgets (rate, cost). The old DESIGN §12.2
 * punted on concurrency because "concurrency is instantaneous, not windowed, so it doesn't
 * fit the same fluid relaxation cleanly." This gate tests the resolution:
 *
 *   LITTLE'S LAW turns the occupancy limit into a flow budget. Time-average in-flight =
 *   (1/T)·Σ wᵢ hᵢ xᵢ, so the concurrency cap L becomes a THIRD linear budget
 *       Σ wᵢ hᵢ xᵢ ≤ L·T              (concurrency-seconds per window)
 *   with per-request consumption = the request's HOLD TIME hᵢ. The bid-price test gains a
 *   term:  admit iff  value ≥ p_R + p_C·cost + p_K·hold.
 *
 * The hypothesis: a request that is cheap + valuable PER TOKEN but SLOW (holds a worker slot
 * for a long time — a "concurrency hog") is exactly what 2-axis joint-LP (blind to hold time)
 * wrongly admits and a 3-axis filter correctly prices out when the concurrency axis binds.
 *
 * We compare, on a discrete-event concurrency simulation, three admission policies:
 *   marginal-AND   — admit iff every axis independently has room (rate, cost, occupancy<L)
 *   joint-2axis    — marginal AND value ≥ p_R + p_C·cost          (shipped solver, hold-blind)
 *   joint-3axis    — marginal AND value ≥ p_R + p_C·cost + p_K·h  (this gate's proposal)
 * Regret = 1 − revenue/clairvoyant, clairvoyant = the fluid optimum (= min of the 3-budget dual).
 *
 * VERDICT (2026-05-30): GO — narrow but real; ship as opt-in with the applicability documented.
 *   - Little's law IS the right model: an occupancy cap L becomes a 3rd FLUID budget L·T with
 *     per-request consumption = hold time hᵢ; the 3-budget dual solves cleanly (3D vertex enum).
 *   - WIN (World A): when concurrency binds and a strictly-dominated hold-time hog is
 *     INDISTINGUISHABLE from good traffic on (rate,cost), 3-axis cuts regret 53%→2% (ε≈51pp) —
 *     2-axis is structurally blind to it.
 *   - NO HARM (World B): concurrency ample ⇒ p_K=0 ⇒ 3-axis ≡ 2-axis ≡ marginal.
 *   - STRUCTURAL LIMIT (World C, honest): a bid-price threshold cannot RATION a MARGINAL (fill)
 *     hog — at value = p_K·hold it is admitted and the greedy limiter rations instead; 3-axis
 *     strictly helps only vs a STRICTLY-dominated hog (same family as the 2-axis bid-price /
 *     non-stationarity caveats).
 *   Implementation ≈ a 3-budget solver + per-type `hold` in the workload model + a per-request
 *   `hold` estimate at admit time + the p_K·hold bid term. It expands the public per-request API
 *   (experimental-frontier under STABILITY.md), so disposition is a product call — see report.
 *
 * Run: npx tsx research/bigger-bets/joint-lp-admission/three-axis-gate.ts
 */

import { solveFluidLp } from "../../../src/admission/fluid-lp";

function makeRng(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Type {
  label: string;
  cost: number;
  value: number;
  hold: number; // service time (slot-holding duration)
  weight: number; // expected COUNT per window
}
interface Duals3 {
  rate: number;
  cost: number;
  conc: number;
}

/** Solve a 3×3 linear system A·x = b by Cramer's rule. null if singular. */
function solve3x3(A: number[][], b: number[]): [number, number, number] | null {
  const det = (m: number[][]): number =>
    m[0]![0]! * (m[1]![1]! * m[2]![2]! - m[1]![2]! * m[2]![1]!) -
    m[0]![1]! * (m[1]![0]! * m[2]![2]! - m[1]![2]! * m[2]![0]!) +
    m[0]![2]! * (m[1]![0]! * m[2]![1]! - m[1]![1]! * m[2]![0]!);
  const D = det(A);
  if (Math.abs(D) < 1e-12) return null;
  const col = (j: number): number[][] =>
    A.map((row, i) => row.map((val, k) => (k === j ? b[i]! : val)));
  return [det(col(0)) / D, det(col(1)) / D, det(col(2)) / D];
}

/**
 * Solve the 3-budget fluid LP through its convex PWL dual:
 *   min D(p) = R·pR + C·pC + K·pK + Σ wᵢ·max(0, vᵢ − pR − pC·cᵢ − pK·hᵢ),  p ≥ 0.
 * The minimum is at a vertex of the plane arrangement (3 axis planes + one bid plane per type);
 * enumerate every triple, solve the 3×3, keep dual-feasible, take min D (strong duality ⇒
 * min D = the primal optimum = the clairvoyant fluid revenue). Tie-break toward larger prices
 * (more selective), matching the shipped 2-budget convention.
 */
function solve3BudgetLp(
  types: Type[],
  R: number,
  C: number,
  K: number,
): { duals: Duals3; objective: number } {
  const D = (p: Duals3): number => {
    let d = R * p.rate + C * p.cost + K * p.conc;
    for (const t of types)
      d += t.weight * Math.max(0, t.value - p.rate - p.cost * t.cost - p.conc * t.hold);
    return d;
  };
  // Planes: pR=0, pC=0, pK=0, and bid plane i: pR + cᵢ·pC + hᵢ·pK = vᵢ.
  const planes: { a: number[]; b: number }[] = [
    { a: [1, 0, 0], b: 0 },
    { a: [0, 1, 0], b: 0 },
    { a: [0, 0, 1], b: 0 },
    ...types.map((t) => ({ a: [1, t.cost, t.hold], b: t.value })),
  ];
  let best: Duals3 = { rate: 0, cost: 0, conc: 0 };
  let bestD = D(best);
  let bestPriceMass = 0;
  for (let i = 0; i < planes.length; i++) {
    for (let j = i + 1; j < planes.length; j++) {
      for (let k = j + 1; k < planes.length; k++) {
        const sol = solve3x3(
          [planes[i]!.a, planes[j]!.a, planes[k]!.a],
          [planes[i]!.b, planes[j]!.b, planes[k]!.b],
        );
        if (sol === null) continue;
        const [pr, pc, pk] = sol;
        if (pr < -1e-9 || pc < -1e-9 || pk < -1e-9) continue; // dual-infeasible
        const p = { rate: Math.max(0, pr), cost: Math.max(0, pc), conc: Math.max(0, pk) };
        const d = D(p);
        const mass = p.rate + p.cost + p.conc;
        if (d < bestD - 1e-7 || (d < bestD + 1e-7 && mass > bestPriceMass)) {
          best = p;
          bestD = d;
          bestPriceMass = mass;
        }
      }
    }
  }
  return { duals: best, objective: bestD };
}

type Admit = (t: Type, rateRem: number, costRem: number, occupancy: number, L: number) => boolean;

const marginalAND: Admit = (t, rateRem, costRem, occ, L) =>
  rateRem >= 1 && costRem >= t.cost && occ < L;

const makeJoint =
  (bid: (t: Type) => number): Admit =>
  (t, rateRem, costRem, occ, L) =>
    rateRem >= 1 && costRem >= t.cost && occ < L && t.value >= bid(t);

/**
 * Discrete-event concurrency simulation over a window [0, N): one arrival per time unit, type
 * drawn from `types` by weight. Each admit holds a slot for `hold` time units (released later),
 * debits the rate (1) and cost budgets, and earns `value`. The concurrency axis denies while
 * `occupancy ≥ L`. Returns total revenue.
 */
function simulate(
  types: Type[],
  seed: number,
  N: number,
  R: number,
  C: number,
  L: number,
  admit: Admit,
): number {
  const rng = makeRng(seed);
  const totalW = types.reduce((s, t) => s + t.weight, 0);
  const pick = (): Type => {
    let r = rng() * totalW;
    for (const t of types) {
      r -= t.weight;
      if (r < 0) return t;
    }
    return types[types.length - 1]!;
  };
  let rateRem = R;
  let costRem = C;
  let revenue = 0;
  const releases: number[] = []; // sorted-ish list of release times of in-flight requests
  for (let t = 0; t < N; t++) {
    // Release everything whose hold expired by now.
    for (let i = releases.length - 1; i >= 0; i--) {
      if (releases[i]! <= t) releases.splice(i, 1);
    }
    const occ = releases.length;
    const arr = pick();
    if (admit(arr, rateRem, costRem, occ, L)) {
      rateRem -= 1;
      costRem -= arr.cost;
      revenue += arr.value;
      releases.push(t + arr.hold);
    }
  }
  return revenue;
}

const SEEDS = 30;
const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

function world(label: string, types: Type[], N: number, R: number, C: number, L: number): void {
  const K = L * N; // concurrency-seconds budget
  // 3-budget LP: the full optimum + the 3 shadow prices.
  const three = solve3BudgetLp(types, R, C, K);
  const clair = three.objective;
  // 2-budget LP (shipped solver): rate + cost only, BLIND to hold time.
  const two = solveFluidLp({
    types: types.map((t) => ({ cost: t.cost, value: t.value, weight: t.weight })),
    rateBudget: R,
    costBudget: C,
  }).duals;
  const bid2 = (t: Type): number => two.rate + two.cost * t.cost;
  const bid3 = (t: Type): number =>
    three.duals.rate + three.duals.cost * t.cost + three.duals.conc * t.hold;

  let mReg = 0;
  let j2Reg = 0;
  let j3Reg = 0;
  for (let s = 0; s < SEEDS; s++) {
    const seed = 0xc0ffee ^ (s * 2654435761);
    mReg += 1 - simulate(types, seed, N, R, C, L, marginalAND) / clair;
    j2Reg += 1 - simulate(types, seed, N, R, C, L, makeJoint(bid2)) / clair;
    j3Reg += 1 - simulate(types, seed, N, R, C, L, makeJoint(bid3)) / clair;
  }
  mReg /= SEEDS;
  j2Reg /= SEEDS;
  j3Reg /= SEEDS;
  console.log(`\n── ${label} ──`);
  console.log(
    `   types: ${types.map((t) => `${t.label}(c=${t.cost},v=${t.value},h=${t.hold})`).join(", ")}`,
  );
  console.log(`   budgets: R=${R} C=${C} L=${L} (K=L·N=${K})`);
  console.log(`   2-axis duals {rate:${two.rate.toFixed(4)}, cost:${two.cost.toFixed(5)}}`);
  console.log(
    `   3-axis duals {rate:${three.duals.rate.toFixed(4)}, cost:${three.duals.cost.toFixed(5)}, conc:${three.duals.conc.toFixed(5)}}`,
  );
  console.log(
    `   regret  marginal=${pct(mReg)}   joint-2axis=${pct(j2Reg)}   joint-3axis=${pct(j3Reg)}`,
  );
  console.log(
    `   ε(3-axis vs 2-axis) = ${pct(j2Reg - j3Reg)}    ε(3-axis vs marginal) = ${pct(mReg - j3Reg)}`,
  );
}

console.log("=== TK-1405 GATE: 3-axis joint-LP (concurrency shadow price via Little's law) ===");

// WORLD A — the cleanest possible win: `short` and `long` are IDENTICAL on (cost, value), so
// 2-axis joint-LP and marginal-AND literally cannot tell them apart — yet `long` holds a slot
// 13× longer (a strictly-dominated concurrency hog: v/h 0.67 vs 0.05). Short demand alone
// OVER-subscribes the slots, so the fluid LP rejects `long` outright (x=0) and the 3-axis bid
// test (value < p_K·hold) rejects it too — freeing the slots the others squander on hogs.
world(
  "WORLD A — concurrency binds; short/long indistinguishable on (cost,value), 13× hold",
  [
    { label: "short", cost: 100, value: 10, hold: 15, weight: 1800 },
    { label: "long", cost: 100, value: 10, hold: 200, weight: 200 },
  ],
  2000,
  2000, // R ample (admit-rate never binds)
  1_000_000_000, // C ample (cost never binds) ⇒ 2-axis duals ≈ 0 ⇒ 2-axis ≡ marginal
  10, // L — the only binding axis
);

// WORLD B — FOIL: concurrency is ample (L huge), so it never binds ⇒ p_K should be 0 and
// 3-axis ≡ 2-axis ≡ marginal (no harm from adding the axis when it isn't scarce).
world(
  "WORLD B — concurrency ample (foil: p_K≈0, no harm)",
  [
    { label: "quick", cost: 10, value: 1, hold: 1, weight: 1000 },
    { label: "whale", cost: 10, value: 5, hold: 100, weight: 1000 },
  ],
  2000,
  2000,
  10_000_000,
  100_000, // L huge — never binds
);

// WORLD C — the STRUCTURAL LIMIT (honest negative). When the hog is the LP's MARGINAL (fill)
// type its value EXACTLY equals its concurrency bid (v/h = p_K), so the bid test ADMITS it — a
// bid-price threshold cannot RATION a marginal type (the concurrency limiter then rations
// greedily/FIFO, not by value). Here `whale` is the fill type ⇒ 3-axis ≡ marginal ⇒ ε≈0. 3-axis
// strictly helps only against a STRICTLY-dominated hog (rejected outright), as in WORLD A.
world(
  "WORLD C — structural limit: a MARGINAL hog can't be rationed by the bid filter",
  [
    { label: "quick", cost: 100, value: 2, hold: 1, weight: 1000 },
    { label: "whale", cost: 20, value: 6, hold: 80, weight: 1000 },
  ],
  2000,
  1500, // R scarce-ish
  120_000, // C scarce
  12, // L scarce
);

console.log("\nReading:");
console.log(
  "  WORLD A: ε(3-axis vs 2-axis) ≫ 0 ⇒ pricing the hold-time earns its keep DECISIVELY when a",
);
console.log(
  "           strictly-dominated hog is indistinguishable from good traffic on (rate,cost).",
);
console.log(
  "  WORLD B: 3-axis ≈ 2-axis ≈ marginal (p_K≈0) ⇒ NO HARM when concurrency isn't scarce.",
);
console.log(
  "  WORLD C: ε≈0 — the bid filter can't ration a MARGINAL hog (admitted at value=bid); the",
);
console.log(
  "           greedy limiter rations instead. 3-axis strictly helps only vs a dominated hog.",
);
