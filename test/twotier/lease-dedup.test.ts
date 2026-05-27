import { describe, expect, it, vi } from "vitest";
import { gcra } from "../../src/algorithms/gcra";
import { ManualClock } from "../../src/core/clock";
import { MemoryStore } from "../../src/stores/memory";
import { twoTier } from "../../src/twotier";

/**
 * TK-R01: the on-demand lease path had no in-flight dedup, so N concurrent misses on a cold key each
 * issued their own L2 lease — N round trips and up to N×batch credits outstanding on one node, which
 * breaks the published overshoot bound (it assumes ≤ batch outstanding per node) and stampedes L2.
 * Coalescing collapses concurrent misses onto one lease whose batch all the waiters share.
 */
describe("twoTier leased — in-flight lease coalescing (TK-R01)", () => {
  it("collapses concurrent cold-key misses into one lease and shares the batch", async () => {
    const clock = new ManualClock(0);
    const l2 = new MemoryStore({ sweepIntervalMs: 0, clock });
    const applySpy = vi.spyOn(l2, "apply");
    const limiter = twoTier({
      strategy: gcra({ limit: 10_000, periodMs: 60_000, burst: 500 }),
      l2,
      mode: "leased",
      lease: { batch: 10 },
      clock,
    });

    // 3 concurrent misses on a cold key: before the fix this issued 3 leases (3×batch outstanding);
    // now it is ONE lease whose batch all three share.
    const concurrent = await Promise.all([
      limiter.check("k"),
      limiter.check("k"),
      limiter.check("k"),
    ]);
    expect(concurrent.every((d) => d.allowed)).toBe(true);
    expect(applySpy).toHaveBeenCalledTimes(1);

    // The remaining 7 credits of that single batch serve subsequent requests with no new lease, so
    // the node never holds more than `batch` outstanding — the overshoot-bound assumption restored.
    for (let i = 0; i < 7; i++) {
      expect((await limiter.check("k")).allowed).toBe(true);
    }
    expect(applySpy).toHaveBeenCalledTimes(1); // 10 requests served from one batch of 10

    // The 11th exhausts the batch and triggers exactly one more lease.
    expect((await limiter.check("k")).allowed).toBe(true);
    expect(applySpy).toHaveBeenCalledTimes(2);

    await limiter.close?.();
  });
});
