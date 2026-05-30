import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { solveFluidLp } from "../../src/admission/fluid-lp";
import { unifiedAdmission } from "../../src/admission/unified";
import { tokenBucket } from "../../src/algorithms/token-bucket";
import { adaptiveConcurrency } from "../../src/concurrency/adaptive";
import { ManualClock } from "../../src/core/clock";
import { rateLimit } from "../../src/core/limiter";

/**
 * TK-1405 — 3-axis joint-LP: a CONCURRENCY shadow price on top of rate + cost. Via Little's law
 * an occupancy cap `L` over a window `T` is a third fluid budget `K = L·T` (concurrency-seconds)
 * consumed per admit by the request's HOLD time, so the bid test becomes
 * `value ≥ p_R + p_C·cost + p_K·hold`. The gate (`three-axis-gate.ts`) showed this cuts regret
 * ~53%→2% against a strictly-dominated hold-time hog that 2-axis is BLIND to (identical on
 * cost+value). This suite pins the shipped solver + filter; the foils mirror the gate.
 */

/** Cost axis: a frozen-clock tokenBucket = a pure fixed budget of `cap`. */
function costAxis(cap: number) {
  return rateLimit({
    strategy: tokenBucket({ capacity: cap, refillPerSec: 1 }),
    clock: new ManualClock(0),
  });
}
/** The gate's WORLD A workload: short/long IDENTICAL on (cost,value), 13× hold; concurrency binds. */
function shortLongWorkload() {
  return {
    types: [
      { cost: 100, value: 10, weight: 1800, hold: 15 },
      { cost: 100, value: 10, weight: 200, hold: 200 },
    ],
    rateBudget: 2000,
    costBudget: 1_000_000_000,
    concBudget: 20_000, // K = L·N = 10·2000
  };
}

describe("3-budget fluid LP solver (TK-1405)", () => {
  it("reproduces the gate's WORLD A duals: only concurrency binds ⇒ p_K = 2/3, p_R = p_C = 0", () => {
    const s = solveFluidLp(shortLongWorkload());
    expect(s.duals.conc).toBeCloseTo(2 / 3, 4);
    expect(s.duals.rate).toBeCloseTo(0, 9);
    expect(s.duals.cost).toBeCloseTo(0, 9);
    // The optimum admits shorts up to the concurrency budget and rejects the dominated long.
    expect(s.admitFractions[1]).toBeCloseTo(0, 6); // long rejected outright
    expect(s.admitFractions[0]!).toBeGreaterThan(0); // short admitted
    expect(s.objective).toBeCloseTo((20_000 / 15) * 10, 0); // K/h_short · v_short = 13333.3
  });

  it("the bid prices reject the dominated long and (marginally) admit the short", () => {
    const { duals } = solveFluidLp(shortLongWorkload());
    const bid = (h: number): number => duals.rate + duals.cost * 100 + (duals.conc ?? 0) * h;
    expect(10).toBeGreaterThanOrEqual(bid(15) - 1e-9); // short clears (10 ≥ 2/3·15 = 10)
    expect(10).toBeLessThan(bid(200)); // long rejected (10 < 2/3·200 ≈ 133)
  });

  it("FOIL — concurrency ample ⇒ p_K ≈ 0 (no spurious concurrency price)", () => {
    const s = solveFluidLp({ ...shortLongWorkload(), concBudget: 1_000_000_000 });
    expect(s.duals.conc).toBeCloseTo(0, 6);
  });

  it("2-budget path is byte-unchanged when `concBudget` is omitted (no `conc` field)", () => {
    const s = solveFluidLp({
      types: [
        { cost: 100, value: 1, weight: 0.5 },
        { cost: 10_000, value: 50, weight: 0.5 },
      ],
      rateBudget: 1,
      costBudget: 50,
    });
    expect(s.duals.rate).toBeCloseTo(0, 9);
    expect(s.duals.cost).toBeCloseTo(0.01, 9);
    expect(s.duals.conc).toBeUndefined();
  });

  it("validates the concurrency mode: concBudget and per-type hold come together, both well-formed", () => {
    const ok = { types: [{ cost: 1, value: 1, weight: 1, hold: 5 }], rateBudget: 1, costBudget: 1 };
    expect(() => solveFluidLp(ok)).toThrow(/needs BOTH/); // holds, no concBudget
    expect(() =>
      solveFluidLp({
        types: [{ cost: 1, value: 1, weight: 1 }],
        rateBudget: 1,
        costBudget: 1,
        concBudget: 10,
      }),
    ).toThrow(/needs BOTH/); // concBudget, no holds
    expect(() => solveFluidLp({ ...ok, concBudget: 0 })).toThrow(/concBudget must be/); // K ≤ 0
    expect(() =>
      solveFluidLp({
        types: [{ cost: 1, value: 1, weight: 1, hold: -1 }],
        rateBudget: 1,
        costBudget: 1,
        concBudget: 10,
      }),
    ).toThrow(/hold must be/); // negative hold
  });
});

describe("3-axis filter on unifiedAdmission (TK-1405)", () => {
  it("rejects a hold-time hog that 2-axis is structurally blind to", () => {
    const three = unifiedAdmission({
      cost: costAxis(1e9),
      policy: "joint-lp",
      jointLp: { workload: shortLongWorkload() },
    });
    // 2-axis on the SAME (cost,value) types — short and long are indistinguishable to it.
    const two = unifiedAdmission({
      cost: costAxis(1e9),
      policy: "joint-lp",
      jointLp: {
        workload: {
          types: [
            { cost: 100, value: 10, weight: 1800 },
            { cost: 100, value: 10, weight: 200 },
          ],
          rateBudget: 2000,
          costBudget: 1e9,
        },
      },
    });
    // 2-axis admits the request regardless of hold (it cannot see hold):
    expect(two.admitSync({ cost: 100, value: 10 }).decision.allowed).toBe(true);
    // 3-axis admits a SHORT-hold request but rejects the LONG hog — the win 2-axis cannot express.
    // (hold 5 clears with margin: 10 ≥ 0.667·5 = 3.33; hold 200 is rejected: 10 < 0.667·200 = 133.)
    expect(three.admitSync({ cost: 100, value: 10, hold: 5 }).decision.allowed).toBe(true);
    expect(three.admitSync({ cost: 100, value: 10, hold: 200 }).policyDenied).toBe(true);
  });

  it("a missing `hold` is fail-open: the concurrency term is inert (3-axis ≡ 2-axis on that request)", () => {
    const a = unifiedAdmission({
      cost: costAxis(1e9),
      policy: "joint-lp",
      jointLp: { workload: shortLongWorkload() },
    });
    // Without a hold the long hog clears (conc term = p_K·0 = 0) — never a wrongful rejection.
    expect(a.admitSync({ cost: 100, value: 10 }).decision.allowed).toBe(true);
    expect(a.admitSync({ cost: 100, value: 10, hold: 0 }).decision.allowed).toBe(true);
  });

  it("the `duals.conc` escape hatch prices concurrency directly", () => {
    const a = unifiedAdmission({
      cost: costAxis(1e9),
      policy: "joint-lp",
      jointLp: { duals: { rate: 0, cost: 0, conc: 0.5 } },
    });
    expect(a.admitSync({ cost: 100, value: 10, hold: 100 }).policyDenied).toBe(true); // 10 < 0.5·100 = 50
    expect(a.admitSync({ cost: 100, value: 60, hold: 100 }).decision.allowed).toBe(true); // 60 ≥ 50
  });

  it("monotone in hold: a higher-hold request never clears a bid a lower-hold one fails", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 5, noNaN: true }), // p_K
        fc.double({ min: 0, max: 100, noNaN: true }), // value
        fc.double({ min: 0, max: 300, noNaN: true }), // h2 (lower)
        fc.double({ min: 0, max: 300, noNaN: true }), // delta ≥ 0 ⇒ h1 = h2 + delta
        (pk, value, h2, delta) => {
          const h1 = h2 + delta;
          const make = () =>
            unifiedAdmission({
              cost: costAxis(1e9),
              policy: "joint-lp",
              jointLp: { duals: { rate: 0, cost: 0, conc: pk } },
            });
          const hi = make().admitSync({ cost: 10, value, hold: h1 });
          if (hi.decision.allowed) {
            // higher hold cleared ⇒ the lower hold (smaller bid) must clear too
            expect(make().admitSync({ cost: 10, value, hold: h2 }).decision.allowed).toBe(true);
          }
        },
      ),
      { numRuns: 200, seed: 20260530 },
    );
  });

  it("strictly more selective: every 3-axis admit is also a 2-axis admit on the same rate/cost prices", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 100, noNaN: true }), // cost
        fc.double({ min: 5, max: 300, noNaN: true }), // value (biased high so many runs actually admit)
        fc.double({ min: 0, max: 100, noNaN: true }), // hold
        fc.double({ min: 0, max: 0.2, noNaN: true }), // conc price
        (cost, value, hold, conc) => {
          const three = unifiedAdmission({
            cost: costAxis(1e9),
            policy: "joint-lp",
            jointLp: { duals: { rate: 1, cost: 0.01, conc } },
          });
          const two = unifiedAdmission({
            cost: costAxis(1e9),
            policy: "joint-lp",
            jointLp: { duals: { rate: 1, cost: 0.01 } },
          });
          const j3 = three.admitSync({ cost, value, hold });
          if (j3.decision.allowed) {
            // the conc term only ADDS to the bid, so a 3-axis admit must clear the 2-axis bid too
            expect(two.admitSync({ cost, value, hold }).decision.allowed).toBe(true);
          }
        },
      ),
      { numRuns: 300, seed: 20260530 },
    );
  });
});

describe("3-axis construction validation (TK-1405)", () => {
  it("rejects combining `adaptive` with the 3-axis concurrency budget (not yet composable)", () => {
    expect(() =>
      unifiedAdmission({
        cost: costAxis(10),
        policy: "joint-lp",
        jointLp: {
          workload: {
            types: [{ cost: 1, value: 1, weight: 1, hold: 1 }],
            rateBudget: 1,
            costBudget: 1,
            concBudget: 1,
          },
          adaptive: { sampleWindow: 10 },
        },
      }),
    ).toThrow(/cannot be combined/);
  });

  it("validates the conc dual (finite ≥ 0)", () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        unifiedAdmission({
          cost: costAxis(10),
          policy: "joint-lp",
          jointLp: { duals: { rate: 0, cost: 0, conc: bad } },
        }),
      ).toThrow(/conc must be a finite number/);
    }
  });

  it("a workload with concBudget but a missing per-type hold fails loud (via the solver)", () => {
    expect(() =>
      unifiedAdmission({
        cost: costAxis(10),
        policy: "joint-lp",
        jointLp: {
          workload: {
            types: [{ cost: 1, value: 1, weight: 1 }],
            rateBudget: 1,
            costBudget: 1,
            concBudget: 10,
          },
        },
      }),
    ).toThrow(/needs BOTH/);
  });
});

// ── Robustness + composition (the 3-skeptic adversarial-pass fixes) ──
describe("3-axis robustness — per-request hold safety (TK-1405)", () => {
  it("a NEGATIVE per-request hold cannot rescue a request the 2-axis bid rejects (no negative term)", () => {
    // duals price BOTH cost and conc. A cost-100 value-10 request fails the 2-axis bid (10 < 0.2·100 = 20)
    // and must STAY rejected — a negative hold must not subtract its way to an admit (the feature-defeat).
    const a = unifiedAdmission({
      cost: costAxis(1e9),
      policy: "joint-lp",
      jointLp: { duals: { rate: 0, cost: 0.2, conc: 0.5 } },
    });
    expect(a.admitSync({ cost: 100, value: 10, hold: -100 }).policyDenied).toBe(true);
    expect(a.admitSync({ cost: 100, value: 10, hold: -1e9 }).policyDenied).toBe(true);
  });

  it("a NaN / Infinity per-request hold never poisons the bid (no 0·NaN), on 2-axis or 3-axis", () => {
    // 2-axis admitter (conc undefined): a stray non-finite hold must be fully inert (a clearing request clears).
    const two = unifiedAdmission({
      cost: costAxis(1e9),
      policy: "joint-lp",
      jointLp: { duals: { rate: 0, cost: 0.01 } },
    });
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(two.admitSync({ cost: 100, value: 50, hold: bad }).decision.allowed).toBe(true);
    }
    // 3-axis admitter: a non-finite hold is treated as 0 (no conc term) ⇒ clears if the 2-axis part clears.
    const three = unifiedAdmission({
      cost: costAxis(1e9),
      policy: "joint-lp",
      jointLp: { duals: { rate: 0, cost: 0, conc: 0.5 } },
    });
    expect(three.admitSync({ cost: 100, value: 1, hold: Number.NaN }).decision.allowed).toBe(true);
  });
});

describe("3-axis solver — admitFractions is FEASIBLE (TK-1405, Skeptic 1 fix)", () => {
  it("the recovered plan never overruns any budget across random 3-budget instances", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            cost: fc.nat({ max: 6 }),
            value: fc.nat({ max: 12 }),
            weight: fc.integer({ min: 1, max: 6 }),
            hold: fc.nat({ max: 6 }),
          }),
          { minLength: 1, maxLength: 5 },
        ),
        fc.double({ min: 1, max: 12, noNaN: true }), // R
        fc.double({ min: 1, max: 60, noNaN: true }), // C
        fc.double({ min: 1, max: 40, noNaN: true }), // K
        (types, R, C, K) => {
          const sol = solveFluidLp({ types, rateBudget: R, costBudget: C, concBudget: K });
          let uR = 0;
          let uC = 0;
          let uK = 0;
          sol.admitFractions.forEach((x, i) => {
            uR += x * types[i]!.weight;
            uC += x * types[i]!.weight * types[i]!.cost;
            uK += x * types[i]!.weight * types[i]!.hold;
          });
          expect(uR).toBeLessThanOrEqual(R + 1e-6);
          expect(uC).toBeLessThanOrEqual(C + 1e-6);
          expect(uK).toBeLessThanOrEqual(K + 1e-6);
        },
      ),
      { numRuns: 400, seed: 20260530 },
    );
  });
});

describe("3-axis composition (TK-1405)", () => {
  it("NO-HARM foil at the unified level: ample concurrency ⇒ the hog is admitted (≡ 2-axis)", () => {
    // K huge ⇒ p_K = 0 ⇒ the conc term is inert ⇒ even a long-hold request clears, just like 2-axis.
    const a = unifiedAdmission({
      cost: costAxis(1e9),
      policy: "joint-lp",
      jointLp: { workload: { ...shortLongWorkload(), concBudget: 1_000_000_000 } },
    });
    expect(a.admitSync({ cost: 100, value: 10, hold: 200 }).decision.allowed).toBe(true);
  });

  it("a 3-axis policy deny releases the held concurrency slot (no leak)", () => {
    const conc = adaptiveConcurrency({ minLimit: 1, maxLimit: 1, initialLimit: 1 });
    const a = unifiedAdmission({
      concurrency: conc,
      cost: costAxis(1e9),
      policy: "joint-lp",
      jointLp: { duals: { rate: 0, cost: 0, conc: 0.5 } },
    });
    // A hog (value 10, hold 100 ⇒ bid 50) is filtered AFTER the slot was transiently acquired — it must free it.
    const denied = a.admitSync({ cost: 100, value: 10, hold: 100 });
    expect(denied.policyDenied).toBe(true);
    // The slot is free again → a clearing request can still acquire the single slot.
    const ok = a.admitSync({ cost: 100, value: 100, hold: 100 });
    expect(ok.decision.allowed).toBe(true);
    ok.release();
  });
});
