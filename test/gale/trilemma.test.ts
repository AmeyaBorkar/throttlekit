import { describe, expect, it } from "vitest";

/**
 * GALE capstone — the rate-limiting trilemma lower bound, zero-coordination regime.
 * Full statement + proof: research/gale/TRILEMMA.md. This is the exhaustive, CI-gated check.
 *
 * Model. One L2 window, N nodes, global limit L. A *zero-coordination* protocol pre-authorises a
 * local budget b_n to each node and admits up to b_n of that node's offered demand with no
 * inter-node communication (the most general no-coordination scheme; randomisation cannot help a
 * worst-case hard bound). Let S = Σ b_n. Against a worst-case demand adversary:
 *   - overshoot       Δ = (S − L)^+        (adversary offers ≥ b_n to every node ⇒ admits S)
 *   - under-utilisation U = (L − min_n b_n)^+  (adversary puts all L demand on the min-budget node)
 *
 * Theorem.  Δ + N·U ≥ (N−1)·L,  and it is tight (attained by the uniform allocation b_n = L/N).
 * Consequence: at zero coordination you cannot make both overshoot and under-utilisation small —
 * their weighted sum is forced to scale with N·L. Coordination is the only escape, and it is exactly
 * what GALE's window-coupled leasing spends to reach Δ = 0 with U → 0 (a hot node leases more).
 */

interface Outcome {
  readonly overshoot: number;
  readonly underUtil: number;
}

/** Worst-case (Δ, U) of a fixed zero-coordination budget allocation against the demand adversary. */
function worstCase(budgets: readonly number[], limit: number): Outcome {
  let sum = 0;
  let min = Number.POSITIVE_INFINITY;
  for (const b of budgets) {
    sum += b;
    if (b < min) min = b;
  }
  return {
    overshoot: Math.max(0, sum - limit),
    underUtil: Math.max(0, limit - min),
  };
}

/** Enumerate every integer allocation with each b_n in 0..limit (odometer over N digits). */
function* allocations(n: number, limit: number): Generator<number[]> {
  const b = new Array<number>(n).fill(0);
  for (;;) {
    yield b;
    let i = 0;
    while (i < n) {
      const v = (b[i] ?? 0) + 1;
      if (v <= limit) {
        b[i] = v;
        break;
      }
      b[i] = 0;
      i++;
    }
    if (i === n) return;
  }
}

describe("GALE — rate-limiting trilemma lower bound (zero coordination)", () => {
  it.each([
    { n: 2, limit: 4 },
    { n: 3, limit: 6 },
    { n: 4, limit: 8 },
  ])("Δ + N·U ≥ (N-1)·L on every allocation, and is tight: N=$n, L=$limit", ({ n, limit }) => {
    const bound = (n - 1) * limit;
    let minObjective = Number.POSITIVE_INFINITY;
    for (const b of allocations(n, limit)) {
      const { overshoot, underUtil } = worstCase(b, limit);
      const objective = overshoot + n * underUtil;
      // The lower bound holds on EVERY zero-coordination allocation.
      expect(objective).toBeGreaterThanOrEqual(bound);
      if (objective < minObjective) minObjective = objective;
    }
    // Tight: the uniform allocation b_n = L/N attains it (here L/N is integer).
    expect(minObjective).toBe(bound);
    // (Allocations with some b_n > L only raise Δ, so 0..L is the binding range — verified above.)
  });

  it("both trilemma corners are bad at zero coordination (N=4, L=8)", () => {
    const n = 4;
    const limit = 8;
    // Corner A — zero overshoot (S = L): a single hot node is starved to its 1/N share.
    const a = worstCase([2, 2, 2, 2], limit);
    expect(a.overshoot).toBe(0);
    expect(a.underUtil).toBe(6); // L − L/N = 8 − 2
    // Corner B — zero under-utilisation (every node pre-authorised for L): massive overshoot.
    const b = worstCase([8, 8, 8, 8], limit);
    expect(b.underUtil).toBe(0);
    expect(b.overshoot).toBe(24); // (N−1)·L
    // Neither corner escapes the bound; only spending coordination does.
    expect(a.overshoot + n * a.underUtil).toBe((n - 1) * limit);
    expect(b.overshoot + n * b.underUtil).toBe((n - 1) * limit);
  });
});
