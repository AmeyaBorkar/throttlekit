import { type Context, Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { honoRateLimit } from "../../src/adapters/hono";
import { gcra } from "../../src/algorithms/gcra";
import { ManualClock } from "../../src/core/clock";
import { StoreUnavailableError } from "../../src/core/errors";
import type { Store, Transform } from "../../src/core/types";
import { MemoryStore } from "../../src/stores/memory";

/** A store whose apply always rejects, to exercise fail policies. */
const throwingStore: Store = {
  apply<S, R>(_key: string, _t: Transform<S, R>): Promise<R> {
    return Promise.reject(new StoreUnavailableError());
  },
  reset(): Promise<void> {
    return Promise.resolve();
  },
};

/** Build a Hono app guarded by the middleware, with a trivial OK route at `/`. */
function appWith(options: Parameters<typeof honoRateLimit>[0]): Hono {
  const app = new Hono();
  app.use("*", honoRateLimit(options));
  app.get("/", (c) => c.text("hello"));
  return app;
}

const ipHeaders = (ip: string): Record<string, string> => ({ "cf-connecting-ip": ip });

describe("honoRateLimit (hono v4)", () => {
  it("allows under the limit: 200 + body preserved + draft headers set", async () => {
    const clock = new ManualClock(0);
    const app = appWith({
      strategy: gcra({ limit: 2, periodMs: 1000 }),
      clock,
      store: new MemoryStore({ clock }),
    });
    const res = await app.request("/", { headers: ipHeaders("1.2.3.4") });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
    expect(res.headers.get("RateLimit-Limit")).toBe("2");
    expect(res.headers.get("RateLimit-Remaining")).toBe("1");
    expect(res.headers.get("RateLimit-Reset")).toBe("1");
  });

  it("denies over the limit: 429 + Retry-After + JSON, route not reached", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock });
    const app = appWith({ strategy: gcra({ limit: 1, periodMs: 1000 }), clock, store });

    const first = await app.request("/", { headers: ipHeaders("5.5.5.5") });
    expect(first.status).toBe(200);

    const second = await app.request("/", { headers: ipHeaders("5.5.5.5") });
    expect(second.status).toBe(429);
    expect(second.headers.get("Retry-After")).toBe("1");
    expect(second.headers.get("RateLimit-Remaining")).toBe("0");
    expect(second.headers.get("RateLimit-Limit")).toBe("1");
    expect(await second.json()).toMatchObject({ error: "Too Many Requests" });
  });

  it("the route handler is not invoked on denial", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock });
    const route = vi.fn((c: Context) => c.text("hello"));
    const app = new Hono();
    app.use("*", honoRateLimit({ strategy: gcra({ limit: 1, periodMs: 1000 }), clock, store }));
    app.get("/", route);

    await app.request("/", { headers: ipHeaders("6.6.6.6") });
    route.mockClear();
    const denied = await app.request("/", { headers: ipHeaders("6.6.6.6") });
    expect(denied.status).toBe(429);
    expect(route).not.toHaveBeenCalled();
  });

  it("fail-open: store error forwards to the route (200)", async () => {
    const onError = vi.fn();
    const app = appWith({
      strategy: gcra({ limit: 5, periodMs: 1000 }),
      store: throwingStore,
      fail: "open",
      onError,
    });
    const res = await app.request("/", { headers: ipHeaders("1.1.1.1") });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("fail-closed: store error returns 503, route not reached", async () => {
    const onError = vi.fn();
    const route = vi.fn((c: Context) => c.text("hello"));
    const app = new Hono();
    app.use(
      "*",
      honoRateLimit({
        strategy: gcra({ limit: 5, periodMs: 1000 }),
        store: throwingStore,
        fail: "closed",
        onError,
      }),
    );
    app.get("/", route);

    const res = await app.request("/", { headers: ipHeaders("1.1.1.1") });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "rate limiter unavailable" });
    expect(route).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("uses a custom key (distinct keys are independent buckets)", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock });
    // Key off a query param instead of the client IP.
    const app = appWith({
      strategy: gcra({ limit: 1, periodMs: 1000 }),
      clock,
      store,
      key: (c) => new URL(c.req.url).searchParams.get("tenant") ?? "anon",
    });
    expect((await app.request("/?tenant=a")).status).toBe(200);
    expect((await app.request("/?tenant=a")).status).toBe(429); // same tenant -> denied
    expect((await app.request("/?tenant=b")).status).toBe(200); // independent
  });

  it("derives the key from cf-connecting-ip (distinct IPs are independent)", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock });
    const app = appWith({ strategy: gcra({ limit: 1, periodMs: 1000 }), clock, store });
    expect((await app.request("/", { headers: ipHeaders("1.1.1.1") })).status).toBe(200);
    expect((await app.request("/", { headers: ipHeaders("1.1.1.1") })).status).toBe(429);
    expect((await app.request("/", { headers: ipHeaders("2.2.2.2") })).status).toBe(200);
  });

  it("uses a custom 429 handler on denial, merging Retry-After in", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock });
    const denyHandler = vi.fn(() => new Response("nope", { status: 429 }));
    const app = appWith({
      strategy: gcra({ limit: 1, periodMs: 1000 }),
      clock,
      store,
      handler: denyHandler,
    });

    await app.request("/", { headers: ipHeaders("3.3.3.3") });
    const res = await app.request("/", { headers: ipHeaders("3.3.3.3") });
    expect(res.status).toBe(429);
    expect(await res.text()).toBe("nope");
    expect(denyHandler).toHaveBeenCalledTimes(1);
    expect(res.headers.get("Retry-After")).toBe("1");
    expect(res.headers.get("RateLimit-Limit")).toBe("1");
  });

  it("emit:false sets no rate-limit headers on allow", async () => {
    const clock = new ManualClock(0);
    const app = appWith({
      strategy: gcra({ limit: 2, periodMs: 1000 }),
      clock,
      store: new MemoryStore({ clock }),
      emit: false,
    });
    const res = await app.request("/", { headers: ipHeaders("1.2.3.4") });
    expect(res.status).toBe(200);
    expect(res.headers.get("RateLimit-Limit")).toBeNull();
  });

  it("supports a per-request cost function", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock });
    // burst of 3; a cost-3 request consumes the whole bucket, so the next is denied.
    const app = appWith({
      strategy: gcra({ limit: 3, periodMs: 1000 }),
      clock,
      store,
      cost: () => 3,
    });
    const first = await app.request("/", { headers: ipHeaders("4.4.4.4") });
    expect(first.status).toBe(200);
    expect(first.headers.get("RateLimit-Remaining")).toBe("0");
    const second = await app.request("/", { headers: ipHeaders("4.4.4.4") });
    expect(second.status).toBe(429);
  });
});
