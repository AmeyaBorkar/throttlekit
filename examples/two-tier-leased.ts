/**
 * Two-tier (L1 + L2) limiting in `leased` mode: each node leases a batch of tokens from the
 * distributed tier in one round trip, then serves them locally — driving steady-state network
 * cost toward ~1 round trip per `batch` requests, with a bounded global overshoot (<= L x batch).
 *
 * In production the L2 is a distributed store (e.g. RedisStore from "throttlekit/redis"). Here we
 * use a MemoryStore as L2 so the example runs standalone and deterministically.
 *
 * Run with:  npx tsx examples/two-tier-leased.ts
 */

import { ManualClock, MemoryStore, gcra, twoTier } from "../src/index";

async function main(): Promise<void> {
  const clock = new ManualClock(0);

  // Stand in for a distributed store. Swap for: new RedisStore({ client: new Redis(url) }).
  const l2 = new MemoryStore({ clock });

  const limiter = twoTier({
    strategy: gcra({ limit: 10_000, periodMs: 60_000, burst: 500 }),
    l2,
    mode: "leased", // "strict" | "cached-deny" | "leased"
    // Lease 50 tokens at a time; with the default lowWater (0) this is purely lease-on-demand,
    // giving the tightest overshoot bound (<= L x batch).
    lease: { batch: 50 },
    clock,
  });

  // The first check leases a batch from L2 (one round trip); the next 49 are served from local
  // credit with no L2 access at all.
  let allowed = 0;
  for (let i = 0; i < 60; i++) {
    const d = await limiter.check("tenant-1");
    if (d.allowed) allowed++;
  }
  console.log("allowed of 60:", allowed); // 60 — well within the 500-burst budget

  // Note: two-tier check is async (L2 is asynchronous); checkSync throws by design.
  try {
    limiter.checkSync("tenant-1");
  } catch (err) {
    console.log("checkSync rejected as expected:", (err as Error).message);
  }
}

void main();
