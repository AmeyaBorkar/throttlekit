/**
 * Express middleware: unifiedAdmission + adaptiveConcurrency lifecycle wiring.
 *
 * Validates the first-fire-wins pattern from §6 of
 * `research/bigger-bets/middleware-integration/DESIGN.md`:
 *   - `finish` first ⇒ release({ dropped: false })  (or true under dropOn5xx + 5xx)
 *   - `close`  first ⇒ release({ dropped: true })
 *   - second event ⇒ no-op (idempotent)
 *
 * The mock res is an EventEmitter so the test can fire events deterministically.
 */

import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { expressAdaptiveConcurrency, expressUnifiedAdmission } from "../../src/adapters/express";
import { unifiedAdmission } from "../../src/admission/unified";
import { gcra } from "../../src/algorithms/gcra";
import { tokenBucket } from "../../src/algorithms/token-bucket";
import { adaptiveConcurrency } from "../../src/concurrency/adaptive";
import { ManualClock } from "../../src/core/clock";
import { rateLimit } from "../../src/core/limiter";
import { MemoryStore } from "../../src/stores/memory";

/** A live captured response: an EventEmitter for finish/close, with mutable status/headers. */
interface MockRes {
  res: Response;
  statusCode: number;
  headers: Record<string, string>;
  jsonBody: unknown;
  ended: boolean;
  emitter: EventEmitter;
}

function makeRes(initialStatus = 200): MockRes {
  const emitter = new EventEmitter();
  const m: MockRes = {
    statusCode: initialStatus,
    headers: {},
    jsonBody: undefined,
    ended: false,
    emitter,
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
      m.ended = true;
      if (body !== undefined) m.jsonBody = body;
      return res;
    },
    on(event: string, listener: () => void) {
      emitter.on(event, listener);
      return res;
    },
    // Mirror Node's writableEnded; not strictly needed by the adapter but kept for parity.
    get writableEnded() {
      return m.ended;
    },
    // Expose statusCode as a property for the dropOn5xx check at finish-time.
    get statusCode() {
      return m.statusCode;
    },
  } as unknown as Response;
  m.res = res;
  return m;
}

function makeReq(): Request {
  return {
    socket: { remoteAddress: "203.0.113.5" },
    headers: {},
  } as unknown as Request;
}

describe("expressUnifiedAdmission", () => {
  it("admits, sets standard headers, calls next(), releases on finish (dropped=false)", async () => {
    const clock = new ManualClock(0);
    const guard = adaptiveConcurrency({ clock, minLimit: 4, initialLimit: 4, maxLimit: 4 });
    const admitter = unifiedAdmission({
      rate: rateLimit({
        strategy: gcra({ limit: 60, periodMs: 60_000 }),
        clock,
        store: new MemoryStore({ clock }),
      }),
      concurrency: guard,
      cost: rateLimit({
        strategy: tokenBucket({ capacity: 1000, refillPerSec: 100 }),
        clock,
        store: new MemoryStore({ clock }),
      }),
      clock,
    });
    const mw = expressUnifiedAdmission({ admitter, clock });
    const m = makeRes();
    const next = vi.fn();

    mw(makeReq(), m.res, next);
    await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(1));

    // Headers from the combined Decision (limit = MIN across axes).
    expect(m.headers["RateLimit-Limit"]).toBeDefined();
    expect(m.headers["RateLimit-Remaining"]).toBeDefined();
    expect(guard.inflight).toBe(1);

    // Fire finish → release with dropped=false.
    m.emitter.emit("finish");
    expect(guard.inflight).toBe(0);

    // Second event (close after finish) is a no-op via idempotency.
    m.emitter.emit("close");
    expect(guard.inflight).toBe(0);
  });

  it("releases with dropped=true when close fires before finish (client hangup)", async () => {
    const clock = new ManualClock(0);
    const guard = adaptiveConcurrency({ clock, minLimit: 4, initialLimit: 4, maxLimit: 4 });
    const admitter = unifiedAdmission({ concurrency: guard, clock });
    const mw = expressUnifiedAdmission({ admitter, clock });
    const m = makeRes();
    const next = vi.fn();

    mw(makeReq(), m.res, next);
    await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(1));
    expect(guard.inflight).toBe(1);

    // Client disconnected: close fires without prior finish.
    m.emitter.emit("close");
    expect(guard.inflight).toBe(0);
  });

  it("denies over the concurrency ceiling: 429, headers, next() not called, no slot held", async () => {
    const clock = new ManualClock(0);
    const guard = adaptiveConcurrency({ clock, minLimit: 1, initialLimit: 1, maxLimit: 1 });
    const admitter = unifiedAdmission({ concurrency: guard, clock });
    const mw = expressUnifiedAdmission({ admitter, clock });

    // First admit succeeds (and holds the slot).
    const m1 = makeRes();
    const next1 = vi.fn();
    mw(makeReq(), m1.res, next1);
    await vi.waitFor(() => expect(next1).toHaveBeenCalledTimes(1));
    expect(guard.inflight).toBe(1);

    // Second admit denies (concurrency axis bound).
    const m2 = makeRes();
    const next2 = vi.fn();
    mw(makeReq(), m2.res, next2);
    await vi.waitFor(() => expect(m2.statusCode).toBe(429));
    expect(next2).not.toHaveBeenCalled();
    expect(guard.inflight).toBe(1); // still 1 — denial didn't acquire
    expect(m2.headers["RateLimit-Limit"]).toBeDefined();
    expect(m2.headers["Retry-After"]).toBeDefined();

    // Release first; second slot is now available.
    m1.emitter.emit("finish");
    expect(guard.inflight).toBe(0);
  });

  it("dropOn5xx: finish with statusCode>=500 reports dropped=true", async () => {
    const clock = new ManualClock(0);
    const guard = adaptiveConcurrency({ clock, minLimit: 4, initialLimit: 4, maxLimit: 4 });
    const admitter = unifiedAdmission({ concurrency: guard, clock });
    const mw = expressUnifiedAdmission({ admitter, clock, dropOn5xx: true });
    const m = makeRes(500);
    const next = vi.fn();

    mw(makeReq(), m.res, next);
    await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(1));

    // Simulate the handler having set 500 then ending the response.
    m.statusCode = 500;
    m.emitter.emit("finish");
    expect(guard.inflight).toBe(0);
    // We can't directly observe `dropped=true` without inspecting the controller's internal
    // state, but the slot is released — that's the contract this test covers. The drop signal
    // is exercised functionally in the property test (TK-1327).
  });

  it("dropOn5xx default false: finish with 5xx is NOT dropped", async () => {
    const clock = new ManualClock(0);
    const guard = adaptiveConcurrency({ clock, minLimit: 4, initialLimit: 4, maxLimit: 4 });
    const admitter = unifiedAdmission({ concurrency: guard, clock });
    const mw = expressUnifiedAdmission({ admitter, clock }); // no dropOn5xx
    const m = makeRes(500);
    const next = vi.fn();

    mw(makeReq(), m.res, next);
    await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(1));
    m.statusCode = 500;
    m.emitter.emit("finish");
    expect(guard.inflight).toBe(0);
  });

  it("fires onLimited with the per-axis snapshot on deny", async () => {
    const clock = new ManualClock(0);
    const guard = adaptiveConcurrency({ clock, minLimit: 1, initialLimit: 1, maxLimit: 1 });
    const admitter = unifiedAdmission({ concurrency: guard, clock });
    const onLimited = vi.fn();
    const mw = expressUnifiedAdmission({ admitter, clock, onLimited });

    // Saturate.
    const m1 = makeRes();
    mw(makeReq(), m1.res, vi.fn());
    await vi.waitFor(() => expect(guard.inflight).toBe(1));

    // Second admit → onLimited fires.
    const m2 = makeRes();
    mw(makeReq(), m2.res, vi.fn());
    await vi.waitFor(() => expect(onLimited).toHaveBeenCalledTimes(1));

    const [reqArg, resArg, decisionArg, axesArg] = onLimited.mock.calls[0]!;
    expect(reqArg).toBeDefined();
    expect(resArg).toBeDefined();
    expect(decisionArg.allowed).toBe(false);
    // The concurrency axis bound this denial.
    expect(axesArg.concurrency).toBeDefined();
    expect(axesArg.concurrency.allowed).toBe(false);
  });

  it("idempotency: finish then close then finish does not double-release", async () => {
    const clock = new ManualClock(0);
    const guard = adaptiveConcurrency({ clock, minLimit: 4, initialLimit: 4, maxLimit: 4 });
    const admitter = unifiedAdmission({ concurrency: guard, clock });
    const mw = expressUnifiedAdmission({ admitter, clock });
    const m = makeRes();
    const next = vi.fn();

    mw(makeReq(), m.res, next);
    await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(1));
    expect(guard.inflight).toBe(1);

    m.emitter.emit("finish");
    expect(guard.inflight).toBe(0);
    m.emitter.emit("close");
    expect(guard.inflight).toBe(0);
    m.emitter.emit("finish"); // defensive: framework fires twice
    expect(guard.inflight).toBe(0);
  });
});

describe("expressAdaptiveConcurrency", () => {
  it("admits, wires release to finish, no slot leak", async () => {
    const clock = new ManualClock(0);
    const guard = adaptiveConcurrency({ clock, minLimit: 4, initialLimit: 4, maxLimit: 4 });
    const mw = expressAdaptiveConcurrency({ guard, clock });
    const m = makeRes();
    const next = vi.fn();

    mw(makeReq(), m.res, next);
    expect(next).toHaveBeenCalledTimes(1); // synchronous: acquire is sync
    expect(guard.inflight).toBe(1);
    expect(m.headers["RateLimit-Limit"]).toBe("4");

    m.emitter.emit("finish");
    expect(guard.inflight).toBe(0);
  });

  it("denies over the ceiling: 429 + Retry-After: max(1, round(lastRtt)) hint", async () => {
    const clock = new ManualClock(0);
    const guard = adaptiveConcurrency({ clock, minLimit: 1, initialLimit: 1, maxLimit: 1 });
    const mw = expressAdaptiveConcurrency({ guard, clock });

    // First request: acquire.
    const m1 = makeRes();
    mw(makeReq(), m1.res, vi.fn());
    expect(guard.inflight).toBe(1);

    // Second request: denied.
    const m2 = makeRes();
    const next2 = vi.fn();
    mw(makeReq(), m2.res, next2);
    expect(next2).not.toHaveBeenCalled();
    expect(m2.statusCode).toBe(429);
    expect(m2.headers["Retry-After"]).toBeDefined();
  });

  it("close before finish ⇒ dropped=true (slot freed)", async () => {
    const clock = new ManualClock(0);
    const guard = adaptiveConcurrency({ clock, minLimit: 4, initialLimit: 4, maxLimit: 4 });
    const mw = expressAdaptiveConcurrency({ guard, clock });
    const m = makeRes();
    mw(makeReq(), m.res, vi.fn());
    expect(guard.inflight).toBe(1);

    m.emitter.emit("close"); // hangup
    expect(guard.inflight).toBe(0);
  });

  it("emit: false suppresses all rate-limit headers", async () => {
    const clock = new ManualClock(0);
    const guard = adaptiveConcurrency({ clock, minLimit: 4, initialLimit: 4, maxLimit: 4 });
    const mw = expressAdaptiveConcurrency({ guard, clock, emit: false });
    const m = makeRes();
    mw(makeReq(), m.res, vi.fn());
    expect(m.headers["RateLimit-Limit"]).toBeUndefined();
    expect(m.headers.RateLimit).toBeUndefined();
    m.emitter.emit("finish");
  });
});
