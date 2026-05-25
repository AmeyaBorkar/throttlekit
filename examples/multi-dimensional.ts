/**
 * Multi-dimensional limiting: enforce per-IP AND per-user AND per-route limits together.
 * `all(...)` allows only if every dimension allows and consumes nothing unless all allow
 * (no partial consume). Pass the composite to `multiRateLimit` — NOT `rateLimit`.
 *
 * On a Redis store, every dimension is fused into a single atomic Lua round trip.
 *
 * Run with:  npx tsx examples/multi-dimensional.ts
 */

import { ManualClock, MemoryStore, all, fixedWindow, gcra, multiRateLimit } from "../src/index";

// The context every dimension's `key` function receives.
interface Ctx {
  ip: string;
  userId: string;
  route: string;
}

async function main(): Promise<void> {
  const clock = new ManualClock(0);

  const limiter = multiRateLimit<Ctx>({
    clock,
    store: new MemoryStore({ clock }),
    strategy: all<Ctx>({
      ip: { key: (c) => c.ip, strategy: gcra({ limit: 100, periodMs: 60_000 }) },
      user: { key: (c) => c.userId, strategy: gcra({ limit: 1_000, periodMs: 60_000 }) },
      // A tight per-route window: only 3 requests per second to this route.
      route: { key: (c) => c.route, strategy: fixedWindow({ limit: 3, windowMs: 1_000 }) },
    }),
  });

  const ctx: Ctx = { ip: "203.0.113.7", userId: "user-42", route: "/search" };

  // The route window (limit 3) is the binding constraint; the 4th request in the same second is
  // denied, and NO dimension is consumed on that denied check.
  for (let i = 1; i <= 4; i++) {
    const d = await limiter.check(ctx);
    console.log(
      `#${i} allowed:`,
      d.allowed,
      "remaining:",
      d.remaining,
      "retryAfterMs:",
      d.retryAfterMs,
    );
  }

  // The returned Decision reflects the binding dimension. checkSync is available on a sync store.
  const sync = limiter.checkSync({ ip: "203.0.113.8", userId: "user-7", route: "/profile" });
  console.log("sync allowed:", sync.allowed);
}

void main();
