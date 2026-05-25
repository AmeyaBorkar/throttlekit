/**
 * Distributed rate limiting over PostgreSQL — no Redis required.
 *
 * PostgresStore runs the same pure JS transform the in-memory store runs, inside a transaction
 * serialized per key by a transaction-scoped advisory lock, so N concurrent checks admit exactly K.
 * State is stored as JSON text, so decisions are bit-identical to every other backend.
 *
 * Requires the optional `pg` peer dependency and a reachable Postgres.
 * Run with:  DATABASE_URL=postgres://user:pass@localhost:5433/db npx tsx examples/postgres.ts
 */

import { Pool } from "pg";
import { gcra, rateLimit } from "../src/index";
import { PostgresStore } from "../src/postgres/index";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (url === undefined) {
    console.log(
      "set DATABASE_URL to run this example (e.g. postgres://user:pass@localhost:5433/db)",
    );
    return;
  }

  const pool = new Pool({ connectionString: url });
  // The store auto-creates its table on first use. `prefix` namespaces keys so one table can back
  // many limiters. Expired rows are reclaimed by a background sweep (sweepIntervalMs) and are
  // invisible to reads immediately, so lazy expiry keeps decisions correct in between.
  const store = new PostgresStore({ pool, prefix: "api" });

  const limiter = rateLimit({
    strategy: gcra({ limit: 1_000, periodMs: 60_000, burst: 100 }),
    store,
  });

  const key = "user-42";
  await limiter.reset(key); // start clean for a repeatable demo

  const a = await limiter.check(key);
  console.log("allowed:", a.allowed, "remaining:", a.remaining, "limit:", a.limit);

  // Spend a larger cost in one atomic transaction.
  const b = await limiter.check(key, 10);
  console.log("cost-10 allowed:", b.allowed, "remaining:", b.remaining);

  // Throughput tip: each check is one transaction (a few round trips). For hot keys, wrap this
  // store as the L2 of `twoTier({ mode: "leased" })` to amortize ~batch checks per round trip —
  // exactly the same lever you'd use over Redis.

  await store.close();
  await pool.end();
}

void main();
