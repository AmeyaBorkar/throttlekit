import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import Koa from "koa";
import type { Context } from "koa";
import { afterEach, describe, expect, it, vi } from "vitest";
import { koaRateLimit } from "../../src/adapters/koa";
import type { KoaRateLimitOptions } from "../../src/adapters/koa";
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

/** A live test server: a real Koa app behind a real http.Server on an ephemeral port. */
interface Harness {
  server: Server;
  /** Issue a real HTTP request to the app and return status, headers, and parsed JSON body. */
  get(
    headers?: Record<string, string>,
  ): Promise<{ status: number; headers: Headers; body: unknown }>;
}

/** Mount the rate-limit middleware plus a trivial OK terminal middleware and start listening. */
async function makeHarness(
  options: KoaRateLimitOptions,
  terminal?: Koa.Middleware,
): Promise<Harness> {
  const app = new Koa();
  app.silent = true; // suppress error logging for the throwing-store cases
  app.use(koaRateLimit(options));
  app.use(
    terminal ??
      (async (ctx) => {
        ctx.status = 200;
        ctx.body = { ok: true };
      }),
  );

  const server = createServer(app.callback());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}/`;

  return {
    server,
    async get(headers?: Record<string, string>) {
      const init: RequestInit = headers !== undefined ? { headers } : {};
      const res = await fetch(base, init);
      const text = await res.text();
      const body = text.length > 0 ? JSON.parse(text) : undefined;
      return { status: res.status, headers: res.headers, body };
    },
  };
}

describe("koaRateLimit", () => {
  const servers: Server[] = [];
  const track = (h: Harness): Harness => {
    servers.push(h.server);
    return h;
  };

  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop();
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
  });

  it("allows under the limit and sets draft RateLimit-* headers", async () => {
    const clock = new ManualClock(0);
    const h = track(
      await makeHarness({
        strategy: gcra({ limit: 2, periodMs: 1000 }),
        clock,
        store: new MemoryStore({ clock }),
      }),
    );

    const res = await h.get();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers.get("ratelimit-limit")).toBe("2");
    expect(res.headers.get("ratelimit-remaining")).toBe("1");
    expect(res.headers.get("ratelimit-reset")).toBe("1"); // ceil(500/1000)
  });

  it("denies over the limit: 429 + Retry-After + JSON body, chain stops", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock });
    let terminalCalls = 0;
    const h = track(
      await makeHarness(
        { strategy: gcra({ limit: 1, periodMs: 1000 }), clock, store },
        async (ctx) => {
          terminalCalls += 1;
          ctx.status = 200;
          ctx.body = { ok: true };
        },
      ),
    );

    const first = await h.get();
    expect(first.status).toBe(200);

    const res = await h.get();
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("1");
    expect(res.headers.get("ratelimit-remaining")).toBe("0");
    expect(res.body).toMatchObject({ error: "Too Many Requests" });
    expect((res.body as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(0);
    // The terminal middleware ran only for the allowed request.
    expect(terminalCalls).toBe(1);
  });

  it("fail-open: store error allows the request (chain continues, onError fired)", async () => {
    const onError = vi.fn();
    const h = track(
      await makeHarness({
        strategy: gcra({ limit: 5, periodMs: 1000 }),
        store: throwingStore,
        fail: "open",
        onError,
      }),
    );

    const res = await h.get();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("fail-closed: store error responds 503 and stops the chain", async () => {
    const onError = vi.fn();
    let terminalCalls = 0;
    const h = track(
      await makeHarness(
        {
          strategy: gcra({ limit: 5, periodMs: 1000 }),
          store: throwingStore,
          fail: "closed",
          onError,
        },
        async (ctx) => {
          terminalCalls += 1;
          ctx.status = 200;
        },
      ),
    );

    const res = await h.get();

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "rate limiter unavailable" });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(terminalCalls).toBe(0);
  });

  it("uses a custom key function", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock });
    const key = vi.fn((ctx: Context) => String(ctx.get("x-user") || "anon"));
    const h = track(
      await makeHarness({ strategy: gcra({ limit: 1, periodMs: 1000 }), clock, store, key }),
    );

    // alice: first allowed, second denied.
    const a1 = await h.get({ "x-user": "alice" });
    expect(a1.status).toBe(200);
    const a2 = await h.get({ "x-user": "alice" });
    expect(a2.status).toBe(429);

    // bob: independent key, first allowed.
    const b1 = await h.get({ "x-user": "bob" });
    expect(b1.status).toBe(200);
    expect(key).toHaveBeenCalled();
  });

  it("applies a custom cost (function form)", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock });
    const h = track(
      await makeHarness({
        strategy: gcra({ limit: 10, periodMs: 1000, burst: 10 }),
        clock,
        store,
        cost: () => 10,
      }),
    );

    const first = await h.get();
    expect(first.status).toBe(200);
    const second = await h.get();
    expect(second.status).toBe(429);
  });

  it("invokes a custom handler instead of the default 429 responder", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock });
    const handler = vi.fn((ctx: Context) => {
      ctx.status = 418;
      ctx.body = { teapot: true };
    });
    const h = track(
      await makeHarness({
        strategy: gcra({ limit: 1, periodMs: 1000 }),
        clock,
        store,
        handler,
      }),
    );

    const first = await h.get();
    expect(first.status).toBe(200);
    const res = await h.get();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(418);
    expect(res.body).toEqual({ teapot: true });
    // headers (incl Retry-After) are set before the custom handler runs
    expect(res.headers.get("retry-after")).toBe("1");
  });

  it("fires onLimited on denial", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock });
    const onLimited = vi.fn();
    const h = track(
      await makeHarness({ strategy: gcra({ limit: 1, periodMs: 1000 }), clock, store, onLimited }),
    );

    const first = await h.get();
    expect(first.status).toBe(200);
    const res = await h.get();
    expect(res.status).toBe(429);
    expect(onLimited).toHaveBeenCalledTimes(1);
  });

  it("emit:false suppresses all rate-limit headers", async () => {
    const clock = new ManualClock(0);
    const h = track(
      await makeHarness({
        strategy: gcra({ limit: 2, periodMs: 1000 }),
        clock,
        store: new MemoryStore({ clock }),
        emit: false,
      }),
    );

    const res = await h.get();

    expect(res.status).toBe(200);
    expect(res.headers.get("ratelimit-limit")).toBeNull();
    expect(res.headers.get("ratelimit-remaining")).toBeNull();
    expect(res.headers.get("ratelimit-reset")).toBeNull();
  });

  it("uses the proxy-correct default key (ignores spoofed XFF by default)", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock });
    const h = track(
      await makeHarness({ strategy: gcra({ limit: 1, periodMs: 1000 }), clock, store }),
    );

    // Same loopback socket peer, different spoofed XFF: must collapse to ONE key (XFF ignored).
    const first = await h.get({ "x-forwarded-for": "1.1.1.1" });
    expect(first.status).toBe(200);
    const second = await h.get({ "x-forwarded-for": "2.2.2.2" });
    expect(second.status).toBe(429);
  });

  it("emits structured headers using the strategy name + window", async () => {
    const clock = new ManualClock(0);
    const h = track(
      await makeHarness({
        strategy: gcra({ limit: 5, periodMs: 1000 }),
        clock,
        store: new MemoryStore({ clock }),
        emit: { draft: true, structured: true },
      }),
    );

    const res = await h.get();

    expect(res.headers.get("ratelimit")).toBe('"gcra";r=4;t=1');
    expect(res.headers.get("ratelimit-policy")).toBe('"gcra";q=5;w=1');
  });

  it("derives windowSeconds from a larger window (fixedWindow)", async () => {
    const clock = new ManualClock(0);
    const h = track(
      await makeHarness({
        strategy: fixedWindow({ limit: 5, windowMs: 60_000 }),
        clock,
        store: new MemoryStore({ clock }),
        emit: { structured: true },
      }),
    );

    const res = await h.get();
    expect(res.headers.get("ratelimit-policy")).toBe('"fixedWindow";q=5;w=60');
  });

  it("respects a custom policyName", async () => {
    const clock = new ManualClock(0);
    const h = track(
      await makeHarness({
        strategy: gcra({ limit: 5, periodMs: 1000 }),
        clock,
        store: new MemoryStore({ clock }),
        emit: { structured: true },
        policyName: "public-api",
      }),
    );

    const res = await h.get();
    expect(res.headers.get("ratelimit-policy")).toBe('"public-api";q=5;w=1');
  });

  it("accepts a prebuilt limiter via the { limiter } form", async () => {
    const clock = new ManualClock(0);
    const limiter = rateLimit({
      strategy: gcra({ limit: 1, periodMs: 1000 }),
      clock,
      store: new MemoryStore({ clock }),
    });
    const h = track(await makeHarness({ limiter, emit: false }));

    const res = await h.get();
    expect(res.status).toBe(200);
  });
});
