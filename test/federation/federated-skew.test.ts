/**
 * TK-904 federated skew measurement — the COMPLEMENT of the static-partition
 * baseline (`static-skew.test.ts`) under the IDENTICAL skew model. Federation
 * must recover the utilization static-partition leaves on the table; this
 * file commits the numbers that beat baselines.md §2.
 *
 * Skew model (same as the static baseline):
 *   f_hot  = 1/K + s · (1 − 1/K)
 *   f_cold = (1 − f_hot) / (K − 1)
 *
 * Predicted under federated window-coupling: every offered request can in
 * principle be admitted (the global budget pools across regions), so
 * U_capacity → 1.0 modulo the worst-case (K−1)·(batch−1) tokens of
 * uncommitted escrow at window's end. For K=3, batch=16, L=300:
 *   worst-case unused: 2 · 15 = 30 tokens
 *   so U_capacity ≥ (300 − 30) / 300 = 0.90 across all skew values
 */

import { describe, expect, it } from "vitest";

import { fixedWindow } from "../../src/algorithms/fixed-window";
import { ManualClock } from "../../src/core/clock";
import { TestCoordinator, federate } from "../../src/federation";

const REGIONS: readonly string[] = ["us-east", "eu-west", "ap-south"];

interface FederatedSkewMeasurement {
  skew: number;
  offered: number;
  admitted: number;
  uCapacity: number;
  uOffered: number;
}

async function measureFederatedSkew(
  skew: number,
  globalLimit = 300,
  batch = 16,
): Promise<FederatedSkewMeasurement> {
  const K = REGIONS.length;
  const clock = new ManualClock(0);
  const coordinator = new TestCoordinator({ budgetPerWindow: globalLimit });

  const limiters: Record<string, ReturnType<typeof federate>> = {};
  for (const region of REGIONS) {
    limiters[region] = federate({
      strategy: fixedWindow({ limit: globalLimit, windowMs: 60_000 }),
      coordinator,
      region,
      batch,
      clock,
    });
  }

  const fHot = 1 / K + skew * (1 - 1 / K);
  const fCold = K === 1 ? 0 : (1 - fHot) / (K - 1);
  const coldLoad = Math.round(globalLimit * fCold);
  const hotLoad = globalLimit - coldLoad * (K - 1);

  let admitted = 0;
  let offered = 0;

  const hotRegion = REGIONS[0] as string;
  for (let i = 0; i < hotLoad; i++) {
    offered++;
    if ((await limiters[hotRegion]!.check("k")).allowed) admitted++;
  }
  for (let r = 1; r < K; r++) {
    const coldRegion = REGIONS[r] as string;
    for (let i = 0; i < coldLoad; i++) {
      offered++;
      if ((await limiters[coldRegion]!.check("k")).allowed) admitted++;
    }
  }

  return {
    skew,
    offered,
    admitted,
    uCapacity: admitted / globalLimit,
    uOffered: admitted / offered,
  };
}

describe("federation/window-coupled skew recovery (TK-904)", () => {
  it("uniform load (s=0) admits the full budget (federation matches static)", async () => {
    const m = await measureFederatedSkew(0);
    expect(m.admitted).toBeGreaterThanOrEqual(270); // ≥ L - (K-1)·(B-1) = 270
    expect(m.admitted).toBeLessThanOrEqual(300); // Δ = 0 holds
  });

  it("max skew (s=1) still admits ~all of L — pooling recovers capacity", async () => {
    const m = await measureFederatedSkew(1);
    expect(m.admitted).toBeLessThanOrEqual(300); // Δ = 0
    // Federation should admit at least 90% (vs static-partition's 33%).
    expect(m.uCapacity).toBeGreaterThan(0.9);
  });

  it("federation's flat U(s) beats static's collapsing U(s) — the contribution", async () => {
    const sweep = [0, 0.25, 0.5, 0.75, 1.0];
    const fedRows: FederatedSkewMeasurement[] = [];
    for (const s of sweep) fedRows.push(await measureFederatedSkew(s));

    // Captured static baseline U values (from research/.../baselines.md §2):
    const staticU = [1.0, 0.833, 0.667, 0.5, 0.333];

    console.log(
      "\n  Federated window-coupled skew measurement (K=3, L=300, batch=16, fixedWindow):",
    );
    console.log("  | skew | offered | admitted | U_capacity | static U | delta |");
    console.log("  |---:|---:|---:|---:|---:|---:|");
    for (let i = 0; i < fedRows.length; i++) {
      const r = fedRows[i]!;
      const su = staticU[i]!;
      const delta = r.uCapacity - su;
      console.log(
        `  | ${r.skew.toFixed(2)} | ${r.offered} | ${r.admitted} | ${r.uCapacity.toFixed(3)} | ${su.toFixed(3)} | ${delta >= 0 ? "+" : ""}${delta.toFixed(3)} |`,
      );

      // Δ = 0 across regions — the load-bearing safety bound.
      expect(r.admitted).toBeLessThanOrEqual(300);
      // Federation U is bounded below by L - (K-1)·(B-1) / L = 270/300 = 0.9 across ALL skew.
      // (At low skew the unused regional escrow is the cost; at high skew it's the only
      // cost too.)
      expect(r.uCapacity).toBeGreaterThanOrEqual(0.89);
    }

    // The CONTRIBUTION: at low skew federation costs ~8% (batch overhead);
    // at high skew federation RECOVERS hugely (~60 points). The crossover is
    // typically around s ≈ 0.1 — wherever static's linear drop crosses
    // federation's flat ~92%.
    const lowSkewGap = fedRows[0]!.uCapacity - staticU[0]!;
    const highSkewGap = fedRows[fedRows.length - 1]!.uCapacity - staticU[staticU.length - 1]!;
    // At low skew federation may be slightly worse (batch overhead).
    expect(lowSkewGap).toBeGreaterThan(-0.12);
    // At max skew federation must be DRAMATICALLY better (hard contribution).
    expect(highSkewGap).toBeGreaterThan(0.5);
  });

  it("with smaller batch (B=4): less unused capacity, even closer to ideal", async () => {
    // With smaller batches, the (K-1)·(B-1) worst-case unused capacity shrinks.
    // For K=3, B=4: worst-case unused = 2·3 = 6 tokens. Admitted should be near 294/300 = 0.98.
    const m = await measureFederatedSkew(1, 300, 4);
    expect(m.uCapacity).toBeGreaterThan(0.95);
    expect(m.admitted).toBeLessThanOrEqual(300);
  });
});
