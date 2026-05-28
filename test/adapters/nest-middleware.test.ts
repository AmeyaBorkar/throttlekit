/**
 * NestJS middleware (Express-shaped): unifiedAdmission + adaptiveConcurrency.
 * Registered via MiddlewareConsumer.apply(...) in real apps; here we drive
 * the function directly with a mock Node-style res.
 */

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { NodeReqLike } from "../../src/adapters/core";
import {
  nestAdaptiveConcurrencyMiddleware,
  nestUnifiedAdmissionMiddleware,
} from "../../src/adapters/nest";
import { unifiedAdmission } from "../../src/admission/unified";
import { adaptiveConcurrency } from "../../src/concurrency/adaptive";
import { ManualClock } from "../../src/core/clock";

interface MockRes {
  emitter: EventEmitter;
  statusCode: number;
  headers: Record<string, string>;
  jsonBody: unknown;
  endBody: unknown;
  on(event: "finish" | "close", listener: () => void): unknown;
  setHeader(name: string, value: string): unknown;
  status(code: number): unknown;
  json(body: unknown): unknown;
  end(body?: unknown): unknown;
}

function makeRes(initialStatus = 200): MockRes {
  const emitter = new EventEmitter();
  const m: MockRes = {
    emitter,
    statusCode: initialStatus,
    headers: {},
    jsonBody: undefined,
    endBody: undefined,
    on(event, listener) {
      emitter.on(event, listener);
      return m;
    },
    setHeader(name, value) {
      m.headers[name] = value;
      return m;
    },
    status(code) {
      m.statusCode = code;
      return m;
    },
    json(body) {
      m.jsonBody = body;
      return m;
    },
    end(body) {
      m.endBody = body;
      return m;
    },
  };
  return m;
}

function makeReq(): NodeReqLike {
  return {
    socket: { remoteAddress: "203.0.113.5" },
    headers: {},
  };
}

describe("nestUnifiedAdmissionMiddleware", () => {
  it("admits, sets headers, calls next(), releases on finish", async () => {
    const clock = new ManualClock(0);
    const guard = adaptiveConcurrency({ clock, minLimit: 4, initialLimit: 4, maxLimit: 4 });
    const admitter = unifiedAdmission({ concurrency: guard, clock });
    const mw = nestUnifiedAdmissionMiddleware({ admitter, clock });
    const m = makeRes();
    const next = vi.fn();

    mw(makeReq(), m, next);
    await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(1));
    expect(guard.inflight).toBe(1);
    expect(m.headers["RateLimit-Limit"]).toBeDefined();

    m.emitter.emit("finish");
    expect(guard.inflight).toBe(0);
  });

  it("denies over the ceiling: 429", async () => {
    const clock = new ManualClock(0);
    const guard = adaptiveConcurrency({ clock, minLimit: 1, initialLimit: 1, maxLimit: 1 });
    const admitter = unifiedAdmission({ concurrency: guard, clock });
    const mw = nestUnifiedAdmissionMiddleware({ admitter, clock });

    const m1 = makeRes();
    const next1 = vi.fn();
    mw(makeReq(), m1, next1);
    await vi.waitFor(() => expect(next1).toHaveBeenCalledTimes(1));

    const m2 = makeRes();
    const next2 = vi.fn();
    mw(makeReq(), m2, next2);
    await vi.waitFor(() => expect(m2.statusCode).toBe(429));
    expect(next2).not.toHaveBeenCalled();
  });

  it("close before finish ⇒ slot released", async () => {
    const clock = new ManualClock(0);
    const guard = adaptiveConcurrency({ clock, minLimit: 4, initialLimit: 4, maxLimit: 4 });
    const admitter = unifiedAdmission({ concurrency: guard, clock });
    const mw = nestUnifiedAdmissionMiddleware({ admitter, clock });
    const m = makeRes();
    const next = vi.fn();

    mw(makeReq(), m, next);
    await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(1));
    expect(guard.inflight).toBe(1);

    m.emitter.emit("close");
    expect(guard.inflight).toBe(0);
  });
});

describe("nestAdaptiveConcurrencyMiddleware", () => {
  it("admits + releases on finish", () => {
    const clock = new ManualClock(0);
    const guard = adaptiveConcurrency({ clock, minLimit: 4, initialLimit: 4, maxLimit: 4 });
    const mw = nestAdaptiveConcurrencyMiddleware({ guard, clock });
    const m = makeRes();
    const next = vi.fn();
    mw(makeReq(), m, next);
    expect(next).toHaveBeenCalled();
    expect(guard.inflight).toBe(1);
    m.emitter.emit("finish");
    expect(guard.inflight).toBe(0);
  });

  it("denies: 429 + headers, next() not called", () => {
    const clock = new ManualClock(0);
    const guard = adaptiveConcurrency({ clock, minLimit: 1, initialLimit: 1, maxLimit: 1 });
    const mw = nestAdaptiveConcurrencyMiddleware({ guard, clock });

    const m1 = makeRes();
    mw(makeReq(), m1, vi.fn());

    const m2 = makeRes();
    const next2 = vi.fn();
    mw(makeReq(), m2, next2);
    expect(m2.statusCode).toBe(429);
    expect(next2).not.toHaveBeenCalled();
    expect(m2.headers["Retry-After"]).toBeDefined();
  });
});
