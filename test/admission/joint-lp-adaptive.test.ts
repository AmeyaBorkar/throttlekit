import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { solveFluidLp } from "../../src/admission/fluid-lp";
import { unifiedAdmission } from "../../src/admission/unified";
import { tokenBucket } from "../../src/algorithms/token-bucket";
import { ManualClock } from "../../src/core/clock";
import { rateLimit } from "../../src/core/limiter";

/**
 * TK-1401 — online (sample-then-price) dual refinement, D-JLP-8 (Devanur–Hayes).
 *
 * The GATE (research/.../joint-lp-admission/adaptive-gate.ts) established the
 * self-validating **"guarded"** design: price the warm-up with the construction
 * prior, then at the window boundary adopt the LEARNED duals only if they STRICTLY
 * beat the prior on the observed sample, else keep the prior. This suite commits the
 * gate's conclusions as regression-guards on the SHIPPED warm-up machine — every
 * regret number below comes from driving the real `unifiedAdmission` end-to-end.
 *
 * Faithful harness: same Markov workload + budgets as the static regret gate
 * (test/admission/joint-lp-regret.test.ts). The cost axis is the only binding
 * budget here (R = N ⇒ rate is slack ⇒ p_R = 0; see the canonical duals {rate:0,…}),
 * so a single cost limiter (tokenBucket on a frozen clock = a fixed budget consumed
 * in arrival order) reproduces the fluid harness's admit set EXACTLY — and ties the
 * measured regret to the real warm-up state machine, not an inlined copy of it.
 */

// ── Deterministic harness (verbatim semantics of the static regret gate) ──

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

const R = 1000;
const C = 50_000;
const N = 1000;
const SEEDS = 20;
const W = 200; // sampleWindow — matches the gate

/** Markov-correlated {small, large} arrivals, lag-1 autocorrelation ρ. `largeValue`
 *  is the TRUE value of a large request in this world. */
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

/** The per-arrival-normalized workload model for a believed/true large value. */
function workloadFor(largeValue: number) {
  return {
    types: [
      { cost: 100, value: 1, weight: 0.5 },
      { cost: 10_000, value: largeValue, weight: 0.5 },
    ],
    rateBudget: R / N,
    costBudget: C / N,
  };
}

type Kind = "marginal" | "static-prior" | "static-oracle" | "adaptive";

/** Build a fresh admitter of the given kind. Cost-only (rate is slack); a frozen-clock
 *  tokenBucket of capacity C is a fixed cost budget consumed in arrival order. */
function makeAdmitter(
  kind: Kind,
  believedLargeValue: number,
  oracleDuals: { rate: number; cost: number },
) {
  const cost = rateLimit({
    strategy: tokenBucket({ capacity: C, refillPerSec: 1 }),
    clock: new ManualClock(0),
  });
  switch (kind) {
    case "marginal":
      return unifiedAdmission({ cost });
    case "static-prior":
      return unifiedAdmission({
        cost,
        policy: "joint-lp",
        jointLp: { workload: workloadFor(believedLargeValue) },
      });
    case "static-oracle":
      return unifiedAdmission({ cost, policy: "joint-lp", jointLp: { duals: oracleDuals } });
    case "adaptive":
      return unifiedAdmission({
        cost,
        policy: "joint-lp",
        jointLp: { workload: workloadFor(believedLargeValue), adaptive: { sampleWindow: W } },
      });
  }
}

function revenue(arrivals: Arrival[], make: () => ReturnType<typeof unifiedAdmission>): number {
  const a = make();
  let rev = 0;
  for (const arr of arrivals) {
    if (a.admitSync({ cost: arr.cost, value: arr.value }).decision.allowed) rev += arr.value;
  }
  return rev;
}

/** Mean regret of each policy at one ρ, in a world with `trueLargeValue`, prior believing
 *  `believedLargeValue`. Regret = 1 − rev/clairvoyant; deterministic over fixed seeds. */
function meanRegrets(
  rho: number,
  trueLargeValue: number,
  believedLargeValue: number,
): { marginal: number; staticPrior: number; staticOracle: number; adaptive: number } {
  const trueSol = solveFluidLp(workloadFor(trueLargeValue));
  const Vclair = trueSol.objective * N;
  const oracleDuals = trueSol.duals;
  let mm = 0;
  let sp = 0;
  let so = 0;
  let ad = 0;
  for (let seed = 0; seed < SEEDS; seed++) {
    const rng = makeRng(0xdeadbeef ^ Math.round(rho * 1000) ^ (seed * 2654435761));
    const arrivals = generateWorkload(rho, N, rng, trueLargeValue);
    mm +=
      1 -
      revenue(arrivals, () => makeAdmitter("marginal", believedLargeValue, oracleDuals)) / Vclair;
    sp +=
      1 -
      revenue(arrivals, () => makeAdmitter("static-prior", believedLargeValue, oracleDuals)) /
        Vclair;
    so +=
      1 -
      revenue(arrivals, () => makeAdmitter("static-oracle", believedLargeValue, oracleDuals)) /
        Vclair;
    ad +=
      1 -
      revenue(arrivals, () => makeAdmitter("adaptive", believedLargeValue, oracleDuals)) / Vclair;
  }
  return {
    marginal: mm / SEEDS,
    staticPrior: sp / SEEDS,
    staticOracle: so / SEEDS,
    adaptive: ad / SEEDS,
  };
}

describe("online dual refinement — the TK-1401 gate, as a committed regression test (D-JLP-8)", () => {
  it("WORLD A (correct prior): the guard validates-and-keeps it (no adoption) — adaptive ≈ static(oracle)", () => {
    // prior == true (large worth 50). A correct prior is already optimal and CANNOT be strictly
    // beaten on the observed sample, so the guard adopts nothing and keeps it ⇒ adaptive ==
    // static-prior == oracle here. NB: this is on-sample non-inferiority, NOT a full-horizon
    // "never hurts" theorem — see the autocorrelation caveat cell below for where it can.
    for (const rho of [-0.5, 0, 0.5]) {
      const { adaptive, staticOracle, staticPrior } = meanRegrets(rho, 50, 50);
      expect(adaptive).toBeLessThan(0.03); // essentially optimal
      expect(Math.abs(adaptive - staticOracle)).toBeLessThan(0.01); // matches the oracle
      expect(adaptive).toBeLessThanOrEqual(staticPrior + 0.005); // equal to the prior here (no adoption)
    }
  });

  it("WORLD C (catastrophically wrong prior): adaptive RESCUES a prior that admits nothing", () => {
    // prior believes large worth 200 ⇒ p_C = 0.02 ⇒ the bid for a (truly-worth-50) large
    // is 200 > 50 (reject) AND for a small is 2 > 1 (reject) ⇒ static-prior admits NOTHING
    // (≈100% regret). The online re-solve sees the true values and escapes the trap.
    for (const rho of [-0.5, 0, 0.5]) {
      const { adaptive, staticPrior, marginal } = meanRegrets(rho, 50, 200);
      expect(staticPrior).toBeGreaterThan(0.95); // the catastrophe: admits ~nothing
      expect(adaptive).toBeLessThan(0.4); // rescued to a healthy regret
      expect(staticPrior - adaptive).toBeGreaterThan(0.55); // a large, decisive rescue
      expect(adaptive).toBeLessThan(marginal); // and it even beats plain marginal-AND here
    }
  });

  it("WORLD B (mild misspecification): adaptive does no harm vs the prior", () => {
    // prior under-values large (believes 50, truly 200). Under the marginal-AND feasibility
    // the prior already admits large, so the gap to the oracle is small and the guard mostly
    // keeps the prior — the point is it must not HURT.
    const { adaptive, staticPrior } = meanRegrets(0, 200, 50);
    expect(adaptive).toBeLessThanOrEqual(staticPrior + 0.02);
  });

  it("the ρ = +1 absorbing foil: adaptive falls back to marginal and BEATS the static prior", () => {
    // On the absorbing chain (one type forever) fluid-LP pricing is wrong (Talluri–van Ryzin).
    // The on-sample guard refuses to adopt the bad learned duals, and the prior-priced warm-up
    // already behaves like marginal — so adaptive tracks marginal and avoids static's collapse.
    const a = meanRegrets(1, 50, 50); // correct prior, but the foil still defeats static pricing
    expect(a.adaptive).toBeLessThanOrEqual(a.marginal + 0.02); // tracks marginal (the best available)
    expect(a.adaptive).toBeLessThan(a.staticPrior); // strictly better than committing to the duals
  });

  it("on-sample ≠ full-horizon: under autocorrelation the guard can adopt a sample-overfit dual that is slightly WORSE full-horizon (honest caveat — the foil's cousin)", () => {
    // The guard guarantees non-inferiority ON THE OBSERVED SAMPLE, not over the full horizon.
    // Under positive autocorrelation (ρ=0.5) the W-arrival window is NOT a representative draw,
    // so a dual that strictly beats the prior on-sample can lose on the full stream. We
    // REGRESSION-GUARD this (exactly like the ρ=+1 foil, D-JLP-9) so the limitation is pinned and
    // never silently "fixed" by a future change. Here the prior under-prices large (believes 2)
    // while it is truly worth 80 — both still reject large under the cost budget, so the prior is
    // near-optimal (≈1.16%) and the overfit adoption costs ≈0.8pp.
    const { adaptive, staticPrior, marginal } = meanRegrets(0.5, 80, 2);
    expect(adaptive).toBeGreaterThan(staticPrior); // full-horizon non-inferiority does NOT hold
    expect(adaptive - staticPrior).toBeLessThan(0.03); // but the harm is bounded and small
    expect(adaptive).toBeLessThan(marginal); // and adaptive still far beats plain marginal-AND
  });
});

// ── Warm-up state-machine invariants ──

function genCost(cap: number) {
  return rateLimit({
    strategy: tokenBucket({ capacity: cap, refillPerSec: 1 }),
    clock: new ManualClock(0),
  });
}
/** A 2-type workload model with a tunable large value (the prior). */
function model(largeValue: number, rateBudget = 1, costBudget = 50) {
  return {
    types: [
      { cost: 100, value: 1, weight: 0.5 },
      { cost: 10_000, value: largeValue, weight: 0.5 },
    ],
    rateBudget,
    costBudget,
  };
}

describe("online dual refinement — warm-up state machine", () => {
  it("until the window fills, adaptive is decision-for-decision identical to static(prior)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 5, max: 60 }), // sampleWindow
        fc.array(
          fc.record({
            cost: fc.double({ min: 1, max: 12_000, noNaN: true }),
            value: fc.double({ min: 0, max: 300, noNaN: true }),
          }),
          { minLength: 1, maxLength: 50 },
        ),
        (window, stream) => {
          const prior = model(200); // an arbitrary (here wrong) prior
          const adaptive = unifiedAdmission({
            cost: genCost(1e9),
            policy: "joint-lp",
            jointLp: { workload: prior, adaptive: { sampleWindow: window } },
          });
          const staticPrior = unifiedAdmission({
            cost: genCost(1e9),
            policy: "joint-lp",
            jointLp: { workload: prior },
          });
          // Compare only the first (window − 1) requests: both price with the prior there.
          // The window-th request triggers the freeze and may re-price, so it is excluded.
          const compareN = Math.min(stream.length, window - 1);
          for (let i = 0; i < compareN; i++) {
            const s = stream[i]!;
            const a = adaptive.admitSync({ cost: s.cost, value: s.value });
            const b = staticPrior.admitSync({ cost: s.cost, value: s.value });
            expect(a.decision.allowed).toBe(b.decision.allowed);
            expect(Boolean(a.policyDenied)).toBe(Boolean(b.policyDenied));
          }
        },
      ),
      { numRuns: 200, seed: 20260530 },
    );
  });

  it("a CORRECT prior is kept: post-window behavior matches static(prior) (the guard rejects noisy learned duals)", () => {
    // Feed the true mixture (large worth 50) to an admitter whose prior is ALSO 50. The
    // learned duals can only ≈ the prior, never strictly beat it on-sample ⇒ keep the prior ⇒
    // post-window decisions equal a static-prior admitter's on the same continuation.
    const prior50 = model(50);
    const rng = makeRng(12345);
    const warm = generateForModel(rng, W, 50);
    const probe = generateForModel(rng, 50, 50);

    const adaptive = unifiedAdmission({
      cost: genCost(1e12),
      policy: "joint-lp",
      jointLp: { workload: prior50, adaptive: { sampleWindow: W } },
    });
    const staticPrior = unifiedAdmission({
      cost: genCost(1e12),
      policy: "joint-lp",
      jointLp: { workload: prior50 },
    });
    for (const a of warm) {
      adaptive.admitSync({ cost: a.cost, value: a.value });
      staticPrior.admitSync({ cost: a.cost, value: a.value });
    }
    for (const a of probe) {
      const x = adaptive.admitSync({ cost: a.cost, value: a.value });
      const y = staticPrior.admitSync({ cost: a.cost, value: a.value });
      expect(x.decision.allowed).toBe(y.decision.allowed); // kept the prior
    }
  });

  it("a CATASTROPHIC prior is escaped: post-window behavior diverges from static(prior)", () => {
    // prior believes large worth 200 (rejects everything truly worth ≤200); the true stream is
    // small(1)/large(50). The learned duals strictly beat the prior on-sample ⇒ adopt ⇒ the
    // admitter starts admitting where the static prior would still reject everything.
    const prior200 = model(200);
    const rng = makeRng(999);
    const warm = generateForModel(rng, W, 50); // true large value 50
    const probe = generateForModel(rng, 100, 50);

    const adaptive = unifiedAdmission({
      cost: genCost(1e12),
      policy: "joint-lp",
      jointLp: { workload: prior200, adaptive: { sampleWindow: W } },
    });
    const staticPrior = unifiedAdmission({
      cost: genCost(1e12),
      policy: "joint-lp",
      jointLp: { workload: prior200 },
    });
    let adaptiveAdmits = 0;
    let staticAdmits = 0;
    for (const a of warm.concat(probe)) {
      if (adaptive.admitSync({ cost: a.cost, value: a.value }).decision.allowed) adaptiveAdmits++;
      if (staticPrior.admitSync({ cost: a.cost, value: a.value }).decision.allowed) staticAdmits++;
    }
    expect(staticAdmits).toBe(0); // the catastrophic prior admits nothing, ever
    expect(adaptiveAdmits).toBeGreaterThan(0); // the adaptive admitter escaped and admits
  });

  it("freezes after exactly `sampleWindow` policy-evaluated requests (the duals stop changing)", () => {
    // A small deterministic check that adoption is one-shot at the boundary: once frozen, the
    // same (cost,value) probe yields a stable decision regardless of further traffic.
    const adaptive = unifiedAdmission({
      cost: genCost(1e12),
      policy: "joint-lp",
      jointLp: { workload: model(200), adaptive: { sampleWindow: 10 } },
    });
    // 10 small arrivals (value 1, cost 100) ⇒ learned duals price the cost axis off the dense
    // small type, which (vs the prior's reject-everything) is adopted at the boundary.
    for (let i = 0; i < 10; i++) adaptive.admitSync({ cost: 100, value: 1 });
    const after1 = adaptive.admitSync({ cost: 100, value: 1 }).decision.allowed;
    for (let i = 0; i < 100; i++) adaptive.admitSync({ cost: 100, value: 1 }); // more traffic
    const after2 = adaptive.admitSync({ cost: 100, value: 1 }).decision.allowed;
    expect(after2).toBe(after1); // frozen — no further re-pricing
  });

  it("works identically on admit (async)", async () => {
    const adaptive = unifiedAdmission({
      cost: genCost(1e12),
      policy: "joint-lp",
      jointLp: { workload: model(200), adaptive: { sampleWindow: 5 } },
    });
    for (let i = 0; i < 5; i++) await adaptive.admit({ cost: 100, value: 1 });
    // post-freeze the dense small type clears (the prior would have rejected it)
    expect((await adaptive.admit({ cost: 100, value: 1 })).decision.allowed).toBe(true);
  });

  it("is robust to a pathological warm-up sample (out-of-domain value) — keeps the prior, never throws", () => {
    // A negative value reaches the re-solve, which validates value ≥ 0 and throws; the warm-up
    // must swallow it and keep the validated prior (the on-sample guarantee holds for ANY input).
    const adaptive = unifiedAdmission({
      cost: genCost(1e12),
      policy: "joint-lp",
      jointLp: { workload: model(50), adaptive: { sampleWindow: 4 } },
    });
    expect(() => {
      adaptive.admitSync({ cost: 100, value: 1 });
      adaptive.admitSync({ cost: 100, value: -1 }); // out-of-domain — buffered into the model
      adaptive.admitSync({ cost: 100, value: 1 });
      adaptive.admitSync({ cost: 100, value: 1 }); // window boundary → re-solve throws → keep prior
    }).not.toThrow();
    // Post-catch the admitter serves the prior duals {rate:0, cost:0.01} (model(50)): a dense
    // small clears, a sparse large is filtered — proving it really did keep the validated prior.
    expect(adaptive.admitSync({ cost: 100, value: 1 }).decision.allowed).toBe(true); // 1 ≥ 0.01·100
    expect(adaptive.admitSync({ cost: 10_000, value: 1 }).policyDenied).toBe(true); // 1 < 0.01·10000
  });

  it("survives more distinct (cost,value) classes than the type cap, then freezes to a stable decision", () => {
    // > MAX_OBSERVED_TYPES (64) distinct pairs in the window: the model truncates later NEW pairs,
    // but the guard (replayed on the TRUE buffer) keeps it safe and the window still freezes at W.
    const adaptive = unifiedAdmission({
      cost: genCost(1e12),
      policy: "joint-lp",
      jointLp: { workload: model(50), adaptive: { sampleWindow: 200 } },
    });
    for (let i = 0; i < 250; i++) adaptive.admitSync({ cost: 1 + (i % 200), value: 1 + (i % 150) });
    const before = adaptive.admitSync({ cost: 100, value: 5 }).decision.allowed;
    for (let i = 0; i < 100; i++) adaptive.admitSync({ cost: 7, value: 3 }); // more traffic, post-freeze
    const after = adaptive.admitSync({ cost: 100, value: 5 }).decision.allowed;
    expect(after).toBe(before); // frozen → a stable, deterministic decision (no late re-pricing)
  });

  it("budget normalization is invariant: counts+totals workload ≡ probabilities+per-arrival workload", () => {
    // The SAME workload expressed two ways must drive identical adaptive behavior. solveFluidLp is
    // scale-invariant for the duals, and the per-arrival replay budget is derived as budget ÷ Σweight,
    // so both representations normalize to the same per-arrival budget (rate 1, cost 50).
    const probs = {
      types: [
        { cost: 100, value: 1, weight: 0.5 },
        { cost: 10_000, value: 50, weight: 0.5 },
      ],
      rateBudget: 1,
      costBudget: 50,
    };
    const counts = {
      types: [
        { cost: 100, value: 1, weight: 500 },
        { cost: 10_000, value: 50, weight: 500 },
      ],
      rateBudget: 1000,
      costBudget: 50_000,
    };
    const a = unifiedAdmission({
      cost: genCost(1e12),
      policy: "joint-lp",
      jointLp: { workload: probs, adaptive: { sampleWindow: 50 } },
    });
    const b = unifiedAdmission({
      cost: genCost(1e12),
      policy: "joint-lp",
      jointLp: { workload: counts, adaptive: { sampleWindow: 50 } },
    });
    const stream = generateForModel(makeRng(4242), 120, 50); // through warm-up + freeze + after
    for (const s of stream) {
      const x = a.admitSync({ cost: s.cost, value: s.value });
      const y = b.admitSync({ cost: s.cost, value: s.value });
      expect(x.decision.allowed).toBe(y.decision.allowed);
      expect(Boolean(x.policyDenied)).toBe(Boolean(y.policyDenied));
    }
  });
});

describe("online dual refinement — construction validation", () => {
  const cost = () => genCost(1000);
  it("rejects adaptive with the bare `duals` form (no per-arrival budgets to re-solve)", () => {
    expect(() =>
      unifiedAdmission({
        cost: cost(),
        policy: "joint-lp",
        // duals + adaptive is the unsupported combination we assert on (a runtime, not a type, error)
        jointLp: { duals: { rate: 0, cost: 0.01 }, adaptive: { sampleWindow: 100 } },
      }),
    ).toThrow(/requires the jointLp\.workload form/);
  });

  it("rejects a non-positive or non-integer sampleWindow", () => {
    for (const bad of [0, -5, 2.5, Number.NaN]) {
      expect(() =>
        unifiedAdmission({
          cost: cost(),
          policy: "joint-lp",
          jointLp: { workload: model(50), adaptive: { sampleWindow: bad } },
        }),
      ).toThrow(/sampleWindow must be a positive integer/);
    }
  });

  it("constructs with the workload form + a valid window", () => {
    expect(() =>
      unifiedAdmission({
        cost: cost(),
        policy: "joint-lp",
        jointLp: { workload: model(50), adaptive: { sampleWindow: 100 } },
      }),
    ).not.toThrow();
  });
});

/** Deterministic 2-type stream (small 100/1, large 10000/largeValue), 50/50, no correlation. */
function generateForModel(rng: () => number, n: number, largeValue: number): Arrival[] {
  const out: Arrival[] = [];
  for (let i = 0; i < n; i++) {
    out.push(rng() < 0.5 ? { cost: 100, value: 1 } : { cost: 10_000, value: largeValue });
  }
  return out;
}
