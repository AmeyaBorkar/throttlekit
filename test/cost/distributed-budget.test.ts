import { describe, expect, it } from "vitest";
import type { LeaseSizer } from "../gale/lease-sizer";
import { simulateWindowCoupled } from "../gale/window-coupled-sim";
import { carryoverBound, simulateDistributedBudget } from "./distributed-budget";
import { heavyTailLengths } from "./token-budget";

/**
 * Distributed instantiation of the cost-uncertainty thread (TALE × GALE unification). A single TPM
 * budget L shared across C gateways, each leasing B-token batches from a shared L2 = the GALE leased
 * two-tier with the token as the unit. Design: research/cost-uncertainty/PROPOSAL.md (§ Layer 1
 * distributed / § Capstone). Seeded; thresholds calibrated with explore-distributed.ts.
 *
 * Headline: window-coupling makes global overshoot bounded INDEPENDENT of the gateway count C,
 * exactly as GALE Pillar 1 does for nodes — and the windowCoupled token budget is byte-identical to
 * GALE's request-granular window-coupled leasing.
 */
const L = 10000;
const B = 200;
const W = 200;
const CS = [1, 2, 4, 8, 16, 32] as const;

// Per-gateway per-window token demand (heavy-tailed); fixed median so aggregate overloads L as C grows.
const demandsFor = (c: number, median = 4000, seed0 = 100): number[][] =>
  Array.from({ length: c }, (_u, i) => heavyTailLengths(W, median, 20 * median, seed0 + i));

const run = (demands: number[][], c: number, mode: "windowCoupled" | "carryover", budget = L) =>
  simulateDistributedBudget(demands, { budget, gateways: c, leaseBatch: B, mode });

describe("distributed TPM — windowCoupled overshoot is bounded independent of fleet size", () => {
  it("overshoot is 0 for EVERY gateway count C (fixed budget L)", () => {
    for (const c of CS) {
      const result = run(demandsFor(c), c, "windowCoupled");
      const maxOvershoot = Math.max(...result.map((r) => r.overshoot));
      expect(maxOvershoot).toBe(0); // ≤ L every window, no matter how many gateways share it
    }
  });

  it("stays work-conserving: utilization → 1 once enough gateways share the budget", () => {
    const utilAt = (c: number): number => {
      const r = run(demandsFor(c), c, "windowCoupled");
      return r.reduce((a, x) => a + Math.min(x.produced, L) / L, 0) / r.length;
    };
    // A single gateway (median 4000 < L) underfills; more gateways aggregate to saturate L.
    expect(utilAt(1)).toBeLessThan(0.6); // ~0.443 measured
    for (const c of [4, 8, 16, 32]) expect(utilAt(c)).toBeGreaterThan(0.95); // ~0.96 → 1.000
  });
});

describe("distributed TPM — carryover pays a fleet-size-dependent overshoot", () => {
  it("carryover overshoot is positive yet within the C·(B−1) bound (fixed L)", () => {
    for (const c of CS) {
      const result = run(demandsFor(c), c, "carryover");
      const maxOvershoot = Math.max(...result.map((r) => r.overshoot));
      expect(maxOvershoot).toBeGreaterThan(0); // unlike windowCoupled's 0 — carryover always leaks
      expect(maxOvershoot).toBeLessThanOrEqual(carryoverBound(c, B)); // the L + C·(B−1) envelope
    }
  });

  it("in an un-starved regime (L scales with C) the overshoot GROWS with C — the fleet penalty", () => {
    const meanOvershoot: number[] = [];
    for (const c of [2, 4, 8, 16, 32]) {
      const Lc = 1500 * c; // budget not the binding constraint ⇒ the worst case is realisable
      const demands = demandsFor(c, 2500, 200);
      // window-coupling still pins overshoot to 0 even as both C and L grow…
      expect(Math.max(...run(demands, c, "windowCoupled", Lc).map((r) => r.overshoot))).toBe(0);
      // …whereas carryover's overshoot climbs with the fleet size.
      const co = run(demands, c, "carryover", Lc);
      meanOvershoot.push(co.reduce((a, r) => a + r.overshoot, 0) / co.length);
    }
    // Strictly increasing in C: ~32 → 62 → 98 → 153 → 196 measured.
    for (let i = 0; i + 1 < meanOvershoot.length; i++) {
      expect(meanOvershoot[i + 1]).toBeGreaterThan(meanOvershoot[i] as number);
    }
  });
});

describe("the reduction: the windowCoupled token budget IS GALE window-coupled leasing", () => {
  // A fixed-size lease sizer (always leases B) — the token budget's lease policy.
  const fixedSizer = (b: number): LeaseSizer => ({
    size: () => b,
    observe: () => {},
    continuous: b,
  });

  it("windowCoupled `produced` is byte-identical to GALE `simulateWindowCoupled` `admitted`", () => {
    for (const c of [2, 8, 32]) {
      const demands = demandsFor(c);
      const mine = run(demands, c, "windowCoupled").map((r) => r.produced);
      const gale = simulateWindowCoupled(
        demands,
        demands.map(() => fixedSizer(B)),
        L,
      ).map((r) => r.admitted);
      expect(mine).toEqual(gale); // same mechanism, token unit vs request unit
    }
  });
});
