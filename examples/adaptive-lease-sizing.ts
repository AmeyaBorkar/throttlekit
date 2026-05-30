/**
 * Adaptive lease sizing (GALE Pillar 2) in two-tier `leased` mode.
 *
 * Instead of a fixed `lease.batch`, each key's batch is sized online: every L2 window the limiter
 * feeds a per-key learner the demand that key served and leases at the size it reads back — descending
 * onto the EOQ optimum `√(2·orderCost·demand/strandPenalty)` and tracking drift. Larger batches cut
 * L2 round trips but strand more budget at the window boundary; the learner balances the two from
 * the demand it observes, so you don't have to hand-tune `batch` per key.
 *
 * Safety is independent of the size: by GALE Pillar 1 the per-window global admissions stay ≤ Limit
 * for ANY batch the learner emits (exactly `Limit` under `windowCoupled`). Adaptive sizing only tunes
 * efficiency — it can never loosen the cap.
 *
 * In production the L2 is a distributed store (e.g. RedisStore from "throttlekit/redis"). Here we use
 * a MemoryStore so the example runs standalone and deterministically.
 *
 * Run with:  npx tsx examples/adaptive-lease-sizing.ts
 */

import {
  ManualClock,
  MemoryStore,
  type Store,
  type Transform,
  fixedWindow,
  twoTier,
} from "../src/index";

/** Count L2 round trips (each lease) so we can watch coordination fall as the learner grows the batch. */
function counting(inner: Store): { store: Store; calls: () => number } {
  let n = 0;
  const store: Store = {
    apply<S, R>(key: string, transform: Transform<S, R>): Promise<R> {
      n++;
      return inner.apply(key, transform);
    },
    reset: (key: string) => inner.reset(key),
  };
  return { store, calls: () => n };
}

async function main(): Promise<void> {
  const clock = new ManualClock(0);
  const W = 60_000;
  const { store, calls } = counting(new MemoryStore({ clock }));

  const limiter = twoTier({
    strategy: fixedWindow({ limit: 1_000_000, windowMs: W }),
    l2: store,
    mode: "leased",
    lease: {
      windowCoupled: true, // the proven exact-Limit regime; stranding is what the learner trades against
      // High order cost ⇒ the learner prefers a larger batch; start tiny so the growth is visible.
      // (A fixed `lease.batch` would be stuck at one size; here `batch` would just be a warm-start.)
      adaptive: { orderCost: 200, strandPenalty: 1, initialSize: 4, maxSize: 1000 },
    },
    clock,
  });

  const DEMAND = 60; // steady demand of 60 requests/window for one key
  console.log("window   L2 round trips to serve 60 requests");
  console.log("------   ----------------------------------");
  for (let w = 0; w < 12; w++) {
    clock.advance(w === 0 ? 0 : W);
    const before = calls();
    for (let i = 0; i < DEMAND; i++) await limiter.check("tenant-1");
    const leases = calls() - before;
    if (w < 3 || w === 11) console.log(`  ${String(w).padStart(2)}              ${leases}`);
  }

  console.log(
    "\nThe batch grew from the warm-start of 4 toward the EOQ optimum, so the same 60 requests/window",
  );
  console.log(
    "now cost a fraction of the round trips — with the per-window global cap unchanged. A fixed",
  );
  console.log("`lease: { batch: 4 }` would have paid ~15 round trips every window, forever.");
}

void main();
