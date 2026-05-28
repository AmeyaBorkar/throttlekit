/**
 * Multi-process regional escrow + regional-only outage mode (0.8.5).
 *
 * Demonstrates two TK-1306 deliverables on top of the existing federation
 * primitives:
 *
 * 1. **Multi-process atomicity within a region.** M federation engines in
 *    the same region share a single `RedisRegionalEscrow` (the L2), so the
 *    in-flight per-region escrow is bounded by what the L3 coordinator has
 *    actually granted instead of `M × batch`.
 * 2. **Regional-only outage mode.** When `onCoordinatorOutage: "regional-only"`
 *    is set, the engine keeps serving from the L2 balance during a
 *    coordinator outage and re-probes via `coordinator.isHealthy()` every
 *    `coordinatorHealthCheckMs` (default 5000).
 *
 * Quick start:
 *
 *   # Two Redis instances: one for the L2 (regional Redis), one for the L3
 *   # coordinator (cross-region). In production these would be in
 *   # different clusters; here they're just two databases on the same Redis.
 *   docker run --rm -d --name tk-fed-regional-redis -p 16379:6379 redis:7
 *
 *   npx tsx examples/federation-regional-escrow.ts
 *
 *   docker stop tk-fed-regional-redis
 *
 * The defaults model an M=4 multi-process deployment in `us-east`: four
 * federation engines (each one process) sharing one regional Redis L2;
 * the L3 coordinator backs the global budget across regions. Watch the
 * output — total admissions stay ≤ perKeyBudget even though M*batch
 * would exceed it without an L2.
 */

import { createClient } from "redis";
import { fixedWindow } from "../src/algorithms/fixed-window";
import { RedisCoordinator, RedisRegionalEscrow, federate } from "../src/federation";
import { fromNodeRedis } from "../src/redis/clients";

const REDIS_URL = process.env.TK_REDIS_URL ?? "redis://localhost:16379";
const REGION = "us-east";
const M_PROCESSES = 4;
const PER_KEY_BUDGET = 100;
const WINDOW_MS = 60_000;
const BATCH = 8;

async function main(): Promise<void> {
  // Two databases on the same Redis: L2 (regional) on DB 0, L3 (coordinator) on DB 1.
  const l2Client = createClient({ url: REDIS_URL, database: 0 });
  const l3Client = createClient({ url: REDIS_URL, database: 1 });
  await l2Client.connect();
  await l3Client.connect();
  await l2Client.flushDb();
  await l3Client.flushDb();

  // L3 coordinator: cross-region budget pool.
  const coordinator = new RedisCoordinator({
    client: fromNodeRedis(l3Client),
    windowMs: WINDOW_MS,
    budgetPerWindow: PER_KEY_BUDGET,
    prefix: "example-l3",
  });

  // L2 regional escrow: shared by M engines in the same region.
  const regionalEscrow = new RedisRegionalEscrow({
    client: fromNodeRedis(l2Client),
    windowMs: WINDOW_MS,
    region: REGION,
    prefix: "example-l2",
  });

  // M federation engines in the same region, all sharing the L2 + L3.
  const engines = Array.from({ length: M_PROCESSES }, (_, i) =>
    federate({
      strategy: fixedWindow({ limit: PER_KEY_BUDGET, windowMs: WINDOW_MS }),
      coordinator,
      regionalEscrow,
      region: `${REGION}-p${i}`,
      batch: BATCH,
      onCoordinatorOutage: "regional-only",
    }),
  );

  console.log(
    `federation example (multi-process regional escrow) — M=${M_PROCESSES} processes in ${REGION}`,
  );
  console.log(`  perKeyBudget = ${PER_KEY_BUDGET}, batch = ${BATCH}, windowMs = ${WINDOW_MS}`);
  console.log("");

  // Drive a hot key from all M engines round-robin. Without an L2, each
  // process would lease its own batch from coord; total in-flight =
  // min(M*batch, perKeyBudget). With an L2, the engines share the same
  // pool and total admissions stay at perKeyBudget exactly.
  const HOT_KEY = "global:checkout";
  const ROUNDS = 200;
  const admits = new Array<number>(M_PROCESSES).fill(0);
  for (let round = 0; round < ROUNDS; round++) {
    for (let i = 0; i < M_PROCESSES; i++) {
      const eng = engines[i];
      if (eng === undefined) continue;
      const d = await eng.check(HOT_KEY);
      if (d.allowed) admits[i]!++;
    }
  }
  const total = admits.reduce((a, b) => a + b, 0);

  console.log("admits per engine (M=4 processes sharing one L2):");
  for (let i = 0; i < M_PROCESSES; i++) {
    console.log(`  p${i}: ${admits[i]}`);
  }
  console.log(`total admitted: ${total}`);
  console.log(`perKeyBudget:   ${PER_KEY_BUDGET}`);
  console.log("");

  if (total <= PER_KEY_BUDGET) {
    console.log("✓ Δ = 0 — federation bound holds (admitted ≤ perKeyBudget).");
    console.log(`  Without an L2, M × batch would be ${M_PROCESSES * BATCH} → leaked overshoot.`);
  } else {
    console.log(`✗ Δ > 0 (${total - PER_KEY_BUDGET}) — federation bound VIOLATED (bug!).`);
  }

  console.log("");
  console.log("regional-only outage mode (also wired here):");
  console.log("  if the L3 coordinator goes down, the engine continues admitting");
  console.log("  from the L2 balance until depletion (Δ ≤ L2 balance at outage onset),");
  console.log("  then denies. coordinator.isHealthy() polls every coordinatorHealthCheckMs");
  console.log("  (default 5s); on recovery, normal lease + reconcile resumes.");
  console.log("  See research/regional-escrow/DESIGN.md §7 for the full semantics.");

  // Clean up.
  await l2Client.flushDb();
  await l3Client.flushDb();
  await l2Client.quit();
  await l3Client.quit();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
