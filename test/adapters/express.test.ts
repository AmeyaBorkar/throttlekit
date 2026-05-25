import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { expressRateLimit } from "../../src/adapters/express";
import { fixedWindow } from "../../src/algorithms/fixed-window";
import { gcra } from "../../src/algorithms/gcra";
import { ManualClock } from "../../src/core/clock";
import { StoreUnavailableError } from "../../src/core/errors";
import { rateLimit } from "../../src/core/limiter";
import type { Store, Transform } from "../../src/core/types";
import { MemoryStore } from "../../src/stores/memory";

/** A live captured response: closures mutate THIS object in place (read fields directly). */
interface MockRes {
  res: Response;
  statusCode: number | undefined;
  headers: Record<string, string>;
  jsonBody: unknown;
  endBody: unknown;
  ended: boolean;
}

function makeRes(): MockRes {
  const m: MockRes = {
    statusCode: undefined,
    headers: {},
    jsonBody: undefined,
    endBody: undefined,
    ended: false,
    res: undefined as unknown as Response,
  };
  const res = {
    status(code: number) {
      m.statusCode = code;
      return res;
    },
    setHeader(name: string, value: string) {
      m.headers[name] = value;
      return res;
    },
    json(body: unknown) {
      m.jsonBody = body;
      m.ended = true;
      return res;
    },
    end(body?: unknown) {
      m.endBody = body;
      m.ended = true;
      return res;
    },
  } as unknown as Response;
  m.res = res;
  return m;
}

function makeReq(overrides: Record<string, unknown> = {}): Request {
  return {
    socket: { remoteAddress: "203.0.113.5" },
    headers: {},
    ...overrides,
  } as unknown as Request;
}

/** A store whose apply always rejects, to exercise fail policies. */
const throwingStore: Store = {
  apply<S, R>(_key: string, _t: Transform<S, R>): Promise<R> {
    return Promise.reject(new StoreUnavailableError());
  },
  reset(): Promise<void> {
    return Promise.resolve();
  },
};

describe("expressRateLimit", () => {
  it("allows under the limit and calls next() with draft headers set", async () => {
    const clock = new ManualClock(0);
    const mw = expressRateLimit({
      strategy: gcra({ limit: 2, periodMs: 1000 }),
      clock,
      store: new MemoryStore({ clock }),
    });
    const m = makeRes();
    const next = vi.fn();

    mw(makeReq(), m.res, next);
    await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(1));

    expect(m.statusCode).toBeUndefined();
    expect(m.ended).toBe(false);
    expect(m.headers["RateLimit-Limit"]).toBe("2");
    expect(m.headers["RateLimit-Remaining"]).toBe("1");
    expect(m.headers["RateLimit-Reset"]).toBe("1"); // ceil(500/1000)
  });

  it("denies over the limit: 429 + Retry-After + headers, next() not called", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock });
    const strategy = gcra({ limit: 1, periodMs: 1000 }); // burst 1: 2nd request denied
    const mw = expressRateLimit({ strategy, clock, store });

    // First request consumes the single slot.
    {
      const next = vi.fn();
      mw(makeReq(), makeRes().res, next);
      await vi.waitFor(() => expect(next).toHaveBeenCalled());
    }

    const next = vi.fn();
    const m = makeRes();
    mw(makeReq(), m.res, next);
    await vi.waitFor(() => expect(m.ended).toBe(true));

    expect(next).not.toHaveBeenCalled();
    expect(m.statusCode).toBe(429);
    expect(m.headers["Retry-After"]).toBe("1");
    expect(m.headers["RateLimit-Remaining"]).toBe("0");
    expect(m.jsonBody).toMatchObject({ error: "Too Many Requests" });
  });

  it("fail-open: store error allows the request (next called, no error status)", async () => {
    const onError = vi.fn();
    const mw = expressRateLimit({
      strategy: gcra({ limit: 5, periodMs: 1000 }),
      store: throwingStore,
      fail: "open",
      onError,
    });
    const next = vi.fn();
    const m = makeRes();
    mw(makeReq(), m.res, next);
    await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(1));

    expect(onError).toHaveBeenCalledTimes(1);
    expect(m.statusCode).toBeUndefined();
  });

  it("fail-closed: store error responds 503 and does not call next", async () => {
    const onError = vi.fn();
    const mw = expressRateLimit({
      strategy: gcra({ limit: 5, periodMs: 1000 }),
      store: throwingStore,
      fail: "closed",
      onError,
    });
    const next = vi.fn();
    const m = makeRes();
    mw(makeReq(), m.res, next);
    await vi.waitFor(() => expect(m.ended).toBe(true));

    expect(onError).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
    expect(m.statusCode).toBe(503);
  });

  it("uses a custom key function", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock });
    const strategy = gcra({ limit: 1, periodMs: 1000 });
    const key = vi.fn((req: Request) => String((req as unknown as { uid: string }).uid));
    const mw = expressRateLimit({ strategy, clock, store, key });

    const reqA = makeReq({ uid: "alice" });
    const reqB = makeReq({ uid: "bob" });

    // alice's first request: allowed
    {
      const next = vi.fn();
      mw(reqA, makeRes().res, next);
      await vi.waitFor(() => expect(next).toHaveBeenCalled());
    }
    // alice's second request: denied
    {
      const next = vi.fn();
      const m = makeRes();
      mw(reqA, m.res, next);
      await vi.waitFor(() => expect(m.ended).toBe(true));
      expect(m.statusCode).toBe(429);
    }
    // bob's first request: allowed (independent key)
    {
      const next = vi.fn();
      mw(reqB, makeRes().res, next);
      await vi.waitFor(() => expect(next).toHaveBeenCalled());
    }
    expect(key).toHaveBeenCalled();
  });

  it("applies a custom cost (function form)", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock });
    // burst 10; a cost-10 request fills it, so the next is denied.
    const mw = expressRateLimit({
      strategy: gcra({ limit: 10, periodMs: 1000, burst: 10 }),
      clock,
      store,
      cost: () => 10,
    });

    {
      const next = vi.fn();
      mw(makeReq(), makeRes().res, next);
      await vi.waitFor(() => expect(next).toHaveBeenCalled());
    }
    const next = vi.fn();
    const m = makeRes();
    mw(makeReq(), m.res, next);
    await vi.waitFor(() => expect(m.ended).toBe(true));
    expect(m.statusCode).toBe(429);
    expect(next).not.toHaveBeenCalled();
  });

  it("invokes a custom handler instead of the default 429 responder", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock });
    const handler = vi.fn((_req: Request, res: Response) => {
      res.status(418).json({ teapot: true });
    });
    const mw = expressRateLimit({
      strategy: gcra({ limit: 1, periodMs: 1000 }),
      clock,
      store,
      handler,
    });

    {
      const next = vi.fn();
      mw(makeReq(), makeRes().res, next);
      await vi.waitFor(() => expect(next).toHaveBeenCalled());
    }
    const next = vi.fn();
    const m = makeRes();
    mw(makeReq(), m.res, next);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

    expect(m.statusCode).toBe(418);
    expect(m.jsonBody).toEqual({ teapot: true });
    // headers (incl Retry-After) are still set before the custom handler runs
    expect(m.headers["Retry-After"]).toBe("1");
  });

  it("fires onLimited on denial", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock });
    const onLimited = vi.fn();
    const mw = expressRateLimit({
      strategy: gcra({ limit: 1, periodMs: 1000 }),
      clock,
      store,
      onLimited,
    });
    {
      const next = vi.fn();
      mw(makeReq(), makeRes().res, next);
      await vi.waitFor(() => expect(next).toHaveBeenCalled());
    }
    const m = makeRes();
    mw(makeReq(), m.res, vi.fn());
    await vi.waitFor(() => expect(m.ended).toBe(true));
    expect(onLimited).toHaveBeenCalledTimes(1);
  });

  it("emit:false suppresses all rate-limit headers", async () => {
    const clock = new ManualClock(0);
    const mw = expressRateLimit({
      strategy: gcra({ limit: 2, periodMs: 1000 }),
      clock,
      store: new MemoryStore({ clock }),
      emit: false,
    });
    const next = vi.fn();
    const m = makeRes();
    mw(makeReq(), m.res, next);
    await vi.waitFor(() => expect(next).toHaveBeenCalled());
    expect(Object.keys(m.headers)).toHaveLength(0);
  });

  it("uses the proxy-correct default key (ignores spoofed XFF by default)", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock });
    const strategy = gcra({ limit: 1, periodMs: 1000 });
    const mw = expressRateLimit({ strategy, clock, store });

    // Same socket peer, different (spoofed) XFF: must collapse to ONE key since XFF is ignored.
    const reqWithSpoof1 = makeReq({
      socket: { remoteAddress: "203.0.113.5" },
      headers: { "x-forwarded-for": "1.1.1.1" },
    });
    const reqWithSpoof2 = makeReq({
      socket: { remoteAddress: "203.0.113.5" },
      headers: { "x-forwarded-for": "2.2.2.2" },
    });

    {
      const next = vi.fn();
      mw(reqWithSpoof1, makeRes().res, next);
      await vi.waitFor(() => expect(next).toHaveBeenCalled());
    }
    const next = vi.fn();
    const m = makeRes();
    mw(reqWithSpoof2, m.res, next);
    await vi.waitFor(() => expect(m.ended).toBe(true));
    expect(m.statusCode).toBe(429); // same key despite differing spoofed XFF
  });

  it("emits structured headers using the strategy name + window (gcra exposes windowMs)", async () => {
    const clock = new ManualClock(0);
    const mw = expressRateLimit({
      strategy: gcra({ limit: 5, periodMs: 1000 }),
      clock,
      store: new MemoryStore({ clock }),
      emit: { draft: true, structured: true },
    });
    const next = vi.fn();
    const m = makeRes();
    mw(makeReq(), m.res, next);
    await vi.waitFor(() => expect(next).toHaveBeenCalled());
    expect(m.headers.RateLimit).toBe('"gcra";r=4;t=1');
    expect(m.headers["RateLimit-Policy"]).toBe('"gcra";q=5;w=1'); // windowMs 1000 -> w=1
  });

  it("derives windowSeconds from a strategy with a larger window (fixedWindow)", async () => {
    const clock = new ManualClock(0);
    const mw = expressRateLimit({
      strategy: fixedWindow({ limit: 5, windowMs: 60_000 }),
      clock,
      store: new MemoryStore({ clock }),
      emit: { structured: true },
    });
    const next = vi.fn();
    const m = makeRes();
    mw(makeReq(), m.res, next);
    await vi.waitFor(() => expect(next).toHaveBeenCalled());
    expect(m.headers["RateLimit-Policy"]).toBe('"fixedWindow";q=5;w=60');
  });

  it("respects a custom policyName", async () => {
    const clock = new ManualClock(0);
    const mw = expressRateLimit({
      strategy: gcra({ limit: 5, periodMs: 1000 }),
      clock,
      store: new MemoryStore({ clock }),
      emit: { structured: true },
      policyName: "public-api",
    });
    const next = vi.fn();
    const m = makeRes();
    mw(makeReq(), m.res, next);
    await vi.waitFor(() => expect(next).toHaveBeenCalled());
    expect(m.headers["RateLimit-Policy"]).toBe('"public-api";q=5;w=1');
  });

  it("accepts a prebuilt limiter via the { limiter } form", async () => {
    const clock = new ManualClock(0);
    const limiter = rateLimit({
      strategy: gcra({ limit: 1, periodMs: 1000 }),
      clock,
      store: new MemoryStore({ clock }),
    });
    const mw = expressRateLimit({ limiter, emit: false });
    const next = vi.fn();
    mw(makeReq(), makeRes().res, next);
    await vi.waitFor(() => expect(next).toHaveBeenCalled());
  });
});
