/**
 * Distributed rate limiting over Redis. Built-in strategies run their atomic Lua form in a single
 * EVALSHA round trip, so the decision is exact across every process sharing the Redis instance.
 *
 * Requires the optional `ioredis` peer dependency and a reachable Redis.
 * Run with:  REDIS_URL=redis://localhost:6379 npx tsx examples/redis-distributed.ts
 */

import Redis from "ioredis";
import { gcra, rateLimit } from "../src/index";
import { RedisStore } from "../src/redis/index";

async function main(): Promise<void> {
  const url = process.env.REDIS_URL;
  if (url === undefined) {
    console.log("set REDIS_URL to run this example (e.g. redis://localhost:6379)");
    return;
  }

  const client = new Redis(url);
  // `RedisStore` derives `now` from the Redis server clock by default, so node clock skew can't
  // corrupt shared state. `prefix` namespaces keys so one Redis can back many limiters.
  const store = new RedisStore({ client, prefix: "tk" });

  const limiter = rateLimit({
    strategy: gcra({ limit: 1_000, periodMs: 60_000, burst: 100 }),
    store, // one atomic EVALSHA per check
    prefix: "api",
  });

  const key = "user-42";
  await limiter.reset(key); // start clean for a repeatable demo

  const a = await limiter.check(key);
  console.log("allowed:", a.allowed, "remaining:", a.remaining, "limit:", a.limit);

  // Spend a larger cost in one atomic check.
  const b = await limiter.check(key, 10);
  console.log("cost-10 allowed:", b.allowed, "remaining:", b.remaining);

  await client.quit();
}

void main();
