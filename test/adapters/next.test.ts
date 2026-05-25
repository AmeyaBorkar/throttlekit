import { describe, expect, it, vi } from "vitest";
import { nextRateLimit } from "../../src/adapters/next";
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

const reqFor = (ip: string): Request =>
  new Request("https://x.test/", { headers: { "cf-connecting-ip": ip } });

describe("nextRateLimit (next.js, dependency-free)", () => {
  it("allows under the limit: { limited: false } with draft headers", async () => {
    const clock = new ManualClock(0);
    const limit = nextRateLimit({
      strategy: gcra({ limit: 2, periodMs: 1000 }),
      clock,
      store: new MemoryStore({ clock }),
    });
    const r = await limit(reqFor("1.2.3.4"));
    expect(r.limited).toBe(false);
    if (r.limited) throw new Error("expected allowed");
    expect(r.headers["RateLimit-Limit"]).toBe("2");
    expect(r.headers["RateLimit-Remaining"]).toBe("1");
    expect(r.headers["RateLimit-Reset"]).toBe("1");
  });

  it("denies over the limit: { limited: true } 429 + Retry-After + JSON", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock });
    const limit = nextRateLimit({ strategy: gcra({ limit: 1, periodMs: 1000 }), clock, store });

    const first = await limit(reqFor("5.5.5.5"));
    expect(first.limited).toBe(false);

    const second = await limit(reqFor("5.5.5.5"));
    expect(second.limited).toBe(true);
    if (!second.limited) throw new Error("expected denied");
    expect(second.response.status).toBe(429);
    expect(second.response.headers.get("Retry-After")).toBe("1");
    expect(second.response.headers.get("RateLimit-Remaining")).toBe("0");
    expect(second.response.headers.get("Content-Type")).toBe("application/json");
    expect(await second.response.json()).toMatchObject({ error: "Too Many Requests" });
  });

  it("fail-open: store error yields { limited: false, headers: {} }", async () => {
    const onError = vi.fn();
    const limit = nextRateLimit({
      strategy: gcra({ limit: 5, periodMs: 1000 }),
      store: throwingStore,
      fail: "open",
      onError,
    });
    const r = await limit(reqFor("1.1.1.1"));
    expect(r.limited).toBe(false);
    if (r.limited) throw new Error("expected allowed");
    expect(r.headers).toEqual({});
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("fail-closed: store error yields { limited: true } 503", async () => {
    const onError = vi.fn();
    const limit = nextRateLimit({
      strategy: gcra({ limit: 5, periodMs: 1000 }),
      store: throwingStore,
      fail: "closed",
      onError,
    });
    const r = await limit(reqFor("1.1.1.1"));
    expect(r.limited).toBe(true);
    if (!r.limited) throw new Error("expected denied");
    expect(r.response.status).toBe(503);
    expect(await r.response.json()).toMatchObject({ error: "rate limiter unavailable" });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("uses a custom key (distinct keys are independent buckets)", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock });
    const limit = nextRateLimit({
      strategy: gcra({ limit: 1, periodMs: 1000 }),
      clock,
      store,
      key: (request) => new URL(request.url).searchParams.get("tenant") ?? "anon",
    });
    const req = (tenant: string): Request => new Request(`https://x.test/?tenant=${tenant}`);
    expect((await limit(req("a"))).limited).toBe(false);
    expect((await limit(req("a"))).limited).toBe(true); // same tenant -> denied
    expect((await limit(req("b"))).limited).toBe(false); // independent
  });

  it("derives the key from cf-connecting-ip (distinct IPs are independent)", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock });
    const limit = nextRateLimit({ strategy: gcra({ limit: 1, periodMs: 1000 }), clock, store });
    expect((await limit(reqFor("1.1.1.1"))).limited).toBe(false);
    expect((await limit(reqFor("1.1.1.1"))).limited).toBe(true);
    expect((await limit(reqFor("2.2.2.2"))).limited).toBe(false);
  });

  it("falls back to x-forwarded-for (trust-aware) when cf-connecting-ip is absent", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock });
    const limit = nextRateLimit({
      strategy: gcra({ limit: 1, periodMs: 1000 }),
      clock,
      store,
      trustProxy: 1,
    });
    const r1 = new Request("https://x.test/", {
      headers: { "x-forwarded-for": "8.8.8.8, 10.0.0.1" },
    });
    const r2 = new Request("https://x.test/", {
      headers: { "x-forwarded-for": "8.8.8.8, 10.0.0.2" },
    });
    expect((await limit(r1)).limited).toBe(false);
    expect((await limit(r2)).limited).toBe(true); // same client despite different proxy
  });

  it("falls back to 'anon' when no IP headers are present (shared bucket)", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock });
    const limit = nextRateLimit({ strategy: gcra({ limit: 1, periodMs: 1000 }), clock, store });
    expect((await limit(new Request("https://x.test/a"))).limited).toBe(false);
    expect((await limit(new Request("https://x.test/b"))).limited).toBe(true); // same 'anon'
  });

  it("uses a custom 429 handler on denial, merging Retry-After in", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock });
    const denyHandler = vi.fn(() => new Response("nope", { status: 429 }));
    const limit = nextRateLimit({
      strategy: gcra({ limit: 1, periodMs: 1000 }),
      clock,
      store,
      handler: denyHandler,
    });

    await limit(reqFor("3.3.3.3"));
    const r = await limit(reqFor("3.3.3.3"));
    expect(r.limited).toBe(true);
    if (!r.limited) throw new Error("expected denied");
    expect(r.response.status).toBe(429);
    expect(await r.response.text()).toBe("nope");
    expect(denyHandler).toHaveBeenCalledTimes(1);
    expect(r.response.headers.get("Retry-After")).toBe("1");
  });

  it("emit:false yields empty headers on allow", async () => {
    const clock = new ManualClock(0);
    const limit = nextRateLimit({
      strategy: gcra({ limit: 2, periodMs: 1000 }),
      clock,
      store: new MemoryStore({ clock }),
      emit: false,
    });
    const r = await limit(reqFor("1.2.3.4"));
    expect(r.limited).toBe(false);
    if (r.limited) throw new Error("expected allowed");
    expect(r.headers).toEqual({});
  });

  it("supports a per-request cost function", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock });
    const limit = nextRateLimit({
      strategy: gcra({ limit: 3, periodMs: 1000 }),
      clock,
      store,
      cost: () => 3,
    });
    const first = await limit(reqFor("4.4.4.4"));
    expect(first.limited).toBe(false);
    if (first.limited) throw new Error("expected allowed");
    expect(first.headers["RateLimit-Remaining"]).toBe("0");
    expect((await limit(reqFor("4.4.4.4"))).limited).toBe(true);
  });
});
