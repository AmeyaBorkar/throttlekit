import { describe, expect, it } from "vitest";
import {
  type ReservationPolicy,
  bestFixedReservationCost,
  createOnlineReservation,
  criticalFractile,
  greedyReservationPolicy,
  learnedReservationPolicy,
  maxReservationPolicy,
  oracleReservationPolicy,
  quantile,
  reservationCost,
  simulateAdmission,
  simulateReservation,
} from "./learned-reservation";
import { heavyTailLengths } from "./token-budget";

/**
 * Cost-uncertainty kernel (TALE Layer 2) — online learned reservation. The cost-axis sibling of GALE
 * Pillar 2 (test/gale/lease-sizer.test.ts). Design + proofs: research/cost-uncertainty/PROPOSAL.md.
 * All traces are seeded (deterministic); every threshold is reproducible and was calibrated with
 * research/cost-uncertainty/explore-reservation.ts.
 *
 * Fixed cost model throughout: holdCost h = 1, overrunCost p = 4 (so the critical fractile τ = 0.8 —
 * an abort is 4× as costly as a token of idle reservation, so reserve the 80th percentile).
 */
const H = 1;
const P = 4;
const TAU = criticalFractile(H, P);
const M = 512;
const CAND = Array.from({ length: M + 1 }, (_u, i) => i); // fixed reservations 0..512 for hindsight

describe("TALE Layer 2 — cost model (newsvendor / pinball)", () => {
  it("criticalFractile is p/(h+p)", () => {
    expect(TAU).toBe(0.8);
    expect(criticalFractile(1, 1)).toBe(0.5); // symmetric ⇒ the median
    expect(criticalFractile(3, 1)).toBe(0.25);
  });

  it("reservationCost is the asymmetric pinball loss", () => {
    expect(reservationCost(100, 60, H, P)).toBe(40); // over by 40 ⇒ 40·h = 40
    expect(reservationCost(60, 100, H, P)).toBe(160); // under by 40 ⇒ 40·p = 160
    expect(reservationCost(100, 100, H, P)).toBe(0); // exact ⇒ no cost
  });

  it("the best fixed reservation in hindsight IS the empirical critical-fractile quantile", () => {
    const trace = heavyTailLengths(6400, 120, M, 7);
    const best = bestFixedReservationCost(trace, H, P, CAND);
    // The minimiser of Σ pinball over r is exactly the τ-quantile — the newsvendor identity, measured.
    expect(best.reservation).toBe(quantile(trace, TAU));
  });
});

describe("TALE Layer 2 — online regret (data-driven newsvendor)", () => {
  it("static regret is sublinear on a stationary heavy-tail cost stream (avg regret → 0)", () => {
    const avg: number[] = [];
    for (const t of [100, 400, 1600, 6400]) {
      const trace = heavyTailLengths(t, 120, M, 7);
      const { cost } = simulateReservation(
        trace,
        createOnlineReservation({ holdCost: H, overrunCost: P, maxReservation: M }),
        H,
        P,
      );
      const best = bestFixedReservationCost(trace, H, P, CAND);
      const regret = cost - best.cost;
      // Best-fixed is genuinely strong on a stationary stream, so the online learner pays positive regret.
      expect(regret).toBeGreaterThan(0);
      avg.push(regret / t);
    }
    // No-regret signature: average regret per request strictly decreases and approaches 0.
    for (let i = 0; i + 1 < avg.length; i++) {
      expect(avg[i + 1]).toBeLessThan(avg[i] as number);
    }
    expect(avg[avg.length - 1]).toBeLessThan((avg[0] as number) / 2); // ~2.77 vs ~8.49 measured
  });

  it("converges onto the oracle τ-quantile under a stationary stream", () => {
    const trace = heavyTailLengths(6400, 120, M, 7);
    const learner = createOnlineReservation({ holdCost: H, overrunCost: P, maxReservation: M });
    simulateReservation(trace, learner, H, P);
    const oracleQ = quantile(trace, TAU); // 265
    expect(learner.continuous).toBeGreaterThan(oracleQ * 0.8);
    expect(learner.continuous).toBeLessThan(oracleQ * 1.3); // ~290 measured
  });

  it("adapts: beats ANY fixed reservation under a distribution shift (negative regret)", () => {
    // Output-length regime change (median 80 → 300): no single reservation serves both regimes well.
    const trace = [...heavyTailLengths(2000, 80, M, 21), ...heavyTailLengths(2000, 300, M, 22)];
    const { cost } = simulateReservation(
      trace,
      createOnlineReservation({ holdCost: H, overrunCost: P, maxReservation: M }),
      H,
      P,
    );
    const best = bestFixedReservationCost(trace, H, P, CAND);
    expect(cost).toBeLessThan(best.cost * 0.75); // ~0.69 measured — adapting strictly wins
  });
});

describe("TALE Layer 2 — admission: the false-reject ⇆ abort trade-off (safety unconditional)", () => {
  // Pre-train the learner to steady state (the limiter has been running), then measure admission.
  const warmedLearned = (): ReservationPolicy => {
    const l = createOnlineReservation({ holdCost: H, overrunCost: P, maxReservation: M });
    for (const c of heavyTailLengths(3000, 120, M, 99)) l.observe(c);
    return learnedReservationPolicy(l);
  };
  const opts = { budget: 1000, slots: 16, maxTokens: M, chunk: 1, rounds: 400 } as const;
  const queue = heavyTailLengths(400, 120, M, 7);
  const run = (p: ReservationPolicy) => simulateAdmission(queue, p, opts);

  it("greedy (no reservation = Layer-1 streaming): full utilization but many aborts", () => {
    const r = run(greedyReservationPolicy);
    expect(r.utilization).toBe(1); // work-conserving
    expect(r.aborts).toBeGreaterThanOrEqual(16); // over-admits ⇒ preempts many half-done streams
    expect(r.overshoot).toBe(0); // …yet the meter still bounds overshoot
  });

  it("reserve-max (r = m): no overshoot, but utilization collapses (starved concurrency)", () => {
    const r = run(maxReservationPolicy(M));
    expect(r.utilization).toBeCloseTo(0.4, 5); // one reservation barely fits ⇒ ~1 concurrent stream
    expect(r.overshoot).toBe(0);
  });

  it("learned (τ-quantile): full utilization AND few aborts — dominates both corners, matches oracle", () => {
    const learned = run(warmedLearned());
    const greedy = run(greedyReservationPolicy);
    const reserveMax = run(maxReservationPolicy(M));
    const oracle = run(oracleReservationPolicy);

    expect(learned.utilization).toBe(1); // as work-conserving as greedy…
    expect(learned.aborts).toBeLessThanOrEqual(5); // …but ~4 aborts, not greedy's 16
    expect(learned.aborts).toBeLessThan(greedy.aborts / 3); // strictly dominates greedy on aborts
    expect(learned.utilization).toBeGreaterThan(reserveMax.utilization); // and reserve-max on util
    expect(learned.aborts).toBeLessThanOrEqual(oracle.aborts + 1); // tracks the clairvoyant oracle
    expect(learned.overshoot).toBe(0); // safety holds regardless of the reservation
  });

  it("SAFETY is unconditional: overshoot is meter-bounded for EVERY reservation policy", () => {
    for (const p of [
      greedyReservationPolicy,
      maxReservationPolicy(M),
      oracleReservationPolicy,
      warmedLearned(),
    ]) {
      // chunk=1 ⇒ the streaming meter holds overshoot at exactly 0, no matter the admission reservation.
      expect(run(p).overshoot).toBe(0);
      // admitted is fully accounted: every admitted request either completed or was aborted.
      const r = run(p);
      expect(r.completed + r.aborts).toBe(r.admitted);
    }
  });
});

describe("TALE Layer 2 — input validation", () => {
  it("rejects non-positive cost parameters and bad reservation bounds", () => {
    expect(() =>
      createOnlineReservation({ holdCost: 0, overrunCost: 1, maxReservation: 10 }),
    ).toThrow(RangeError);
    expect(() =>
      createOnlineReservation({ holdCost: 1, overrunCost: -1, maxReservation: 10 }),
    ).toThrow(RangeError);
    expect(() =>
      createOnlineReservation({ holdCost: 1, overrunCost: 1, maxReservation: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      createOnlineReservation({
        holdCost: 1,
        overrunCost: 1,
        maxReservation: 10,
        minReservation: 20,
      }),
    ).toThrow(RangeError);
  });
});
