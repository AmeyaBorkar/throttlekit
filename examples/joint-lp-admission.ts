/**
 * Joint-LP admission — the bid-price policy for a cost-bound LLM gateway.
 *
 * `unifiedAdmission`'s default ("marginal-AND") admits a request iff every axis
 * independently has room. When the COST axis is the bottleneck and request types
 * differ in value-per-token, that greedily burns budget on whatever arrives first
 * — including cheap-to-pass, low-value, token-heavy calls that starve the
 * high-value calls arriving later.
 *
 * `policy: "joint-lp"` adds a revenue-management **bid-price filter** on top:
 * admit iff `value ≥ p_R + p_C · cost`, where the shadow prices `(p_R, p_C)` come
 * from the fluid-LP relaxation of the workload. It only ever *removes* admits
 * (strictly more selective), preserving budget for requests that clear the
 * marginal value of what they consume. THEORY.md (TK-1007) measured a mean
 * revenue gap of ε = 25.33% closed vs marginal-AND across realistic workloads.
 *
 * Honest caveat: under highly autocorrelated ("absorbing") workloads the static
 * fluid-LP duals can under-perform marginal-AND (Talluri–van Ryzin 1998). Default
 * stays marginal; enable joint-LP when the cost axis binds and types differ in
 * value-density. See research/bigger-bets/joint-lp-admission/DESIGN.md §7.
 *
 * Run with:  npx tsx examples/joint-lp-admission.ts
 */

import { ManualClock, rateLimit, solveFluidLp, tokenBucket, unifiedAdmission } from "../src/index";

// Two completion archetypes on a shared token budget:
//   small — 100 tokens, business value 1   (value-density 0.0100 /token)
//   large — 10k tokens, business value 50  (value-density 0.0050 /token)
// Small is ~2× more revenue-efficient per token. The `weight` is the EXPECTED
// COUNT of each type per window — what makes the cost axis genuinely bind (the
// budget must be scarce relative to expected demand, else the LP admits all and
// the bid prices are trivially zero).
const SMALL = { cost: 100, value: 1, weight: 500 };
const LARGE = { cost: 10_000, value: 50, weight: 500 };

// 1) Solve the fluid LP once, at config time, from the workload model. We expect
//    ~500 small + ~500 large completions/window against a 50k-token budget (ample
//    request-rate headroom), so the COST axis binds. The solver returns the bid
//    prices the gateway applies per request.
const COST_BUDGET = 50_000;
const sol = solveFluidLp({
  types: [SMALL, LARGE],
  rateBudget: 2_000, // request-rate headroom — not the binding axis here
  costBudget: COST_BUDGET,
});
console.log("Fluid-LP bid prices:", sol.duals); // { rate: 0, cost: 0.01 }
console.log(`  small clears: ${SMALL.value} ≥ ${sol.duals.rate + sol.duals.cost * SMALL.cost}`);
console.log(
  `  large clears: ${LARGE.value} ≥ ${sol.duals.rate + sol.duals.cost * LARGE.cost} ?  (no — filtered)`,
);

/** Build a gateway under one of the two policies, with a fresh 50k-token budget. */
function gateway(policy: "marginal" | "joint-lp") {
  const clock = new ManualClock(0); // frozen → the bucket is a pure 50k-token budget
  return unifiedAdmission({
    cost: rateLimit({
      strategy: tokenBucket({ capacity: COST_BUDGET, refillPerSec: 1 }),
      clock,
    }),
    ...(policy === "joint-lp" ? ({ policy, jointLp: { duals: sol.duals } } as const) : {}),
  });
}

// 2) An adversarial arrival order: a burst of token-heavy LARGE calls first (which
//    marginal-AND greedily admits, draining the 50k budget on 5 of them), then a
//    long stream of the more revenue-efficient SMALL calls — enough to fill the
//    budget on their own. This is where the bid-price filter earns its keep.
const arrivals = [
  ...Array.from({ length: 6 }, () => ({ ...LARGE, label: "large(v=50)" })),
  ...Array.from({ length: 600 }, () => ({ ...SMALL, label: "small(v=1)" })),
];

function run(policy: "marginal" | "joint-lp"): { revenue: number; admitted: number } {
  const admit = gateway(policy);
  let revenue = 0;
  let admitted = 0;
  for (const a of arrivals) {
    const { decision } = admit.admitSync({ cost: a.cost, value: a.value });
    if (decision.allowed) {
      revenue += a.value;
      admitted += 1;
    }
  }
  return { revenue, admitted };
}

const marginal = run("marginal");
const joint = run("joint-lp");

console.log("\nAdversarial order (6 large, then 600 small) on a 50k-token budget:");
console.log(`  marginal-AND : admitted ${marginal.admitted}, revenue ${marginal.revenue}`);
console.log(`  joint-LP     : admitted ${joint.admitted}, revenue ${joint.revenue}`);
const pct = (((joint.revenue - marginal.revenue) / marginal.revenue) * 100).toFixed(0);
console.log(
  `  → joint-LP filters the low-value large calls, preserving budget for the
    high-value small ones: ${joint.revenue} vs ${marginal.revenue} revenue (${pct}% more).`,
);
