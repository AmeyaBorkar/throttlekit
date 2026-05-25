import { describe, expect, it } from "vitest";

/**
 * Exhaustive (BFS) model check of ThrottleKit's distributed leasing overshoot
 * bound — the CI-runnable, Java-free twin of spec/DistributedLeasing.tla.
 *
 * It reproduces the SAME finite transition system the TLA+ spec model-checks
 * with TLC, modelling the `leased` branch of src/twotier/index.ts with the
 * default `lowWater = 0` (lease-on-demand) and a per-request cost of 1:
 *
 *   - Serve(n): the `have >= cost` fast path — consume one local credit,
 *               admit, do not touch L2.
 *   - Lease(n): lease-on-demand — when credits[n] = 0 and L2 can fit a whole
 *               Batch (l2 >= Batch), one round trip removes Batch from the
 *               window, the triggering request is served, and Batch-1 credits
 *               are retained locally.
 *   - Roll:     the L2 window rolls over — l2 and admitted reset, but local
 *               credits CARRY OVER (the code never clears them at a window
 *               boundary). This carryover is the sole source of overshoot.
 *
 * The proved bound, per L2 window:
 *
 *   admitted <= Limit + N * (Batch - 1)        where N = |Nodes|
 *
 * We enumerate EVERY reachable state and assert (a) Overshoot holds on all of
 * them and (b) the bound is tight (some reachable state attains it).
 */

interface Params {
  readonly nodes: number;
  readonly limit: number;
  readonly batch: number;
}

interface State {
  /** Remaining L2 budget in the current window, in 0..limit. */
  readonly l2: number;
  /** credits[i] in 0..(batch-1): node i's unconsumed leased tokens. */
  readonly credits: readonly number[];
  /** Requests admitted in the CURRENT window. */
  readonly admitted: number;
}

const maxAdmitted = (p: Params): number => p.limit + p.nodes * (p.batch - 1);

/** Canonical key for the visited set. admitted is part of the state. */
const keyOf = (s: State): string => `${s.l2}|${s.credits.join(",")}|${s.admitted}`;

/** All successor states of `s` under Next = \E n: Serve(n) \/ Lease(n) \/ Roll. */
function successors(p: Params, s: State): State[] {
  const out: State[] = [];

  for (let n = 0; n < p.nodes; n++) {
    const have = s.credits[n] ?? 0;

    // Serve(n): credit hit — credits[n] >= 1.
    if (have >= 1) {
      const credits = s.credits.slice();
      credits[n] = have - 1;
      out.push({ l2: s.l2, credits, admitted: s.admitted + 1 });
    }

    // Lease(n): credits[n] = 0 and a whole Batch fits (l2 >= batch).
    if (have === 0 && s.l2 >= p.batch) {
      const credits = s.credits.slice();
      credits[n] = p.batch - 1;
      out.push({ l2: s.l2 - p.batch, credits, admitted: s.admitted + 1 });
    }
  }

  // Roll: window refill — l2 and admitted reset; credits carry over.
  out.push({ l2: p.limit, credits: s.credits, admitted: 0 });

  return out;
}

/** Exhaustive BFS over all reachable states. Returns the witnessed maximum. */
function explore(p: Params): { distinct: number; maxAdmittedSeen: number } {
  const init: State = {
    l2: p.limit,
    credits: Array.from({ length: p.nodes }, () => 0),
    admitted: 0,
  };
  const bound = maxAdmitted(p);

  const visited = new Set<string>();
  const queue: State[] = [init];
  visited.add(keyOf(init));
  let maxAdmittedSeen = 0;

  while (queue.length > 0) {
    const s = queue.pop() as State;

    // Invariant: TypeOK ranges hold on every reachable state.
    expect(s.l2).toBeGreaterThanOrEqual(0);
    expect(s.l2).toBeLessThanOrEqual(p.limit);
    expect(s.credits).toHaveLength(p.nodes);
    for (const c of s.credits) {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(p.batch - 1);
    }

    // Invariant: Overshoot — admitted never exceeds the bound.
    expect(s.admitted).toBeLessThanOrEqual(bound);

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

describe("distributed leasing overshoot bound (exhaustive model check)", () => {
  it("Overshoot holds on every reachable state — N=2, Limit=4, Batch=2 (bound 6)", () => {
    const p: Params = { nodes: 2, limit: 4, batch: 2 };
    const { distinct, maxAdmittedSeen } = explore(p);
    // Matches TLC: 31 distinct states for this config.
    expect(distinct).toBe(31);
    // Tightness: the bound is actually attained by some reachable state.
    expect(maxAdmittedSeen).toBe(maxAdmitted(p));
    expect(maxAdmittedSeen).toBe(6);
  });

  it("Overshoot holds on every reachable state — N=3, Limit=6, Batch=3 (bound 12)", () => {
    const p: Params = { nodes: 3, limit: 6, batch: 3 };
    const { distinct, maxAdmittedSeen } = explore(p);
    // Matches TLC: 441 distinct states for this config.
    expect(distinct).toBe(441);
    expect(maxAdmittedSeen).toBe(maxAdmitted(p));
    expect(maxAdmittedSeen).toBe(12);
  });

  it("the tight bound MaxAdmitted-1 is violated by some reachable state (bound is exact)", () => {
    // The dual of the TLA+ `OvershootTight` invariant: there exists a reachable
    // state with admitted = MaxAdmitted, so `admitted <= MaxAdmitted - 1` fails.
    for (const p of [
      { nodes: 2, limit: 4, batch: 2 },
      { nodes: 3, limit: 6, batch: 3 },
    ] as const) {
      const { maxAdmittedSeen } = explore(p);
      expect(maxAdmittedSeen).toBeGreaterThan(maxAdmitted(p) - 1);
    }
  });

  it("batch=1 means zero overshoot — admitted never exceeds Limit", () => {
    // With Batch=1, credits are always 0 (range 0..0): no carryover, so the
    // leased mode degrades to exactly the L2 budget per window.
    const p: Params = { nodes: 3, limit: 5, batch: 1 };
    const { maxAdmittedSeen } = explore(p);
    expect(maxAdmitted(p)).toBe(5);
    expect(maxAdmittedSeen).toBe(5);
  });
});
