import { describe, expect, it, vi } from "vitest";
import { leakyBucket } from "../../src/algorithms/leaky-bucket";
import { ManualClock } from "../../src/core/clock";
import { MemoryStore } from "../../src/stores/memory";

/**
 * TK-R05: a delay beyond setTimeout's 32-bit ceiling (~24.8 days) silently clamps to 1ms and fires
 * almost immediately, so a naive `schedule` would stop pacing. The chunked sleep must keep waiting.
 */
describe("leakyBucket.schedule — long-delay sleep (TK-R05)", () => {
  it("does not resolve early for a delay beyond setTimeout's 32-bit max", async () => {
    vi.useFakeTimers();
    try {
      const clock = new ManualClock(0);
      // A sweep-less store, so advancing fake time by ~2e9 ms doesn't fire the default 5s sweep timer
      // hundreds of thousands of times (which made this test flaky/slow).
      const store = new MemoryStore({ clock, sweepIntervalMs: 0 });
      // ratePerSec 1 ⇒ T = 1000ms/unit; maxQueueMs huge so a big backlog is still accepted.
      const shaper = leakyBucket({ ratePerSec: 1, maxQueueMs: 3_000_000_000, clock, store });
      // Prime: push the next departure ~2.2e9 ms out (cost 2.2e6 × 1000ms = 2.2e9).
      await shaper.reserve("k", 2_200_000);

      let done = false;
      const scheduled = shaper.schedule("k", 1).then(() => {
        done = true;
      });

      // A naive setTimeout would have already fired by the 32-bit ceiling; the chunked one has not.
      await vi.advanceTimersByTimeAsync(2_147_483_647);
      expect(done).toBe(false);

      // Advance past the remainder: now it resolves.
      await vi.advanceTimersByTimeAsync(2_200_000_000);
      await scheduled;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
