import { describe, expect, it, vi } from "vitest";
import { withRateLimit } from "../../src/adapters/fetch";
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

const okHandler = (): Response => new Response("hello", { status: 200 });

describe("withRateLimit (fetch)", () => {
  it("allows under the limit: 200 + body preserved + draft headers copied on", async () => {
    const clock = new ManualClock(0);
    const wrapped = withRateLimit(okHandler, {
      strategy: gcra({ limit: 2, periodMs: 1000 }),
      clock,
      store: new MemoryStore({ clock }),
    });
    const res = await wrapped(
      new Request("https://x.test/", { headers: { "cf-connecting-ip": "1.2.3.4" } }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
    expect(res.headers.get("RateLimit-Limit")).toBe("2");
    expect(res.headers.get("RateLimit-Remaining")).toBe("1");
    expect(res.headers.get("RateLimit-Reset")).toBe("1");
  });

  it("preserves headers the handler itself set", async () => {
    const clock = new ManualClock(0);
    const handler = (): Response =>
      new Response("ok", { status: 201, headers: { "X-Custom": "yes" } });
    const wrapped = withRateLimit(handler, {
      strategy: gcra({ limit: 2, periodMs: 1000 }),
      clock,
      store: new MemoryStore({ clock }),
    });
    const res = await wrapped(
      new Request("https://x.test/", { headers: { "cf-connecting-ip": "9.9.9.9" } }),
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("X-Custom")).toBe("yes");
    expect(res.headers.get("RateLimit-Limit")).toBe("2");
  });

  it("denies over the limit: 429 + Retry-After, handler not called", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock });
    const handler = vi.fn(okHandler);
    const wrapped = withRateLimit(handler, {
      strategy: gcra({ limit: 1, periodMs: 1000 }),
      clock,
      store,
    });
    const req = (): Request =>
      new Request("https://x.test/", { headers: { "cf-connecting-ip": "5.5.5.5" } });

    const first = await wrapped(req());
    expect(first.status).toBe(200);
    handler.mockClear();

    const second = await wrapped(req());
    expect(second.status).toBe(429);
    expect(second.headers.get("Retry-After")).toBe("1");
    expect(second.headers.get("RateLimit-Remaining")).toBe("0");
    expect(handler).not.toHaveBeenCalled();
    expect(await second.json()).toMatchObject({ error: "Too Many Requests" });
  });

  it("fail-open: store error forwards to the handler (200)", async () => {
    const onError = vi.fn();
    const handler = vi.fn(okHandler);
    const wrapped = withRateLimit(handler, {
      strategy: gcra({ limit: 5, periodMs: 1000 }),
      store: throwingStore,
      fail: "open",
      onError,
    });
    const res = await wrapped(new Request("https://x.test/"));
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("fail-closed: store error returns 503, handler not called", async () => {
    const onError = vi.fn();
    const handler = vi.fn(okHandler);
    const wrapped = withRateLimit(handler, {
      strategy: gcra({ limit: 5, periodMs: 1000 }),
      store: throwingStore,
      fail: "closed",
      onError,
    });
    const res = await wrapped(new Request("https://x.test/"));
    expect(res.status).toBe(503);
    expect(handler).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("derives the key from cf-connecting-ip (distinct IPs are independent)", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock });
    const wrapped = withRateLimit(okHandler, {
      strategy: gcra({ limit: 1, periodMs: 1000 }),
      clock,
      store,
    });
    const reqFor = (ip: string): Request =>
      new Request("https://x.test/", { headers: { "cf-connecting-ip": ip } });

    expect((await wrapped(reqFor("1.1.1.1"))).status).toBe(200); // A first
    expect((await wrapped(reqFor("1.1.1.1"))).status).toBe(429); // A second -> denied
    expect((await wrapped(reqFor("2.2.2.2"))).status).toBe(200); // B independent
  });

  it("cf-connecting-ip takes precedence over x-forwarded-for", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock });
    const wrapped = withRateLimit(okHandler, {
      strategy: gcra({ limit: 1, periodMs: 1000 }),
      clock,
      store,
    });
    // Both requests share cf-connecting-ip but differ in XFF; cf wins so they collide -> 2nd denied.
    const r1 = new Request("https://x.test/", {
      headers: { "cf-connecting-ip": "7.7.7.7", "x-forwarded-for": "1.1.1.1" },
    });
    const r2 = new Request("https://x.test/", {
      headers: { "cf-connecting-ip": "7.7.7.7", "x-forwarded-for": "2.2.2.2" },
    });
    expect((await wrapped(r1)).status).toBe(200);
    expect((await wrapped(r2)).status).toBe(429);
  });

  it("falls back to x-forwarded-for (trust-aware) when cf-connecting-ip is absent", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock });
    const wrapped = withRateLimit(okHandler, {
      strategy: gcra({ limit: 1, periodMs: 1000 }),
      clock,
      store,
      trustProxy: 1, // trust one hop: client is the entry left of the rightmost
    });
    // chain (synthetic remoteAddr = rightmost XFF): [client, proxy]; trust 1 -> client.
    const r1 = new Request("https://x.test/", {
      headers: { "x-forwarded-for": "8.8.8.8, 10.0.0.1" },
    });
    const r2 = new Request("https://x.test/", {
      headers: { "x-forwarded-for": "8.8.8.8, 10.0.0.2" },
    });
    expect((await wrapped(r1)).status).toBe(200);
    expect((await wrapped(r2)).status).toBe(429); // same client 8.8.8.8 despite different proxy
  });

  it("falls back to 'anon' when no IP headers are present (shared bucket)", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock });
    const wrapped = withRateLimit(okHandler, {
      strategy: gcra({ limit: 1, periodMs: 1000 }),
      clock,
      store,
    });
    expect((await wrapped(new Request("https://x.test/a"))).status).toBe(200);
    expect((await wrapped(new Request("https://x.test/b"))).status).toBe(429); // same 'anon' key
  });

  it("emit:false copies no rate-limit headers on allow", async () => {
    const clock = new ManualClock(0);
    const wrapped = withRateLimit(okHandler, {
      strategy: gcra({ limit: 2, periodMs: 1000 }),
      clock,
      store: new MemoryStore({ clock }),
      emit: false,
    });
    const res = await wrapped(
      new Request("https://x.test/", { headers: { "cf-connecting-ip": "1.2.3.4" } }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("RateLimit-Limit")).toBeNull();
  });

  it("supports an async handler and forwards extra args", async () => {
    const clock = new ManualClock(0);
    const handler = vi.fn(async (_req: Request, ...args: unknown[]) => {
      return new Response(JSON.stringify(args), { status: 200 });
    });
    const wrapped = withRateLimit(handler, {
      strategy: gcra({ limit: 2, periodMs: 1000 }),
      clock,
      store: new MemoryStore({ clock }),
    });
    const env = { secret: 1 };
    const res = await wrapped(
      new Request("https://x.test/", { headers: { "cf-connecting-ip": "1.2.3.4" } }),
      env,
    );
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledWith(expect.any(Request), env);
  });

  it("uses a custom 429 handler on denial", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock });
    const denyHandler = vi.fn(() => new Response("nope", { status: 429 }));
    const wrapped = withRateLimit(okHandler, {
      strategy: gcra({ limit: 1, periodMs: 1000 }),
      clock,
      store,
      handler: denyHandler,
    });
    const req = (): Request =>
      new Request("https://x.test/", { headers: { "cf-connecting-ip": "3.3.3.3" } });
    await wrapped(req());
    const res = await wrapped(req());
    expect(res.status).toBe(429);
    expect(await res.text()).toBe("nope");
    expect(denyHandler).toHaveBeenCalledTimes(1);
    // Rate-limit headers (Retry-After) are merged in without clobbering the custom response.
    expect(res.headers.get("Retry-After")).toBe("1");
  });
});
