import { describe, expect, it, vi } from "vitest";
import type { NodeReqLike } from "../../src/adapters/core";
import {
  type NestExecutionContextLike,
  type NestResponseLike,
  nestRateLimit,
} from "../../src/adapters/nest";
import { fixedWindow } from "../../src/algorithms/fixed-window";
import { ManualClock } from "../../src/core/clock";
import { RateLimitExceededError } from "../../src/core/errors";
import type { Store } from "../../src/core/types";
import { MemoryStore } from "../../src/stores/memory";

/** A fake ExecutionContext over a request with `socket.remoteAddress = ip`, capturing set headers. */
function ctx(ip = "1.2.3.4"): {
  context: NestExecutionContextLike;
  headers: Record<string, string>;
} {
  const headers: Record<string, string> = {};
  const req: NodeReqLike = { socket: { remoteAddress: ip }, headers: {} };
  const res: NestResponseLike = {
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    },
  };
  return {
    context: { switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) },
    headers,
  };
}

const downStore: Store = {
  apply: () => Promise.reject(new Error("store down")),
  reset: () => Promise.resolve(),
};

function guard(extra: Record<string, unknown> = {}) {
  const clock = new ManualClock(0);
  return nestRateLimit({
    strategy: fixedWindow({ limit: 2, windowMs: 60_000 }),
    store: new MemoryStore({ clock, sweepIntervalMs: 0 }),
    clock,
    ...extra,
  });
}

describe("nestRateLimit", () => {
  it("returns true under the limit and sets standards headers on the response", async () => {
    const g = guard();
    const { context, headers } = ctx();
    expect(await g.canActivate(context)).toBe(true);
    expect(Object.keys(headers).some((k) => k.toLowerCase().startsWith("ratelimit"))).toBe(true);
  });

  it("throws RateLimitExceededError over the limit (default exception)", async () => {
    const g = guard();
    await g.canActivate(ctx().context);
    await g.canActivate(ctx().context);
    await expect(g.canActivate(ctx().context)).rejects.toBeInstanceOf(RateLimitExceededError);
  });

  it("uses a custom exceptionFactory (e.g. an HttpException stand-in)", async () => {
    class HttpException extends Error {
      constructor(
        readonly body: unknown,
        readonly status: number,
      ) {
        super("http");
      }
    }
    const g = guard({
      exceptionFactory: (d: { retryAfterMs: number }) => new HttpException(d, 429),
    });
    await g.canActivate(ctx().context);
    await g.canActivate(ctx().context);
    await expect(g.canActivate(ctx().context)).rejects.toBeInstanceOf(HttpException);
  });

  it("keys distinct client IPs independently and fires onLimited", async () => {
    const onLimited = vi.fn();
    const g = guard({ onLimited });
    await g.canActivate(ctx("1.1.1.1").context);
    await g.canActivate(ctx("1.1.1.1").context);
    await expect(g.canActivate(ctx("1.1.1.1").context)).rejects.toBeInstanceOf(
      RateLimitExceededError,
    );
    expect(onLimited).toHaveBeenCalledOnce();
    expect(await g.canActivate(ctx("2.2.2.2").context)).toBe(true); // different IP, own bucket
  });

  it("sets headers via a Fastify-style reply.header()", async () => {
    const g = guard();
    const headers: Record<string, string> = {};
    const req: NodeReqLike = { socket: { remoteAddress: "1.2.3.4" }, headers: {} };
    const res: NestResponseLike = {
      header: (name: string, value: string) => {
        headers[name] = value;
      },
    };
    const context: NestExecutionContextLike = {
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    };
    expect(await g.canActivate(context)).toBe(true);
    expect(Object.keys(headers).some((k) => k.toLowerCase().startsWith("ratelimit"))).toBe(true);
  });

  it("fails open (true) and closed (throws) on a store outage", async () => {
    const clock = new ManualClock(0);
    const base = { strategy: fixedWindow({ limit: 1, windowMs: 60_000 }), store: downStore, clock };
    expect(await nestRateLimit(base).canActivate(ctx().context)).toBe(true);
    await expect(
      nestRateLimit({ ...base, fail: "closed" }).canActivate(ctx().context),
    ).rejects.toThrow(/store down/);
  });
});
