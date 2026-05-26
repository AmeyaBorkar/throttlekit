import { describe, expect, it } from "vitest";
import { makeStationary } from "./demand";
import { evaluateScheme } from "./evaluate";
import { createLeaseSizer } from "./lease-sizer";

/**
 * GALE evaluation — its position on the overshoot / coordination / utilisation trilemma versus the
 * incumbents, on a deterministic skewed-overload workload. The numbers below are reproducible (seeded)
 * and recorded in research/gale/EVALUATION.md.
 *
 * Skewed overload: one hot node (~80 req/window) + four cold (~5) against a limit of 100 — total
 * offered ≈ the limit, so the trilemma bites. `h` (strand penalty) is GALE's coordination↔utilisation
 * dial; under contention it is set higher so leases track demand (less stranding).
 */
const C_ORDER = 20;
const LIMIT = 100;
const WINDOWS = 500;
const SKEWED = [80, 5, 5, 5, 5].map((m, i) => makeStationary(WINDOWS, m, 0.3, 500 + i));
const galeSizers = (n: number, h: number) =>
  Array.from({ length: n }, () =>
    createLeaseSizer({ orderCost: C_ORDER, strandPenalty: h, maxSize: 1000 }),
  );

describe("GALE evaluation — Pareto position vs baselines (skewed overload)", () => {
  const strict = evaluateScheme(SKEWED, LIMIT, { kind: "strict" });
  const staticShare = evaluateScheme(SKEWED, LIMIT, { kind: "static" });
  const legacy = evaluateScheme(SKEWED, LIMIT, {
    kind: "leasedFixed",
    batch: 10,
    windowCoupled: false,
  });
  const coupledBest = evaluateScheme(SKEWED, LIMIT, {
    kind: "leasedFixed",
    batch: 5,
    windowCoupled: true,
  });
  const gale = evaluateScheme(SKEWED, LIMIT, { kind: "gale", sizers: galeSizers(5, 10) });

  it("each baseline fails on at least one axis", () => {
    expect(strict.coordination).toBeGreaterThan(50_000); // exact, but a round trip per request
    expect(staticShare.meanUtil).toBeLessThan(0.5); // starves the hot node to its 1/N share
    expect(legacy.overshoot).toBeGreaterThan(0); // carryover overshoots the limit
  });

  it("GALE is good on all three axes simultaneously", () => {
    expect(gale.overshoot).toBe(0); // window-coupled ⇒ zero overshoot
    expect(gale.meanUtil).toBeGreaterThan(0.9); // high utilisation under skew (~0.96)
    expect(gale.coordination).toBeLessThan(strict.coordination / 3); // ≪ central-per-request (~4×)
  });

  it("GALE Pareto-dominates the best fixed-batch window-coupled scheme", () => {
    // Identical zero overshoot, but adaptive per-node sizing serves as much at far fewer round trips.
    expect(gale.overshoot).toBe(coupledBest.overshoot); // both 0
    expect(gale.meanUtil).toBeGreaterThanOrEqual(coupledBest.meanUtil * 0.98);
    expect(gale.coordination).toBeLessThan(coupledBest.coordination * 0.85);
  });

  it("GALE roughly doubles utilisation versus the static equal share", () => {
    expect(gale.meanUtil).toBeGreaterThan(staticShare.meanUtil * 2);
  });
});

describe("GALE evaluation — overshoot vs fleet size", () => {
  it("window-coupled overshoot stays 0 as N grows while legacy overshoot grows", () => {
    const limit = 100;
    const windows = 200;
    const batch = 10;
    const legacyByN: number[] = [];
    for (const n of [2, 4, 8, 16]) {
      const traces = Array.from({ length: n }, (_u, i) =>
        makeStationary(windows, Math.ceil(150 / n), 0.4, 700 + i),
      );
      const legacy = evaluateScheme(traces, limit, {
        kind: "leasedFixed",
        batch,
        windowCoupled: false,
      });
      const coupled = evaluateScheme(traces, limit, {
        kind: "leasedFixed",
        batch,
        windowCoupled: true,
      });
      expect(coupled.overshoot).toBe(0); // independent of N
      expect(legacy.overshoot).toBeGreaterThan(0);
      legacyByN.push(legacy.overshoot);
    }
    // Legacy overshoot grows with the fleet (strictly larger at N=16 than at N=2).
    expect(legacyByN[legacyByN.length - 1]).toBeGreaterThan(legacyByN[0] as number);
  });
});
