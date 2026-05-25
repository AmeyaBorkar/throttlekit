/**
 * Adaptive concurrency: a dynamically inferred ceiling on in-flight requests, inferred from the
 * latency gradient and adjusted with a congestion-control sawtooth. Protects a service from
 * overload even when the right static rate is unknown.
 *
 * Run with:  npx tsx examples/adaptive-concurrency.ts
 */

import { adaptiveConcurrency } from "../src/index";

// A fake unit of work whose latency grows with concurrency, so the guard has a signal to react to.
function fakeWork(inflight: number): Promise<void> {
  const latency = 5 + inflight * 2;
  return new Promise((resolve) => setTimeout(resolve, latency));
}

async function main(): Promise<void> {
  const guard = adaptiveConcurrency({
    minLimit: 4,
    maxLimit: 512,
    algorithm: "gradient2", // or "aimd"
  });

  let shed = 0;
  let served = 0;

  // Fire a burst of work; the guard admits up to its current inferred ceiling and sheds the rest.
  const tasks = Array.from({ length: 50 }, async () => {
    const lease = guard.acquire();
    if (!lease.ok) {
      // Over the inferred ceiling — shed the request (e.g. respond 503).
      shed++;
      return;
    }
    try {
      await fakeWork(guard.inflight);
      served++;
      lease.release(); // latency since acquire() is measured automatically
    } catch {
      // A failed/timed-out request is an overload signal.
      lease.release({ dropped: true });
    }
  });

  await Promise.all(tasks);

  const stats = guard.stats();
  console.log("served:", served, "shed:", shed);
  console.log("inferred limit:", guard.limit, "inflight:", guard.inflight);
  console.log("stats:", stats); // { limit, inflight, rttNoload, lastRtt }
}

void main();
