import { describe, expect, it } from "vitest";
import type { UnifiedAdmission, UnifiedAdmitter } from "../../src/admission/unified";
import { gcra } from "../../src/algorithms/gcra";
import { rateLimit } from "../../src/core/limiter";
import type { Decision } from "../../src/core/types";
import {
  METRIC_NAMES,
  SPAN_ATTRIBUTES,
  bindingAxisOf,
  instrumentAdmitter,
  instrumentGuard,
  instrumentLimiter,
  recordDecisionOnSpan,
  recordUnifiedAdmissionOnSpan,
} from "../../src/observability/otel";
import { MemoryStore } from "../../src/stores/memory";

/** A Meter stub that records the instrument names ThrottleKit asks for. */
class RecordingMeter {
  counters: string[] = [];
  histograms: string[] = [];
  gauges: string[] = [];
  createCounter(name: string) {
    this.counters.push(name);
    return { add() {} };
  }
  createHistogram(name: string) {
    this.histograms.push(name);
    return { record() {} };
  }
  createObservableGauge(name: string) {
    this.gauges.push(name);
    return { name };
  }
  addBatchObservableCallback() {
    /* not invoked in this test */
  }
}

describe("observability contract (TK-819 / TK-820)", () => {
  it("pins the exact metric names — a rename must be a deliberate, breaking change", () => {
    expect(METRIC_NAMES).toEqual({
      checks: "throttlekit.checks",
      remaining: "throttlekit.remaining",
      storeLatency: "throttlekit.store.latency",
      concurrencyLimit: "throttlekit.concurrency.limit",
      concurrencyInflight: "throttlekit.concurrency.inflight",
      concurrencyRttNoload: "throttlekit.concurrency.rtt_noload",
      // Additive in 1.2.0 — a NEW name (the binding-axis denial counter), not a changed one.
      deniesByAxis: "throttlekit.denies_by_axis",
    });
  });

  it("pins the exact span-attribute keys", () => {
    expect(SPAN_ATTRIBUTES).toEqual({
      strategy: "throttlekit.strategy",
      allowed: "throttlekit.allowed",
      limit: "throttlekit.limit",
      remaining: "throttlekit.remaining",
      retryAfterMs: "throttlekit.retry_after_ms",
      // TK-1008: tk.binding_axis for unified-admission decisions.
      bindingAxis: "throttlekit.binding_axis",
    });
  });

  it("instrumentLimiter creates exactly the contract instruments", () => {
    const meter = new RecordingMeter();
    instrumentLimiter(
      rateLimit({
        strategy: gcra({ limit: 5, periodMs: 1000 }),
        store: new MemoryStore({ sweepIntervalMs: 0 }),
      }),
      meter as never,
    );
    expect(meter.counters).toEqual([METRIC_NAMES.checks]);
    expect(meter.histograms).toEqual([METRIC_NAMES.remaining, METRIC_NAMES.storeLatency]);
  });

  it("instrumentGuard creates exactly the three concurrency gauges", () => {
    const meter = new RecordingMeter();
    const guard = { stats: () => ({ limit: 1, inflight: 0, rttNoload: 0 }) };
    instrumentGuard(guard as never, meter as never);
    expect(meter.gauges).toEqual([
      METRIC_NAMES.concurrencyLimit,
      METRIC_NAMES.concurrencyInflight,
      METRIC_NAMES.concurrencyRttNoload,
    ]);
  });

  it("recordDecisionOnSpan sets the documented attributes (plus extras)", () => {
    const attrs: Record<string, string | number | boolean> = {};
    const span = {
      setAttribute(k: string, v: string | number | boolean) {
        attrs[k] = v;
      },
    };
    const decision: Decision = {
      allowed: false,
      limit: 100,
      remaining: 0,
      resetAt: 1234,
      retryAfterMs: 500,
    };
    recordDecisionOnSpan(span, decision, "gcra", { region: "us-east" });
    expect(attrs).toEqual({
      "throttlekit.strategy": "gcra",
      "throttlekit.allowed": false,
      "throttlekit.limit": 100,
      "throttlekit.remaining": 0,
      "throttlekit.retry_after_ms": 500,
      region: "us-east",
    });
  });

  // ── TK-1008: bindingAxisOf + recordUnifiedAdmissionOnSpan ─────────────────────────────────

  const denied: Decision = {
    allowed: false,
    limit: 1,
    remaining: 0,
    resetAt: 1000,
    retryAfterMs: 100,
  };
  const allowed: Decision = {
    allowed: true,
    limit: 10,
    remaining: 5,
    resetAt: 60_000,
    retryAfterMs: 0,
  };

  describe("bindingAxisOf (TK-1008)", () => {
    it("returns undefined when all axes admit", () => {
      expect(bindingAxisOf({ rate: allowed, concurrency: allowed, cost: allowed })).toBeUndefined();
    });

    it("returns undefined when all axes are unconfigured", () => {
      expect(
        bindingAxisOf({ rate: undefined, concurrency: undefined, cost: undefined }),
      ).toBeUndefined();
    });

    it("returns concurrency when only concurrency denied", () => {
      expect(bindingAxisOf({ rate: undefined, concurrency: denied, cost: undefined })).toBe(
        "concurrency",
      );
    });

    it("returns rate when only rate denied", () => {
      expect(bindingAxisOf({ rate: denied, concurrency: undefined, cost: undefined })).toBe("rate");
    });

    it("returns cost when only cost denied", () => {
      expect(bindingAxisOf({ rate: undefined, concurrency: undefined, cost: denied })).toBe("cost");
    });

    it("returns concurrency first when multiple deny (deterministic priority)", () => {
      expect(bindingAxisOf({ rate: denied, concurrency: denied, cost: denied })).toBe(
        "concurrency",
      );
    });

    it("returns rate before cost when both deny", () => {
      expect(bindingAxisOf({ rate: denied, concurrency: undefined, cost: denied })).toBe("rate");
    });
  });

  describe("recordUnifiedAdmissionOnSpan (TK-1008)", () => {
    it("sets the standard Decision attributes + tk.binding_axis on a denied admission", () => {
      const attrs: Record<string, string | number | boolean> = {};
      const span = {
        setAttribute(k: string, v: string | number | boolean) {
          attrs[k] = v;
        },
      };
      recordUnifiedAdmissionOnSpan(span, denied, {
        rate: allowed,
        concurrency: undefined,
        cost: denied,
      });
      expect(attrs).toEqual({
        "throttlekit.allowed": false,
        "throttlekit.limit": 1,
        "throttlekit.remaining": 0,
        "throttlekit.retry_after_ms": 100,
        "throttlekit.binding_axis": "cost",
      });
    });

    it("omits tk.binding_axis on an admitted admission", () => {
      const attrs: Record<string, string | number | boolean> = {};
      const span = {
        setAttribute(k: string, v: string | number | boolean) {
          attrs[k] = v;
        },
      };
      recordUnifiedAdmissionOnSpan(span, allowed, {
        rate: allowed,
        concurrency: allowed,
        cost: allowed,
      });
      expect(attrs["throttlekit.binding_axis"]).toBeUndefined();
      expect(attrs["throttlekit.allowed"]).toBe(true);
    });

    it("merges extra attributes alongside the contract attributes", () => {
      const attrs: Record<string, string | number | boolean> = {};
      const span = {
        setAttribute(k: string, v: string | number | boolean) {
          attrs[k] = v;
        },
      };
      recordUnifiedAdmissionOnSpan(
        span,
        denied,
        { rate: denied, concurrency: undefined, cost: undefined },
        { tenant: "abc", region: "us-east" },
      );
      expect(attrs.tenant).toBe("abc");
      expect(attrs.region).toBe("us-east");
      expect(attrs["throttlekit.binding_axis"]).toBe("rate");
    });
  });

  // ── 1.2.0: instrumentAdmitter → throttlekit.denies_by_axis{lane} ──────────────────────────
  describe("instrumentAdmitter (denies_by_axis)", () => {
    type Add = { value: number; attrs: Record<string, unknown> };
    function meterCapturing(adds: Add[], names: string[]) {
      return {
        createCounter(name: string) {
          names.push(name);
          return {
            add(value: number, attrs: Record<string, unknown>) {
              adds.push({ value, attrs });
            },
          };
        },
        createHistogram() {
          return { record() {} };
        },
        createObservableGauge() {
          return { name: "" };
        },
        addBatchObservableCallback() {},
      };
    }
    function admission(
      decision: Decision,
      bindingAxis?: "rate" | "concurrency" | "cost",
      policyDenied?: boolean,
    ): UnifiedAdmission {
      return {
        decision,
        release() {},
        ...(bindingAxis !== undefined ? { bindingAxis } : {}),
        ...(policyDenied ? { policyDenied } : {}),
      };
    }
    function fakeAdmitter(next: UnifiedAdmission): UnifiedAdmitter {
      return {
        admit: async () => next,
        admitSync: () => next,
        lastDecisions: () => ({}),
      };
    }

    it("creates exactly the denies_by_axis counter and records {lane} on an axis-bound denial", async () => {
      const adds: Add[] = [];
      const names: string[] = [];
      const admit = instrumentAdmitter(
        fakeAdmitter(admission(denied, "cost")),
        meterCapturing(adds, names) as never,
      );
      await admit.admit({ key: "k", cost: 5 });
      expect(names).toEqual([METRIC_NAMES.deniesByAxis]);
      expect(adds).toEqual([{ value: 1, attrs: { lane: "cost" } }]);
    });

    it("attributes a joint-LP (no binding axis) denial to lane 'policy'", () => {
      const adds: Add[] = [];
      const admit = instrumentAdmitter(
        fakeAdmitter(admission(denied, undefined, true)),
        meterCapturing(adds, []) as never,
      );
      admit.admitSync({ key: "k" });
      expect(adds).toEqual([{ value: 1, attrs: { lane: "policy" } }]);
    });

    it("records nothing on an allow", async () => {
      const adds: Add[] = [];
      const admit = instrumentAdmitter(
        fakeAdmitter(admission(allowed)),
        meterCapturing(adds, []) as never,
      );
      await admit.admit();
      expect(adds).toEqual([]);
    });

    it("merges static attributes onto the lane", () => {
      const adds: Add[] = [];
      const admit = instrumentAdmitter(
        fakeAdmitter(admission(denied, "rate")),
        meterCapturing(adds, []) as never,
        { attributes: { region: "us-east" } },
      );
      admit.admitSync();
      expect(adds).toEqual([{ value: 1, attrs: { region: "us-east", lane: "rate" } }]);
    });

    it("forwards lastDecisions to the inner admitter", () => {
      const admit = instrumentAdmitter(
        fakeAdmitter(admission(denied, "rate")),
        meterCapturing([], []) as never,
      );
      expect(admit.lastDecisions()).toEqual({});
    });
  });
});
