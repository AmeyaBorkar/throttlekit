import { describe, expect, it } from "vitest";
import { gcra } from "../../src/algorithms/gcra";
import { rateLimit } from "../../src/core/limiter";
import type { Decision } from "../../src/core/types";
import {
  METRIC_NAMES,
  SPAN_ATTRIBUTES,
  bindingAxisOf,
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
});
