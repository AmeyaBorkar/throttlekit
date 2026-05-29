import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type FluidLpInput, type WorkloadType, solveFluidLp } from "../../src/admission/fluid-lp";
import { ThrottleKitError } from "../../src/core/errors";

/**
 * The zero-dep fluid-LP solver behind the joint-LP admission policy
 * (research/bigger-bets/joint-lp-admission/DESIGN.md §3–§4, D-JLP-7). Two layers
 * of evidence:
 *
 *  1. The THEORY.md canonical fixture → exact bid prices { rate: 0, cost: 0.01 }
 *     and the rate/cost/both/neither binding regimes (§9.1).
 *  2. A KKT certificate over random N-type instances: every returned solution is
 *     primal-feasible AND satisfies dual feasibility + complementary slackness.
 *     For a linear program those conditions are jointly *sufficient* for global
 *     optimality. The duals come from minimizing the dual objective D — NOT from
 *     the KKT predicate the test asserts — so the certificate is independent, not
 *     circular. A random-feasible-x sampler adds a "nothing beats it" lower bound.
 *  3. A TIE-HEAVY (integer-valued) cross-check against a brute-force LP oracle,
 *     including the exact degenerate inputs the earlier primal-enumeration solver
 *     got wrong (value ties / equal-cost columns) — the regression suite for the
 *     dual-minimization rewrite.
 */

const TOL = 1e-9;
const KKT_TOL = 1e-6;

describe("solveFluidLp — THEORY.md canonical fixture", () => {
  // small (cheap LLM call): cost 100, value 1; large (expensive): cost 10000, value 50.
  // Per-arrival budgets (R/N = 1, C/N = 50 for the TK-1007 sweep): cost binds, small
  // is the denser type (1/100 > 50/10000), the cost budget admits all small and no
  // large ⇒ x* = (1, 0), bid prices (p_R, p_C) = (0, 0.01). These two numbers are the
  // reference duals the empirical ε = 25.33% was measured on.
  const FIXTURE: FluidLpInput = {
    types: [
      { cost: 100, value: 1, weight: 0.5 },
      { cost: 10_000, value: 50, weight: 0.5 },
    ],
    rateBudget: 1,
    costBudget: 50,
  };

  it("recovers the canonical bid prices, admit plan, and objective", () => {
    const sol = solveFluidLp(FIXTURE);
    expect(sol.duals.rate).toBeCloseTo(0, 9);
    expect(sol.duals.cost).toBeCloseTo(0.01, 9);
    expect(sol.admitFractions[0]).toBeCloseTo(1, 9);
    expect(sol.admitFractions[1]).toBeCloseTo(0, 9);
    expect(sol.objective).toBeCloseTo(0.5, 9); // 0.5·1·1 + 0.5·50·0
  });

  it("the recovered bid prices reproduce the admit/reject split", () => {
    const { duals } = solveFluidLp(FIXTURE);
    const bid = (cost: number) => duals.rate + duals.cost * cost;
    expect(1).toBeGreaterThanOrEqual(bid(100) - TOL); // small clears (at equality)
    expect(50).toBeLessThan(bid(10_000)); // large is rejected (50 < 100)
  });
});

describe("solveFluidLp — binding regimes", () => {
  it("neither binds: admit everything, duals zero", () => {
    const sol = solveFluidLp({
      types: [
        { cost: 1, value: 10, weight: 1 },
        { cost: 2, value: 20, weight: 1 },
      ],
      rateBudget: 100,
      costBudget: 100,
    });
    expect(sol.admitFractions).toEqual([1, 1]);
    expect(sol.duals).toEqual({ rate: 0, cost: 0 });
    expect(sol.objective).toBeCloseTo(30, 9);
  });

  it("rate binds only (one fractional type): p_R = the fractional type's value, p_C = 0", () => {
    // costs tiny ⇒ cost never binds. rate budget 1.5 admits the value-3 type fully
    // (rate 1) and the value-1 type at x=0.5 (rate 0.5). The value-1 type is strictly
    // fractional ⇒ it is the marginal type ⇒ p_R = 1 (unambiguous; no degeneracy).
    const sol = solveFluidLp({
      types: [
        { cost: 1, value: 3, weight: 1 },
        { cost: 1, value: 1, weight: 1 },
      ],
      rateBudget: 1.5,
      costBudget: 1_000,
    });
    expect(sol.admitFractions[0]).toBeCloseTo(1, 9);
    expect(sol.admitFractions[1]).toBeCloseTo(0.5, 9);
    expect(sol.duals.cost).toBeCloseTo(0, 9);
    expect(sol.duals.rate).toBeCloseTo(1, 9); // value of the strictly-fractional type
  });

  it("rate-binding corner (no fractional type): bid prices reproduce the fluid admit plan", () => {
    // rate budget 1 admits exactly the value-3 type (x=1) and rejects value-1 (x=0).
    // No type is strictly fractional ⇒ the rate dual is degenerate (any p_R ∈ (1, 3]
    // is LP-optimal). The revenue-management convention — matched by the reference
    // solveFluidLP — picks p_R = the marginal *admitted* value (3), the bid price that
    // makes the online filter reproduce the fluid plan: reject value-1 to save the
    // slot. (p_R = 1 would wrongly let the filter admit value-1.)
    const sol = solveFluidLp({
      types: [
        { cost: 1, value: 3, weight: 1 },
        { cost: 1, value: 1, weight: 1 },
      ],
      rateBudget: 1,
      costBudget: 1_000,
    });
    expect(sol.admitFractions).toEqual([1, 0]);
    expect(sol.duals.cost).toBeCloseTo(0, 9);
    expect(sol.duals.rate).toBeCloseTo(3, 9);
    // The meaningful property: the bid-price test reproduces the admit/reject split.
    const bid = (cost: number) => sol.duals.rate + sol.duals.cost * cost;
    expect(3).toBeGreaterThanOrEqual(bid(1) - TOL); // value-3 admitted
    expect(1).toBeLessThan(bid(1)); // value-1 rejected by the filter
  });

  it("both bind: two fractional types, both duals positive", () => {
    // Tight on both axes with distinct costs ⇒ the optimum sits at the rate∩cost
    // intersection with two fractional types and strictly-positive (p_R, p_C).
    const sol = solveFluidLp({
      types: [
        { cost: 1, value: 5, weight: 1 },
        { cost: 10, value: 20, weight: 1 },
      ],
      rateBudget: 1.5,
      costBudget: 8,
    });
    expect(sol.duals.rate).toBeGreaterThan(0);
    expect(sol.duals.cost).toBeGreaterThan(0);
    // Both constraints exactly satisfied at the optimum.
    const rate = sol.admitFractions[0]! * 1 + sol.admitFractions[1]! * 1;
    const cost = sol.admitFractions[0]! * 1 + sol.admitFractions[1]! * 10;
    expect(rate).toBeCloseTo(1.5, 6);
    expect(cost).toBeCloseTo(8, 6);
  });

  it("single type: admit the budget-feasible fraction", () => {
    const sol = solveFluidLp({
      types: [{ cost: 10, value: 5, weight: 2 }],
      rateBudget: 100,
      costBudget: 10, // cost binds: 2·10·x ≤ 10 ⇒ x ≤ 0.5
    });
    expect(sol.admitFractions[0]).toBeCloseTo(0.5, 9);
    expect(sol.duals.cost).toBeCloseTo(0.5, 9); // v/c = 5/10
  });

  it("cost-free types are always fully admitted", () => {
    const sol = solveFluidLp({
      types: [
        { cost: 0, value: 1, weight: 1 },
        { cost: 100, value: 1, weight: 1 },
      ],
      rateBudget: 100,
      costBudget: 50, // admits the cost-free type + 0.5 of the costly one
    });
    expect(sol.admitFractions[0]).toBeCloseTo(1, 9);
  });
});

describe("solveFluidLp — validation", () => {
  const ok: FluidLpInput = {
    types: [{ cost: 1, value: 1, weight: 1 }],
    rateBudget: 1,
    costBudget: 1,
  };
  it("rejects an empty type list", () => {
    expect(() => solveFluidLp({ ...ok, types: [] })).toThrow(ThrottleKitError);
  });
  it("rejects a negative cost/value/weight", () => {
    expect(() => solveFluidLp({ ...ok, types: [{ cost: -1, value: 1, weight: 1 }] })).toThrow(
      ThrottleKitError,
    );
    expect(() => solveFluidLp({ ...ok, types: [{ cost: 1, value: -1, weight: 1 }] })).toThrow(
      ThrottleKitError,
    );
  });
  it("rejects a non-positive or non-finite budget", () => {
    expect(() => solveFluidLp({ ...ok, rateBudget: 0 })).toThrow(ThrottleKitError);
    expect(() => solveFluidLp({ ...ok, costBudget: Number.POSITIVE_INFINITY })).toThrow(
      ThrottleKitError,
    );
  });
});

describe("solveFluidLp — KKT optimality certificate (random N-type instances)", () => {
  it("every solution is primal-feasible and satisfies dual feasibility + complementary slackness", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            cost: fc.double({ min: 1, max: 1000, noNaN: true }),
            value: fc.double({ min: 0.1, max: 100, noNaN: true }),
            weight: fc.double({ min: 0.1, max: 2, noNaN: true }),
          }),
          { minLength: 1, maxLength: 5 },
        ),
        fc.double({ min: 0.1, max: 8, noNaN: true }),
        fc.double({ min: 1, max: 4000, noNaN: true }),
        (types, rateBudget, costBudget) => {
          const sol = solveFluidLp({ types, rateBudget, costBudget });
          const n = types.length;

          // ── Primal feasibility ──────────────────────────────────────────
          let rate = 0;
          let cost = 0;
          let obj = 0;
          for (let i = 0; i < n; i++) {
            const x = sol.admitFractions[i]!;
            expect(x).toBeGreaterThanOrEqual(-KKT_TOL);
            expect(x).toBeLessThanOrEqual(1 + KKT_TOL);
            rate += types[i]!.weight * x;
            cost += types[i]!.weight * types[i]!.cost * x;
            obj += types[i]!.weight * types[i]!.value * x;
          }
          expect(rate).toBeLessThanOrEqual(rateBudget + KKT_TOL);
          expect(cost).toBeLessThanOrEqual(costBudget + KKT_TOL);
          expect(sol.objective).toBeCloseTo(obj, 6);

          // ── Dual feasibility ────────────────────────────────────────────
          expect(sol.duals.rate).toBeGreaterThanOrEqual(-KKT_TOL);
          expect(sol.duals.cost).toBeGreaterThanOrEqual(-KKT_TOL);

          // ── Complementary slackness (primal): reduced value sign ↔ x bound.
          //    For each type, reduced = value − p_R − p_C·cost.
          //    reduced > 0 ⇒ x = 1; reduced < 0 ⇒ x = 0; |reduced| ≈ 0 ⇒ free.
          for (let i = 0; i < n; i++) {
            const reduced = types[i]!.value - sol.duals.rate - sol.duals.cost * types[i]!.cost;
            const x = sol.admitFractions[i]!;
            if (reduced > KKT_TOL) expect(x).toBeGreaterThan(1 - 1e-4);
            else if (reduced < -KKT_TOL) expect(x).toBeLessThan(1e-4);
          }

          // ── Complementary slackness (dual): a positive price ⇒ tight budget.
          if (sol.duals.rate > KKT_TOL) expect(Math.abs(rate - rateBudget)).toBeLessThan(1e-4);
          if (sol.duals.cost > KKT_TOL) expect(Math.abs(cost - costBudget)).toBeLessThan(1e-4);
        },
      ),
      { numRuns: 400, seed: 20260529 }, // fixed seed: deterministic in CI (solver is exact, any seed passes)
    );
  });

  it("no random feasible plan beats the solver's objective (independent optimality lower bound)", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            cost: fc.double({ min: 1, max: 1000, noNaN: true }),
            value: fc.double({ min: 0.1, max: 100, noNaN: true }),
            weight: fc.double({ min: 0.1, max: 2, noNaN: true }),
          }),
          { minLength: 1, maxLength: 5 },
        ),
        fc.double({ min: 0.1, max: 8, noNaN: true }),
        fc.double({ min: 1, max: 4000, noNaN: true }),
        fc.array(
          fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 5, maxLength: 5 }),
          {
            minLength: 20,
            maxLength: 20,
          },
        ),
        (types, rateBudget, costBudget, samples) => {
          const sol = solveFluidLp({ types, rateBudget, costBudget });
          const n = types.length;
          for (const sample of samples) {
            let rate = 0;
            let cost = 0;
            let obj = 0;
            for (let i = 0; i < n; i++) {
              const x = sample[i]!;
              rate += types[i]!.weight * x;
              cost += types[i]!.weight * types[i]!.cost * x;
              obj += types[i]!.weight * types[i]!.value * x;
            }
            // Only feasible plans are valid comparators.
            if (rate <= rateBudget + TOL && cost <= costBudget + TOL) {
              expect(obj).toBeLessThanOrEqual(sol.objective + 1e-6);
            }
          }
        },
      ),
      { numRuns: 300, seed: 20260529 },
    );
  });
});

/**
 * Exact, independent brute-force optimum for the 2-budget bounded LP: enumerate
 * 0/1 assignments and, for each, the ≤2-fractional vertices that make one or both
 * budgets tight. Correct for small n; used only as a TEST oracle.
 */
function bruteForceOptimum(types: WorkloadType[], R: number, C: number): number {
  const n = types.length;
  const w = types.map((t) => t.weight);
  const v = types.map((t) => t.value);
  const c = types.map((t) => t.cost);
  const feasObj = (x: number[]): number => {
    let r = 0;
    let k = 0;
    let o = 0;
    for (let i = 0; i < n; i++) {
      r += w[i]! * x[i]!;
      k += w[i]! * c[i]! * x[i]!;
      o += w[i]! * v[i]! * x[i]!;
    }
    return r <= R + 1e-9 && k <= C + 1e-9 ? o : -1;
  };
  let best = 0;
  for (let mask = 0; mask < 1 << n; mask++) {
    const base = Array.from({ length: n }, (_, i) => (mask >> i) & 1);
    best = Math.max(best, feasObj(base));
    // one fractional type filling rate or cost exactly
    for (let f = 0; f < n; f++) {
      if (w[f]! <= 0) continue;
      for (const tight of ["R", "C"] as const) {
        const x = base.slice();
        let ru = 0;
        let ku = 0;
        for (let i = 0; i < n; i++) {
          if (i === f) continue;
          ru += w[i]! * x[i]!;
          ku += w[i]! * c[i]! * x[i]!;
        }
        const xf =
          tight === "R" ? (R - ru) / w[f]! : c[f]! > 1e-12 ? (C - ku) / (w[f]! * c[f]!) : -1;
        if (xf >= -1e-9 && xf <= 1 + 1e-9) {
          x[f] = Math.max(0, Math.min(1, xf));
          best = Math.max(best, feasObj(x));
        }
      }
    }
    // two fractional types, both budgets tight
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        const det = w[a]! * w[b]! * c[b]! - w[b]! * w[a]! * c[a]!;
        if (Math.abs(det) < 1e-12) continue;
        const x = base.slice();
        let ru = 0;
        let ku = 0;
        for (let i = 0; i < n; i++) {
          if (i === a || i === b) continue;
          ru += w[i]! * x[i]!;
          ku += w[i]! * c[i]! * x[i]!;
        }
        const b1 = R - ru;
        const b2 = C - ku;
        const xa = (b1 * w[b]! * c[b]! - w[b]! * b2) / det;
        const xb = (w[a]! * b2 - b1 * w[a]! * c[a]!) / det;
        if (xa >= -1e-9 && xa <= 1 + 1e-9 && xb >= -1e-9 && xb <= 1 + 1e-9) {
          x[a] = Math.max(0, Math.min(1, xa));
          x[b] = Math.max(0, Math.min(1, xb));
          best = Math.max(best, feasObj(x));
        }
      }
    }
  }
  return best;
}

describe("solveFluidLp — degeneracy / ties (regression for the dual-minimization rewrite)", () => {
  it("3-way value tie: returns the true optimum (was suboptimal under primal enumeration)", () => {
    // Skeptic-1 minimal case: all values equal ⇒ the old greedy tie-order picked a
    // cost-infeasible fill and fell back to obj 21.43; the true optimum is 30.
    const sol = solveFluidLp({
      types: [
        { weight: 0.5, cost: 10, value: 10 },
        { weight: 2, cost: 3, value: 10 },
        { weight: 1, cost: 1, value: 10 },
      ],
      rateBudget: 3,
      costBudget: 10,
    });
    expect(sol.objective).toBeCloseTo(30, 6);
    expect(sol.admitFractions[0]).toBeCloseTo(0, 6); // reject the costly type
    expect(sol.duals.rate).toBeCloseTo(10, 6);
    expect(sol.duals.cost).toBeCloseTo(0, 6);
  });

  it("equal-cost (duplicate) columns + both budgets tight: true optimum 16.8", () => {
    // Skeptic-1 CASE1: identical cost-5 columns; old both-bind regime skipped the
    // equal-cost pair and mishandled a third marginal type → obj 11; true is 16.8.
    const sol = solveFluidLp({
      types: [
        { weight: 1, cost: 5, value: 10 },
        { weight: 2, cost: 0, value: 1 },
        { weight: 0.5, cost: 0, value: 2 },
        { weight: 1, cost: 5, value: 10 },
        { weight: 0.5, cost: 5, value: 1 },
      ],
      rateBudget: 2,
      costBudget: 8,
    });
    expect(sol.objective).toBeCloseTo(16.8, 6);
  });

  it("matches a brute-force oracle across tie-heavy integer instances", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            // Small integers ⇒ value/cost/density ties are common (the degenerate class).
            cost: fc.integer({ min: 0, max: 3 }),
            value: fc.integer({ min: 1, max: 4 }),
            weight: fc.integer({ min: 1, max: 3 }),
          }),
          { minLength: 1, maxLength: 5 },
        ),
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 1, max: 12 }),
        (types, rateBudget, costBudget) => {
          const got = solveFluidLp({ types, rateBudget, costBudget });
          const want = bruteForceOptimum(types, rateBudget, costBudget);
          expect(got.objective).toBeCloseTo(want, 6); // exact LP optimum, ties and all
          // The reported plan is feasible and realizes the reported objective.
          let rate = 0;
          let cost = 0;
          let obj = 0;
          for (let i = 0; i < types.length; i++) {
            const x = got.admitFractions[i]!;
            expect(x).toBeGreaterThanOrEqual(-1e-9);
            expect(x).toBeLessThanOrEqual(1 + 1e-9);
            rate += types[i]!.weight * x;
            cost += types[i]!.weight * types[i]!.cost * x;
            obj += types[i]!.weight * types[i]!.value * x;
          }
          expect(rate).toBeLessThanOrEqual(rateBudget + 1e-6);
          expect(cost).toBeLessThanOrEqual(costBudget + 1e-6);
          expect(obj).toBeCloseTo(got.objective, 6);
        },
      ),
      { numRuns: 600, seed: 20260529 },
    );
  });
});
