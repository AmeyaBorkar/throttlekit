/**
 * Leaky-bucket traffic shaping: pace bursty work to a steady output rate, rejecting only when
 * the wait would exceed `maxQueueMs`. Ideal for staying under a third-party API's rate budget.
 *
 * Run with:  npx tsx examples/leaky-bucket.ts
 */

import { ManualClock, QueueFullError, leakyBucket } from "../src/index";

async function reserveWithoutSleeping(): Promise<void> {
  // 5 units/second drain rate; reservations that would wait > 2s are rejected.
  const shaper = leakyBucket({ ratePerSec: 5, maxQueueMs: 2_000 });

  // `reserve` never sleeps — it returns the paced delay so you can decide what to do.
  const r = await shaper.reserve("upstream-api");
  console.log("reserved:", r.accepted, "delayMs:", r.delayMs);
}

async function scheduleAndCall(): Promise<void> {
  const shaper = leakyBucket({ ratePerSec: 5, maxQueueMs: 2_000 });

  try {
    // `schedule` resolves after the paced delay, or throws QueueFullError if the queue is full.
    await shaper.schedule("upstream-api");
    console.log("slot acquired — calling upstream now");
    // await callUpstream();
  } catch (err) {
    if (err instanceof QueueFullError) {
      console.warn("queue full; retry in", err.retryAfterMs, "ms");
      return;
    }
    throw err;
  }
}

function deterministicReserveSync(): void {
  // With a deterministic clock and the default in-memory store, reserveSync is exact.
  const clock = new ManualClock(0);
  const shaper = leakyBucket({ ratePerSec: 2, maxQueueMs: 1_000, clock }); // T = 500ms/unit

  // From a cold bucket the first reservation departs immediately; each subsequent one is paced.
  console.log("res #1 delayMs:", shaper.reserveSync("k").delayMs); // 0
  console.log("res #2 delayMs:", shaper.reserveSync("k").delayMs); // 500
  const third = shaper.reserveSync("k");
  console.log("res #3 accepted:", third.accepted, "delayMs:", third.delayMs); // 1000

  // The fourth would wait 1500ms > maxQueueMs (1000), so it is rejected.
  const fourth = shaper.reserveSync("k");
  console.log("res #4 accepted:", fourth.accepted, "delayMs:", fourth.delayMs);
}

async function main(): Promise<void> {
  await reserveWithoutSleeping();
  await scheduleAndCall();
  deterministicReserveSync();
}

void main();
