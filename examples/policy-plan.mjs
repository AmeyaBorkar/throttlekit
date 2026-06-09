// Admission Policy Plans — a `terraform plan` for rate / cost limits.
//
// Replay your own *recorded* traffic against a candidate policy and read the exact,
// per-policy, per-key allow<->deny diff BEFORE you deploy. Run after `npm run build`:
//
//   node examples/policy-plan.mjs
//
// (Library-only; no server, no Redis. Everything here is deterministic.)

import {
  PlanRejectedError,
  assertPlanAcceptable,
  corpusFromRecordings,
  plan,
  policy,
  policySet,
  renderPlan,
} from "throttlekit/policy";
import { recordLimiter } from "throttlekit/testkit";

// ── 1. Record real traffic against today's limiters ──────────────────────────
// A rate-limited API (10 req / 1s) and a per-tenant LLM token budget (cost-shaped:
// each call debits its token cost). We record a burst from two tenants.
const apiRec = recordLimiter({ strategy: "fixedWindow", limit: 10, windowMs: 1000 });
// A token budget is a cost-weighted limiter: each call debits its token cost.
const costRec = recordLimiter({ strategy: "fixedWindow", limit: 1000, windowMs: 60_000 });

for (let i = 0; i < 14; i++) apiRec.limiter.checkSync("tenant-a"); // 10 allow, 4 deny
for (let i = 0; i < 6; i++) apiRec.limiter.checkSync("tenant-b"); // a quieter tenant
// Four 300-token completions: 300 / 600 / 900 admitted, the 4th (1200) denied — budget 1000.
for (let i = 0; i < 4; i++) costRec.limiter.checkSync("tenant-a", 300);

// ── 2. Declare the current and candidate policy sets ─────────────────────────
const current = policySet(
  [
    policy("api", { strategy: "fixedWindow", limit: 10, windowMs: 1000 }),
    policy("tokens", { strategy: "fixedWindow", limit: 1000, windowMs: 60_000 }),
  ],
  { label: "v1" },
);

// The proposal: tighten the API to 8 req/s, raise the token budget to 1500.
const candidate = policySet(
  [
    policy("api", { strategy: "fixedWindow", limit: 8, windowMs: 1000 }),
    policy("tokens", { strategy: "fixedWindow", limit: 1500, windowMs: 60_000 }),
  ],
  { label: "v2" },
);

// ── 3. Plan: diff the candidate against the current baseline over the corpus ──
const corpus = corpusFromRecordings({ api: apiRec, tokens: costRec });
const result = plan(current, candidate, corpus);

console.log(renderPlan(result));
console.log();

// ── 4. Gate it in CI: refuse a change that would newly 429 too many requests ─
try {
  assertPlanAcceptable(result, { maxAllowToDeny: 1 });
  console.log("✓ within budget");
} catch (e) {
  if (e instanceof PlanRejectedError) console.log(`✗ ${e.message}`);
  else throw e;
}
