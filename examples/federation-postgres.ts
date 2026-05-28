/**
 * 3-region federation with a Postgres-backed GlobalCoordinator. Parallel
 * to `examples/federation.ts` (which uses the default `RedisCoordinator`).
 * Demonstrates that the federation bound (Δ = 0, K-INDEPENDENT) holds
 * identically across both backends — they implement the same
 * `GlobalCoordinator` interface.
 *
 * Quick start:
 *
 *   # Spin up a Postgres on port 15432 for the coordinator (matches the
 *   # default TK_FED_COORD_PG_URL below).
 *   docker run --rm -d --name tk-fed-pg \
 *     -e POSTGRES_PASSWORD=tk -e POSTGRES_USER=tk -e POSTGRES_DB=tk \
 *     -p 15432:5432 postgres:16
 *
 *   npx tsx examples/federation-postgres.ts
 *
 *   docker stop tk-fed-pg
 *
 * The defaults model the same SaaS deployment as `federation.ts`: K=3
 * regions sharing a 1000-req/min global budget, with 80% of traffic on
 * us-east. Watch the output — federation maintains Δ = 0 and recovers
 * throughput the static-partition policy would lose. The total admitted
 * + denied numbers should be identical to the Redis run; only the
 * coordinator's transport changes.
 */

import { Pool } from "pg";
import { fixedWindow } from "../src/algorithms/fixed-window";
import { PostgresCoordinator, federate } from "../src/federation";

const COORDINATOR_URL = process.env.TK_FED_COORD_PG_URL ?? "postgres://tk:tk@localhost:15432/tk";
const REGIONS = ["us-east", "eu-west", "ap-south"];

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: COORDINATOR_URL });

  // Clean slate for the example. In production, the table is created
  // lazily on first use and is durable across runs.
  await pool.query("DROP TABLE IF EXISTS tk_fed_example");

  const coordinator = new PostgresCoordinator({
    pool,
    windowMs: 60_000,
    budgetPerWindow: 1000,
    tableName: "tk_fed_example",
    prefix: "example-fed",
    gcIntervalMs: 0, // disable GC for the example (one-shot run)
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

  // Skewed workload: us-east 80%, eu-west + ap-south 10% each.
  const loads = [800, 200, 200];

  console.log(`federation example (Postgres) — K=${REGIONS.length} regions, L=1000/min, batch=16`);
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
  console.log("backend: PostgresCoordinator (vs RedisCoordinator in examples/federation.ts)");
  console.log("the bound is identical across backends; trade-off is latency vs HA semantics.");

  // Clean up.
  coordinator.close();
  await pool.query("DROP TABLE IF EXISTS tk_fed_example");
  await pool.end();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
