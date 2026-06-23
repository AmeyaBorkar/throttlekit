import { describe, expect, it } from "vitest";
import {
  type ElysiaContextLike,
  elysiaAdaptiveConcurrency,
  elysiaRateLimit,
} from "../../src/adapters/elysia";
import { fixedWindow } from "../../src/algorithms/fixed-window";
import { adaptiveConcurrency } from "../../src/concurrency/adaptive";
import { ManualClock } from "../../src/core/clock";
import type { Store } from "../../src/core/types";
import { MemoryStore } from "../../src/stores/memory";

const ctx = (ip = "1.1.1.1"): ElysiaContextLike => ({
  request: new Request("https://example.test/", { headers: { "cf-connecting-ip": ip } }),
  set: { headers: {} },
});

const downStore: Store = {
  apply: () => Promise.reject(new Error("down")),
  reset: () => Promise.resolve(),
};

function hook(extra: Record<string, unknown> = {}) {
  const clock = new ManualClock(0);
  return elysiaRateLimit({
    strategy: fixedWindow({ limit: 2, windowMs: 60_000 }),
    store: new MemoryStore({ clock, sweepIntervalMs: 0 }),
    clock,
    ...extra,
  });
}

describe("elysiaRateLimit", () => {
  it("proceeds under the limit (returns undefined) and sets headers on ctx.set", async () => {
    const h = hook();
    const c = ctx();
    const r = await h(c);
    expect(r).toBeUndefined(); // undefined → Elysia runs the handler
    expect(Object.keys(c.set.headers).some((k) => k.toLowerCase().startsWith("ratelimit"))).toBe(
      true,
    );
  });

  it("short-circuits with 429 over the limit", async () => {
    const h = hook();
    await h(ctx());
    await h(ctx());
    const c = ctx();
    const body = await h(c);
    expect(c.set.status).toBe(429);
    expect(body).toMatchObject({ error: "Too Many Requests" });
  });

  it("keys distinct clients independently", async () => {
    const h = hook();
    await h(ctx("1.1.1.1"));
    await h(ctx("1.1.1.1"));
    const blocked = ctx("1.1.1.1");
    await h(blocked);
    expect(blocked.set.status).toBe(429);
    const fresh = ctx("2.2.2.2");
    expect(await h(fresh)).toBeUndefined();
  });

  it("fails open (proceeds) and closed (503) on a store outage", async () => {
    const clock = new ManualClock(0);
    const base = { strategy: fixedWindow({ limit: 1, windowMs: 60_000 }), store: downStore, clock };
    expect(await elysiaRateLimit(base)(ctx())).toBeUndefined();
    const c = ctx();
    await elysiaRateLimit({ ...base, fail: "closed" })(c);
    expect(c.set.status).toBe(503);
  });
});

describe("elysiaAdaptiveConcurrency dropOn5xx", () => {
  // Elysia legitimately accepts an HTTP status NAME string for `set.status`
  // (the adapter types it `number | string`). dropOn5xx must classify a 5xx by
  // status class — numeric 500, numeric-string "500", AND the name string
  // "Internal Server Error" — otherwise Number("Internal Server Error") is NaN,
  // NaN >= 500 is false, and the AIMD ceiling never contracts on the overload.
  const aimdGuard = () =>
    adaptiveConcurrency({
      algorithm: "aimd",
      minLimit: 4,
      maxLimit: 8,
      initialLimit: 8,
      clock: new ManualClock(0),
    });

  async function limitAfter(status: number | string): Promise<number> {
    const guard = aimdGuard();
    const wrap = elysiaAdaptiveConcurrency({ guard, dropOn5xx: true, clock: new ManualClock(0) });
    const c = ctx();
    await wrap(c, async () => {
      c.set.status = status;
      return "x";
    });
    return guard.limit;
  }

  it("contracts the ceiling on a numeric 500", async () => {
    expect(await limitAfter(500)).toBe(7);
  });

  it('contracts the ceiling on a numeric-string "500"', async () => {
    expect(await limitAfter("500")).toBe(7);
  });

  it("contracts the ceiling on the status NAME string 'Internal Server Error'", async () => {
    expect(await limitAfter("Internal Server Error")).toBe(7);
  });

  it("does NOT contract on a clean 200", async () => {
    expect(await limitAfter(200)).toBe(8);
  });
});
