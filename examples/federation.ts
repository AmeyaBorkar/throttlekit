/**
 * 3-region federation: ONE global rate limit shared across all regions,
 * with PROVEN Δ = 0 — the headline contribution of bet #77.
 *
 * Where `examples/multi-region.ts` uses the legacy `twoTier(leased)` with
 * a shared in-process L2 (Δ ≤ Limit + K·(batch−1) — the K-DEPENDENT
 * bound), this example uses `federate(...)` against a `RedisCoordinator`,
 * giving the formally-verified K-INDEPENDENT bound:
 *
 *     admitted_per_window  ≤  Limit
 *
 * for ANY number of regions K. See `spec/GaleFederatedLeasing.tla` and
 * `research/bigger-bets/federation/DESIGN.md`.
 *
 * Quick start:
 *
 *   # Spin up a Redis the coordinator can use (any port; the example
 *   # defaults to redis://localhost:16380 which matches the eval's
 *   # docker-compose).
 *   docker compose -f research/bigger-bets/federation/eval/docker-compose.yml up -d
 *
 *   npx tsx examples/federation.ts
 *
 *   docker compose -f research/bigger-bets/federation/eval/docker-compose.yml down
 *
 * The defaults model a typical SaaS deployment: K=3 regions sharing a
 * 1000-req/min global budget, with ~80% of traffic on us-east. Watch
 * the output — federation maintains Δ = 0 and recovers throughput the
 * static-partition policy would lose.
 */

import { createClient } from "redis";
import { fixedWindow } from "../src/algorithms/fixed-window";
import { RedisCoordinator, federate } from "../src/federation";
import { fromNodeRedis } from "../src/redis/clients";

const COORDINATOR_URL = process.env.TK_FED_COORD_URL ?? "redis://localhost:16380";
const REGIONS = ["us-east", "eu-west", "ap-south"];

async function main(): Promise<void> {
  const client = createClient({ url: COORDINATOR_URL });
  await client.connect();
  await client.flushDb();

  const coordinator = new RedisCoordinator({
    client: fromNodeRedis(client),
    windowMs: 60_000,
    budgetPerWindow: 1000,
    prefix: "example-fed",
  });

  // One federated Limiter per region; they all share the global coordinator.
  const limiters = REGIONS.map((region) =>
    federate({
      strategy: fixedWindow({ limit: 1000, windowMs: 60_000 }),
      coordinator,
      region,
      batch: 16,
    }),
  );

  // Skewed workload: us-east 80%, eu-west + ap-south 10% each (1200 reqs
  // total — 20% past the budget, so denial is expected as the budget
  // fills).
  const loads = [800, 200, 200];

  console.log(`federation example — K=${REGIONS.length} regions, L=1000/min, batch=16`);
  console.log(`offered: ${loads.reduce((a, b) => a + b, 0)} (${loads.join(" + ")})`);
  console.log("");

  const admitted: Record<string, number> = {};
  for (let r = 0; r < REGIONS.length; r++) {
    const region = REGIONS[r] as string;
    const load = loads[r] as number;
    const limiter = limiters[r];
    if (limiter === undefined) continue;
    let count = 0;
    for (let i = 0; i < load; i++) {
      if ((await limiter.check("global:checkout")).allowed) count++;
    }
    admitted[region] = count;
  }

  const total = Object.values(admitted).reduce((a, b) => a + b, 0);
  console.log("admitted per region:");
  for (const region of REGIONS) {
    console.log(`  ${region.padEnd(10)} ${admitted[region]}`);
  }
  console.log(`total admitted: ${total}`);
  console.log("global budget:  1000");
  console.log("");

  if (total <= 1000) {
    console.log("✓ Δ = 0 — federation bound holds (admitted ≤ global budget).");
  } else {
    console.log(`✗ Δ > 0 (${total - 1000}) — federation bound VIOLATED (bug!).`);
  }

  console.log("");
  console.log("contrast: static-partition with L/K = 333 per region would admit");
  console.log("  us-east:  min(800, 333) = 333  (drops 467 req)");
  console.log("  eu-west:  min(200, 333) = 200");
  console.log("  ap-south: min(200, 333) = 200");
  console.log(`  total:    733  (federation: ${total})`);
  console.log("");
  console.log(`-> federation recovered ${total - 733} requests static would deny.`);

  await client.flushDb();
  await client.quit();
}

void main().catch((err) => {
  console.error("example failed:", err);
  process.exit(1);
});
