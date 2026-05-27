import { describe, expect, it } from "vitest";
import { type ElysiaContextLike, elysiaRateLimit } from "../../src/adapters/elysia";
import { fixedWindow } from "../../src/algorithms/fixed-window";
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
