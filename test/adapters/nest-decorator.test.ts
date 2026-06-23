import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NodeReqLike } from "../../src/adapters/core";
import {
  type NestExecutionContextLike,
  RateLimit,
  createRateLimitGuard,
  parseDuration,
} from "../../src/adapters/nest";
import { gcra } from "../../src/algorithms/gcra";
import { RateLimitExceededError } from "../../src/core/errors";

// Minimal reflect-metadata polyfill (NestJS apps load the real one). The decorator/guard read
// `globalThis.Reflect.{defineMetadata,getMetadata}` — implement exactly those, restore afterwards.
type ReflectShim = { defineMetadata?: unknown; getMetadata?: unknown };
const R = Reflect as unknown as ReflectShim;
const hadDefine = "defineMetadata" in R;
const hadGet = "getMetadata" in R;
beforeAll(() => {
  const store = new Map<unknown, WeakMap<object, unknown>>();
  R.defineMetadata = (k: unknown, v: unknown, t: object) => {
    let m = store.get(k);
    if (m === undefined) {
      m = new WeakMap();
      store.set(k, m);
    }
    m.set(t, v);
  };
  R.getMetadata = (k: unknown, t: object) => store.get(k)?.get(t);
});
afterAll(() => {
  if (!hadDefine) R.defineMetadata = undefined;
  if (!hadGet) R.getMetadata = undefined;
});

const reqWith = (ip: string): NodeReqLike =>
  ({ socket: { remoteAddress: ip }, headers: {} }) as unknown as NodeReqLike;

interface ResMock {
  headers: Record<string, string>;
  setHeader(name: string, value: string): void;
}
const resMock = (): ResMock => ({
  headers: {},
  setHeader(name, value) {
    this.headers[name] = value;
  },
});

function ctx(
  handler: object,
  cls: object,
  res: ResMock,
  ip = "203.0.113.7",
): NestExecutionContextLike {
  const req = reqWith(ip);
  return {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    getHandler: () => handler,
    getClass: () => cls,
  };
}

describe("parseDuration", () => {
  it("parses duration strings and bare-ms numbers", () => {
    expect(parseDuration("1m")).toBe(60_000);
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("1d")).toBe(86_400_000);
    expect(parseDuration(5000)).toBe(5000);
    expect(() => parseDuration("soon")).toThrow(RangeError);
    expect(() => parseDuration(0)).toThrow(RangeError);
  });
});

describe("@RateLimit decorator + createRateLimitGuard", () => {
  it("validates eagerly: a missing limit (no strategy) throws at decoration time", () => {
    expect(() => RateLimit({ period: "1m" })).toThrow(/RateLimit.limit/);
  });

  it("validates `defaults` eagerly: a missing limit (no strategy) throws at construction time", () => {
    // The decorator validates `defaults` at decoration; the guard's `defaults`
    // path must do the same. Otherwise a missing-limit `defaults` constructs OK
    // and gcra({ limit: 0 }) throws a per-request RangeError OUTSIDE the
    // fail-policy try/catch — a 500 on every unannotated route instead of a
    // clear load-time error.
    expect(() => createRateLimitGuard({ defaults: { period: "1m" } })).toThrow(
      /must be a positive finite number/,
    );
  });

  it("limits an annotated handler and sets headers; over the limit it throws", async () => {
    class Ctl {
      create(): string {
        return "ok";
      }
    }
    const desc = Object.getOwnPropertyDescriptor(Ctl.prototype, "create");
    if (desc === undefined) throw new Error("descriptor");
    RateLimit({ limit: 3, period: "1m", key: () => "tenant-a" })(Ctl.prototype, "create", desc);

    const guard = createRateLimitGuard();
    const handler = Ctl.prototype.create;
    for (let i = 0; i < 3; i++) {
      const res = resMock();
      expect(await guard.canActivate(ctx(handler, Ctl, res))).toBe(true);
      expect(res.headers["RateLimit-Remaining"]).toBe(String(2 - i));
    }
    await expect(guard.canActivate(ctx(handler, Ctl, resMock()))).rejects.toBeInstanceOf(
      RateLimitExceededError,
    );
  });

  it("falls back to class-level metadata when the handler has none", async () => {
    class Ctl {
      list(): string {
        return "ok";
      }
    }
    RateLimit({ limit: 1, period: "1m", key: () => "cls" })(Ctl);
    const guard = createRateLimitGuard();
    const handler = Ctl.prototype.list; // no handler metadata
    expect(await guard.canActivate(ctx(handler, Ctl, resMock()))).toBe(true);
    await expect(guard.canActivate(ctx(handler, Ctl, resMock()))).rejects.toBeInstanceOf(
      RateLimitExceededError,
    );
  });

  it("passes through unannotated routes, but applies `defaults` when given", async () => {
    class Plain {
      ping(): string {
        return "ok";
      }
    }
    const handler = Plain.prototype.ping;
    // No decorator, no defaults → not limited.
    const open = createRateLimitGuard();
    for (let i = 0; i < 10; i++) {
      expect(await open.canActivate(ctx(handler, Plain, resMock()))).toBe(true);
    }
    // With defaults → limited even though unannotated.
    const guarded = createRateLimitGuard({
      defaults: { limit: 1, period: "1m", key: () => "def" },
    });
    expect(await guarded.canActivate(ctx(handler, Plain, resMock()))).toBe(true);
    await expect(guarded.canActivate(ctx(handler, Plain, resMock()))).rejects.toBeInstanceOf(
      RateLimitExceededError,
    );
  });

  it("accepts a full strategy override and a custom exceptionFactory", async () => {
    class Ctl {
      heavy(): string {
        return "ok";
      }
    }
    const desc = Object.getOwnPropertyDescriptor(Ctl.prototype, "heavy");
    if (desc === undefined) throw new Error("descriptor");
    RateLimit({ strategy: gcra({ limit: 1, periodMs: 60_000 }), key: () => "ovr" })(
      Ctl.prototype,
      "heavy",
      desc,
    );
    class TooMany extends Error {}
    const guard = createRateLimitGuard({ exceptionFactory: () => new TooMany("429") });
    const handler = Ctl.prototype.heavy;
    expect(await guard.canActivate(ctx(handler, Ctl, resMock()))).toBe(true);
    await expect(guard.canActivate(ctx(handler, Ctl, resMock()))).rejects.toBeInstanceOf(TooMany);
  });

  it("the default key derives from the proxy-correct client IP (distinct IPs are independent)", async () => {
    class Ctl {
      get(): string {
        return "ok";
      }
    }
    const desc = Object.getOwnPropertyDescriptor(Ctl.prototype, "get");
    if (desc === undefined) throw new Error("descriptor");
    RateLimit({ limit: 1, period: "1m" })(Ctl.prototype, "get", desc); // no key → default IP key
    const guard = createRateLimitGuard();
    const handler = Ctl.prototype.get;
    expect(await guard.canActivate(ctx(handler, Ctl, resMock(), "198.51.100.1"))).toBe(true);
    // same IP → second is denied
    await expect(
      guard.canActivate(ctx(handler, Ctl, resMock(), "198.51.100.1")),
    ).rejects.toBeInstanceOf(RateLimitExceededError);
    // different IP → independent budget, allowed
    expect(await guard.canActivate(ctx(handler, Ctl, resMock(), "198.51.100.2"))).toBe(true);
  });
});
