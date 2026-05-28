/**
 * Koa middleware: unifiedAdmission + adaptiveConcurrency lifecycle wiring.
 */

import { EventEmitter } from "node:events";
import type { Context } from "koa";
import { describe, expect, it } from "vitest";
import { koaAdaptiveConcurrency, koaUnifiedAdmission } from "../../src/adapters/koa";
import { unifiedAdmission } from "../../src/admission/unified";
import { adaptiveConcurrency } from "../../src/concurrency/adaptive";
import { ManualClock } from "../../src/core/clock";

interface MockCtx {
  ctx: Context;
  res: EventEmitter & { statusCode: number };
  req: { socket: { remoteAddress: string }; headers: Record<string, string> };
  headers: Record<string, string>;
  status: number | undefined;
  body: unknown;
}

function makeCtx(initialStatus = 200): MockCtx {
  const res = Object.assign(new EventEmitter(), { statusCode: initialStatus });
  const m: MockCtx = {
    res,
    req: { socket: { remoteAddress: "203.0.113.5" }, headers: {} },
    headers: {},
    status: undefined,
    body: undefined,
    ctx: undefined as unknown as Context,
  };
  const ctx = {
    res,
    req: m.req,
    set(name: string, value: string) {
      m.headers[name] = value;
    },
    get status(): number | undefined {
      return m.status;
    },
    set status(value: number | undefined) {
      m.status = value;
      if (typeof value === "number") res.statusCode = value;
    },
    get body(): unknown {
      return m.body;
    },
    set body(value: unknown) {
      m.body = value;
    },
  } as unknown as Context;
  m.ctx = ctx;
  return m;
}

describe("koaUnifiedAdmission", () => {
  it("admits, sets headers, awaits next(), releases on finish", async () => {
    const clock = new ManualClock(0);
    const guard = adaptiveConcurrency({ clock, minLimit: 4, initialLimit: 4, maxLimit: 4 });
    const admitter = unifiedAdmission({ concurrency: guard, clock });
    const mw = koaUnifiedAdmission({ admitter, clock });
    const m = makeCtx();
    let nextRan = false;

    const promise = mw(m.ctx, async () => {
      nextRan = true;
    });
    await promise;

    expect(nextRan).toBe(true);
    expect(guard.inflight).toBe(1);
    expect(m.headers["RateLimit-Limit"]).toBeDefined();

    m.res.emit("finish");
    expect(guard.inflight).toBe(0);
  });

  it("denies: ctx.status=429 + ctx.body set", async () => {
    const clock = new ManualClock(0);
    const guard = adaptiveConcurrency({ clock, minLimit: 1, initialLimit: 1, maxLimit: 1 });
    const admitter = unifiedAdmission({ concurrency: guard, clock });
    const mw = koaUnifiedAdmission({ admitter, clock });

    const m1 = makeCtx();
    await mw(m1.ctx, async () => {});
    expect(guard.inflight).toBe(1);

    const m2 = makeCtx();
    let nextRan = false;
    await mw(m2.ctx, async () => {
      nextRan = true;
    });
    expect(nextRan).toBe(false);
    expect(m2.status).toBe(429);
    expect(m2.body).toBeDefined();
  });

  it("close before finish ⇒ slot released", async () => {
    const clock = new ManualClock(0);
    const guard = adaptiveConcurrency({ clock, minLimit: 4, initialLimit: 4, maxLimit: 4 });
    const admitter = unifiedAdmission({ concurrency: guard, clock });
    const mw = koaUnifiedAdmission({ admitter, clock });
    const m = makeCtx();
    await mw(m.ctx, async () => {});
    expect(guard.inflight).toBe(1);
    m.res.emit("close");
    expect(guard.inflight).toBe(0);
  });
});

describe("koaAdaptiveConcurrency", () => {
  it("admits + releases on finish", async () => {
    const clock = new ManualClock(0);
    const guard = adaptiveConcurrency({ clock, minLimit: 4, initialLimit: 4, maxLimit: 4 });
    const mw = koaAdaptiveConcurrency({ guard, clock });
    const m = makeCtx();
    await mw(m.ctx, async () => {});
    expect(guard.inflight).toBe(1);
    m.res.emit("finish");
    expect(guard.inflight).toBe(0);
  });

  it("denies over the ceiling: 429 + Retry-After", async () => {
    const clock = new ManualClock(0);
    const guard = adaptiveConcurrency({ clock, minLimit: 1, initialLimit: 1, maxLimit: 1 });
    const mw = koaAdaptiveConcurrency({ guard, clock });

    const m1 = makeCtx();
    await mw(m1.ctx, async () => {});
    const m2 = makeCtx();
    let nextRan = false;
    await mw(m2.ctx, async () => {
      nextRan = true;
    });
    expect(m2.status).toBe(429);
    expect(nextRan).toBe(false);
    expect(m2.headers["Retry-After"]).toBeDefined();
  });
});
