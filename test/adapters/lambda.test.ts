import { describe, expect, it } from "vitest";
import {
  type ApiGatewayEventLike,
  type LambdaResultLike,
  lambdaRateLimit,
  sourceIpOf,
} from "../../src/adapters/lambda";
import { fixedWindow } from "../../src/algorithms/fixed-window";
import { ManualClock } from "../../src/core/clock";
import type { Store } from "../../src/core/types";
import { MemoryStore } from "../../src/stores/memory";

/** A payload-v1 (REST API) event with the given source IP. */
const v1 = (ip: string): ApiGatewayEventLike => ({
  requestContext: { identity: { sourceIp: ip } },
});
/** A payload-v2 (HTTP API) event with the given source IP. */
const v2 = (ip: string): ApiGatewayEventLike => ({ requestContext: { http: { sourceIp: ip } } });

const okHandler = async (): Promise<LambdaResultLike> => ({
  statusCode: 200,
  headers: { "X-Custom": "1" },
  body: "ok",
});

const downStore: Store = {
  apply: () => Promise.reject(new Error("store down")),
  reset: () => Promise.resolve(),
};

function wrap(extra: Record<string, unknown> = {}, handler = okHandler) {
  const clock = new ManualClock(0);
  return lambdaRateLimit(handler, {
    strategy: fixedWindow({ limit: 2, windowMs: 60_000 }),
    store: new MemoryStore({ clock, sweepIntervalMs: 0 }),
    clock,
    ...extra,
  });
}

describe("sourceIpOf", () => {
  it("prefers v2 http.sourceIp, then v1 identity.sourceIp, then anon", () => {
    expect(sourceIpOf(v2("9.9.9.9"))).toBe("9.9.9.9");
    expect(sourceIpOf(v1("8.8.8.8"))).toBe("8.8.8.8");
    expect(sourceIpOf({})).toBe("anon");
  });
});

describe("lambdaRateLimit", () => {
  it("forwards under the limit and merges rate-limit headers into the result", async () => {
    const handler = wrap();
    const res = await handler(v2("1.1.1.1"));
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("ok");
    expect(res.headers?.["X-Custom"]).toBe("1"); // handler header preserved
    expect(
      Object.keys(res.headers ?? {}).some((h) => h.toLowerCase().startsWith("ratelimit")),
    ).toBe(true); // rate-limit headers merged in
  });

  it("returns 429 with retryAfterMs over the limit", async () => {
    const handler = wrap();
    await handler(v2("1.1.1.1"));
    await handler(v2("1.1.1.1"));
    const res = await handler(v2("1.1.1.1")); // 3rd over limit 2
    expect(res.statusCode).toBe(429);
    expect(JSON.parse(res.body ?? "{}")).toMatchObject({ error: "Too Many Requests" });
    expect(JSON.parse(res.body ?? "{}").retryAfterMs).toBeGreaterThan(0);
  });

  it("keys distinct source IPs independently", async () => {
    const handler = wrap();
    await handler(v1("1.1.1.1"));
    await handler(v1("1.1.1.1"));
    expect((await handler(v1("1.1.1.1"))).statusCode).toBe(429);
    expect((await handler(v1("2.2.2.2"))).statusCode).toBe(200); // different IP, own bucket
  });

  it("supports a custom key and per-event cost", async () => {
    const handler = wrap({ key: () => "tenant", cost: () => 2 });
    expect((await handler(v2("1.1.1.1"))).statusCode).toBe(200); // cost 2 fills the limit
    expect((await handler(v2("9.9.9.9"))).statusCode).toBe(429); // same "tenant" key
  });

  it("fails OPEN on a store outage (forwards to the handler)", async () => {
    const clock = new ManualClock(0);
    const handler = lambdaRateLimit(okHandler, {
      strategy: fixedWindow({ limit: 1, windowMs: 60_000 }),
      store: downStore,
      clock,
    });
    expect((await handler(v2("1.1.1.1"))).statusCode).toBe(200);
  });

  it("fails CLOSED on a store outage with 503", async () => {
    const clock = new ManualClock(0);
    const handler = lambdaRateLimit(okHandler, {
      strategy: fixedWindow({ limit: 1, windowMs: 60_000 }),
      store: downStore,
      clock,
      fail: "closed",
    });
    const res = await handler(v2("1.1.1.1"));
    expect(res.statusCode).toBe(503);
  });
});
