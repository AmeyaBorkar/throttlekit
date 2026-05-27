import { describe, expect, it } from "vitest";
import { fixedWindow } from "../../src/algorithms/fixed-window";
import { gcra } from "../../src/algorithms/gcra";
import { quota } from "../../src/algorithms/quota";
import { slidingWindow } from "../../src/algorithms/sliding-window";
import { slidingWindowLog } from "../../src/algorithms/sliding-window-log";
import { tokenBucket } from "../../src/algorithms/token-bucket";
import { ManualClock } from "../../src/core/clock";
import { rateLimit } from "../../src/core/limiter";
import type { Forecast, Limiter, Strategy } from "../../src/core/types";
import { MemoryStore } from "../../src/stores/memory";

function mustForecastSync(l: Limiter, key: string, cost?: number): Forecast {
  const fn = l.forecastSync;
  if (fn === undefined) throw new Error("forecastSync expected to be defined");
  return fn(key, cost);
}

function make(strategy: Strategy, clock: ManualClock): Limiter {
  return rateLimit({ strategy, clock, store: new MemoryStore({ clock, sweepIntervalMs: 0 }) });
}

const NOW = 1_700_000_000_000;
const strategies: { name: string; make: () => Strategy; limit: number }[] = [
  { name: "gcra", make: () => gcra({ limit: 5, periodMs: 1000 }), limit: 5 },
  { name: "tokenBucket", make: () => tokenBucket({ capacity: 5, refillPerSec: 1 }), limit: 5 },
  { name: "fixedWindow", make: () => fixedWindow({ limit: 5, windowMs: 1000 }), limit: 5 },
  { name: "slidingWindow", make: () => slidingWindow({ limit: 5, windowMs: 1000 }), limit: 5 },
  {
    name: "slidingWindowLog",
    make: () => slidingWindowLog({ limit: 5, windowMs: 1000 }),
    limit: 5,
  },
  { name: "quota", make: () => quota({ limit: 5, resetCadence: "calendar-month" }), limit: 5 },
];

describe("forecast (non-consuming capacity projection)", () => {
  for (const s of strategies) {
    describe(s.name, () => {
      it("reports full spendable capacity on a fresh key, with sane replenish times", () => {
        const clock = new ManualClock(NOW);
        const limiter = make(s.make(), clock);
        const f = mustForecastSync(limiter, "k");
        expect(f.spendableNow).toBe(s.limit);
        expect(f.nextReplenishAt).toBeGreaterThanOrEqual(NOW);
        expect(f.fullAt).toBeGreaterThanOrEqual(f.nextReplenishAt);
        // Forecast never consumes: a real check still sees full capacity.
        expect(limiter.checkSync("k").remaining).toBe(s.limit - 1);
      });

      it("scales spendableNow by the request cost", () => {
        const clock = new ManualClock(NOW);
        const limiter = make(s.make(), clock);
        expect(mustForecastSync(limiter, "k", 2).spendableNow).toBe(Math.floor(s.limit / 2));
      });

      it("once exhausted, spendableNow is 0 and capacity returns in the future", () => {
        const clock = new ManualClock(NOW);
        const limiter = make(s.make(), clock);
        for (let i = 0; i < s.limit; i++) limiter.checkSync("k");
        const f = mustForecastSync(limiter, "k");
        expect(f.spendableNow).toBe(0);
        expect(f.nextReplenishAt).toBeGreaterThan(NOW);
        expect(f.fullAt).toBeGreaterThanOrEqual(f.nextReplenishAt);
      });

      it("async forecast() resolves to the same projection as forecastSync()", async () => {
        const clock = new ManualClock(NOW);
        const limiter = make(s.make(), clock);
        limiter.checkSync("k");
        const sync = mustForecastSync(limiter, "k");
        const fn = limiter.forecast;
        if (fn === undefined) throw new Error("forecast expected");
        expect(await fn("k")).toEqual(sync);
      });
    });
  }

  it("token bucket: exact replenish timing (1 token/s, capacity 5)", () => {
    const clock = new ManualClock(NOW);
    const limiter = make(tokenBucket({ capacity: 5, refillPerSec: 1 }), clock);
    for (let i = 0; i < 5; i++) limiter.checkSync("k"); // drain
    const f = mustForecastSync(limiter, "k");
    expect(f.spendableNow).toBe(0);
    expect(f.nextReplenishAt).toBe(NOW + 1000); // next whole token in 1s
    expect(f.fullAt).toBe(NOW + 5000); // 5 tokens at 1/s
  });

  it("fixed window: capacity returns as a lump at the boundary", () => {
    const clock = new ManualClock(NOW);
    const limiter = make(fixedWindow({ limit: 5, windowMs: 1000 }), clock);
    const boundary = Math.floor(NOW / 1000) * 1000 + 1000;
    limiter.checkSync("k");
    const f = mustForecastSync(limiter, "k");
    expect(f.nextReplenishAt).toBe(boundary);
    expect(f.fullAt).toBe(boundary);
  });

  it("validates cost and the strategy's support", async () => {
    const clock = new ManualClock(NOW);
    const limiter = make(gcra({ limit: 5, periodMs: 1000 }), clock);
    expect(() => mustForecastSync(limiter, "k", 0)).toThrow(RangeError);
    const fc = limiter.forecast;
    if (fc === undefined) throw new Error("forecast expected");
    await expect(fc("k", -1)).rejects.toThrow(RangeError);

    const noForecast: Strategy<number> = {
      name: "noForecast",
      limit: 1,
      ttlMs: 1,
      check: (state) => ({
        state,
        result: { allowed: true, limit: 1, remaining: 0, resetAt: 0, retryAfterMs: 0 },
        ttlMs: 1,
        persist: false,
      }),
    };
    const l2 = rateLimit({ strategy: noForecast, store: new MemoryStore({ sweepIntervalMs: 0 }) });
    expect(() => mustForecastSync(l2, "k")).toThrow(/not supported/);
  });
});
