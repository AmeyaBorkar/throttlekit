/**
 * Fastify middleware: unifiedAdmission + adaptiveConcurrency lifecycle wiring.
 * Mirrors the express test matrix; the lifecycle wires `reply.raw.on(...)`.
 */

import { EventEmitter } from "node:events";
import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { fastifyAdaptiveConcurrency, fastifyUnifiedAdmission } from "../../src/adapters/fastify";
import { unifiedAdmission } from "../../src/admission/unified";
import { adaptiveConcurrency } from "../../src/concurrency/adaptive";
import { ManualClock } from "../../src/core/clock";

interface MockReply {
  reply: FastifyReply;
  raw: EventEmitter & { statusCode: number };
  headers: Record<string, string>;
  code?: number;
  payload: unknown;
}

function makeReply(initialStatus = 200): MockReply {
  const raw = Object.assign(new EventEmitter(), { statusCode: initialStatus });
  const m: MockReply = {
    raw,
    headers: {},
    payload: undefined,
    reply: undefined as unknown as FastifyReply,
  };
  const reply = {
    header(name: string, value: string) {
      m.headers[name] = value;
      return reply;
    },
    code(c: number) {
      m.code = c;
      raw.statusCode = c;
      return reply;
    },
    send(body: unknown) {
      m.payload = body;
      return reply;
    },
    raw,
  } as unknown as FastifyReply;
  m.reply = reply;
  return m;
}

function makeReq(): FastifyRequest {
  return {
    socket: { remoteAddress: "203.0.113.5" },
    headers: {},
  } as unknown as FastifyRequest;
}

describe("fastifyUnifiedAdmission", () => {
  it("admits, sets headers, releases on finish", async () => {
    const clock = new ManualClock(0);
    const guard = adaptiveConcurrency({ clock, minLimit: 4, initialLimit: 4, maxLimit: 4 });
    const admitter = unifiedAdmission({ concurrency: guard, clock });
    const hook = fastifyUnifiedAdmission({ admitter, clock });
    const m = makeReply();

    await hook(makeReq(), m.reply);
    expect(guard.inflight).toBe(1);
    expect(m.headers["RateLimit-Limit"]).toBeDefined();

    m.raw.emit("finish");
    expect(guard.inflight).toBe(0);
  });

  it("close before finish ⇒ dropped=true (slot released)", async () => {
    const clock = new ManualClock(0);
    const guard = adaptiveConcurrency({ clock, minLimit: 4, initialLimit: 4, maxLimit: 4 });
    const admitter = unifiedAdmission({ concurrency: guard, clock });
    const hook = fastifyUnifiedAdmission({ admitter, clock });
    const m = makeReply();

    await hook(makeReq(), m.reply);
    expect(guard.inflight).toBe(1);

    m.raw.emit("close");
    expect(guard.inflight).toBe(0);
  });

  it("denies over the ceiling: 429 with Retry-After", async () => {
    const clock = new ManualClock(0);
    const guard = adaptiveConcurrency({ clock, minLimit: 1, initialLimit: 1, maxLimit: 1 });
    const admitter = unifiedAdmission({ concurrency: guard, clock });
    const hook = fastifyUnifiedAdmission({ admitter, clock });

    const m1 = makeReply();
    await hook(makeReq(), m1.reply);
    expect(guard.inflight).toBe(1);

    const m2 = makeReply();
    await hook(makeReq(), m2.reply);
    expect(m2.code).toBe(429);
    expect(guard.inflight).toBe(1);
  });

  it("idempotent: double finish + close is one release", async () => {
    const clock = new ManualClock(0);
    const guard = adaptiveConcurrency({ clock, minLimit: 4, initialLimit: 4, maxLimit: 4 });
    const admitter = unifiedAdmission({ concurrency: guard, clock });
    const hook = fastifyUnifiedAdmission({ admitter, clock });
    const m = makeReply();

    await hook(makeReq(), m.reply);
    m.raw.emit("finish");
    m.raw.emit("close");
    m.raw.emit("finish");
    expect(guard.inflight).toBe(0);
  });
});

describe("fastifyAdaptiveConcurrency", () => {
  it("admits + releases on finish", async () => {
    const clock = new ManualClock(0);
    const guard = adaptiveConcurrency({ clock, minLimit: 4, initialLimit: 4, maxLimit: 4 });
    const hook = fastifyAdaptiveConcurrency({ guard, clock });
    const m = makeReply();

    await hook(makeReq(), m.reply);
    expect(guard.inflight).toBe(1);
    expect(m.headers["RateLimit-Limit"]).toBe("4");

    m.raw.emit("finish");
    expect(guard.inflight).toBe(0);
  });

  it("denies: 429 + Retry-After", async () => {
    const clock = new ManualClock(0);
    const guard = adaptiveConcurrency({ clock, minLimit: 1, initialLimit: 1, maxLimit: 1 });
    const hook = fastifyAdaptiveConcurrency({ guard, clock });

    const m1 = makeReply();
    await hook(makeReq(), m1.reply);
    expect(guard.inflight).toBe(1);

    const m2 = makeReply();
    await hook(makeReq(), m2.reply);
    expect(m2.code).toBe(429);
    expect(m2.headers["Retry-After"]).toBeDefined();
    expect(vi.isMockFunction(m2.payload)).toBe(false);
  });

  it("onLimited fires on deny", async () => {
    const clock = new ManualClock(0);
    const guard = adaptiveConcurrency({ clock, minLimit: 1, initialLimit: 1, maxLimit: 1 });
    const onLimited = vi.fn();
    const hook = fastifyAdaptiveConcurrency({ guard, clock, onLimited });

    const m1 = makeReply();
    await hook(makeReq(), m1.reply);
    const m2 = makeReply();
    await hook(makeReq(), m2.reply);
    expect(onLimited).toHaveBeenCalledTimes(1);
  });
});
