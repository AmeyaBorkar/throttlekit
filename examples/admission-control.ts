/**
 * Admission control: decide whether to *attempt* work at all, upstream of the per-key limiters.
 *
 *  - adaptiveThrottle — Google-SRE client-side throttling. A client hammering an overloaded backend
 *    only deepens the overload; this sheds a growing fraction of requests *locally* based on the
 *    backend's recent accept rate (p = max(0, (requests - K*accepts)/(requests+1))).
 *  - fairShare — an online equal-share split of one global budget, so one greedy tenant cannot
 *    starve the others.
 *
 * Both read time only through an injected Clock, so they are deterministic under ManualClock. Here
 * we also inject a seeded PRNG so the probabilistic shedding is reproducible.
 *
 * Run with:  npx tsx examples/admission-control.ts
 */

import { ManualClock, adaptiveThrottle, fairShare } from "../src/index";

/** A tiny seeded PRNG (mulberry32) so the demo's shedding is reproducible run to run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function adaptiveShedding(): void {
  const clock = new ManualClock(0);
  const throttle = adaptiveThrottle({ k: 2, windowMs: 10_000, clock, random: mulberry32(42) });

  // Phase 1 — healthy backend: everything we send is accepted, so p stays ~0 and nothing is shed.
  for (let i = 0; i < 10; i++) {
    if (throttle.request()) throttle.record(true);
    clock.advance(50);
  }
  console.log("healthy  → rejectProbability:", throttle.rejectProbability().toFixed(3));

  // Phase 2 — backend falls over: every sent request is rejected. As accepts stall while requests
  // climb, p rises and the client starts shedding locally (request() returns false → we don't send,
  // and per the contract we do NOT record a shed request).
  let sent = 0;
  let shed = 0;
  for (let i = 0; i < 60; i++) {
    if (throttle.request()) {
      sent++;
      throttle.record(false); // sent, but the backend rejected it
    } else {
      shed++; // shed locally — never left the client
    }
    clock.advance(50);
  }
  console.log(
    `overload → sent ${sent}, shed ${shed} locally; rejectProbability now`,
    throttle.rejectProbability().toFixed(3),
  );

  // A priority-1 request is never shed, even mid-overload (use for health checks / payments).
  console.log("priority=1 request always sends:", throttle.request(1));
}

function fairBudgetSplit(): void {
  const clock = new ManualClock(0);
  // One global budget of 10 admissions per window, shared across tenants.
  const limiter = fairShare({ limit: 10, windowMs: 1_000, clock });

  // Both tenants are active early, so the fair cap is floor(10 / 2) = 5 each. Interleaving them
  // shows neither can exceed its share even though tenant "A" is greedy.
  let aAllowed = 0;
  let bAllowed = 0;
  for (let i = 0; i < 8; i++) {
    if (limiter.checkSync("tenant-A").allowed) aAllowed++;
    if (limiter.checkSync("tenant-B").allowed) bAllowed++;
  }
  console.log(`fairShare → A admitted ${aAllowed}, B admitted ${bAllowed} (fair cap 5 each)`);

  // The Decision's `limit` is the tenant's *current* fair cap, not the global budget.
  const d = limiter.checkSync("tenant-A");
  console.log("tenant-A sees limit (its fair cap):", d.limit, "remaining:", d.remaining);
}

adaptiveShedding();
fairBudgetSplit();
