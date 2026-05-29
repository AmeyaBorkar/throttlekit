/**
 * TK-1401 GATE — online (sample-then-price) vs static duals for joint-LP.
 *
 * D-JLP-8 deferred online dual updates with the worry "might underperform; ε=25.33% was
 * measured on STATIC duals." This gate settles WHEN online earns its keep, before any code:
 *
 *   The reframing: static duals are only optimal if the construction-time PRIOR is correct.
 *   Online sample-then-price (Devanur–Hayes) observes the first W arrivals, re-solves the
 *   fluid LP from what it ACTUALLY saw, then freezes. So it should:
 *     (A) Correct prior  → online ≈ static, minus a bounded warm-up cost (it must not hurt).
 *     (B) WRONG prior    → online LEARNS the truth and beats static (the win).
 *     (C) ρ=+1 foil      → report honestly whether online inherits the absorbing-chain failure.
 *
 * Faithful to the shipped DR-19 harness (test/admission/joint-lp-regret.test.ts): same
 * Markov workload, same budgets, same shipped `solveFluidLp`. The only addition is the
 * adaptive policy + a misspecified-value world.
 *
 * VERDICT (2026-05-30): GO — shipped 0.11.3 as the opt-in `jointLp.adaptive` GUARDED design
 * (price the warm-up with the prior; adopt the re-solved duals ONLY IF they beat it on the
 * observed sample). The naive "unpriced warm-up" and "freeze-always" variants FAIL World A
 * (a correct prior, 9.9–21.1% vs static's 0.7–1.2%); guarded keeps it. See
 * src/admission/unified.ts, test/admission/joint-lp-adaptive.test.ts, and DESIGN.md §6 + D-JLP-13/14.
 *
 * Run: npx tsx research/bigger-bets/joint-lp-admission/adaptive-gate.ts
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

interface Arrival {
  cost: number;
  value: number;
}
type Admit = (a: Arrival, rateRem: number, costRem: number) => boolean;

const R = 1000;
const C = 50_000;
const N = 1000;
const SEEDS = 20;

/** Markov-correlated {small, large} arrivals, lag-1 autocorrelation ρ. `largeValue` is the
 *  TRUE value of a large request in this world (the base world uses 50). */
function generateWorkload(
  rho: number,
  n: number,
  rng: () => number,
  largeValue: number,
): Arrival[] {
  const SMALL: Arrival = { cost: 100, value: 1 };
  const LARGE: Arrival = { cost: 10_000, value: largeValue };
  const stayProb = (1 + rho) / 2;
  let cur = rng() < 0.5 ? SMALL : LARGE;
  const out: Arrival[] = [];
  for (let i = 0; i < n; i++) {
    out.push(cur);
    if (rng() >= stayProb) cur = cur === SMALL ? LARGE : SMALL;
  }
  return out;
}

function revenue(arrivals: Arrival[], admit: Admit): number {
  let rateRem = R;
  let costRem = C;
  let rev = 0;
  for (const a of arrivals) {
    if (admit(a, rateRem, costRem)) {
      rateRem -= 1;
      costRem -= a.cost;
      rev += a.value;
    }
  }
  return rev;
}

const marginalAND: Admit = (a, rateRem, costRem) => rateRem >= 1 && costRem >= a.cost;

const makeStatic =
  (duals: { rate: number; cost: number }): Admit =>
  (a, rateRem, costRem) =>
    rateRem >= 1 && costRem >= a.cost && a.value >= duals.rate + duals.cost * a.cost;

/** A FRESH stateful adaptive predicate: admit per marginal for the first W arrivals while
 *  tallying observed (cost→value, count), then re-solve + freeze, then price. */
function makeAdaptive(W: number): Admit {
  let seen = 0;
  const buckets = new Map<number, { cost: number; value: number; count: number }>();
  let duals: { rate: number; cost: number } | undefined;
  return (a, rateRem, costRem) => {
    seen += 1;
    if (duals === undefined) {
      const b = buckets.get(a.cost) ?? { cost: a.cost, value: a.value, count: 0 };
      b.count += 1;
      b.value = a.value; // value is deterministic per cost-type in this workload
      buckets.set(a.cost, b);
      if (seen >= W) {
        const types = [...buckets.values()].map((x) => ({
          cost: x.cost,
          value: x.value,
          weight: x.count / seen,
        }));
        duals = solveFluidLp({ types, rateBudget: R / N, costBudget: C / N }).duals;
      }
      return marginalAND(a, rateRem, costRem); // warm-up: observe, don't filter
    }
    return rateRem >= 1 && costRem >= a.cost && a.value >= duals.rate + duals.cost * a.cost;
  };
}

/** The FIX: price the warm-up with the construction PRIOR's duals, then re-solve from the
 *  first W observations and freeze. Dominates naive: it never runs unpriced (so a binding
 *  budget isn't squandered), starts no worse than static(prior), and refines toward the truth. */
function makeAdaptivePriorRefine(W: number, prior: { rate: number; cost: number }): Admit {
  let seen = 0;
  const buckets = new Map<number, { cost: number; value: number; count: number }>();
  let duals = prior;
  let frozen = false;
  return (a, rateRem, costRem) => {
    seen += 1;
    if (!frozen) {
      const b = buckets.get(a.cost) ?? { cost: a.cost, value: a.value, count: 0 };
      b.count += 1;
      b.value = a.value;
      buckets.set(a.cost, b);
      if (seen >= W) {
        const types = [...buckets.values()].map((x) => ({
          cost: x.cost,
          value: x.value,
          weight: x.count / seen,
        }));
        duals = solveFluidLp({ types, rateBudget: R / N, costBudget: C / N }).duals;
        frozen = true;
      }
    }
    return rateRem >= 1 && costRem >= a.cost && a.value >= duals.rate + duals.cost * a.cost;
  };
}

/** Revenue of a duals policy on a buffered sample under a scaled budget (for the self-test). */
function replayRevenue(
  buf: Arrival[],
  duals: { rate: number; cost: number },
  r: number,
  c: number,
): number {
  let rateRem = r;
  let costRem = c;
  let rev = 0;
  for (const a of buf) {
    if (rateRem >= 1 && costRem >= a.cost && a.value >= duals.rate + duals.cost * a.cost) {
      rateRem -= 1;
      costRem -= a.cost;
      rev += a.value;
    }
  }
  return rev;
}

/** The robust FIX: price warm-up with the prior, then at W adopt the learned duals ONLY IF they
 *  beat the prior on the OBSERVED sample (replayed under the window-scaled budget). Self-validating:
 *  keeps a correct prior (noise can't dislodge it), escapes a catastrophically wrong one. */
function makeAdaptiveGuarded(W: number, prior: { rate: number; cost: number }): Admit {
  let seen = 0;
  const buf: Arrival[] = [];
  const buckets = new Map<number, { cost: number; value: number; count: number }>();
  let duals = prior;
  let frozen = false;
  return (a, rateRem, costRem) => {
    seen += 1;
    if (!frozen) {
      buf.push(a);
      const b = buckets.get(a.cost) ?? { cost: a.cost, value: a.value, count: 0 };
      b.count += 1;
      b.value = a.value;
      buckets.set(a.cost, b);
      if (seen >= W) {
        const types = [...buckets.values()].map((x) => ({
          cost: x.cost,
          value: x.value,
          weight: x.count / seen,
        }));
        const learned = solveFluidLp({ types, rateBudget: R / N, costBudget: C / N }).duals;
        const rPrior = replayRevenue(buf, prior, (R * W) / N, (C * W) / N);
        const rLearned = replayRevenue(buf, learned, (R * W) / N, (C * W) / N);
        duals = rLearned > rPrior ? learned : prior; // adopt only if it beats the prior on-sample
        frozen = true;
      }
    }
    return rateRem >= 1 && costRem >= a.cost && a.value >= duals.rate + duals.cost * a.cost;
  };
}

/** Duals for a believed/true world: solve the per-arrival-normalized LP for a given large value. */
function dualsFor(largeValue: number): { rate: number; cost: number } {
  return solveFluidLp({
    types: [
      { cost: 100, value: 1, weight: 0.5 },
      { cost: 10_000, value: largeValue, weight: 0.5 },
    ],
    rateBudget: R / N,
    costBudget: C / N,
  }).duals;
}
function clairvoyant(largeValue: number): number {
  return (
    solveFluidLp({
      types: [
        { cost: 100, value: 1, weight: 0.5 },
        { cost: 10_000, value: largeValue, weight: 0.5 },
      ],
      rateBudget: R / N,
      costBudget: C / N,
    }).objective * N
  );
}

/** Mean regret of a (fresh-per-seed) policy at one ρ in a world with the given true large value. */
function meanRegret(rho: number, trueLargeValue: number, make: () => Admit): number {
  const Vclair = clairvoyant(trueLargeValue);
  let sum = 0;
  for (let seed = 0; seed < SEEDS; seed++) {
    const rng = makeRng(0xdeadbeef ^ Math.round(rho * 1000) ^ (seed * 2654435761));
    const arrivals = generateWorkload(rho, N, rng, trueLargeValue);
    sum += 1 - revenue(arrivals, make()) / Vclair;
  }
  return sum / SEEDS;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const RHOS = [-1, -0.5, 0, 0.5, 1];

function world(label: string, priorLargeValue: number, trueLargeValue: number): void {
  const priorDuals = dualsFor(priorLargeValue); // what construction believed
  const oracleDuals = dualsFor(trueLargeValue); // best a CORRECT static prior could do
  console.log(`\n── ${label} ──`);
  console.log(`   prior large value=${priorLargeValue} ⇒ duals ${JSON.stringify(priorDuals)}`);
  console.log(
    `   true  large value=${trueLargeValue} ⇒ oracle duals ${JSON.stringify(oracleDuals)}`,
  );
  console.log(
    "   ρ      marginal   static(prior)   static(oracle)   refine(W=200)   GUARDED(W=200)   guarded−oracle",
  );
  for (const rho of RHOS) {
    const m = meanRegret(rho, trueLargeValue, () => marginalAND);
    const sp = meanRegret(rho, trueLargeValue, () => makeStatic(priorDuals));
    const so = meanRegret(rho, trueLargeValue, () => makeStatic(oracleDuals));
    const rf = meanRegret(rho, trueLargeValue, () => makeAdaptivePriorRefine(200, priorDuals)); // freeze-always
    const gd = meanRegret(rho, trueLargeValue, () => makeAdaptiveGuarded(200, priorDuals)); // adopt-if-better
    const gap = gd - so; // distance from the best a correct static prior could do
    console.log(
      `   ${String(rho).padStart(4)}   ${pct(m).padStart(7)}   ${pct(sp).padStart(11)}   ${pct(
        so,
      ).padStart(
        12,
      )}   ${pct(rf).padStart(11)}   ${pct(gd).padStart(12)}   ${pct(gap).padStart(15)}`,
    );
  }
}

console.log(
  "=== TK-1401 GATE: online sample-then-price vs static duals (regret = 1 − rev/clairvoyant) ===",
);

// (A) Correct prior: prior == true. Adaptive must not HURT (≈ static, minus bounded warm-up).
world("WORLD A — correct prior (prior=true large value 50)", 50, 50);

// (B) Misspecified value: construction believed large worth 50, but it is actually worth 200
//     (so large is now the value-DENSE type and SHOULD be admitted). static(prior) wrongly
//     rejects it; adaptive observes value 200 and re-prices. THE WIN.
world("WORLD B — value-misspecified prior (believed 50, true 200)", 50, 200);

// (C) Reverse misspecification: believed large worth 200 (admit it) but it's truly worth 50
//     (should reject). static(prior) wrongly admits the value-sparse large; adaptive corrects.
world("WORLD C — value-misspecified prior (believed 200, true 50)", 200, 50);

console.log(
  "\nReading: WORLD A shows the warm-up cost (adaptive vs static(oracle) at correct prior).",
);
console.log("WORLD B/C: 'online−static(prior)' > 0 ⇒ adaptive recovers the misspecification gap.");
console.log("ρ=+1 is the absorbing-chain foil — read adaptive vs marginal there honestly.");
