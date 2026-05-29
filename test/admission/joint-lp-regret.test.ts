import { describe, expect, it } from "vitest";
import { solveFluidLp } from "../../src/admission/fluid-lp";

/**
 * The DR-19 ship gate, as a committed regression test: joint-LP's empirical
 * advantage over marginal-AND, ε := regret(marginal) − regret(joint), is large
 * and positive across non-degenerate arrival correlations — AND it inverts at
 * ρ = +1 (the absorbing-chain foil), which we deliberately *guard* so the honest
 * caveat (research/.../joint-lp-admission/DESIGN.md §7) is never silently "fixed".
 *
 * The bid prices come from the SHIPPED library solver `solveFluidLp` (not the
 * research reference), tying the calibrated ε = 25.33% to the code that runs in
 * production. The arrival/regret harness is the deterministic kernel from
 * `research/bigger-bets/unified/sim.ts` (TK-1007), inlined here so the test owns
 * its fixture and never depends on research code; the Mulberry32 seed makes every
 * number exact, no flake.
 */

// ── Deterministic harness (verbatim semantics of research/.../unified/sim.ts) ──

/** Mulberry32 — pure, seedable PRNG. Identical to sim.ts. */
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
const SMALL = { cost: 100, value: 1 };
const LARGE = { cost: 10_000, value: 50 };

/** Markov-correlated arrivals over {small, large}; lag-1 autocorrelation exactly ρ. */
function generateWorkload(rho: number, n: number, rng: () => number): Arrival[] {
  const stayProb = (1 + rho) / 2;
  let cur = rng() < 0.5 ? SMALL : LARGE;
  const out: Arrival[] = [];
  for (let i = 0; i < n; i++) {
    out.push(cur);
    if (rng() >= stayProb) cur = cur === SMALL ? LARGE : SMALL;
  }
  return out;
}

/** Run an admit predicate over a workload against a (rate, cost) budget; tally revenue. */
function revenue(
  arrivals: Arrival[],
  admit: (a: Arrival, rateRem: number, costRem: number) => boolean,
  R: number,
  C: number,
): number {
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

const marginalAND = (a: Arrival, rateRem: number, costRem: number): boolean =>
  rateRem >= 1 && costRem >= a.cost;

const makeJointLP =
  (duals: { rate: number; cost: number }) =>
  (a: Arrival, rateRem: number, costRem: number): boolean =>
    rateRem >= 1 && costRem >= a.cost && a.value >= duals.rate + duals.cost * a.cost;

describe("joint-LP empirical regret — the DR-19 ship gate (ε ≥ 5%)", () => {
  const R = 1000;
  const C = 50_000;
  const N = 1000;
  const SEEDS = 20;

  // Bid prices from the SHIPPED solver, on the per-arrival-normalized workload
  // (R/N, C/N, mixture weights 0.5) — reproduces the reference duals {0, 0.01}.
  const sol = solveFluidLp({
    types: [
      { cost: SMALL.cost, value: SMALL.value, weight: 0.5 },
      { cost: LARGE.cost, value: LARGE.value, weight: 0.5 },
    ],
    rateBudget: R / N,
    costBudget: C / N,
  });
  const Vclair = sol.objective * N; // clairvoyant fluid-LP value over N arrivals

  it("the shipped solver reproduces the canonical bid prices {rate: 0, cost: 0.01}", () => {
    expect(sol.duals.rate).toBeCloseTo(0, 9);
    expect(sol.duals.cost).toBeCloseTo(0.01, 9);
    expect(Vclair).toBeCloseTo(500, 6);
  });

  /** Mean (regret_marginal, regret_joint) over SEEDS seeds at one ρ. */
  function meanRegret(rho: number): { marginal: number; joint: number } {
    let mSum = 0;
    let jSum = 0;
    const joint = makeJointLP(sol.duals);
    for (let seed = 0; seed < SEEDS; seed++) {
      const rng = makeRng(0xdeadbeef ^ Math.round(rho * 1000) ^ (seed * 2654435761));
      const arrivals = generateWorkload(rho, N, rng);
      mSum += 1 - revenue(arrivals, marginalAND, R, C) / Vclair;
      jSum += 1 - revenue(arrivals, joint, R, C) / Vclair;
    }
    return { marginal: mSum / SEEDS, joint: jSum / SEEDS };
  }

  it("ε ≫ 5% across non-degenerate ρ ∈ {−1, −0.5, 0, +0.5} (DR-19 MET)", () => {
    const rhos = [-1, -0.5, 0, 0.5];
    const eps = rhos.map((rho) => {
      const { marginal, joint } = meanRegret(rho);
      return marginal - joint;
    });
    const meanEps = eps.reduce((s, e) => s + e, 0) / eps.length;
    // Committed value ≈ 0.398; assert well clear of the 5% gate AND in a sane band
    // (catches a regression that silently halves or destroys the advantage).
    expect(meanEps).toBeGreaterThan(0.05); // the DR-19 contract
    expect(meanEps).toBeGreaterThan(0.3); // pins the magnitude
    expect(meanEps).toBeLessThan(0.45);
    for (const e of eps) expect(e).toBeGreaterThan(0.3); // every non-degenerate ρ wins big
  });

  it("the ρ = +1 foil: joint-LP is WORSE (regression-guards the honest caveat, D-JLP-9)", () => {
    const { marginal, joint } = meanRegret(1);
    // On an absorbing all-large realization joint-LP rejects everything (large
    // fails the bid test) → revenue 0; marginal-AND still admits up to the cost
    // cap. The fluid-LP failure under non-stationarity (Talluri–van Ryzin 1998).
    expect(joint).toBeGreaterThan(marginal);
  });
});
