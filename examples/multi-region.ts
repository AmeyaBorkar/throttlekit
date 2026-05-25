/**
 * Multi-region rate limiting: one global budget shared across regions, with region-local latency.
 *
 * This is NOT a separate engine — it is `twoTier` leased mode with the regions as the leasing nodes
 * and one shared L2 (here an in-process store; in production a global Redis/Postgres). Each region
 * serves most traffic from a local lease (no per-request cross-region hop) and tops up from the
 * shared store ~once per `batch`. The formally-verified leased bound caps the WORLDWIDE overshoot at
 * `Limit + regions × (batch − 1)` (see docs/FORMAL-MODEL.md).
 *
 * Run with:  npx tsx examples/multi-region.ts
 */

import type { Store, Transform } from "../src/core/types";
import { ManualClock, MemoryStore, gcra, twoTier } from "../src/index";

const clock = new ManualClock(0);

// The shared, authoritative "global" store. We wrap it to count cross-region round trips.
const backing = new MemoryStore({ clock, sweepIntervalMs: 0 });
let roundTrips = 0;
const globalL2: Store = {
  apply<S, R>(key: string, t: Transform<S, R>): Promise<R> {
    roundTrips++; // each call is one cross-region hop to the shared store
    return backing.apply(key, t);
  },
  reset(key: string): Promise<void> {
    return backing.reset(key);
  },
};

const LIMIT = 1_000;
const BATCH = 50;
const REGIONS = ["us-east", "eu-west", "ap-south", "sa-east"];

// One leased limiter per region, all leasing the same key from the same shared L2.
const regions = REGIONS.map((name) => ({
  name,
  limiter: twoTier({
    strategy: gcra({ limit: LIMIT, periodMs: 60_000, burst: LIMIT }),
    l2: globalL2,
    clock,
    mode: "leased",
    lease: { batch: BATCH },
  }),
}));

async function main(): Promise<void> {
  const KEY = "global:checkout"; // one shared global budget
  const PER_REGION = 200; // 4 × 200 = 800 total, comfortably under the 1,000 global budget

  let allowed = 0;
  let total = 0;
  for (let i = 0; i < PER_REGION; i++) {
    for (const r of regions) {
      total++;
      if ((await r.limiter.check(KEY)).allowed) allowed++;
    }
  }

  console.log(`${regions.length} regions, global limit ${LIMIT}, lease batch ${BATCH}`);
  console.log(`total checks: ${total}, admitted: ${allowed}`);
  console.log(
    `cross-region round trips: ${roundTrips}  (~${(total / roundTrips).toFixed(0)} requests served per hop)`,
  );
  console.log(
    `proven worldwide overshoot bound: Limit + regions×(batch−1) = ${LIMIT + regions.length * (BATCH - 1)}`,
  );
}

void main();
