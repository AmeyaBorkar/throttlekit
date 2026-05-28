/**
 * Weighted Fair Escrow — multi-tenant LLM gateway scenario.
 *
 * The shape this primitive fixes: an LLM gateway serves N tenants with
 * different priority weights. The provider's TPM budget is shared — but
 * naively splitting it equally wastes capacity when one tenant is idle
 * (static-share), and serving FCFS lets a low-priority flood starve a
 * high-priority customer below their guaranteed share (weight-blind).
 *
 * `weightedFairEscrow(...)` is work-conserving AND weight-honoring: under
 * skewed demand, idle tenants' shares flow to backlogged ones in proportion
 * to weight, every backlogged tenant gets at least its weighted floor
 * `gᵢ = ⌊wᵢ·L/W⌋`, and the per-window cap holds at exactly L (Pillar-1
 * Δ = 0 inheritance). See `research/bigger-bets/pillar4-wfe/DESIGN.md`.
 *
 * Run with:  npx tsx examples/weighted-fair-escrow.ts
 */

import { ManualClock, weightedFairEscrow } from "../src/index";

// Tenant priority weights — enterprise is 4× a free-tier customer.
const TIER_WEIGHTS: Record<string, number> = {
  enterprise: 4,
  pro: 2,
  free: 1,
};

function runScenario(): void {
  // Mimic an LLM gateway with a 30 000-token-per-minute provider budget shared across
  // three customer tiers.
  const clock = new ManualClock(0);
  const TPM_BUDGET = 30_000;
  const WINDOW_MS = 60_000;

  const escrow = weightedFairEscrow({
    limit: TPM_BUDGET,
    windowMs: WINDOW_MS,
    weightOf: (tenant) => TIER_WEIGHTS[tenant.split(":")[0] ?? "free"] ?? 1,
    l1: { maxKeys: 1024 },
    clock,
  });

  // Calls in arrival order. Each tenant is encoded as "tier:id"; the gateway tracks per-customer
  // budget by routing through their tier weight. Enterprise:alpha is the high-priority anchor.
  // pro:beta is steady. free:gamma + free:delta are flooders.
  const calls: Array<{ tenant: string; tokens: number; label: string }> = [
    { tenant: "enterprise:alpha", tokens: 1_000, label: "Enterprise alpha → small completion" },
    { tenant: "pro:beta", tokens: 800, label: "Pro beta → small completion" },
    { tenant: "free:gamma", tokens: 5_000, label: "Free gamma → flood (large completion)" },
    { tenant: "free:delta", tokens: 5_000, label: "Free delta → flood (large completion)" },
    { tenant: "free:gamma", tokens: 5_000, label: "Free gamma → flood again" },
    { tenant: "free:delta", tokens: 5_000, label: "Free delta → flood again" },
    { tenant: "free:gamma", tokens: 5_000, label: "Free gamma → flood third" },
    { tenant: "enterprise:alpha", tokens: 8_000, label: "Enterprise alpha → large completion" },
    { tenant: "pro:beta", tokens: 800, label: "Pro beta → small (steady)" },
    { tenant: "free:delta", tokens: 5_000, label: "Free delta → flood third" },
  ];

  console.log(
    `Per-tenant guaranteed shares for ${TPM_BUDGET} tokens / ${WINDOW_MS / 1000}s window:`,
  );
  const W = 4 + 2 + 1; // enterprise + pro + free
  console.log(`  W = ${W} (enterprise:4 + pro:2 + free:1)`);
  console.log(`  enterprise g = ⌊4·${TPM_BUDGET}/${W}⌋ = ${Math.floor((4 * TPM_BUDGET) / W)} tok`);
  console.log(`  pro        g = ⌊2·${TPM_BUDGET}/${W}⌋ = ${Math.floor((2 * TPM_BUDGET) / W)} tok`);
  console.log(`  free       g = ⌊1·${TPM_BUDGET}/${W}⌋ = ${Math.floor((1 * TPM_BUDGET) / W)} tok`);
  console.log();

  for (const call of calls) {
    const d = escrow.checkSync(call.tenant, call.tokens);
    if (d.allowed) {
      console.log(
        `✓ ALLOW  ${call.label.padEnd(48)} → tok=${call.tokens} limit=${d.limit} remaining=${d.remaining}`,
      );
    } else {
      console.log(
        `✗ DENY   ${call.label.padEnd(48)} → tok=${call.tokens} ceiling=${d.limit} retryAfter=${d.retryAfterMs}ms`,
      );
    }
  }

  console.log();
  console.log("Final per-tenant usage:");
  for (const t of escrow.stats().tenants) {
    console.log(`  ${t.tenant.padEnd(20)} weight=${t.weight}  used=${t.used} tokens`);
  }
  const used = escrow.stats().totalUsed;
  console.log();
  console.log(
    `Total: ${used} / ${TPM_BUDGET} = ${Math.round((used / TPM_BUDGET) * 100)}% utilisation`,
  );
  console.log("(Pillar-1 cap holds: total used ≤ L always, even under multi-tenant overload.)");
  console.log();
  console.log("Read this output as: the free-tier flooders' demand is metered at their");
  console.log("guaranteed share, leaving headroom for enterprise:alpha's large completion.");
  console.log("In a weight-blind FCFS scheme, gamma + delta would have drained the budget");
  console.log("before alpha got the chance.");
}

runScenario();
