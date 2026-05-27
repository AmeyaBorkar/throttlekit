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

/**
 * Partial coordination — the `0 < C < N` interpolation (static-partition model).
 * Full statement + proof: research/gale/TRILEMMA.md (§ Partial coordination).
 *
 * Model: partition the N nodes into m groups; within a group the members share ONE budget pool P_j
 * atomically (intra-group coordination), none across groups. Maintaining a g-member pool costs g−1
 * coordination links per window (a spanning tree), so total coordination C = Σ(g_j−1) = N − m.
 *
 * Reduction lemma: a size-g group with pool P behaves as a single SUPER-NODE of budget P — flooding it
 * admits min(Σd, P) (overshoot is per-pool, not per-node) and a lone hot member draws the whole P, so
 * its under-utilisation is (L−P)^+ (vs the (L−P/g)^+ of an uncoordinated split). The m groups are thus
 * m zero-coordination super-nodes, and the main theorem applies with N := m:
 *
 *      Δ + (N − C)·U ≥ (N − C − 1)·L ,   C = N − m ∈ {0,…,N−1},   tight at uniform pools P_j = L/m.
 *
 * The floor decays linearly — one L per coordination link — from (N−1)L at C=0 to 0 at C=N−1.
 */

/** Shared-pool admission for one group: members pool their demand and draw a common budget P. */
function groupAdmit(demands: readonly number[], pool: number): number {
  let d = 0;
  for (const x of demands) d += x;
  return Math.min(d, pool);
}

describe("GALE — trilemma under partial coordination (static-partition 0<C<N interpolation)", () => {
  it("reduction lemma: intra-group sharing turns a size-g group into a single super-node of budget P", () => {
    const L = 12;
    const g = 3;
    for (const P of [0, 3, 6, 9, 12, 15]) {
      // A lone hot member draws the whole pool — the super-node behaviour: admits min(L, P).
      expect(groupAdmit([L, 0, 0], P)).toBe(Math.min(L, P));
      expect(groupAdmit([0, L, 0], P)).toBe(Math.min(L, P));
      // Flooding the whole group still admits only P (overshoot is per-pool, not per-node).
      expect(groupAdmit(new Array(g).fill(L), P)).toBe(Math.min(g * L, P));
    }
  });

  it("coordination strictly lowers under-utilisation vs an uncoordinated split of the same budget", () => {
    const L = 12;
    const g = 3;
    const P = 6;
    // Coordinated: the lone hot member draws the whole pool ⇒ U = L − min(L,P).
    const coordU = L - groupAdmit([L, 0, 0], P);
    expect(coordU).toBe(6);
    // Uncoordinated: split P into g per-node budgets; the system's best split is uniform ⌊P/g⌋=2, but a
    // single hot node is still capped at its own budget ⇒ U = L − 2 = 10 > coordU.
    const split = [2, 2, 2];
    const uncoordU = L - Math.min(L, Math.min(...split));
    expect(uncoordU).toBe(10);
    expect(coordU).toBeLessThan(uncoordU); // the shared pool is exactly what coordination buys
  });

  it.each([
    { m: 1, limit: 8 },
    { m: 2, limit: 8 },
    { m: 3, limit: 6 },
    { m: 4, limit: 8 },
  ])(
    "m super-node pools: Δ + m·U ≥ (m−1)·L on every pool allocation, and tight: m=$m, L=$limit",
    ({ m, limit }) => {
      const bound = (m - 1) * limit;
      let minObjective = Number.POSITIVE_INFINITY;
      for (const pools of allocations(m, limit)) {
        const { overshoot, underUtil } = worstCase(pools, limit); // same (Δ,U) formulas, pools as budgets
        const objective = overshoot + m * underUtil;
        expect(objective).toBeGreaterThanOrEqual(bound); // the corollary holds on every allocation
        if (objective < minObjective) minObjective = objective;
      }
      expect(minObjective).toBe(bound); // tight: uniform pools P_j = L/m attain it
    },
  );

  it("the overshoot/under-utilisation floor decays linearly as coordination C = N−m grows (N=4, L=8)", () => {
    const N = 4;
    const L = 8;
    const floors = [0, 1, 2, 3].map((C) => {
      const m = N - C; // C links ⇒ m = N − C groups
      let best = Number.POSITIVE_INFINITY;
      for (const pools of allocations(m, L)) {
        const { overshoot, underUtil } = worstCase(pools, L);
        best = Math.min(best, overshoot + m * underUtil);
      }
      return best; // the achievable frontier point = (m−1)L = (N−C−1)L
    });
    expect(floors).toEqual([3 * L, 2 * L, 1 * L, 0]); // 24, 16, 8, 0 — one L per coordination link
    for (let i = 0; i + 1 < floors.length; i++) {
      expect(floors[i + 1]).toBeLessThan(floors[i] as number); // strictly decreasing in C
    }
    expect(floors[N - 1]).toBe(0); // full coordination (C = N−1): no constraint — the GALE corner
  });
});
