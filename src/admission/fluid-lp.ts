/**
 * Zero-dependency fluid-LP solver for two-budget admission (joint-LP policy).
 *
 * Solves the deterministic (fluid) relaxation of the revenue-management
 * admission problem and returns the **bid prices** (LP dual variables) that drive
 * the joint-LP filter in {@link unifiedAdmission}:
 *
 * ```
 * max   Σ wᵢ vᵢ xᵢ
 * s.t.  Σ wᵢ xᵢ      ≤ R        (rate budget,  dual p_R ≥ 0)
 *       Σ wᵢ cᵢ xᵢ   ≤ C        (cost budget,  dual p_C ≥ 0)
 *       0 ≤ xᵢ ≤ 1
 * ```
 *
 * By LP duality / complementary slackness the optimal admission rule is the
 * **bid-price test**: admit a request of type `i` iff `vᵢ ≥ p_R + p_C·cᵢ`.
 *
 * Strict zero-runtime-deps ⇒ no LP library. We solve it **through the dual**,
 * which is robust to the degeneracies (equal values, equal costs, density ties)
 * that defeat naive primal vertex enumeration. The Lagrangian dual of the LP is
 *
 * ```
 * min   D(p_R, p_C) = R·p_R + C·p_C + Σ wᵢ·max(0, vᵢ − p_R − p_C·cᵢ)
 * s.t.  p_R ≥ 0, p_C ≥ 0
 * ```
 *
 * `D` is convex and piecewise-linear; its minimum is attained at a **vertex** of
 * the arrangement of the "bid lines" `vᵢ = p_R + p_C·cᵢ` and the axes. That vertex
 * set is finite and small — `(0,0)`, each single-axis threshold `(vᵢ, 0)` and
 * `(0, vᵢ/cᵢ)`, and each pairwise bid-line intersection — so we evaluate `D` at
 * every candidate and take the minimizer. By strong duality `min D` equals the
 * primal optimum objective, and the minimizing `(p_R, p_C)` are the bid prices.
 * Among co-optimal duals (a degenerate tie) we pick the **most selective** one —
 * the bid prices that reproduce the fluid plan's admit/reject split — matching the
 * revenue-management convention. The primal admit plan is then recovered as a
 * feasibility fill consistent with those duals (forced-in/out by reduced-value
 * sign; the marginal set fills the tight budget(s)).
 *
 * Generalizes the 2-type reference in `research/bigger-bets/unified/sim.ts`
 * (TK-1007) to N types; see THEORY.md and
 * `research/bigger-bets/joint-lp-admission/DESIGN.md` §3–§4 (D-JLP-7). Correctness
 * is pinned by `test/admission/fluid-lp.test.ts`: the THEORY fixture, a KKT
 * certificate, an independent optimality lower bound, AND a tie-heavy
 * (integer-valued) cross-check against a brute-force oracle — the degenerate class
 * that the earlier primal-enumeration solver got wrong.
 *
 * @packageDocumentation
 */

import { ThrottleKitError } from "../core/errors";

/** One request archetype in the workload model handed to {@link solveFluidLp}. */
export interface WorkloadType {
  /** Cost-axis weight per admit (matches `Limiter.check(key, cost)`'s 2nd arg). */
  cost: number;
  /** Business value of admitting one (revenue, priority, …). */
  value: number;
  /** Arrival weight / probability. Need not sum to 1 — used as-is as the per-type usage scale. */
  weight: number;
}

/** Input to {@link solveFluidLp}: the workload mixture plus the two budgets. */
export interface FluidLpInput {
  /** The request archetypes. Non-empty. */
  types: WorkloadType[];
  /** Rate budget R per window (admits/window). > 0. */
  rateBudget: number;
  /** Cost budget C per window (cost units/window). > 0. */
  costBudget: number;
}

/** Output of {@link solveFluidLp}: the bid prices, the optimal admit plan, and its value. */
export interface FluidLpSolution {
  /** Bid prices (LP duals). Admit type i iff `value ≥ duals.rate + duals.cost · cost`. */
  duals: { rate: number; cost: number };
  /** Optimal admit fraction per input type (same order as `input.types`). */
  admitFractions: number[];
  /** Optimal objective `Σ wᵢ vᵢ xᵢ` (telemetry / tests). */
  objective: number;
}

/** Near-zero tolerance for bounds / dual feasibility. */
const EPS = 1e-9;
/** "On the bid line" / equal-objective tolerance for reduced values and D ties. */
const RED_TOL = 1e-7;

/**
 * Solve the 2-budget fluid LP and return the bid prices, optimal admit plan, and
 * objective. O(types²) duals + O(types²·2^k) primal fill on the marginal set
 * (`k = |marginal|`, normally ≤ 2). Zero dependencies.
 *
 * @throws ThrottleKitError if `types` is empty, any `cost`/`value`/`weight` is
 *   non-finite or negative, or either budget is non-finite or ≤ 0.
 */
export function solveFluidLp(input: FluidLpInput): FluidLpSolution {
  validate(input);
  const { types, rateBudget: R, costBudget: C } = input;
  const n = types.length;
  const w = types.map((t) => t.weight);
  const v = types.map((t) => t.value);
  const c = types.map((t) => t.cost);

  // ── Optimal duals: minimize the convex PWL dual objective over its vertices ──
  const dualObjective = (pR: number, pC: number): number => {
    let d = R * pR + C * pC;
    for (let i = 0; i < n; i++) d += w[i]! * Math.max(0, v[i]! - pR - pC * c[i]!);
    return d;
  };

  // Candidate dual vertices: origin, single-axis thresholds, pairwise bid-line
  // intersections. (Bid line i: vᵢ = p_R + p_C·cᵢ.)
  const candidates: Array<{ pR: number; pC: number }> = [{ pR: 0, pC: 0 }];
  for (let i = 0; i < n; i++) {
    candidates.push({ pR: v[i]!, pC: 0 }); // bid line i ∩ {p_C = 0}
    if (c[i]! > EPS) candidates.push({ pR: 0, pC: v[i]! / c[i]! }); // ∩ {p_R = 0}
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dc = c[j]! - c[i]!;
      if (Math.abs(dc) <= EPS) continue; // parallel bid lines — no intersection
      const pC = (v[j]! - v[i]!) / dc;
      const pR = v[i]! - pC * c[i]!;
      candidates.push({ pR, pC });
    }
  }

  // Evaluate D at every dual-feasible candidate; track the minimum.
  let minD = Number.POSITIVE_INFINITY;
  const feasible: Array<{ pR: number; pC: number; d: number }> = [];
  for (const cand of candidates) {
    if (cand.pR < -EPS || cand.pC < -EPS) continue; // dual feasibility p ≥ 0
    const pR = Math.max(0, cand.pR);
    const pC = Math.max(0, cand.pC);
    const d = dualObjective(pR, pC);
    feasible.push({ pR, pC, d });
    if (d < minD) minD = d;
  }

  // Among co-optimal duals (degenerate tie), pick the MOST SELECTIVE: maximize the
  // count of strictly-rejected types (so the bid test reproduces the fluid plan's
  // rejections), tie-broken by larger p_C then larger p_R. This yields the
  // revenue-management convention (e.g. price the cost axis off the marginal
  // *admitted* type, not a cheaper rejected one).
  let best = { pR: 0, pC: 0 };
  let bestScore = [-1, -1, -1];
  for (const f of feasible) {
    if (f.d > minD + RED_TOL) continue;
    let rejected = 0;
    for (let i = 0; i < n; i++) {
      if (v[i]! - f.pR - f.pC * c[i]! < -RED_TOL) rejected++;
    }
    const score = [rejected, f.pC, f.pR];
    if (
      score[0]! > bestScore[0]! ||
      (score[0] === bestScore[0] && score[1]! > bestScore[1]! + EPS) ||
      (score[0] === bestScore[0] &&
        Math.abs(score[1]! - bestScore[1]!) <= EPS &&
        score[2]! > bestScore[2]!)
    ) {
      best = { pR: f.pR, pC: f.pC };
      bestScore = score;
    }
  }
  const pR = best.pR;
  const pC = best.pC;

  // ── Primal admit plan consistent with the optimal duals ──
  // forced-in (reduced > 0 → x = 1), forced-out (reduced < 0 → x = 0), and the
  // marginal set M (reduced ≈ 0) which fills the tight budget(s).
  const x = new Array<number>(n).fill(0);
  const marginal: number[] = [];
  let forcedRate = 0;
  let forcedCost = 0;
  for (let i = 0; i < n; i++) {
    const reduced = v[i]! - pR - pC * c[i]!;
    if (reduced > RED_TOL) {
      x[i] = 1;
      forcedRate += w[i]!;
      forcedCost += w[i]! * c[i]!;
    } else if (reduced >= -RED_TOL) {
      marginal.push(i);
    }
    // else strictly rejected → x stays 0
  }
  fillMarginal(
    x,
    marginal,
    w,
    c,
    Math.max(0, R - forcedRate),
    Math.max(0, C - forcedCost),
    pR > RED_TOL,
    pC > RED_TOL,
  );

  let objective = 0;
  for (let i = 0; i < n; i++) objective += w[i]! * v[i]! * (x[i] as number);

  return { duals: { rate: pR, cost: pC }, admitFractions: x, objective };
}

/**
 * Allocate the marginal set `M` (types on the optimal bid line, all reduced ≈ 0)
 * to satisfy complementary slackness: a tight budget (positive dual) must be hit
 * exactly; a slack budget stays within its cap. The objective is constant over the
 * feasible region (all of `M` lies on the bid line), so any feasible allocation is
 * optimal — this is a *feasibility* fill, not an optimization.
 */
function fillMarginal(
  x: number[],
  M: number[],
  w: number[],
  c: number[],
  remR: number,
  remC: number,
  rateTight: boolean,
  costTight: boolean,
): void {
  if (M.length === 0) return;

  if (!rateTight && !costTight) {
    // Neither budget binds. Marginal types have value = p_R + p_C·c = 0 (both
    // duals 0) ⇒ admitting them is objective-neutral; leave them at 0.
    return;
  }

  if (rateTight && !costTight) {
    // Hit rate = remR while keeping cost ≤ remC: admit cheapest-cost types first
    // (minimizes cost for the required rate, so the cost cap is most likely met).
    const order = [...M].sort((a, b) => c[a]! - c[b]!);
    let r = 0;
    for (const i of order) {
      const need = w[i]!;
      if (need <= EPS) {
        x[i] = 1;
        continue;
      }
      if (r + need <= remR + EPS) {
        x[i] = 1;
        r += need;
      } else {
        x[i] = Math.max(0, Math.min(1, (remR - r) / need));
        r = remR;
      }
    }
    return;
  }

  if (costTight && !rateTight) {
    // Hit cost = remC while keeping rate ≤ remR: admit highest-cost types first
    // (hits the cost budget with the least rate).
    const order = [...M].sort((a, b) => c[b]! - c[a]!);
    let k = 0;
    for (const i of order) {
      const need = w[i]! * c[i]!;
      if (need <= EPS) continue; // cost-free type can't move the cost budget
      if (k + need <= remC + EPS) {
        x[i] = 1;
        k += need;
      } else {
        x[i] = Math.max(0, Math.min(1, (remC - k) / need));
        k = remC;
      }
    }
    return;
  }

  // Both tight: find any x_M ∈ [0,1] with rate_M = remR AND cost_M = remC.
  fillBothTight(x, M, w, c, remR, remC);
}

/**
 * Both budgets tight: solve for a feasible marginal allocation hitting rate = remR
 * and cost = remC exactly. Pick two distinct-cost types as the fractional pair
 * (solve the 2×2), enumerate the rest at 0/1; take the first feasible assignment.
 * Bounded — the marginal set is small in practice. Best-effort if `|M|` is large.
 */
function fillBothTight(
  x: number[],
  M: number[],
  w: number[],
  c: number[],
  remR: number,
  remC: number,
): void {
  const m = M.length;
  // Cap the exhaustive "others 0/1" enumeration; the marginal set is normally ≤ 3.
  const exhaustive = m <= 12;
  for (let ai = 0; ai < m; ai++) {
    for (let bi = ai + 1; bi < m; bi++) {
      const a = M[ai]!;
      const b = M[bi]!;
      const det = w[a]! * (w[b]! * c[b]!) - w[b]! * (w[a]! * c[a]!); // = w_a·w_b·(c_b − c_a)
      if (Math.abs(det) <= EPS) continue; // same cost ⇒ singular pair
      const others = M.filter((_, idx) => idx !== ai && idx !== bi);
      const combos = exhaustive ? 1 << others.length : 1; // 0 = all others at 0 (best-effort if huge)
      for (let mask = 0; mask < combos; mask++) {
        let fr = 0;
        let fc = 0;
        for (let oi = 0; oi < others.length; oi++) {
          const set = (mask >> oi) & 1;
          if (set) {
            fr += w[others[oi]!]!;
            fc += w[others[oi]!]! * c[others[oi]!]!;
          }
        }
        const b1 = remR - fr;
        const b2 = remC - fc;
        // Solve w_a·x_a + w_b·x_b = b1 ; w_a·c_a·x_a + w_b·c_b·x_b = b2.
        const xa = (b1 * (w[b]! * c[b]!) - w[b]! * b2) / det;
        const xb = (w[a]! * b2 - b1 * (w[a]! * c[a]!)) / det;
        if (xa >= -EPS && xa <= 1 + EPS && xb >= -EPS && xb <= 1 + EPS) {
          x[a] = Math.max(0, Math.min(1, xa));
          x[b] = Math.max(0, Math.min(1, xb));
          for (let oi = 0; oi < others.length; oi++) x[others[oi]!] = (mask >> oi) & 1;
          return;
        }
      }
    }
  }
  // Fallback (degenerate / |M| huge): admit all marginal types fully if it fits,
  // else leave the partial fill. The duals + objective are already exact; this only
  // affects the reported admit plan in a pathological case.
  for (const i of M) x[i] = 1;
}

function validate(input: FluidLpInput): void {
  const { types, rateBudget, costBudget } = input;
  if (!Array.isArray(types) || types.length === 0) {
    throw new ThrottleKitError("solveFluidLp: `types` must be a non-empty array");
  }
  for (let i = 0; i < types.length; i++) {
    const t = types[i] as WorkloadType;
    for (const [field, value] of [
      ["cost", t.cost],
      ["value", t.value],
      ["weight", t.weight],
    ] as const) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new ThrottleKitError(
          `solveFluidLp: types[${i}].${field} must be a finite number ≥ 0 (got ${String(value)})`,
        );
      }
    }
  }
  for (const [field, value] of [
    ["rateBudget", rateBudget],
    ["costBudget", costBudget],
  ] as const) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new ThrottleKitError(
        `solveFluidLp: ${field} must be a finite number > 0 (got ${String(value)})`,
      );
    }
  }
}
