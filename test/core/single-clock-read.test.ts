import { describe, expect, it } from "vitest";
import { gcra } from "../../src/algorithms/gcra";
import { rateLimit } from "../../src/core/limiter";
import type { Clock } from "../../src/core/types";
import { MemoryStore } from "../../src/stores/memory";

/**
 * TK-P02: the limiter read clock.now() once and MemoryStore.applySync read it again — two reads per
 * sync check. The limiter now threads its single timestamp into applySync, so the clock is read once
 * (and the strategy + the store's expiry math see the same instant).
 */
function countingClock(): { clock: Clock; calls: () => number; reset: () => void } {
  let n = 0;
  return {
    clock: {
      now: () => {
        n++;
        return 1000;
      },
    },
    calls: () => n,
    reset: () => {
      n = 0;
    },
  };
}

describe("single clock read per sync check (TK-P02)", () => {
  it("reads the clock exactly once per checkSync", () => {
    const c = countingClock();
    const store = new MemoryStore({ clock: c.clock, sweepIntervalMs: 0 });
    const limiter = rateLimit({
      strategy: gcra({ limit: 5, periodMs: 1000, burst: 2 }),
      clock: c.clock,
      store,
    });
    c.reset(); // ignore construction-time reads
    limiter.checkSync("k");
    expect(c.calls()).toBe(1);
  });

  it("reads the clock once per checkManySync regardless of key count", () => {
    const c = countingClock();
    const store = new MemoryStore({ clock: c.clock, sweepIntervalMs: 0 });
    const limiter = rateLimit({
      strategy: gcra({ limit: 5, periodMs: 1000, burst: 2 }),
      clock: c.clock,
      store,
    });
    c.reset();
    limiter.checkManySync(["a", "b", "c"]);
    expect(c.calls()).toBe(1);
  });
});
