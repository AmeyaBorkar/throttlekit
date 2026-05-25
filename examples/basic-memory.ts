/**
 * Basic in-memory GCRA, plus the deterministic ManualClock pattern used in tests.
 *
 * Run with:  npx tsx examples/basic-memory.ts
 */

import { ManualClock, MemoryStore, gcra, rateLimit } from "../src/index";

async function asyncGcra(): Promise<void> {
  // 100 requests / minute, with an instantaneous burst allowance of 20.
  const limiter = rateLimit({
    strategy: gcra({ limit: 100, periodMs: 60_000, burst: 20 }),
    // `store` defaults to a fresh in-process MemoryStore.
  });

  const first = await limiter.check("user-42"); // cost defaults to 1
  console.log("first allowed:", first.allowed, "remaining:", first.remaining);

  // Spend more than one unit on a single request via `cost`.
  const heavy = await limiter.check("user-42", 5);
  console.log("heavy (cost 5) allowed:", heavy.allowed, "remaining:", heavy.remaining);

  if (!heavy.allowed) {
    console.log(`retry after ~${Math.ceil(heavy.retryAfterMs / 1000)}s`);
  }
}

function syncFastPath(): void {
  const limiter = rateLimit({ strategy: gcra({ limit: 5, periodMs: 1_000 }) });
  // checkSync is the synchronous, zero-await fast path — MemoryStore only.
  const d = limiter.checkSync("ip-1.2.3.4");
  console.log("sync allowed:", d.allowed, "limit:", d.limit, "remaining:", d.remaining);
}

function deterministicWithManualClock(): void {
  const clock = new ManualClock(0);
  const limiter = rateLimit({
    strategy: gcra({ limit: 2, periodMs: 1_000 }), // burst defaults to limit (2)
    clock,
    store: new MemoryStore({ clock }),
  });

  // A cold bucket admits exactly `burst` requests instantaneously, then paces at 1/T.
  console.log("t=0   #1:", limiter.checkSync("k").allowed); // true
  console.log("t=0   #2:", limiter.checkSync("k").allowed); // true
  console.log("t=0   #3:", limiter.checkSync("k").allowed); // false — burst exhausted

  clock.advance(500); // one emission interval (periodMs / limit = 1000 / 2) later
  console.log("t=500 #4:", limiter.checkSync("k").allowed); // true
}

async function main(): Promise<void> {
  await asyncGcra();
  syncFastPath();
  deterministicWithManualClock();
}

void main();
