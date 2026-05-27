import { describe, expect, it } from "vitest";
import { type SvelteKitRequestEvent, sveltekitRateLimit } from "../../src/adapters/sveltekit";
import { fixedWindow } from "../../src/algorithms/fixed-window";
import { ManualClock } from "../../src/core/clock";
import type { Store } from "../../src/core/types";
import { MemoryStore } from "../../src/stores/memory";

const event = (ip = "1.1.1.1"): SvelteKitRequestEvent => ({
  request: new Request("https://example.test/"),
  getClientAddress: () => ip,
});
const resolve = (): Response => new Response("ok", { status: 200 });

const downStore: Store = {
  apply: () => Promise.reject(new Error("down")),
  reset: () => Promise.resolve(),
};

function handle(extra: Record<string, unknown> = {}) {
  const clock = new ManualClock(0);
  return sveltekitRateLimit({
    strategy: fixedWindow({ limit: 2, windowMs: 60_000 }),
    store: new MemoryStore({ clock, sweepIntervalMs: 0 }),
    clock,
    ...extra,
  });
}

describe("sveltekitRateLimit", () => {
  it("forwards under the limit and copies rate-limit headers onto the response", async () => {
    const h = handle();
    const res = await h({ event: event(), resolve });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect([...res.headers.keys()].some((k) => k.startsWith("ratelimit"))).toBe(true);
  });

  it("returns 429 over the limit with Retry payload", async () => {
    const h = handle();
    await h({ event: event(), resolve });
    await h({ event: event(), resolve });
    const res = await h({ event: event(), resolve });
    expect(res.status).toBe(429);
    expect(((await res.json()) as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(0);
  });

  it("keys by getClientAddress (distinct clients isolated)", async () => {
    const h = handle();
    await h({ event: event("1.1.1.1"), resolve });
    await h({ event: event("1.1.1.1"), resolve });
    expect((await h({ event: event("1.1.1.1"), resolve })).status).toBe(429);
    expect((await h({ event: event("2.2.2.2"), resolve })).status).toBe(200);
  });

  it("fails open (forwards) and closed (503) on a store outage", async () => {
    const clock = new ManualClock(0);
    const base = { strategy: fixedWindow({ limit: 1, windowMs: 60_000 }), store: downStore, clock };
    const open = sveltekitRateLimit(base);
    const closed = sveltekitRateLimit({ ...base, fail: "closed" });
    expect((await open({ event: event(), resolve })).status).toBe(200);
    expect((await closed({ event: event(), resolve })).status).toBe(503);
  });
});
