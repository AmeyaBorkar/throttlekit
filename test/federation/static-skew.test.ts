/**
 * TK-903 skew measurement — the BASELINE utilization number under static
 * partition. The federated scheme (TK-904) recovers the capacity this
 * baseline leaves on the table; this file commits the numbers that
 * comparison rests on.
 *
 * Skew model. For `K` regions and a skew parameter `s ∈ [0, 1]`:
 *   f_hot  = 1/K + s · (1 − 1/K)            (the hot region's load fraction)
 *   f_cold = (1 − f_hot) / (K − 1)          (each cold region's load fraction)
 *
 * At s=0 the load is uniform (every region gets 1/K of the offered traffic).
 * At s=1 ALL load lands on the hot region. We offer exactly the global
 * budget L worth of requests in one window.
 *
 * Predicted utilization under static partition (each region's slice is L/K):
 *
 *   U(s) = (1/L) · Σ_r min(L · f_r, L/K)
 *        = Σ_r min(f_r, 1/K)
 *
 * which is 1 at s=0 and degrades to 1/K as s → 1 (the hot region binds at
 * its slice while every other region's slice goes un-used).
 *
 * The numbers captured below are committed to
 * `research/bigger-bets/federation/baselines.md`; TK-904 will re-measure
 * the same scenarios under federated leasing and the gap is the
 * contribution of federation.
 */

import { describe, expect, it } from "vitest";

import { fixedWindow } from "../../src/algorithms/fixed-window";
import { ManualClock } from "../../src/core/clock";
import { rateLimit } from "../../src/core/limiter";
import { staticPartition } from "../../src/federation";
import { MemoryStore } from "../../src/stores/memory";

const REGIONS: readonly string[] = ["us-east", "eu-west", "ap-south"];

interface SkewMeasurement {
  skew: number;
  offered: number;
  admitted: number;
  /** admitted / globalLimit — how much of the available capacity was used. */
  uCapacity: number;
  /** admitted / offered — how much of the offered load was admitted. */
  uOffered: number;
  /** The analytical prediction Σ min(f_r, 1/K). */
  predicted: number;
}

/** Run one window of load at a given skew and return the measurement. */
async function measureSkew(skew: number, globalLimit = 300): Promise<SkewMeasurement> {
  const K = REGIONS.length;
  const clock = new ManualClock(0);

  const { strategies, slices } = staticPartition({
    globalLimit,
    regions: REGIONS,
    strategyFactory: (limit) => fixedWindow({ limit, windowMs: 60_000 }),
  });
  const limiters: Record<string, ReturnType<typeof rateLimit>> = {};
  for (const region of REGIONS) {
    limiters[region] = rateLimit({
      strategy: strategies[region]!,
      store: new MemoryStore({ clock }),
      clock,
    });
  }

  // Load fractions per the skew model.
  const fHot = 1 / K + skew * (1 - 1 / K);
  const fCold = K === 1 ? 0 : (1 - fHot) / (K - 1);

  // Convert to integer per-region loads. Hot region gets the rounded share;
  // we then push the rounding remainder onto the hot region so Σ loads === L exactly.
  const coldLoad = Math.round(globalLimit * fCold);
  const hotLoad = globalLimit - coldLoad * (K - 1);

  let admitted = 0;
  let offered = 0;

  const hotRegion = REGIONS[0] as string;
  // Hot region first.
  for (let i = 0; i < hotLoad; i++) {
    offered++;
    if ((await limiters[hotRegion]!.check("k")).allowed) admitted++;
  }
  // Cold regions.
  for (let r = 1; r < K; r++) {
    const coldRegion = REGIONS[r] as string;
    for (let i = 0; i < coldLoad; i++) {
      offered++;
      if ((await limiters[coldRegion]!.check("k")).allowed) admitted++;
    }
  }

  // Analytical prediction: Σ min(f_r, 1/K) — discrete version using actual loads
  // (handles integer rounding of f_hot · L into hotLoad).
  const hotSlice = slices[hotRegion]!;
  const coldSlice = slices[REGIONS[1] as string]!; // all cold slices are equal in symmetric K
  const predictedAdmitted = Math.min(hotLoad, hotSlice) + (K - 1) * Math.min(coldLoad, coldSlice);

  return {
    skew,
    offered,
    admitted,
    uCapacity: admitted / globalLimit,
    uOffered: admitted / offered,
    predicted: predictedAdmitted / globalLimit,
  };
}

describe("federation/static-partition skew degradation (TK-903 baseline)", () => {
  it("uniform load (s=0) achieves U=1.0 (the only case static-partition is optimal)", async () => {
    const m = await measureSkew(0);
    expect(m.admitted).toBe(300);
    expect(m.offered).toBe(300);
    expect(m.uCapacity).toBe(1);
  });

  it("max skew (s=1) collapses U to 1/K (the hot region binds; the rest sit idle)", async () => {
    const m = await measureSkew(1);
    expect(m.admitted).toBe(100); // K=3, slice=100; hot region admits its full slice, others zero
    expect(m.offered).toBe(300);
    expect(m.uCapacity).toBeCloseTo(1 / 3, 2);
  });

  it("matches the closed-form prediction Σ min(f_r, 1/K) across the skew sweep", async () => {
    const sweep = [0, 0.25, 0.5, 0.75, 1.0];
    const rows: SkewMeasurement[] = [];
    for (const s of sweep) rows.push(await measureSkew(s));

    // Pretty-print so the numbers land in test output (and into baselines.md
    // verbatim). The actual assert is just that prediction === measurement.
    console.log("\n  Static-partition skew measurement (K=3, L=300, fixedWindow, one window):");
    console.log("  | skew | offered | admitted | U_capacity | U_offered | predicted |");
    console.log("  |---:|---:|---:|---:|---:|---:|");
    for (const r of rows) {
      console.log(
        `  | ${r.skew.toFixed(2)} | ${r.offered} | ${r.admitted} | ${r.uCapacity.toFixed(3)} | ${r.uOffered.toFixed(3)} | ${r.predicted.toFixed(3)} |`,
      );
    }

    for (const r of rows) {
      // Measured admitted matches the predicted admitted byte-for-byte
      // (within the floor of the rounding in measureSkew).
      expect(Math.round(r.uCapacity * 300)).toBe(Math.round(r.predicted * 300));
    }
  });

  it("at K=5 (more regions), max-skew U drops further to 1/5 = 0.2", async () => {
    // Repeat the model with K=5 — same predicted U(s=1) = 1/K analysis.
    const K = 5;
    const REGIONS_K5 = ["r0", "r1", "r2", "r3", "r4"] as const;
    const L = 500;
    const clock = new ManualClock(0);
    const { strategies } = staticPartition({
      globalLimit: L,
      regions: REGIONS_K5,
      strategyFactory: (limit) => fixedWindow({ limit, windowMs: 60_000 }),
    });
    const limiters = Object.fromEntries(
      REGIONS_K5.map((r) => [
        r,
        rateLimit({ strategy: strategies[r]!, store: new MemoryStore({ clock }), clock }),
      ]),
    );

    // s=1: ALL load on r0. Each region's slice = 100.
    let admitted = 0;
    for (let i = 0; i < L; i++) {
      if ((await limiters.r0!.check("k")).allowed) admitted++;
    }
    expect(admitted).toBe(100); // 1/K = 1/5 fraction of L
    expect(admitted / L).toBeCloseTo(1 / K, 2);
  });
});
