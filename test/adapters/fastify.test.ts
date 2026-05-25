import Fastify from "fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fastifyRateLimit } from "../../src/adapters/fastify";
import type { FastifyRateLimitOptions } from "../../src/adapters/fastify";
import { fixedWindow } from "../../src/algorithms/fixed-window";
import { gcra } from "../../src/algorithms/gcra";
import { ManualClock } from "../../src/core/clock";
import { StoreUnavailableError } from "../../src/core/errors";
import { rateLimit } from "../../src/core/limiter";
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

/** Build a Fastify app with the rate-limit hook registered and a trivial OK route. */
function makeApp(options: FastifyRateLimitOptions): FastifyInstance {
  const app = Fastify();
  app.addHook("onRequest", fastifyRateLimit(options));
  app.get("/", async () => ({ ok: true }));
  return app;
}

describe("fastifyRateLimit", () => {
  const apps: FastifyInstance[] = [];
  const track = (app: FastifyInstance): FastifyInstance => {
    apps.push(app);
    return app;
  };

  afterEach(async () => {
    while (apps.length > 0) {
      const app = apps.pop();
      await app?.close();
    }
  });

  it("allows under the limit and sets draft RateLimit-* headers", async () => {
    const clock = new ManualClock(0);
    const app = track(
      makeApp({
        strategy: gcra({ limit: 2, periodMs: 1000 }),
        clock,
        store: new MemoryStore({ clock }),
      }),
    );

    const res = await app.inject({ method: "GET", url: "/", remoteAddress: "203.0.113.5" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(res.headers["ratelimit-limit"]).toBe("2");
    expect(res.headers["ratelimit-remaining"]).toBe("1");
    expect(res.headers["ratelimit-reset"]).toBe("1"); // ceil(500/1000)
  });

  it("denies over the limit: 429 + Retry-After + JSON body, route not reached", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock });
    const app = track(makeApp({ strategy: gcra({ limit: 1, periodMs: 1000 }), clock, store }));

    // First request consumes the single slot.
    const first = await app.inject({ method: "GET", url: "/", remoteAddress: "203.0.113.5" });
    expect(first.statusCode).toBe(200);

    const res = await app.inject({ method: "GET", url: "/", remoteAddress: "203.0.113.5" });

    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBe("1");
    expect(res.headers["ratelimit-remaining"]).toBe("0");
    expect(res.json()).toMatchObject({ error: "Too Many Requests" });
    expect(res.json().retryAfterMs).toBeGreaterThan(0);
  });

  it("fail-open: store error allows the request (route reached, onError fired)", async () => {
    const onError = vi.fn();
    const app = track(
      makeApp({
        strategy: gcra({ limit: 5, periodMs: 1000 }),
        store: throwingStore,
        fail: "open",
        onError,
      }),
    );

    const res = await app.inject({ method: "GET", url: "/", remoteAddress: "203.0.113.5" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("fail-closed: store error responds 503 and does not reach the route", async () => {
    const onError = vi.fn();
    const app = track(
      makeApp({
        strategy: gcra({ limit: 5, periodMs: 1000 }),
        store: throwingStore,
        fail: "closed",
        onError,
      }),
    );

    const res = await app.inject({ method: "GET", url: "/", remoteAddress: "203.0.113.5" });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "rate limiter unavailable" });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("uses a custom key function", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock });
    const key = vi.fn((request: { headers: Record<string, string | string[] | undefined> }) =>
      String(request.headers["x-user"] ?? "anon"),
    );
    const app = track(makeApp({ strategy: gcra({ limit: 1, periodMs: 1000 }), clock, store, key }));

    // alice: first allowed, second denied.
    const a1 = await app.inject({ method: "GET", url: "/", headers: { "x-user": "alice" } });
    expect(a1.statusCode).toBe(200);
    const a2 = await app.inject({ method: "GET", url: "/", headers: { "x-user": "alice" } });
    expect(a2.statusCode).toBe(429);

    // bob: independent key, first allowed.
    const b1 = await app.inject({ method: "GET", url: "/", headers: { "x-user": "bob" } });
    expect(b1.statusCode).toBe(200);
    expect(key).toHaveBeenCalled();
  });

  it("applies a custom cost (function form)", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock });
    const app = track(
      makeApp({
        strategy: gcra({ limit: 10, periodMs: 1000, burst: 10 }),
        clock,
        store,
        cost: () => 10,
      }),
    );

    const first = await app.inject({ method: "GET", url: "/", remoteAddress: "203.0.113.5" });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: "GET", url: "/", remoteAddress: "203.0.113.5" });
    expect(second.statusCode).toBe(429);
  });

  it("invokes a custom handler instead of the default 429 responder", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock });
    const handler = vi.fn((_request: FastifyRequest, reply: FastifyReply) => {
      void reply.code(418).send({ teapot: true });
    });
    const app = track(
      makeApp({
        strategy: gcra({ limit: 1, periodMs: 1000 }),
        clock,
        store,
        handler,
      }),
    );

    const first = await app.inject({ method: "GET", url: "/", remoteAddress: "203.0.113.5" });
    expect(first.statusCode).toBe(200);
    const res = await app.inject({ method: "GET", url: "/", remoteAddress: "203.0.113.5" });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(418);
    expect(res.json()).toEqual({ teapot: true });
    // headers (incl Retry-After) are set before the custom handler runs
    expect(res.headers["retry-after"]).toBe("1");
  });

  it("fires onLimited on denial", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock });
    const onLimited = vi.fn();
    const app = track(
      makeApp({ strategy: gcra({ limit: 1, periodMs: 1000 }), clock, store, onLimited }),
    );

    const first = await app.inject({ method: "GET", url: "/", remoteAddress: "203.0.113.5" });
    expect(first.statusCode).toBe(200);
    const res = await app.inject({ method: "GET", url: "/", remoteAddress: "203.0.113.5" });
    expect(res.statusCode).toBe(429);
    expect(onLimited).toHaveBeenCalledTimes(1);
  });

  it("emit:false suppresses all rate-limit headers", async () => {
    const clock = new ManualClock(0);
    const app = track(
      makeApp({
        strategy: gcra({ limit: 2, periodMs: 1000 }),
        clock,
        store: new MemoryStore({ clock }),
        emit: false,
      }),
    );

    const res = await app.inject({ method: "GET", url: "/", remoteAddress: "203.0.113.5" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["ratelimit-limit"]).toBeUndefined();
    expect(res.headers["ratelimit-remaining"]).toBeUndefined();
    expect(res.headers["ratelimit-reset"]).toBeUndefined();
  });

  it("uses the proxy-correct default key (ignores spoofed XFF by default)", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock });
    const app = track(makeApp({ strategy: gcra({ limit: 1, periodMs: 1000 }), clock, store }));

    // Same socket peer, different spoofed XFF: must collapse to ONE key since XFF is ignored.
    const first = await app.inject({
      method: "GET",
      url: "/",
      remoteAddress: "203.0.113.5",
      headers: { "x-forwarded-for": "1.1.1.1" },
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: "GET",
      url: "/",
      remoteAddress: "203.0.113.5",
      headers: { "x-forwarded-for": "2.2.2.2" },
    });
    expect(second.statusCode).toBe(429);
  });

  it("emits structured headers using the strategy name + window", async () => {
    const clock = new ManualClock(0);
    const app = track(
      makeApp({
        strategy: gcra({ limit: 5, periodMs: 1000 }),
        clock,
        store: new MemoryStore({ clock }),
        emit: { draft: true, structured: true },
      }),
    );

    const res = await app.inject({ method: "GET", url: "/", remoteAddress: "203.0.113.5" });

    expect(res.headers.ratelimit).toBe('"gcra";r=4;t=1');
    expect(res.headers["ratelimit-policy"]).toBe('"gcra";q=5;w=1');
  });

  it("derives windowSeconds from a larger window (fixedWindow)", async () => {
    const clock = new ManualClock(0);
    const app = track(
      makeApp({
        strategy: fixedWindow({ limit: 5, windowMs: 60_000 }),
        clock,
        store: new MemoryStore({ clock }),
        emit: { structured: true },
      }),
    );

    const res = await app.inject({ method: "GET", url: "/", remoteAddress: "203.0.113.5" });
    expect(res.headers["ratelimit-policy"]).toBe('"fixedWindow";q=5;w=60');
  });

  it("respects a custom policyName", async () => {
    const clock = new ManualClock(0);
    const app = track(
      makeApp({
        strategy: gcra({ limit: 5, periodMs: 1000 }),
        clock,
        store: new MemoryStore({ clock }),
        emit: { structured: true },
        policyName: "public-api",
      }),
    );

    const res = await app.inject({ method: "GET", url: "/", remoteAddress: "203.0.113.5" });
    expect(res.headers["ratelimit-policy"]).toBe('"public-api";q=5;w=1');
  });

  it("accepts a prebuilt limiter via the { limiter } form", async () => {
    const clock = new ManualClock(0);
    const limiter = rateLimit({
      strategy: gcra({ limit: 1, periodMs: 1000 }),
      clock,
      store: new MemoryStore({ clock }),
    });
    const app = track(makeApp({ limiter, emit: false }));

    const res = await app.inject({ method: "GET", url: "/", remoteAddress: "203.0.113.5" });
    expect(res.statusCode).toBe(200);
  });
});
