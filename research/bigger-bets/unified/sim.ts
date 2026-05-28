/**
 * TK-1007 — Joint-LP vs marginal-AND toy simulation.
 *
 * Empirical calibration of ε := regret(marginal-AND) − regret(joint-LP)
 * on a bivariate request workload, sweeping the autocorrelation
 * ρ ∈ [−1, +1]. Spec source:
 * `research/bigger-bets/unified/DESIGN.md` §7 + PLAN.md DR-11 / DR-19.
 *
 * Run with:
 *   npx tsx research/bigger-bets/unified/sim.ts
 *
 * Outputs RESULTS.csv (one row per (ρ, seed) configuration) plus a
 * summary table to stdout. THEORY.md interprets the numbers.
 *
 * ## The model
 *
 * Two-axis admission: a `rate` budget (R per window, one rate-unit per
 * request) and a `cost` budget (C per window, weight-dependent). Each
 * arrival is one of two types:
 *
 *   small: cost-weight c_s = 100   value v_s = 1     ("cheap LLM call")
 *   large: cost-weight c_l = 10000 value v_l = 50    ("expensive LLM call")
 *
 * Mixture is symmetric (π_s = π_l = 0.5). Arrivals are a 2-state
 * Markov chain on the type alphabet {small, large} with stay-probability
 *   P(same | prev) = (1 + ρ) / 2
 * which gives lag-1 autocorrelation exactly ρ. ρ = 0 is independent;
 * ρ = +1 is one type forever (only the first sample's type matters);
 * ρ = −1 is strict alternation.
 *
 * ## The three policies
 *
 * - **marginal-AND** (today's stacked-middleware behavior, equivalent
 *   to `unifiedAdmission`'s sequential mode in TK-1004): admit iff
 *   `rate.remaining ≥ 1 AND cost.remaining ≥ cost_i`. No price signal.
 *
 * - **joint-LP** (the candidate optimum per Devanur-Hayes 2009 /
 *   Talluri-van Ryzin): solve the *fluid LP* using the workload's
 *   expected distribution to obtain bid prices `(p_R, p_C)`; admit iff
 *   `(rate.remaining ≥ 1 AND cost.remaining ≥ cost_i) AND
 *    v_i ≥ p_R + p_C · cost_i`. The bid-price test filters out
 *   types that are *less revenue-efficient* than the LP allows.
 *
 * - **clairvoyant** (the upper bound): we use the fluid-LP value as
 *   the optimistic clairvoyant proxy. By Talluri-van Ryzin (1998),
 *   bid-price-controlled admission is *asymptotically* fluid-optimal,
 *   so the gap between joint-LP and clairvoyant shrinks as N grows.
 *   This is the standard regret-analysis baseline.
 *
 * ## What we measure
 *
 * For each (ρ, seed) tuple:
 *   1. Generate workload of N arrivals (Markov-correlated types).
 *   2. Run each policy through the workload; tally revenue.
 *   3. Regret_policy = (V_clairvoyant − V_policy) / V_clairvoyant.
 *
 * ε := mean(Regret_marginal) − mean(Regret_joint).
 *
 * Ship 0.10.1 joint-LP runtime iff ε ≥ 5% (DR-19); otherwise document
 * the negative result and hold.
 */

// ── Determinism: a seeded LCG PRNG ──────────────────────────────────────────────────────────────

/** Mulberry32 — a simple high-quality 32-bit PRNG. Pure; seedable; reproducible. */
function makeRng(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Workload generation ────────────────────────────────────────────────────────────────────────

interface Arrival {
  type: "small" | "large";
  cost: number;
  value: number;
}

const TYPE_PARAMS = {
  small: { cost: 100, value: 1 },
  large: { cost: 10_000, value: 50 },
} as const;

/**
 * Markov-correlated arrivals over {small, large}. Stationary symmetric
 * π_s = π_l = 0.5; lag-1 correlation exactly ρ via stay-probability
 * (1 + ρ) / 2.
 */
function generateWorkload(rho: number, N: number, rng: () => number): Arrival[] {
  const stayProb = (1 + rho) / 2; // ρ=+1 → 1 (sticky); ρ=0 → 0.5; ρ=−1 → 0 (alternating)
  let cur: "small" | "large" = rng() < 0.5 ? "small" : "large";
  const arrivals: Arrival[] = [];
  for (let i = 0; i < N; i++) {
    const params = TYPE_PARAMS[cur];
    arrivals.push({ type: cur, cost: params.cost, value: params.value });
    // Markov step: stay with stayProb, switch with (1 − stayProb).
    if (rng() >= stayProb) {
      cur = cur === "small" ? "large" : "small";
    }
  }
  return arrivals;
}

// ── Budgets ────────────────────────────────────────────────────────────────────────────────────

interface Budgets {
  R: number; // rate units (one per request)
  C: number; // cost units (tokens, etc.)
}

/**
 * Cost-binding regime: cost is the bottleneck; rate has slack. This is
 * where joint-LP can meaningfully beat marginal-AND — the bid-price
 * filter steers spend away from cost-inefficient types. With
 * v_s/c_s = 0.01 and v_l/c_l = 0.005, *small* is more efficient — so
 * the LP optimum admits small preferentially.
 */
const DEFAULT_BUDGETS: Budgets = { R: 1_000, C: 50_000 };

// ── Fluid LP (per-arrival admit fractions x_s, x_l ∈ [0,1]) ─────────────────────────────────────

interface FluidLP {
  x_s: number;
  x_l: number;
  /** Revenue per arrival at the optimum (times N gives total expected). */
  value: number;
  /** Bid prices (p_R, p_C) — the dual variables. */
  bidPrices: { p_R: number; p_C: number };
}

/**
 * Solve the per-arrival fluid LP for symmetric mixture (π_s = π_l = 0.5):
 *
 *   max 0.5 · v_s · x_s + 0.5 · v_l · x_l
 *   s.t. 0.5 · (x_s + x_l) ≤ R / N          (rate per arrival)
 *        0.5 · (c_s · x_s + c_l · x_l) ≤ C / N    (cost per arrival)
 *        x_s, x_l ∈ [0, 1]
 *
 * Solved by case analysis over the 5 candidate corners (and on the rate
 * / cost binding edges). Returns the optimum + bid prices from
 * complementary slackness.
 */
function solveFluidLP(budgets: Budgets, N: number): FluidLP {
  const { R, C } = budgets;
  const c_s = TYPE_PARAMS.small.cost;
  const c_l = TYPE_PARAMS.large.cost;
  const v_s = TYPE_PARAMS.small.value;
  const v_l = TYPE_PARAMS.large.value;
  const ratePerArrival = R / N;
  const costPerArrival = C / N;

  // Constraints (with 0.5 mixture factor folded in):
  // (i)  x_s + x_l ≤ 2 · ratePerArrival          (rate)
  // (ii) c_s · x_s + c_l · x_l ≤ 2 · costPerArrival  (cost)
  const A_rate = 2 * ratePerArrival; // RHS of (i)
  const A_cost = 2 * costPerArrival; // RHS of (ii)

  // Candidate vertices: (0,0), (min(1,A_rate),0), (0, min(1,A_rate)),
  // (min(1, A_cost/c_s), 0), (0, min(1, A_cost/c_l)), and the
  // intersection of (i) and (ii) inside [0,1]^2.
  const candidates: Array<{ x_s: number; x_l: number }> = [];
  const push = (x_s: number, x_l: number): void => {
    if (
      x_s >= -1e-9 &&
      x_s <= 1 + 1e-9 &&
      x_l >= -1e-9 &&
      x_l <= 1 + 1e-9 &&
      x_s + x_l <= A_rate + 1e-9 &&
      c_s * x_s + c_l * x_l <= A_cost + 1e-9
    ) {
      candidates.push({ x_s: Math.max(0, Math.min(1, x_s)), x_l: Math.max(0, Math.min(1, x_l)) });
    }
  };
  push(0, 0);
  push(Math.min(1, A_rate), 0);
  push(0, Math.min(1, A_rate));
  push(Math.min(1, A_cost / c_s), 0);
  push(0, Math.min(1, A_cost / c_l));
  // Intersection of (i) and (ii): x_s + x_l = A_rate, c_s x_s + c_l x_l = A_cost.
  // Solve: x_l (c_l − c_s) = A_cost − c_s · A_rate → x_l = (A_cost − c_s · A_rate) / (c_l − c_s).
  if (c_l !== c_s) {
    const x_l = (A_cost - c_s * A_rate) / (c_l - c_s);
    const x_s = A_rate - x_l;
    push(x_s, x_l);
  }
  push(1, 1);
  push(1, 0);
  push(0, 1);

  let best = { x_s: 0, x_l: 0, value: 0 };
  for (const cand of candidates) {
    const val = 0.5 * v_s * cand.x_s + 0.5 * v_l * cand.x_l;
    if (val > best.value) {
      best = { x_s: cand.x_s, x_l: cand.x_l, value: val };
    }
  }

  // Determine which constraints are binding (at the optimum) to derive
  // dual prices. p_R is positive iff (i) is tight; p_C is positive iff
  // (ii) is tight. We solve from the tight ones.
  const rateBinding = Math.abs(best.x_s + best.x_l - A_rate) < 1e-7;
  const costBinding = Math.abs(c_s * best.x_s + c_l * best.x_l - A_cost) < 1e-7;
  const smallAtMargin = best.x_s > 1e-7 && best.x_s < 1 - 1e-7;
  const largeAtMargin = best.x_l > 1e-7 && best.x_l < 1 - 1e-7;

  let p_R = 0;
  let p_C = 0;
  if (rateBinding && costBinding && (smallAtMargin || largeAtMargin)) {
    // Both constraints tight, at least one type at margin. Solve 2x2:
    //   v_s = p_R + p_C · c_s
    //   v_l = p_R + p_C · c_l
    p_C = (v_l - v_s) / (c_l - c_s);
    p_R = v_s - p_C * c_s;
  } else if (costBinding && !rateBinding) {
    // Only cost is binding. Either small is at margin (p_C from v_s)
    // or large is at margin (p_C from v_l). Use whichever has x>0.
    p_C = best.x_l > best.x_s ? v_l / c_l : v_s / c_s;
    p_R = 0;
  } else if (rateBinding && !costBinding) {
    // Only rate is binding. p_R from the type at the margin.
    p_R = best.x_l > best.x_s ? v_l : v_s;
    p_C = 0;
  }

  return { x_s: best.x_s, x_l: best.x_l, value: best.value, bidPrices: { p_R, p_C } };
}

// ── Policies ───────────────────────────────────────────────────────────────────────────────────

interface PolicyResult {
  admittedSmall: number;
  admittedLarge: number;
  revenue: number;
}

function simulate(
  arrivals: Arrival[],
  admit: (a: Arrival, rateRemaining: number, costRemaining: number) => boolean,
  budgets: Budgets,
): PolicyResult {
  let rateRemaining = budgets.R;
  let costRemaining = budgets.C;
  let admittedSmall = 0;
  let admittedLarge = 0;
  let revenue = 0;
  for (const a of arrivals) {
    if (admit(a, rateRemaining, costRemaining)) {
      rateRemaining -= 1;
      costRemaining -= a.cost;
      revenue += a.value;
      if (a.type === "small") admittedSmall += 1;
      else admittedLarge += 1;
    }
  }
  return { admittedSmall, admittedLarge, revenue };
}

/** Marginal-AND: admit iff both per-axis budgets have room. No price signal. */
function policyMarginalAND(a: Arrival, rateRemaining: number, costRemaining: number): boolean {
  return rateRemaining >= 1 && costRemaining >= a.cost;
}

/** Joint-LP: budget feasibility AND bid-price feasibility. */
function makePolicyJointLP(bidPrices: { p_R: number; p_C: number }) {
  return (a: Arrival, rateRemaining: number, costRemaining: number): boolean => {
    if (rateRemaining < 1 || costRemaining < a.cost) return false;
    // Bid-price test: value ≥ shadow cost of consuming this request's resources.
    return a.value >= bidPrices.p_R + bidPrices.p_C * a.cost;
  };
}

// ── Sweep + report ─────────────────────────────────────────────────────────────────────────────

interface SeedResult {
  rho: number;
  seed: number;
  V_clairvoyant: number;
  V_marginal: number;
  V_joint: number;
  regret_marginal: number;
  regret_joint: number;
}

function runSweep(
  rhos: readonly number[],
  seedsPerRho: number,
  N: number,
  budgets: Budgets,
): SeedResult[] {
  const fluid = solveFluidLP(budgets, N);
  const V_clairvoyant = fluid.value * N; // expected total over N arrivals
  const results: SeedResult[] = [];
  for (const rho of rhos) {
    for (let seed = 0; seed < seedsPerRho; seed++) {
      const rng = makeRng(0xdeadbeef ^ Math.round(rho * 1000) ^ (seed * 2654435761));
      const arrivals = generateWorkload(rho, N, rng);
      const marginalRes = simulate(arrivals, policyMarginalAND, budgets);
      const jointRes = simulate(arrivals, makePolicyJointLP(fluid.bidPrices), budgets);
      const regret_marginal = 1 - marginalRes.revenue / V_clairvoyant;
      const regret_joint = 1 - jointRes.revenue / V_clairvoyant;
      results.push({
        rho,
        seed,
        V_clairvoyant,
        V_marginal: marginalRes.revenue,
        V_joint: jointRes.revenue,
        regret_marginal,
        regret_joint,
      });
    }
  }
  return results;
}

function aggregate(
  results: SeedResult[],
): Array<{ rho: number; meanMarginal: number; meanJoint: number; epsilon: number }> {
  const byRho = new Map<number, SeedResult[]>();
  for (const r of results) {
    const arr = byRho.get(r.rho) ?? [];
    arr.push(r);
    byRho.set(r.rho, arr);
  }
  const rows: Array<{ rho: number; meanMarginal: number; meanJoint: number; epsilon: number }> = [];
  for (const [rho, rs] of byRho) {
    const meanMarginal = rs.reduce((s, x) => s + x.regret_marginal, 0) / rs.length;
    const meanJoint = rs.reduce((s, x) => s + x.regret_joint, 0) / rs.length;
    rows.push({ rho, meanMarginal, meanJoint, epsilon: meanMarginal - meanJoint });
  }
  rows.sort((a, b) => a.rho - b.rho);
  return rows;
}

function fmtPct(x: number): string {
  return `${(x * 100).toFixed(2)}%`;
}

function main(): void {
  const rhos = [-1, -0.5, 0, 0.5, 1];
  const seedsPerRho = 20;
  const N = 1_000;
  const budgets = DEFAULT_BUDGETS;

  const fluid = solveFluidLP(budgets, N);

  // Header.
  console.log("# TK-1007 — Joint-LP vs marginal-AND toy simulation");
  console.log();
  console.log("Workload: N =", N, "arrivals; symmetric mixture (π_s = π_l = 0.5).");
  console.log("Types: small (cost=100, value=1), large (cost=10000, value=50).");
  console.log("Budgets: R =", budgets.R, "(rate); C =", budgets.C, "(cost).");
  console.log();
  console.log("Fluid LP optimum:");
  console.log(`  x_s = ${fluid.x_s.toFixed(4)}, x_l = ${fluid.x_l.toFixed(4)}`);
  console.log(`  per-arrival revenue = ${fluid.value.toFixed(4)}`);
  console.log(`  total V* = ${(fluid.value * N).toFixed(2)}`);
  console.log(
    `  bid prices: p_R = ${fluid.bidPrices.p_R.toFixed(4)}, p_C = ${fluid.bidPrices.p_C.toFixed(6)}`,
  );
  console.log();
  console.log("Per-arrival bid-price tests:");
  console.log(
    `  small: v_s = 1 ≥ ${fluid.bidPrices.p_R.toFixed(4)} + ${fluid.bidPrices.p_C.toFixed(6)} · 100 = ${(fluid.bidPrices.p_R + fluid.bidPrices.p_C * 100).toFixed(4)} ?`,
  );
  console.log(
    `  large: v_l = 50 ≥ ${fluid.bidPrices.p_R.toFixed(4)} + ${fluid.bidPrices.p_C.toFixed(6)} · 10000 = ${(fluid.bidPrices.p_R + fluid.bidPrices.p_C * 10_000).toFixed(4)} ?`,
  );
  console.log();

  const results = runSweep(rhos, seedsPerRho, N, budgets);
  const summary = aggregate(results);

  // Table.
  console.log(`Summary (mean over ${seedsPerRho} seeds per ρ):`);
  console.log("ρ        regret(marginal-AND)   regret(joint-LP)   ε = M − J");
  for (const row of summary) {
    console.log(
      `${row.rho.toFixed(2).padStart(6)}   ${fmtPct(row.meanMarginal).padStart(20)}   ${fmtPct(row.meanJoint).padStart(15)}   ${fmtPct(row.epsilon).padStart(10)}`,
    );
  }
  console.log();
  const meanEps = summary.reduce((s, x) => s + x.epsilon, 0) / summary.length;
  console.log(`Mean ε over ρ ∈ {-1, -0.5, 0, +0.5, +1}: ${fmtPct(meanEps)}`);
  console.log("DR-19 threshold: 5%. Ship 0.10.1 joint-LP iff ε ≥ 5%.");
  console.log(
    `Verdict: ${meanEps >= 0.05 ? "SHIP" : "HOLD"} (ε ${meanEps >= 0.05 ? "≥" : "<"} 5%)`,
  );
}

main();
