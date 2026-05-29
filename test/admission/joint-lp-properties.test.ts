import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { unifiedAdmission } from "../../src/admission/unified";
import { gcra } from "../../src/algorithms/gcra";
import { tokenBucket } from "../../src/algorithms/token-bucket";
import { adaptiveConcurrency } from "../../src/concurrency/adaptive";
import { ManualClock } from "../../src/core/clock";
import { rateLimit } from "../../src/core/limiter";

/**
 * Joint-LP policy guarantees on top of `unifiedAdmission`:
 *  - **D-JLP-2 default-unchanged**: `policy:"marginal"` (and omitted) is
 *    decision-identical to the pre-0.11.1 path; supplying `value` is inert.
 *  - **D-JLP-5 strictly more selective**: every joint-LP admit is also a marginal
 *    admit on identical state — the filter only ever removes admits.
 *  - **monotone in value**: a higher-value request never fails a bid-price test a
 *    lower-value one passes.
 *  - **duals = 0 ≡ marginal**: a zero bid price makes `value ≥ 0` always true.
 *  - **shape**: a policy denial sets `allowed:false, remaining:0, policyDenied:true`
 *    with every configured axis still `allowed:true`, releases any held slot, and
 *    works on both `admit` and `admitSync`.
 *  - construction validation (D-JLP-11 cost-axis required; exactly-one duals/workload).
 */

const NUM_RUNS = 300;
const HOUR = 3_600_000;

/** A cost-axis limiter (tokenBucket: check(key, cost) debits `cost`). The clock
 *  never advances in these tests, so any positive refill yields zero refill — the
 *  bucket behaves as a pure fixed budget of `capacity`. */
function costAxis(capacity: number, clock: ManualClock) {
  return rateLimit({ strategy: tokenBucket({ capacity, refillPerSec: 1 }), clock });
}
/** A rate-axis limiter (gcra: one unit per check). */
function rateAxis(limit: number, clock: ManualClock) {
  return rateLimit({ strategy: gcra({ limit, periodMs: HOUR }), clock });
}

describe("joint-LP — monotone in value (the bid-price test never penalizes higher value)", () => {
  it("if a value-v2 request clears the filter, every v1 ≥ v2 does too", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 5, noNaN: true }), // duals.rate
        fc.double({ min: 0, max: 0.1, noNaN: true }), // duals.cost
        fc.double({ min: 1, max: 50, noNaN: true }), // requestCost
        fc.double({ min: 0, max: 100, noNaN: true }), // v2 (lower)
        fc.double({ min: 0, max: 100, noNaN: true }), // delta ≥ 0 ⇒ v1 = v2 + delta
        (rate, cost, requestCost, v2, delta) => {
          const v1 = v2 + delta;
          // Generous cost axis ⇒ only the bid-price filter can deny.
          const make = () =>
            unifiedAdmission({
              cost: costAxis(1e9, new ManualClock(0)),
              policy: "joint-lp",
              jointLp: { duals: { rate, cost } },
            });
          const lo = make().admitSync({ cost: requestCost, value: v2 });
          if (lo.decision.allowed) {
            const hi = make().admitSync({ cost: requestCost, value: v1 });
            expect(hi.decision.allowed).toBe(true);
          }
        },
      ),
      { numRuns: NUM_RUNS, seed: 20260529 },
    );
  });
});

describe("joint-LP — strictly more selective than marginal (D-JLP-5)", () => {
  it("on identical fresh state, every joint-LP admit is also a marginal admit", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 500, noNaN: true }), // cost-axis capacity
        fc.integer({ min: 1, max: 20 }), // rate-axis limit
        fc.double({ min: 1, max: 200, noNaN: true }), // requestCost
        fc.double({ min: 0, max: 100, noNaN: true }), // value
        fc.double({ min: 0, max: 5, noNaN: true }), // duals.rate
        fc.double({ min: 0, max: 0.5, noNaN: true }), // duals.cost
        (cap, limit, requestCost, value, dr, dc) => {
          const marginal = unifiedAdmission({
            rate: rateAxis(limit, new ManualClock(0)),
            cost: costAxis(cap, new ManualClock(0)),
          });
          const joint = unifiedAdmission({
            rate: rateAxis(limit, new ManualClock(0)),
            cost: costAxis(cap, new ManualClock(0)),
            policy: "joint-lp",
            jointLp: { duals: { rate: dr, cost: dc } },
          });
          const m = marginal.admitSync({ cost: requestCost, value });
          const j = joint.admitSync({ cost: requestCost, value });
          if (j.decision.allowed) expect(m.decision.allowed).toBe(true); // joint ⊆ marginal
        },
      ),
      { numRuns: NUM_RUNS, seed: 20260529 },
    );
  });
});

describe("joint-LP — default-unchanged (D-JLP-2)", () => {
  it('omitted policy ≡ policy:"marginal", decision-for-decision, and `value` is inert', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            cost: fc.double({ min: 1, max: 100, noNaN: true }),
            value: fc.double({ min: 0, max: 50, noNaN: true }),
          }),
          { minLength: 1, maxLength: 30 },
        ),
        (stream) => {
          const omitted = unifiedAdmission({
            rate: rateAxis(10, new ManualClock(0)),
            cost: costAxis(500, new ManualClock(0)),
          });
          const marginal = unifiedAdmission({
            rate: rateAxis(10, new ManualClock(0)),
            cost: costAxis(500, new ManualClock(0)),
            policy: "marginal",
          });
          for (const s of stream) {
            const a = omitted.admitSync({ cost: s.cost }); // no value
            const b = marginal.admitSync({ cost: s.cost, value: s.value }); // value supplied but inert
            expect(b.decision).toEqual(a.decision);
            expect(b.policyDenied).toBeFalsy();
          }
        },
      ),
      { numRuns: NUM_RUNS, seed: 20260529 },
    );
  });

  it("golden: a successful admit reports the cost axis's real remaining (guards the shared finalize/combine path)", () => {
    // The omitted-vs-marginal comparison above runs both on the same code path, so a
    // regression in the SHARED finalize/combine could pass it unseen. This pins the
    // exact Decision a known cost-axis state must produce — independent of policy.
    const admit = unifiedAdmission({ cost: costAxis(500, new ManualClock(0)) });
    const r = admit.admitSync({ cost: 100 });
    expect(r.decision.allowed).toBe(true);
    expect(r.decision.limit).toBe(500);
    expect(r.decision.remaining).toBe(400); // 500 − 100; catches a corrupted `remaining`
    expect(r.decision.retryAfterMs).toBe(0);
    expect(r.policyDenied).toBeFalsy();
  });
});

describe("joint-LP — duals = 0 ≡ marginal", () => {
  it("zero bid prices admit identically to marginal over a random stream", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            cost: fc.double({ min: 1, max: 100, noNaN: true }),
            value: fc.double({ min: 0, max: 50, noNaN: true }),
          }),
          { minLength: 1, maxLength: 30 },
        ),
        (stream) => {
          const marginal = unifiedAdmission({
            cost: costAxis(500, new ManualClock(0)),
          });
          const zeroDuals = unifiedAdmission({
            cost: costAxis(500, new ManualClock(0)),
            policy: "joint-lp",
            jointLp: { duals: { rate: 0, cost: 0 } },
          });
          for (const s of stream) {
            const a = marginal.admitSync({ cost: s.cost });
            const b = zeroDuals.admitSync({ cost: s.cost, value: s.value });
            expect(b.decision.allowed).toBe(a.decision.allowed);
            expect(b.policyDenied).toBeFalsy(); // value ≥ 0 always clears bid 0
          }
        },
      ),
      { numRuns: NUM_RUNS, seed: 20260529 },
    );
  });
});

describe("joint-LP — policy-denial shape + lifecycle", () => {
  it("a filter denial: allowed:false, remaining:0, policyDenied:true, axes NOT consulted", () => {
    const a = unifiedAdmission({
      cost: costAxis(1e9, new ManualClock(0)), // generous: only the filter denies
      policy: "joint-lp",
      jointLp: { duals: { rate: 0, cost: 1 } }, // bid = cost·1; a cost-10 value-1 request: 1 < 10 ⇒ deny
    });
    const r = a.admitSync({ cost: 10, value: 1 });
    expect(r.decision.allowed).toBe(false);
    expect(r.decision.remaining).toBe(0);
    expect(r.policyDenied).toBe(true);
    // The filter runs BEFORE the rate/cost axes (so a filtered request consumes no
    // budget), hence the cost axis was never consulted — that is the whole point.
    expect(a.lastDecisions().cost).toBeUndefined();
  });

  it("a cleared request is a normal admit (policyDenied falsy)", () => {
    const a = unifiedAdmission({
      cost: costAxis(1e9, new ManualClock(0)),
      policy: "joint-lp",
      jointLp: { duals: { rate: 0, cost: 1 } },
    });
    const r = a.admitSync({ cost: 10, value: 100 }); // 100 ≥ 10 ⇒ clears
    expect(r.decision.allowed).toBe(true);
    expect(r.policyDenied).toBeFalsy();
  });

  it("releases the held concurrency slot when the filter denies (no slot leak)", () => {
    const conc = adaptiveConcurrency({ minLimit: 1, maxLimit: 1, initialLimit: 1 });
    const a = unifiedAdmission({
      concurrency: conc,
      cost: costAxis(1e9, new ManualClock(0)),
      policy: "joint-lp",
      jointLp: { duals: { rate: 0, cost: 1 } },
    });
    // Filter-denied: would have held the single slot, must release it.
    const denied = a.admitSync({ cost: 10, value: 1 });
    expect(denied.decision.allowed).toBe(false);
    expect(denied.policyDenied).toBe(true);
    // The slot is free again → a clearing request can still acquire it.
    const ok = a.admitSync({ cost: 10, value: 100 });
    expect(ok.decision.allowed).toBe(true);
    ok.release();
  });

  it("the bid-price gate works identically on admit (async)", async () => {
    const a = unifiedAdmission({
      cost: costAxis(1e9, new ManualClock(0)),
      policy: "joint-lp",
      jointLp: { duals: { rate: 0, cost: 1 } },
    });
    expect((await a.admit({ cost: 10, value: 1 })).policyDenied).toBe(true);
    expect((await a.admit({ cost: 10, value: 100 })).policyDenied).toBeFalsy();
  });
});

describe("joint-LP — construction validation", () => {
  const clock = () => new ManualClock(0);
  it('policy "joint-lp" without a cost axis throws (D-JLP-11)', () => {
    expect(() =>
      unifiedAdmission({
        rate: rateAxis(5, clock()),
        policy: "joint-lp",
        jointLp: { duals: { rate: 0, cost: 0 } },
      }),
    ).toThrow(/requires a `cost` axis/);
  });
  it("requires exactly one of jointLp.duals or jointLp.workload", () => {
    expect(() => unifiedAdmission({ cost: costAxis(10, clock()), policy: "joint-lp" })).toThrow(
      /exactly one/,
    );
    expect(() =>
      unifiedAdmission({
        cost: costAxis(10, clock()),
        policy: "joint-lp",
        jointLp: {
          duals: { rate: 0, cost: 0 },
          workload: { types: [{ cost: 1, value: 1, weight: 1 }], rateBudget: 1, costBudget: 1 },
        },
      }),
    ).toThrow(/exactly one/);
  });
  it("rejects jointLp without policy:'joint-lp'", () => {
    expect(() =>
      unifiedAdmission({ cost: costAxis(10, clock()), jointLp: { duals: { rate: 0, cost: 0 } } }),
    ).toThrow(/requires policy/);
  });
  it("rejects an unknown policy value", () => {
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: probing runtime validation
      unifiedAdmission({ cost: costAxis(10, clock()), policy: "bogus" as any }),
    ).toThrow(RangeError);
  });
  it("solves a workload model at construction and uses its duals", () => {
    // small denser than large; cost budget admits small, rejects large via the filter.
    const a = unifiedAdmission({
      cost: costAxis(1e9, clock()),
      policy: "joint-lp",
      jointLp: {
        workload: {
          types: [
            { cost: 100, value: 1, weight: 0.5 },
            { cost: 10_000, value: 50, weight: 0.5 },
          ],
          rateBudget: 1,
          costBudget: 50,
        },
      },
    });
    expect(a.admitSync({ cost: 100, value: 1 }).decision.allowed).toBe(true); // small clears (1 ≥ 0.01·100)
    expect(a.admitSync({ cost: 10_000, value: 50 }).policyDenied).toBe(true); // large filtered (50 < 0.01·10000)
  });
});
