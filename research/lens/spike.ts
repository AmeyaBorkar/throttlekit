/**
 * TK-LENS-0 de-risking spike (throwaway; run: `npx tsx research/lens/spike.ts`).
 *
 * Proves the load-bearing claims the ThrottleKit Lens depends on, BEFORE writing any package code:
 *
 *  (1) For a unifiedAdmission, every denial is attributable to EXACTLY ONE lane — the binding axis
 *      (concurrency -> rate -> cost, first deny) OR the joint-LP "policy" lane (policyDenied) — and that
 *      lane is reconstructable purely from `result.bindingAxis` / `result.policyDenied` AND, independently,
 *      from `admitter.lastDecisions()` (the two must agree). This is what makes the axis Sankey exact.
 *  (2) An allowed admission has bindingAxis === undefined and policyDenied falsy.
 *  (3) The universal path: a PLAIN rateLimit() (no axes) attributed by (strategy, key) purely from the
 *      existing tapDecisions stream — i.e. the board works for every user, the axis lane is a bonus.
 *
 * Uses long periods so nothing refills mid-loop; system clock is fine (assertions are count-based, not
 * timing-based). Exits non-zero on any failure.
 */

import {
  type Decision,
  type UnifiedAxis,
  adaptiveConcurrency,
  fixedWindow,
  gcra,
  rateLimit,
  tapDecisions,
  unifiedAdmission,
} from "../../src/index";

const HOUR = 3_600_000;
let failures = 0;
function check(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ok   ${msg}`);
  } else {
    failures++;
    console.error(`  FAIL ${msg}`);
  }
}

type LastDecisions = Readonly<Partial<Record<UnifiedAxis, Decision | undefined>>>;

/** Mirror of src/observability/otel.ts:bindingAxisOf — the independent reconstruction from per-axis truth. */
function reconstruct(last: LastDecisions): UnifiedAxis | undefined {
  if (last.concurrency?.allowed === false) return "concurrency";
  if (last.rate?.allowed === false) return "rate";
  if (last.cost?.allowed === false) return "cost";
  return undefined;
}

/** The single lane a result is attributed to in the Sankey. Exactly one bucket per event. */
function laneOf(r: {
  decision: Decision;
  bindingAxis?: UnifiedAxis;
  policyDenied?: boolean;
}): string {
  if (r.decision.allowed) return "allow";
  if (r.bindingAxis !== undefined) return r.bindingAxis;
  if (r.policyDenied) return "policy";
  return "UNATTRIBUTED";
}

const tally: Record<string, number> = {};

/** Run one admit, assert the binding-axis invariant, and tally its lane. */
async function step(
  admitter: ReturnType<typeof unifiedAdmission>,
  opts: { key?: string; cost?: number; value?: number },
  label: string,
): Promise<void> {
  const r = await admitter.admit(opts);
  const last = admitter.lastDecisions();
  // The wrapper field and the per-axis snapshot reconstruction must agree (never disagree).
  check(
    r.bindingAxis === reconstruct(last),
    `${label}: result.bindingAxis (${String(r.bindingAxis)}) === reconstruct(lastDecisions) (${String(reconstruct(last))})`,
  );
  if (!r.decision.allowed && r.bindingAxis === undefined) {
    // The only deny with no binding axis must be the joint-LP policy lane.
    check(r.policyDenied === true, `${label}: axis-less deny is a policy deny (policyDenied=true)`);
  }
  const lane = laneOf(r);
  tally[lane] = (tally[lane] ?? 0) + 1;
  r.release(); // release any held slot (no-op on deny)
}

async function main(): Promise<void> {
  console.log("# Scenario RATE-bound (gcra burst 3; concurrency + cost generous)");
  {
    const a = unifiedAdmission({
      rate: rateLimit({ strategy: gcra({ limit: 3, periodMs: HOUR, burst: 3 }) }),
      concurrency: adaptiveConcurrency({ minLimit: 100, maxLimit: 100, initialLimit: 100 }),
      cost: rateLimit({ strategy: fixedWindow({ limit: 10_000, windowMs: HOUR }) }),
    });
    for (let i = 0; i < 6; i++) await step(a, { key: "k", cost: 1 }, `rate#${i + 1}`);
    const last = a.lastDecisions();
    check(last.rate?.allowed === false, "RATE: last rate axis denied");
    check(last.cost === undefined, "RATE: cost axis short-circuited (undefined) — never debited");
  }

  console.log("# Scenario COST-bound (fixedWindow limit 3; rate + concurrency generous)");
  {
    const a = unifiedAdmission({
      rate: rateLimit({ strategy: gcra({ limit: 10_000, periodMs: HOUR }) }),
      concurrency: adaptiveConcurrency({ minLimit: 100, maxLimit: 100, initialLimit: 100 }),
      cost: rateLimit({ strategy: fixedWindow({ limit: 3, windowMs: HOUR }) }),
    });
    for (let i = 0; i < 6; i++) await step(a, { key: "k", cost: 1 }, `cost#${i + 1}`);
    const last = a.lastDecisions();
    check(last.rate?.allowed === true, "COST: rate axis allowed (evaluated before cost)");
    check(last.cost?.allowed === false, "COST: cost axis denied (the binding one)");
  }

  console.log("# Scenario CONCURRENCY-bound (limit 1, slots held / not released)");
  {
    const a = unifiedAdmission({
      rate: rateLimit({ strategy: gcra({ limit: 10_000, periodMs: HOUR }) }),
      concurrency: adaptiveConcurrency({ minLimit: 1, maxLimit: 1, initialLimit: 1 }),
      cost: rateLimit({ strategy: fixedWindow({ limit: 10_000, windowMs: HOUR }) }),
    });
    const first = await a.admit({ key: "k" }); // holds the only slot (NOT released)
    check(
      first.decision.allowed && first.bindingAxis === undefined,
      "CONC: first admit allowed, no binding axis",
    );
    tally[laneOf(first)] = (tally[laneOf(first)] ?? 0) + 1;
    const second = await a.admit({ key: "k" }); // no slot left -> concurrency binds
    const last = a.lastDecisions();
    check(second.bindingAxis === "concurrency", "CONC: second admit bound by concurrency");
    check(
      last.rate === undefined && last.cost === undefined,
      "CONC: rate+cost short-circuited (concurrency is first)",
    );
    check(
      second.bindingAxis === reconstruct(last),
      "CONC: bindingAxis === reconstruct(lastDecisions)",
    );
    tally[laneOf(second)] = (tally[laneOf(second)] ?? 0) + 1;
    first.release();
    second.release();
  }

  console.log("# Scenario POLICY lane (joint-lp bid-price filter; not a fourth axis)");
  {
    const a = unifiedAdmission({
      rate: rateLimit({ strategy: gcra({ limit: 10_000, periodMs: HOUR }) }),
      cost: rateLimit({ strategy: fixedWindow({ limit: 10_000, windowMs: HOUR }) }),
      policy: "joint-lp",
      jointLp: { duals: { rate: 1, cost: 1 } }, // bid = 1 + 1*cost
    });
    // value 0.5 < bid(2) => policy deny; per-axis budgets untouched (decisions stay undefined).
    const denied = await a.admit({ key: "k", cost: 1, value: 0.5 });
    const last = a.lastDecisions();
    check(
      !denied.decision.allowed && denied.policyDenied === true,
      "POLICY: low-value request denied by policy",
    );
    check(denied.bindingAxis === undefined, "POLICY: policy deny has NO binding axis");
    check(
      last.rate === undefined && last.cost === undefined,
      "POLICY: per-axis budgets never consulted (decisions undefined) — policy is not an axis",
    );
    tally[laneOf(denied)] = (tally[laneOf(denied)] ?? 0) + 1;
    denied.release();
    // value 10 >= bid(2) => admitted.
    const ok = await a.admit({ key: "k", cost: 1, value: 10 });
    check(
      ok.decision.allowed && ok.bindingAxis === undefined,
      "POLICY: high-value request admitted",
    );
    tally[laneOf(ok)] = (tally[laneOf(ok)] ?? 0) + 1;
    ok.release();
  }

  console.log("# Invariant: every event lands in exactly one lane; no UNATTRIBUTED denies");
  {
    const total = Object.values(tally).reduce((s, n) => s + n, 0);
    const sumLanes = Object.entries(tally)
      .filter(([k]) => k !== "UNATTRIBUTED")
      .reduce((s, [, n]) => s + n, 0);
    check((tally.UNATTRIBUTED ?? 0) === 0, "no UNATTRIBUTED events");
    check(total === sumLanes, `Σ lane counts (${sumLanes}) === total events (${total})`);
    console.log("  lanes:", JSON.stringify(tally));
  }

  console.log(
    "# Universal path: plain rateLimit() attributed by (strategy,key) from tapDecisions alone",
  );
  {
    type Ev = { key: string; strategy: string; allowed: boolean };
    const events: Ev[] = [];
    const limiter = tapDecisions(
      rateLimit({ strategy: gcra({ limit: 3, periodMs: HOUR, burst: 3 }) }),
      (e) => events.push({ key: e.key, strategy: e.strategy, allowed: e.decision.allowed }),
    );
    for (let i = 0; i < 5; i++) await limiter.check("alice");
    for (let i = 0; i < 2; i++) await limiter.check("bob");
    // Reconstruct a by-(strategy,key) deny attribution purely from the event stream.
    const denies = new Map<string, number>();
    let strategySeen = "";
    for (const e of events) {
      strategySeen = e.strategy;
      if (!e.allowed) denies.set(e.key, (denies.get(e.key) ?? 0) + 1);
    }
    check(strategySeen === "gcra", "universal: events carry the strategy name (gcra)");
    check(events.length === 7, `universal: tap saw every check (7), got ${events.length}`);
    check(
      denies.get("alice") === 2,
      `universal: alice denied twice (5 checks, burst 3), got ${denies.get("alice") ?? 0}`,
    );
    check(!denies.has("bob"), "universal: bob never denied (2 checks < burst 3)");
  }

  console.log(failures === 0 ? "\nSPIKE PASSED" : `\nSPIKE FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
