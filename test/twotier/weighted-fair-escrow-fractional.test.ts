import { describe, expect, it } from "vitest";
import { ManualClock } from "../../src/core/clock";
import type { Decision } from "../../src/core/types";
import { weightedFairEscrow } from "../../src/twotier/weighted-fair-escrow";

/**
 * Fractional integer-gate conformance for `weightedFairEscrow` (#5b).
 *
 * `aggregate()` has an O(1) running-counter fast path (`Σ weight` / `Σ used`) gated on INTEGER weights
 * AND costs. For ANY fractional weight or cost it falls back to the O(T) rescan, because a running
 * counter sums in MUTATION order, where a single 1-ULP float re-association can flip a floor or a
 * comparison vs a fresh rescan — and the existing integer-only WFE property tests would not catch it.
 *
 * This suite drives FRACTIONAL weights AND costs and asserts the shipped limiter's decisions are
 * byte-identical to an independent rescan oracle (`reference("rescan", …)`), covering safety (Σ ≤ L),
 * the 3:1 weighted split, and a work-conservation CONTRAST case.
 *
 * GATE GUARD — why this fails if the integer gate is removed: the `reference` below is a faithful
 * line-by-line copy of the shipped L1 algorithm, parameterised by how it aggregates. In `"rescan"`
 * mode it always rescans (the oracle, independent of the gate). In `"counter"` mode it reads the same
 * mutation-order running counters the shipped limiter keeps — i.e. it models the limiter WITH THE GATE
 * REMOVED. The final test proves the two modes DIVERGE in real decisions on the timeline below, so if
 * the gate is dropped the shipped limiter starts behaving like `"counter"` and the conformance tests
 * above (which compare against `"rescan"`) start failing.
 */

const T0 = 1_700_000_000_000;
const WINDOW = 60_000;

/**
 * A faithful reimplementation of the shipped L1 `weightedFairEscrow.decide` algorithm, parameterised by
 * aggregation mode. `"rescan"` = the always-O(T) oracle; `"counter"` = read the mutation-order running
 * counters (what the shipped limiter does if the integer gate is removed). The arithmetic is otherwise
 * identical to `src/twotier/weighted-fair-escrow.ts`.
 */
function reference(
  mode: "rescan" | "counter",
  opts: { limit: number; windowMs: number; weightOf: (t: string) => number; clock: ManualClock },
) {
  const lEffective = Math.floor(opts.limit);
  const windowMs = opts.windowMs;
  const weightOf = opts.weightOf;
  let windowStart = Number.NEGATIVE_INFINITY;
  const tenants = new Map<string, { weight: number; used: number }>();
  // Running counters maintained in lockstep (admit order for used, bootstrap/update order for weight),
  // mirroring the shipped limiter — read only in "counter" mode.
  let aggWeight = 0;
  let aggUsed = 0;

  const rollWindow = (now: number): void => {
    if (now >= windowStart + windowMs) {
      windowStart = Math.floor(now / windowMs) * windowMs;
      tenants.clear();
      aggWeight = 0;
      aggUsed = 0;
    }
  };
  const gShare = (weight: number, totalWeight: number): number =>
    Math.floor((weight * lEffective) / totalWeight);
  const aggregate = (): { totalWeight: number; totalUsed: number } => {
    if (mode === "counter") return { totalWeight: aggWeight, totalUsed: aggUsed };
    let totalWeight = 0;
    let totalUsed = 0;
    for (const t of tenants.values()) {
      totalWeight += t.weight;
      totalUsed += t.used;
    }
    return { totalWeight, totalUsed };
  };
  const decide = (entry: { weight: number; used: number }, cost: number, now: number): Decision => {
    const resetAt = Math.ceil(windowStart + windowMs);
    const { totalWeight, totalUsed } = aggregate();
    const gAsker = gShare(entry.weight, totalWeight);
    const lRemaining = lEffective - totalUsed;
    if (cost > lRemaining) {
      return {
        allowed: false,
        limit: Math.max(gAsker, entry.used),
        remaining: Math.max(0, gAsker - entry.used),
        resetAt,
        retryAfterMs: Math.max(0, Math.ceil(resetAt - now)),
      };
    }
    if (entry.used + cost <= gAsker) {
      entry.used += cost;
      aggUsed += cost;
      return {
        allowed: true,
        limit: gAsker,
        remaining: Math.max(0, gAsker - entry.used),
        resetAt,
        retryAfterMs: 0,
      };
    }
    let reserve = 0;
    for (const t of tenants.values()) {
      if (t === entry) continue;
      reserve += Math.max(0, gShare(t.weight, totalWeight) - t.used);
    }
    const borrowAvailable = Math.max(0, lRemaining - reserve);
    const wanted = entry.used + cost - gAsker;
    const grantable = Math.min(wanted, cost, borrowAvailable, lRemaining);
    const realizedCeiling = gAsker + grantable;
    if (entry.used + cost <= realizedCeiling) {
      entry.used += cost;
      aggUsed += cost;
      return {
        allowed: true,
        limit: realizedCeiling,
        remaining: Math.max(0, realizedCeiling - entry.used),
        resetAt,
        retryAfterMs: 0,
      };
    }
    return {
      allowed: false,
      limit: realizedCeiling,
      remaining: Math.max(0, realizedCeiling - entry.used),
      resetAt,
      retryAfterMs: Math.max(0, Math.ceil(resetAt - now)),
    };
  };
  return {
    checkSync(tenant: string, cost: number): Decision {
      const w = weightOf(tenant);
      const now = opts.clock.now();
      rollWindow(now);
      let entry = tenants.get(tenant);
      if (entry === undefined) {
        entry = { weight: w, used: 0 };
        tenants.set(tenant, entry);
        aggWeight += w;
      } else {
        aggWeight += w - entry.weight;
        entry.weight = w;
      }
      return decide(entry, cost, now);
    },
    totalUsed(): number {
      let s = 0;
      for (const t of tenants.values()) s += t.used;
      return s;
    },
  };
}

/** Deterministic LCG (Numerical Recipes) — reproducible adversarial sequences, no fast-check needed. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

const NASTY_COSTS = [0.1, 0.2, 0.3, 0.7, 0.9, 1.1, 0.01, 0.33, 2.7];
const NASTY_WEIGHTS = [0.7, 1.3, 2.1, 0.9, 1.7, 3.3];
const TENANTS = ["A", "B", "C", "D", "E"];

/** The fixed adversarial timeline used by the conformance tests AND the gate-guard, so they agree. */
function adversarialTimeline(seed: number): {
  L: number;
  weightOf: (t: string) => number;
  calls: Array<[string, number]>;
} {
  const rnd = lcg(seed);
  const L = 5 + Math.floor(rnd() * 40);
  const wmap = new Map<string, number>();
  for (const t of TENANTS)
    wmap.set(t, NASTY_WEIGHTS[Math.floor(rnd() * NASTY_WEIGHTS.length)] as number);
  const weightOf = (t: string): number => wmap.get(t) ?? 1;
  const nCalls = 150 + Math.floor(rnd() * 120);
  const calls: Array<[string, number]> = [];
  for (let i = 0; i < nCalls; i++) {
    const t = TENANTS[Math.floor(rnd() * TENANTS.length)] as string;
    const cost = NASTY_COSTS[Math.floor(rnd() * NASTY_COSTS.length)] as number;
    calls.push([t, cost]);
  }
  return { L, weightOf, calls };
}

const SEEDS = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89];

describe("weightedFairEscrow — fractional integer-gate conformance (#5b)", () => {
  it("Σ ≤ L: byte-identical to the rescan oracle across adversarial fractional timelines", () => {
    for (const seed of SEEDS) {
      const { L, weightOf, calls } = adversarialTimeline(seed);
      const real = weightedFairEscrow({
        limit: L,
        windowMs: WINDOW,
        weightOf,
        clock: new ManualClock(T0),
      });
      const oracle = reference("rescan", {
        limit: L,
        windowMs: WINDOW,
        weightOf,
        clock: new ManualClock(T0),
      });
      for (let i = 0; i < calls.length; i++) {
        const [t, cost] = calls[i] as [string, number];
        const got = real.checkSync(t, cost);
        const want = oracle.checkSync(t, cost);
        expect(got, `seed=${seed} call#${i} t=${t} cost=${cost}`).toEqual(want);
        // T1 safety holds for fractional input too — the true (rescan) total never exceeds L.
        expect(real.stats().totalUsed).toBeLessThanOrEqual(L);
      }
    }
  });

  it("3:1 fractional-weight split: every decision matches the rescan oracle byte-for-byte", () => {
    // weights 1.5 : 0.5 = 3:1, both fractional; fractional costs. Two continuously-backlogged tenants.
    const weightOf = (t: string): number => (t === "high" ? 1.5 : 0.5);
    const real = weightedFairEscrow({
      limit: 20,
      windowMs: WINDOW,
      weightOf,
      clock: new ManualClock(T0),
    });
    const oracle = reference("rescan", {
      limit: 20,
      windowMs: WINDOW,
      weightOf,
      clock: new ManualClock(T0),
    });
    const calls: Array<[string, number]> = [
      ["high", 0.5],
      ["low", 0.5],
    ];
    for (let i = 0; i < 100; i++) {
      calls.push([i % 2 === 0 ? "high" : "low", [0.1, 0.3, 0.7, 1.1][i % 4] as number]);
    }
    for (let i = 0; i < calls.length; i++) {
      const [t, c] = calls[i] as [string, number];
      expect(real.checkSync(t, c), `3:1 call#${i}`).toEqual(oracle.checkSync(t, c));
    }
    expect(real.stats().totalUsed).toBeLessThanOrEqual(20);
  });

  it("CONTRAST — a paused high-weight tenant keeps its reserve while a backlogged one borrows, matching the oracle", () => {
    // 'high' (w=3.3) takes a small fractional burst then goes quiet (paused, not absent), so its
    // guaranteed share stays reserved; 'low' (w=0.7) is continuously backlogged. The two-tenant active
    // set means the aggregate sums more than one used — divergence-capable, the streaming-vs-batch
    // reserve contrast under fractional cost.
    const weightOf = (t: string): number => (t === "high" ? 3.3 : 0.7);
    const real = weightedFairEscrow({
      limit: 15,
      windowMs: WINDOW,
      weightOf,
      clock: new ManualClock(T0),
    });
    const oracle = reference("rescan", {
      limit: 15,
      windowMs: WINDOW,
      weightOf,
      clock: new ManualClock(T0),
    });
    for (let i = 0; i < 80; i++) {
      if (i < 4) {
        const hc = [0.3, 0.7, 0.9, 0.1][i] as number; // high's brief burst, then it pauses
        expect(real.checkSync("high", hc), `contrast high call#${i}`).toEqual(
          oracle.checkSync("high", hc),
        );
      }
      const c = [0.2, 0.9, 1.3, 0.33][i % 4] as number;
      expect(real.checkSync("low", c), `contrast low call#${i}`).toEqual(
        oracle.checkSync("low", c),
      );
    }
    expect(real.stats().totalUsed).toBeLessThanOrEqual(15);
  });

  it("GATE GUARD — the integer gate is load-bearing: a mutation-order counter diverges from the rescan oracle", () => {
    // Prove the conformance above is non-vacuous: on the SAME timelines, an aggregate that reads the
    // mutation-order running counters (= the shipped limiter WITH THE GATE REMOVED) produces a DIFFERENT
    // decision than the rescan oracle for at least one call. So removing the gate WOULD break the tests
    // above. (The shipped limiter, gated, rescans on fractional input and therefore matches the oracle.)
    let totalDivergences = 0;
    for (const seed of SEEDS) {
      const { L, weightOf, calls } = adversarialTimeline(seed);
      const rescan = reference("rescan", {
        limit: L,
        windowMs: WINDOW,
        weightOf,
        clock: new ManualClock(T0),
      });
      const counter = reference("counter", {
        limit: L,
        windowMs: WINDOW,
        weightOf,
        clock: new ManualClock(T0),
      });
      for (let i = 0; i < calls.length; i++) {
        const [t, cost] = calls[i] as [string, number];
        const a = rescan.checkSync(t, cost);
        const b = counter.checkSync(t, cost);
        if (a.allowed !== b.allowed || a.limit !== b.limit || a.remaining !== b.remaining) {
          totalDivergences++;
        }
      }
    }
    // The counter and rescan aggregates disagree on many decisions across these fractional timelines —
    // exactly the float re-association the integer gate guards against.
    expect(totalDivergences).toBeGreaterThan(0);
  });
});
