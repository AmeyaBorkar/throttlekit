/**
 * Reproducible BFS state-count harness for MODULE GaleFederatedLeasing
 * (spec/GaleFederatedLeasing.tla).
 *
 * GaleFederatedLeasing is a literal relabeling of GaleWindowCoupledLeasing
 * (Node → Region, credits → escrow, l2 → globalBudget). Because the
 * transition system is isomorphic, this BFS — which already serves as the
 * CI-runnable, Java-free twin of GaleWindowCoupledLeasing in
 * `test/gale/leasing-variants.test.ts` — also produces the TLC distinct-
 * state counts for the federated spec at the matching configs.
 *
 * Running:
 *
 *     npx tsx research/bigger-bets/federation/tla-counts.ts
 *
 * Output: a markdown table of (distinct states, max admitted) for the
 * baseline (carryover) and federated window-coupled variants across the
 * standard small configs. The output is pasted into DESIGN.md §4.
 *
 * This script intentionally stands alone — no imports from `src/` — so
 * a reviewer can re-run it without a built tree. It re-implements the BFS
 * inline; the canonical reference is `test/gale/leasing-variants.test.ts`.
 */

type Variant = "baseline" | "windowCoupled";

interface Params {
  readonly regions: number;
  readonly limit: number;
  readonly batch: number;
  readonly variant: Variant;
}

interface State {
  readonly globalBudget: number;
  readonly escrow: readonly number[];
  readonly admitted: number;
}

const bound = (p: Params): number =>
  p.variant === "baseline" ? p.limit + p.regions * (p.batch - 1) : p.limit;

const keyOf = (s: State): string => `${s.globalBudget}|${s.escrow.join(",")}|${s.admitted}`;

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

function explore(p: Params): { distinct: number; maxAdmitted: number; depth: number } {
  const init: State = {
    globalBudget: p.limit,
    escrow: Array.from({ length: p.regions }, () => 0),
    admitted: 0,
  };

  const visited = new Map<string, number>(); // key -> depth at first visit
  visited.set(keyOf(init), 0);

  const queue: { s: State; d: number }[] = [{ s: init, d: 0 }];
  let maxAdmitted = 0;
  let depth = 0;
  const b = bound(p);

  while (queue.length > 0) {
    // queue.shift() would be O(n²); use a moving head index instead.
    const head = queue.shift();
    if (head === undefined) break;
    const { s, d } = head;
    depth = Math.max(depth, d);

    // Invariants — fail loudly if the spec is broken.
    if (s.globalBudget < 0 || s.globalBudget > p.limit) {
      throw new Error(`TypeOK(globalBudget) violated: ${s.globalBudget}`);
    }
    if (s.escrow.length !== p.regions) {
      throw new Error(`TypeOK(escrow) violated: length ${s.escrow.length} != ${p.regions}`);
    }
    for (const e of s.escrow) {
      if (e < 0 || e > p.batch - 1) throw new Error(`TypeOK(escrow) violated: ${e}`);
    }
    if (s.admitted > b) {
      throw new Error(`Overshoot violated at ${keyOf(s)}: ${s.admitted} > ${b}`);
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

const configs: Array<{ label: string; p: Params }> = [
  // Small config — matches DistributedLeasing.cfg / GaleWindowCoupledLeasing tests for Nodes=2.
  { label: "K=2, Limit=4, Batch=2", p: { regions: 2, limit: 4, batch: 2, variant: "baseline" } },
  {
    label: "K=2, Limit=4, Batch=2",
    p: { regions: 2, limit: 4, batch: 2, variant: "windowCoupled" },
  },
  // Mid config — matches GaleWindowCoupledLeasing.cfg (Regions=3, Limit=6, Batch=3).
  { label: "K=3, Limit=6, Batch=3", p: { regions: 3, limit: 6, batch: 3, variant: "baseline" } },
  {
    label: "K=3, Limit=6, Batch=3",
    p: { regions: 3, limit: 6, batch: 3, variant: "windowCoupled" },
  },
  // Stretch — five regions; demonstrates federation's K-independence vs baseline scaling.
  { label: "K=5, Limit=10, Batch=2", p: { regions: 5, limit: 10, batch: 2, variant: "baseline" } },
  {
    label: "K=5, Limit=10, Batch=2",
    p: { regions: 5, limit: 10, batch: 2, variant: "windowCoupled" },
  },
];

console.log("");
console.log("| Config | Variant | Distinct states | Max admitted | Bound | Tight? |");
console.log("|---|---|---:|---:|---:|:---:|");
for (const { label, p } of configs) {
  const { distinct, maxAdmitted } = explore(p);
  const b = bound(p);
  const tight = maxAdmitted === b ? "✓" : "—";
  const variantStr =
    p.variant === "windowCoupled" ? "federated (window-coupled)" : "baseline (carryover)";
  console.log(`| ${label} | ${variantStr} | ${distinct} | ${maxAdmitted} | ${b} | ${tight} |`);
}
console.log("");
console.log("Bounds:");
console.log("  baseline  (carryover):       Limit + K * (Batch - 1)   [K-dependent]");
console.log("  federated (window-coupled):  Limit                      [K-INDEPENDENT]");
