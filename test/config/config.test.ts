import { describe, expect, it } from "vitest";
import { loadConfig, loadConfigObject } from "../../src/config";
import { ManualClock } from "../../src/core/clock";
import { ThrottleKitError } from "../../src/core/errors";
import { MemoryStore } from "../../src/stores/memory";

describe("loadConfig (.throttlekit.yaml / .json)", () => {
  it("builds working limiters from a YAML file: each enforces its own policy", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock, sweepIntervalMs: 0 });
    const { limiters } = loadConfig(
      `
version: 1
limiters:
  api:     { strategy: gcra,        limit: 3, period: 1m }
  uploads: { strategy: fixedWindow, limit: 2, period: 1s }
  monthly: { strategy: quota,       limit: 5, resetCadence: calendar-month }
`,
      { store },
    );
    expect(Object.keys(limiters)).toEqual(["api", "uploads", "monthly"]);

    // Each limiter is independently namespaced (its name is its prefix by default).
    for (let i = 0; i < 3; i++) expect((await limiters.api!.check("k")).allowed).toBe(true);
    expect((await limiters.api!.check("k")).allowed).toBe(false);

    for (let i = 0; i < 2; i++) expect((await limiters.uploads!.check("k")).allowed).toBe(true);
    expect((await limiters.uploads!.check("k")).allowed).toBe(false);

    // A quota's window dwarfs the test horizon; just check the configured limit.
    expect(limiters.monthly!.strategy.limit).toBe(5);
  });

  it("auto-detects JSON (text starts with `{`) and supports a shared prefix default", () => {
    const json = JSON.stringify({
      version: 1,
      defaults: { prefix: "tier-pro" },
      limiters: { api: { strategy: "gcra", limit: 10, period: "1s" } },
    });
    const { limiters } = loadConfig(json);
    expect(limiters.api!.strategy.name).toBe("gcra");
  });

  it("accepts a pre-parsed object via loadConfigObject (bring-your-own parser)", () => {
    const { limiters } = loadConfigObject({
      version: 1,
      limiters: {
        a: { strategy: "tokenBucket", capacity: 10, refillPerSec: 5 },
        b: { strategy: "slidingWindow", limit: 4, period: "2s", buckets: 4 },
      },
    });
    expect(limiters.a!.strategy.name).toBe("tokenBucket");
    expect(limiters.b!.strategy.name).toBe("slidingWindow");
  });

  it("rejects missing fields with a clear path", () => {
    expect(() =>
      loadConfigObject({ version: 1, limiters: { x: { strategy: "gcra" } } } as never),
    ).toThrow(ThrottleKitError);
    expect(() =>
      loadConfigObject({ version: 1, limiters: { x: { strategy: "weird" as never, limit: 1 } } }),
    ).toThrow(/unknown strategy/);
    expect(() => loadConfigObject({ version: 1 } as never)).toThrow(/missing `limiters`/);
  });
});
