import { describe, expect, it } from "vitest";

/**
 * GALE — exhaustive (BFS) model check of distributed-leasing overshoot across
 * coordination variants. The CI-gated, Java-free twin of
 * spec/GaleWindowCoupledLeasing.tla, in the exact style of
 * test/twotier/leasing-model.test.ts.
 *
 * It first REPRODUCES the committed baseline result (current ThrottleKit
 * `leased` mode, modelled by spec/DistributedLeasing.tla) — matching TLC's
 * distinct-state counts (31, 441) and its tight, fleet-size-DEPENDENT bound
 *   admitted <= Limit + N*(Batch-1)
 * — which validates that the transition system here is faithful. It then proves
 * the keystone GALE claim: COUPLING credit lifetime to the L2 window boundary
 * (credits expire on a roll instead of carrying over) collapses the per-window
 * overshoot to ZERO, giving a bound INDEPENDENT OF FLEET SIZE N:
 *   admitted <= Limit                                  (for any N)
 * and this remains exact even under work-conserving credit returns.
 *
 * Model (lowWater = 0, per-request cost = 1, fixed lease size B), per L2 window:
 *   Serve(n):  held[n] >= 1            -> held[n]--, admitted++         (local hit)
 *   Lease(n):  held[n] == 0 && l2 >= B -> l2 -= B, held[n] = B-1, admitted++
 *   Return(n): (escrow-sound)          -> l2 += held[n], held[n] = 0   (give back idle credits)
 *   Roll:      l2 = Limit, admitted = 0, and credits either
 *                - carry over  (baseline)        -> the sole source of overshoot, or
 *                - expire      (windowCoupled)   -> no carryover.
 */

type Variant = "baseline" | "windowCoupled";

interface Params {
  readonly nodes: number;
  readonly limit: number;
  readonly batch: number;
  readonly variant: Variant;
  /** Allow nodes to return idle credits to L2 (work-conservation). Baseline excludes it (matches TLC). */
  readonly allowReturn: boolean;
}

interface State {
  readonly l2: number;
  readonly held: readonly number[];
  readonly admitted: number;
}

/** The proven per-window upper bound for the variant. */
function boundFor(p: Params): number {
  return p.variant === "baseline" ? p.limit + p.nodes * (p.batch - 1) : p.limit;
}

/** Canonical key for the visited set; admitted is part of the state. */
const keyOf = (s: State): string => `${s.l2}|${s.held.join(",")}|${s.admitted}`;

/** All successor states of `s` under Next = \E n: Serve(n) \/ Lease(n) \/ [Return(n)] \/ Roll. */
function successors(p: Params, s: State): State[] {
  const out: State[] = [];

  for (let n = 0; n < p.nodes; n++) {
    const have = s.held[n] ?? 0;

    // Serve(n): consume a local credit, admit, no L2 round trip.
    if (have >= 1) {
      const held = s.held.slice();
      held[n] = have - 1;
      out.push({ l2: s.l2, held, admitted: s.admitted + 1 });
    }

    // Lease(n): out of local credits and a whole batch fits in the window budget.
    if (have === 0 && s.l2 >= p.batch) {
      const held = s.held.slice();
      held[n] = p.batch - 1;
      out.push({ l2: s.l2 - p.batch, held, admitted: s.admitted + 1 });
    }

    // Return(n): hand idle credits back to L2 (sound where L2 escrow-accounts grants).
    if (p.allowReturn && have >= 1) {
      const held = s.held.slice();
      held[n] = 0;
      out.push({ l2: s.l2 + have, held, admitted: s.admitted });
    }
  }

  // Roll: the L2 fixed window rolls over — l2 and admitted reset.
  if (p.variant === "windowCoupled") {
    // Window-coupled: local credits EXPIRE at the boundary (no carryover).
    out.push({ l2: p.limit, held: s.held.map(() => 0), admitted: 0 });
  } else {
    // Baseline: local credits CARRY OVER unchanged (the sole source of overshoot).
    out.push({ l2: p.limit, held: s.held, admitted: 0 });
  }

  return out;
}

/** Exhaustive BFS over all reachable states; asserts the invariants on each. */
function explore(p: Params): { distinct: number; maxAdmittedSeen: number } {
  const bound = boundFor(p);
  const init: State = {
    l2: p.limit,
    held: Array.from({ length: p.nodes }, () => 0),
    admitted: 0,
  };

  const visited = new Set<string>([keyOf(init)]);
  const queue: State[] = [init];
  let maxAdmittedSeen = 0;

  while (queue.length > 0) {
    const s = queue.pop() as State;

    // Invariants on EVERY reachable state. Plain throws (not per-state `expect`) keep the
    // exhaustive sweep fast at large N; a violation fails the test with the offending state.
    if (s.l2 < 0 || s.l2 > p.limit) {
      throw new Error(`TypeOK(l2) violated: ${s.l2} not in 0..${p.limit}`);
    }
    if (s.held.length !== p.nodes) {
      throw new Error(`TypeOK(held) violated: length ${s.held.length} != ${p.nodes}`);
    }
    for (const c of s.held) {
      if (c < 0 || c > p.batch - 1) {
        throw new Error(`TypeOK(held) violated: credit ${c} not in 0..${p.batch - 1}`);
      }
    }
    // Overshoot: admitted never exceeds the variant's bound, on every reachable state.
    if (s.admitted > bound) {
      throw new Error(`Overshoot violated: admitted=${s.admitted} > bound=${bound} at ${keyOf(s)}`);
    }

    if (s.admitted > maxAdmittedSeen) maxAdmittedSeen = s.admitted;

    for (const next of successors(p, s)) {
      const k = keyOf(next);
      if (!visited.has(k)) {
        visited.add(k);
        queue.push(next);
      }
    }
  }

  return { distinct: visited.size, maxAdmittedSeen };
}

describe("GALE leasing variants (exhaustive model check)", () => {
  describe("harness validation — reproduce committed DistributedLeasing.tla / TLC results", () => {
    it("baseline N=2,L=4,B=2: 31 distinct states, tight max admitted 6 (= L+N(B-1))", () => {
      const p: Params = { nodes: 2, limit: 4, batch: 2, variant: "baseline", allowReturn: false };
      const { distinct, maxAdmittedSeen } = explore(p);
      expect(distinct).toBe(31);
      expect(maxAdmittedSeen).toBe(boundFor(p));
      expect(maxAdmittedSeen).toBe(6);
    });

    it("baseline N=3,L=6,B=3: 441 distinct states, tight max admitted 12 (= L+N(B-1))", () => {
      const p: Params = { nodes: 3, limit: 6, batch: 3, variant: "baseline", allowReturn: false };
      const { distinct, maxAdmittedSeen } = explore(p);
      expect(distinct).toBe(441);
      expect(maxAdmittedSeen).toBe(boundFor(p));
      expect(maxAdmittedSeen).toBe(12);
    });
  });

  describe("keystone — window-coupled credits give overshoot INDEPENDENT of N", () => {
    it("at fixed L=8,B=2: baseline grows as L+N(B-1) while window-coupled stays exactly L", () => {
      const L = 8;
      const B = 2;
      // Exhaustive up to N=8 (the reachable state space grows ~2^N); beyond this the bound L is
      // immediate — window-coupling leaves zero carryover, so any one window admits at most its
      // budget L regardless of N. (The at-scale behaviour is measured in the evaluation harness.)
      for (const N of [1, 2, 4, 8]) {
        const base = explore({
          nodes: N,
          limit: L,
          batch: B,
          variant: "baseline",
          allowReturn: false,
        });
        // Returns disabled here to isolate the carryover effect (their safety-compatibility is
        // covered by the tightness tests below); this keeps the swept state space small.
        const coupled = explore({
          nodes: N,
          limit: L,
          batch: B,
          variant: "windowCoupled",
          allowReturn: false,
        });

        // Baseline overshoot scales with the fleet size N.
        expect(base.maxAdmittedSeen).toBe(L + N * (B - 1));
        // Window-coupled overshoot is zero — bound is exactly L, for every N.
        expect(coupled.maxAdmittedSeen).toBe(L);
      }
    });
  });

  describe("tightness — window-coupled attains exactly L (loses no steady-state capacity)", () => {
    it.each([
      { nodes: 3, limit: 6, batch: 3 },
      { nodes: 5, limit: 10, batch: 2 },
      { nodes: 4, limit: 12, batch: 4 },
    ])(
      "N=$nodes,L=$limit,B=$batch reaches admitted == L under returns",
      ({ nodes, limit, batch }) => {
        const { maxAdmittedSeen } = explore({
          nodes,
          limit,
          batch,
          variant: "windowCoupled",
          allowReturn: true,
        });
        expect(maxAdmittedSeen).toBe(limit);
      },
    );
  });

  it("batch=1 has no carryover in either variant — both equal exactly Limit", () => {
    // With Batch=1, credits are always 0 (range 0..0), so there is nothing to carry: the
    // baseline already degrades to the window budget, matching window-coupled.
    const base = explore({ nodes: 3, limit: 5, batch: 1, variant: "baseline", allowReturn: false });
    const coupled = explore({
      nodes: 3,
      limit: 5,
      batch: 1,
      variant: "windowCoupled",
      allowReturn: true,
    });
    expect(base.maxAdmittedSeen).toBe(5);
    expect(coupled.maxAdmittedSeen).toBe(5);
  });
});
