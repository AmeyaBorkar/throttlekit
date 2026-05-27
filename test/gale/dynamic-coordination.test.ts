import { describe, expect, it, vi } from "vitest";
import { dynamicLowerBoundU, dynamicUnitBatchU, optimalU } from "./dynamic-coordination";

/**
 * GALE capstone — the DYNAMIC `≤ C`-message trilemma (research/gale/TRILEMMA.md § Partial coordination
 * — dynamic). Coordination is demand-driven leasing capped at C round-trips of batch B; windowCoupled
 * ⇒ Δ = 0, so we characterise U = min over pre-auth of max over demand of under-utilisation, exactly.
 *
 * Proven here: C=0 recovers the static floor (N−1)L/N; the bound Δ + N·U ≥ (N−1)(L − C·B) holds for
 * every B (single-hot adversary) and is TIGHT at B=1 (unit leasing, no stranding); uniform pre-auth is
 * optimal. Documented-open: for batched leasing (B>1, C≥2) a "barely-hot-then-starve" adversary strands
 * up to B−1 per lease, so U* exceeds the single-hot bound — the tight closed form there is open.
 */

// Exhaustive min-over-pre-auth × max-over-demand searches; raise the timeout (cf. distributed-budget).
vi.setConfig({ testTimeout: 30_000 });

describe("GALE — dynamic ≤C-message trilemma (leasing capped at C round-trips of batch B)", () => {
  it("C=0 recovers the static zero-coordination floor U = (N−1)L/N (no leasing; B-independent)", () => {
    for (const [N, L] of [
      [2, 8],
      [3, 9],
      [4, 8],
    ] as const) {
      const expected = ((N - 1) * L) / N; // integer since N | L
      for (const B of [1, 3, 5]) expect(optimalU(N, L, B, 0).U).toBe(expected);
    }
  });

  it("B=1 (unit leasing, no stranding) is TIGHT to the closed form min_β[L−β−min(C,L−Nβ)]", () => {
    for (const [N, L] of [
      [2, 8],
      [3, 9],
      [4, 12],
    ] as const) {
      for (let C = 0; C <= L; C++) {
        // full pre-auth search for N≤3; uniform for N=4 (the full search confirms uniform is optimal).
        expect(optimalU(N, L, 1, C, N >= 4).U).toBe(dynamicUnitBatchU(N, L, C));
      }
    }
  });

  it("the proved lower bound Δ + N·U ≥ (N−1)(L−C·B) holds for every B (single-hot adversary)", () => {
    for (const [N, L] of [
      [2, 8],
      [3, 9],
    ] as const) {
      for (const B of [1, 2, 3, 4]) {
        for (let C = 0; C <= 4; C++) {
          expect(optimalU(N, L, B, C).U).toBeGreaterThanOrEqual(
            dynamicLowerBoundU(N, L, B, C) - 1e-9,
          );
        }
      }
    }
  });

  it("batched leasing (B>1, C≥2) strands — U* exceeds the single-hot bound (the open phenomenon)", () => {
    // The spread "barely-hot-then-starve" adversary (worst demand [2,2,5]) burns both leases; the
    // tight closed form in this regime is open. Here U*=4 while the single-hot bound is only 2.
    const u = optimalU(3, 9, 3, 2);
    expect(u.U).toBe(4);
    expect(u.U).toBeGreaterThan(dynamicLowerBoundU(3, 9, 3, 2)); // 4 > 2 — the stranding gap
  });

  it("U* is non-increasing in C (more coordination never hurts); B=1 reaches 0 at C=L", () => {
    for (const [N, L, B] of [
      [2, 8, 2],
      [3, 9, 1],
    ] as const) {
      let prev = Number.POSITIVE_INFINITY;
      for (let C = 0; C <= L; C++) {
        const u = optimalU(N, L, B, C).U;
        expect(u).toBeLessThanOrEqual(prev);
        prev = u;
      }
      if (B === 1) expect(optimalU(N, L, 1, L).U).toBe(0); // perfect leasing covers the whole budget
    }
  });

  it("uniform pre-auth is optimal (full pre-auth search matches uniform-only)", () => {
    for (const [N, L, B, C] of [
      [3, 9, 2, 1],
      [3, 9, 3, 2],
      [3, 9, 4, 2],
      [2, 8, 3, 2],
    ] as const) {
      expect(optimalU(N, L, B, C, false).U).toBe(optimalU(N, L, B, C, true).U);
    }
  });
});
