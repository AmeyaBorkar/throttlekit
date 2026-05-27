import { describe, expect, it, vi } from "vitest";
import { gcra } from "../../src/algorithms/gcra";
import { rateLimit } from "../../src/core/limiter";
import type { Store } from "../../src/core/types";
import { MemoryStore } from "../../src/stores/memory";
import { twoTier } from "../../src/twotier";

/**
 * TK-R02: limiters that own a timer (the default in-process store's sweep, the two-tier
 * returnIdleAfterMs timer) must be disposable, and disposal must NOT close a caller-provided store.
 */
describe("Limiter.close (TK-R02)", () => {
  it("rateLimit().close() clears the owned default MemoryStore's sweep timer", async () => {
    vi.useFakeTimers();
    try {
      const before = vi.getTimerCount();
      const limiter = rateLimit({ strategy: gcra({ limit: 5, periodMs: 1000, burst: 1 }) });
      expect(vi.getTimerCount()).toBe(before + 1); // default MemoryStore registered a sweep timer
      await limiter.close?.();
      expect(vi.getTimerCount()).toBe(before); // …cleared on close
    } finally {
      vi.useRealTimers();
    }
  });

  it("rateLimit() does not close a caller-provided store", async () => {
    const closeSpy = vi.fn(() => Promise.resolve());
    const fakeStore = {
      apply: () => Promise.resolve(undefined as never),
      reset: () => Promise.resolve(),
      close: closeSpy,
    } as unknown as Store;
    const limiter = rateLimit({
      strategy: gcra({ limit: 5, periodMs: 1000, burst: 1 }),
      store: fakeStore,
    });
    await limiter.close?.();
    expect(closeSpy).not.toHaveBeenCalled(); // the store is the caller's to close
  });

  it("twoTier(leased).close() clears the returnIdleAfterMs timer", async () => {
    vi.useFakeTimers();
    try {
      const l2 = new MemoryStore({ sweepIntervalMs: 0 }); // no timer of its own
      const before = vi.getTimerCount();
      const limiter = twoTier({
        strategy: gcra({ limit: 100, periodMs: 60_000, burst: 10 }),
        l2,
        mode: "leased",
        lease: { batch: 10, returnIdleAfterMs: 1000 },
      });
      expect(vi.getTimerCount()).toBe(before + 1); // the idle-return interval
      await limiter.close?.();
      expect(vi.getTimerCount()).toBe(before); // …cleared on close
    } finally {
      vi.useRealTimers();
    }
  });
});
