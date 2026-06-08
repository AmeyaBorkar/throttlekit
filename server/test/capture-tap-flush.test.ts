import type { Decision, Forecast } from "throttlekit";
import { describe, expect, it } from "vitest";
import { createFlushLoop } from "../src/capture/flush.js";
import { createCaptureRecorder } from "../src/capture/recorder.js";
import { captureService } from "../src/capture/tap.js";
import type { CaptureConfig, CaptureSegment, TenantRule } from "../src/capture/types.js";
import type { RateLimiterService } from "../src/service.js";

/**
 * #289 Replay P3 (Phase B) — P3.5 (core): the service-level capture tap + the back-pressured flush loop.
 * The tap records each decision AFTER the inner service returns it, so it can never change/delay/break a
 * decision; it is a zero-overhead pass-through when capture is off. The flush loop drains the recorder to
 * the store off the decision path, dropping (counted) a failed write rather than throwing. The load test
 * pins the control-path guarantees: decisions are unaffected and memory stays bounded under a key flood.
 */

const ALLOW: Decision = { allowed: true, limit: 3, remaining: 2, resetAt: 2000, retryAfterMs: 0 };
const FIXED = { now: () => 1000 };
const tenantByPrefix: TenantRule = (_p, key) => {
  const i = key.indexOf(":");
  return i === -1 ? key : key.slice(0, i);
};

function scopedConfig(overrides?: Partial<CaptureConfig["retention"]>): CaptureConfig {
  return {
    enabled: true,
    redaction: { mode: "hmac", secret: "k" },
    retention: { ttlMs: 1000, maxScopes: 100, ringSize: 100, ...overrides },
    tenantOf: tenantByPrefix,
  };
}

interface Calls {
  check: number;
  checkMany: number;
  admit: number;
  debit: number;
  peek: number;
  forecast: number;
}

function mockInner(calls: Calls): RateLimiterService {
  return {
    policies: () => ["api"],
    check: async () => {
      calls.check++;
      return ALLOW;
    },
    checkMany: async (_p, keys) => {
      calls.checkMany++;
      return keys.map(() => ALLOW);
    },
    peek: async () => {
      calls.peek++;
      return ALLOW;
    },
    forecast: async () => {
      calls.forecast++;
      return { spendableNow: 0, nextReplenishAt: 0, fullAt: 0 } as unknown as Forecast;
    },
    debit: async () => {
      calls.debit++;
      return ALLOW;
    },
    admit: async () => {
      calls.admit++;
      return {
        decision: ALLOW,
        leaseId: "1",
        leaseExpiresAt: 0,
        bindingAxis: "",
        policyDenied: false,
      };
    },
    release: () => {},
    heartbeat: (ids) => ({ liveIds: [...ids], reclaimedIds: [], nextDeadline: 0 }),
    sweep: () => {},
  };
}

const noCalls = (): Calls => ({ check: 0, checkMany: 0, admit: 0, debit: 0, peek: 0, forecast: 0 });

describe("#289 P3.5 — capture service tap", () => {
  it("records consuming decisions (check/checkMany/debit/admit) but not peek/forecast", async () => {
    const recorder = createCaptureRecorder(scopedConfig(), { clock: FIXED });
    recorder.register("api", { policyKind: "rate" });
    const svc = captureService(mockInner(noCalls()), recorder);

    expect(await svc.check("api", "acme:u1")).toEqual(ALLOW);
    await svc.checkMany("api", ["acme:u2", "beta:u1"]);
    await svc.debit("api", "acme:u3", 2);
    await svc.admit("api", "beta:u2", { cost: 3 });
    await svc.peek("api", "acme:u9"); // not recorded
    await svc.forecast("api", "acme:u9"); // not recorded

    const total = recorder.segments().reduce((n, s) => n + s.count, 0);
    expect(total).toBe(5); // 1 check + 2 checkMany + 1 debit + 1 admit; peek/forecast excluded
    const counts = Object.fromEntries(recorder.counts().map((c) => [c.policy, c.allowed]));
    expect(counts.api).toBe(5);
  });

  it("returns the inner service UNWRAPPED when capture is disabled (zero overhead)", () => {
    const recorder = createCaptureRecorder({
      enabled: false,
      redaction: { mode: "drop" },
      retention: { ttlMs: 1, maxScopes: 1, ringSize: 1 },
    });
    const inner = mockInner(noCalls());
    expect(captureService(inner, recorder)).toBe(inner); // identical reference, not a wrapper
  });

  it("never alters the inner decision (capture is a tail, not a filter)", async () => {
    const calls = noCalls();
    const recorder = createCaptureRecorder(scopedConfig(), { clock: FIXED });
    const svc = captureService(mockInner(calls), recorder);
    const d = await svc.check("api", "acme:x", 1);
    expect(d).toEqual(ALLOW);
    expect(calls.check).toBe(1); // delegated exactly once
  });

  it("control-path load: decisions unaffected and memory bounded under a key flood", async () => {
    const recorder = createCaptureRecorder(scopedConfig({ maxScopes: 8, ringSize: 4 }), {
      clock: FIXED,
    });
    recorder.register("api", { policyKind: "rate" });
    const svc = captureService(mockInner(noCalls()), recorder);

    // 5000 checks across 500 distinct tenants — far exceeding maxScopes*ringSize.
    let allowed = 0;
    for (let i = 0; i < 5000; i++) {
      const d = await svc.check("api", `t${i % 500}:user`);
      if (d.allowed) allowed++;
    }
    expect(allowed).toBe(5000); // every decision returned, unaffected by capture

    const segs = recorder.segments();
    expect(segs.length).toBeLessThanOrEqual(8); // scopes FIFO-bounded
    for (const s of segs) expect(s.count).toBeLessThanOrEqual(4); // rings bounded
    expect(recorder.counts()[0]?.allowed).toBe(5000); // the tally still saw them all
  });
});

function mockStore(behavior?: { fail?: boolean }) {
  const written: CaptureSegment[] = [];
  const store = {
    write: async (s: CaptureSegment): Promise<string> => {
      if (behavior?.fail) throw new Error("disk full");
      written.push(s);
      return `id-${written.length}`;
    },
    list: async () => [],
    read: async (): Promise<CaptureSegment> => {
      throw new Error("not used");
    },
    sweep: async () => 0,
  };
  return { store, written };
}

describe("#289 P3.5 — flush loop", () => {
  function fillRecorder() {
    const recorder = createCaptureRecorder(scopedConfig(), { clock: FIXED });
    recorder.register("api", { policyKind: "rate" });
    recorder.record({ policy: "api", key: "acme:u1", cost: 1, decision: ALLOW });
    recorder.record({ policy: "api", key: "beta:u1", cost: 1, decision: ALLOW });
    return recorder;
  }

  it("drains the recorder to the store and reports what was written", async () => {
    const recorder = fillRecorder();
    const { store, written } = mockStore();
    const loop = createFlushLoop(recorder, store);

    const result = await loop.flushOnce();
    expect(result).toEqual({ written: 2, dropped: 0 }); // 2 scopes ⇒ 2 segments
    expect(written).toHaveLength(2);
    expect(recorder.segments()).toEqual([]); // drained
  });

  it("drops (counts) a failed write rather than throwing", async () => {
    const recorder = fillRecorder();
    const { store } = mockStore({ fail: true });
    const loop = createFlushLoop(recorder, store);
    const result = await loop.flushOnce();
    expect(result).toEqual({ written: 0, dropped: 2 }); // both writes failed, none threw
  });

  it("a flush over an empty recorder is a no-op", async () => {
    const recorder = createCaptureRecorder(scopedConfig(), { clock: FIXED });
    const { store } = mockStore();
    const result = await createFlushLoop(recorder, store).flushOnce();
    expect(result).toEqual({ written: 0, dropped: 0 });
  });
});
