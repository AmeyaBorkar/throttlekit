/**
 * BFS twin of MODULE GaleFederatedLeasing (`spec/GaleFederatedLeasing.tla`).
 *
 * GaleFederatedLeasing is a literal relabeling of GaleWindowCoupledLeasing
 * (`Nodes → Regions`, `credits → escrow`, `l2 → globalBudget`); the
 * transition system is isomorphic. This module reproduces TLC's distinct-
 * state counts in CI without Java.
 *
 * Anchor / harness validation: the BASELINE (carryover) variant — at
 * `K=2, L=4, B=2` and `K=3, L=6, B=3` — matches the committed TLC counts
 * in `spec/README.md` byte-for-byte (31 and 441 distinct states). That
 * validates the JS BFS is faithful to TLC's exploration; the FEDERATED
 * (window-coupled) variant rows are the contribution this BFS commits.
 *
 * Shared between the federated test and the standalone reproduction
 * script (`research/bigger-bets/federation/tla-counts.ts`); kept here
 * (test/) rather than in src/ because it has no production role.
 */

/** Variant: which spec do we model? */
export type Variant = "baseline" | "windowCoupled";

export interface Params {
  /** Number of regions (corresponds to `Nodes` in baseline / `Regions` in federated). */
  readonly regions: number;
  /** Global budget per window. */
  readonly limit: number;
  /** Per-region escrow lease size. */
  readonly batch: number;
  /** Which transition system to model. */
  readonly variant: Variant;
}

export interface State {
  readonly globalBudget: number;
  readonly escrow: readonly number[];
  readonly admitted: number;
}

export interface ExploreResult {
  /** Total distinct reachable states (matches TLC's "distinct states found"). */
  distinct: number;
  /** Tightest admitted observed (witness of bound tightness). */
  maxAdmitted: number;
  /** Maximum BFS depth (matches TLC's "depth of the complete state graph search"). */
  depth: number;
}

/** The proven per-global-window upper bound for the variant. */
export function boundFor(p: Params): number {
  return p.variant === "baseline" ? p.limit + p.regions * (p.batch - 1) : p.limit;
}

/** Canonical state key. Admitted IS part of the state — distinct states track it. */
const keyOf = (s: State): string => `${s.globalBudget}|${s.escrow.join(",")}|${s.admitted}`;

/** All successor states of `s` under Next = ∃ r: Serve(r) ∨ Lease(r) ∨ Roll. */
function successors(p: Params, s: State): State[] {
  const out: State[] = [];

  for (let r = 0; r < p.regions; r++) {
    const have = s.escrow[r] ?? 0;

    // Serve(r): regional-L2 hit — consume one escrow unit, admit, no global RTT.
    if (have >= 1) {
      const escrow = s.escrow.slice();
      escrow[r] = have - 1;
      out.push({ globalBudget: s.globalBudget, escrow, admitted: s.admitted + 1 });
    }

    // Lease(r): out of escrow and a whole Batch fits in the global window budget.
    if (have === 0 && s.globalBudget >= p.batch) {
      const escrow = s.escrow.slice();
      escrow[r] = p.batch - 1;
      out.push({
        globalBudget: s.globalBudget - p.batch,
        escrow,
        admitted: s.admitted + 1,
      });
    }
  }

  // Roll: the global window rolls.
  if (p.variant === "windowCoupled") {
    // Federated window-coupling: regional escrow EXPIRES at the boundary.
    out.push({ globalBudget: p.limit, escrow: s.escrow.map(() => 0), admitted: 0 });
  } else {
    // Baseline: regional escrow CARRIES OVER (the sole source of Δ).
    out.push({ globalBudget: p.limit, escrow: s.escrow, admitted: 0 });
  }

  return out;
}

/**
 * Exhaustive BFS over the reachable state space. Asserts the TLA⁺
 * invariants (`TypeOK`, `Overshoot`) on every reachable state — throws on
 * a violation with the offending state in the message, so a test sees
 * which configuration broke.
 */
export function explore(p: Params): ExploreResult {
  const init: State = {
    globalBudget: p.limit,
    escrow: Array.from({ length: p.regions }, () => 0),
    admitted: 0,
  };

  const bound = boundFor(p);
  const visited = new Map<string, number>([[keyOf(init), 0]]);
  // Moving-head deque so we don't pay O(n) for queue.shift().
  const queue: { s: State; d: number }[] = [{ s: init, d: 0 }];
  let head = 0;
  let depth = 0;
  let maxAdmitted = 0;

  while (head < queue.length) {
    const entry = queue[head] as { s: State; d: number };
    head++;
    const { s, d } = entry;
    if (d > depth) depth = d;

    // TypeOK + Overshoot — fail loudly with the offending state if the spec is broken.
    if (s.globalBudget < 0 || s.globalBudget > p.limit) {
      throw new Error(`TypeOK(globalBudget) violated: ${s.globalBudget} at ${keyOf(s)}`);
    }
    if (s.escrow.length !== p.regions) {
      throw new Error(
        `TypeOK(escrow) violated: length ${s.escrow.length} != ${p.regions} at ${keyOf(s)}`,
      );
    }
    for (const e of s.escrow) {
      if (e < 0 || e > p.batch - 1) {
        throw new Error(
          `TypeOK(escrow) violated: credit ${e} not in 0..${p.batch - 1} at ${keyOf(s)}`,
        );
      }
    }
    if (s.admitted > bound) {
      throw new Error(`Overshoot violated at ${keyOf(s)}: admitted=${s.admitted} > bound=${bound}`);
    }
    if (s.admitted > maxAdmitted) maxAdmitted = s.admitted;

    for (const next of successors(p, s)) {
      const k = keyOf(next);
      if (!visited.has(k)) {
        visited.set(k, d + 1);
        queue.push({ s: next, d: d + 1 });
      }
    }
  }

  return { distinct: visited.size, maxAdmitted, depth };
}
