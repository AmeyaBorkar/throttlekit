import { describe, expect, it } from "vitest";
import { type BudgetScheme, heavyTailLengths, simulate } from "./token-budget";

/**
 * Cost-uncertainty kernel (TALE Layer 1). Design + proofs: research/cost-uncertainty/PROPOSAL.md.
 * Token-budget admission under post-hoc costs: the streaming meter bounds overshoot independent of
 * max_tokens, where the two production corners each fail an axis that worsens as max_tokens grows.
 * Numbers below are reproducible (seeded) and recorded in the proposal's evaluation section.
 */

const L = 1000;
const C = 4;
const MS = [256, 512, 1024, 2048] as const;
const sim = (
  queue: readonly number[],
  m: number,
  chunk: number,
  scheme: BudgetScheme,
  rounds = 500,
) => simulate(queue, { budget: L, slots: C, maxTokens: m, chunk, rounds, scheme });

describe("streaming meter — overshoot independent of max_tokens (the headline)", () => {
  it("g=1: zero overshoot and full utilization for every max_tokens", () => {
    for (const m of MS) {
      const r = sim(heavyTailLengths(400, 120, m, 7), m, 1, "streaming");
      expect(r.overshoot).toBe(0); // per-token meter stops exactly at the budget
      expect(r.utilization).toBe(1); // fills the whole budget — nothing sterilised
    }
  });

  it("chunked (g=8): overshoot stays <= g-1, independent of max_tokens", () => {
    for (const m of MS) {
      const r = sim(heavyTailLengths(400, 120, m, 7), m, 8, "streaming");
      expect(r.overshoot).toBeLessThanOrEqual(7); // <= g-1, regardless of m
      expect(r.utilization).toBe(1);
    }
  });

  it("even when every request runs to the cap, overshoot is bounded and m-independent", () => {
    for (const m of MS) {
      const capHitting = new Array(400).fill(m);
      const r = sim(capHitting, m, 1, "streaming", m + 200);
      expect(r.overshoot).toBe(0); // vs admit-then-count's C*(m-1) on the same trace
    }
  });
});

describe("reserve-max — safe, but utilization collapses as max_tokens grows", () => {
  it("never overshoots, yet a big reservation starves concurrency", () => {
    const utils = MS.map((m) => sim(heavyTailLengths(400, 120, m, 7), m, 1, "reserveMax"));
    for (const r of utils) expect(r.overshoot).toBe(0); // reservation guarantees no overshoot
    // Exact seeded utilisation: 0.769 -> 0.500 -> 0.000 -> 0.000 as m goes 256 -> 2048.
    expect(utils[0]?.utilization).toBeCloseTo(0.769, 3);
    expect(utils[1]?.utilization).toBeCloseTo(0.5, 3);
    expect(utils[2]?.utilization).toBe(0); // m >= L: cannot admit a single request
    expect(utils[3]?.utilization).toBe(0);
    // Strictly degrades with max_tokens.
    expect(utils[1]?.utilization).toBeLessThan(utils[0]?.utilization as number);
  });
});

describe("admit-then-count — full utilization, but overshoot grows (unbounded) with max_tokens", () => {
  it("worst-case overshoot scales with the cap, within the C*(m-1) envelope", () => {
    const deltas = MS.map((m) => {
      const capHitting = new Array(400).fill(m);
      return sim(capHitting, m, 1, "admitThenCount", m + 200).overshoot;
    });
    // Measured: 24, 1048, 3096, 7192 — strictly increasing in m, all within C*(m-1).
    expect(deltas).toEqual([24, 1048, 3096, 7192]);
    for (let i = 0; i < MS.length; i++) {
      expect(deltas[i]).toBeGreaterThan(0);
      expect(deltas[i]).toBeLessThanOrEqual(C * ((MS[i] as number) - 1));
    }
    expect(deltas[3]).toBeGreaterThan(deltas[0] as number); // grows with the cap
  });
});

describe("streaming dominates both corners on every max_tokens", () => {
  it("matches admit-then-count's utilisation at reserve-max-or-better safety", () => {
    for (const m of MS) {
      const q = heavyTailLengths(400, 120, m, 7);
      const stream = sim(q, m, 1, "streaming");
      const reserve = sim(q, m, 1, "reserveMax");
      // As work-conserving as admit-then-count (util 1) AND as safe as reserve-max (Δ 0),
      // while reserve-max's utilisation is <= streaming's (often far worse) at the same m.
      expect(stream.utilization).toBe(1);
      expect(stream.overshoot).toBe(0);
      expect(reserve.utilization).toBeLessThanOrEqual(stream.utilization);
    }
  });
});
