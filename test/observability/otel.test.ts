import type {
  BatchObservableCallback,
  BatchObservableResult,
  Counter,
  Histogram,
  Meter,
  MetricOptions,
  Observable,
  ObservableGauge,
} from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import { gcra } from "../../src/algorithms/gcra";
import { adaptiveConcurrency } from "../../src/concurrency/adaptive";
import { ManualClock } from "../../src/core/clock";
import { rateLimit } from "../../src/core/limiter";
import type { Limiter } from "../../src/core/types";
import { instrumentGuard, instrumentLimiter } from "../../src/observability/otel";
import { MemoryStore } from "../../src/stores/memory";

/** A single recorded synchronous measurement (counter add / histogram record). */
interface Measurement {
  value: number;
  attributes: Record<string, unknown> | undefined;
}

/** A spied synchronous instrument that simply remembers every value/attributes pair. */
class FakeInstrument {
  readonly name: string;
  readonly options: MetricOptions | undefined;
  readonly measurements: Measurement[] = [];

  constructor(name: string, options?: MetricOptions) {
    this.name = name;
    this.options = options;
  }

  private push(value: number, attributes?: Record<string, unknown>): void {
    this.measurements.push({ value, attributes });
  }

  /** Counter.add */
  add(value: number, attributes?: Record<string, unknown>): void {
    this.push(value, attributes);
  }

  /** Histogram.record */
  record(value: number, attributes?: Record<string, unknown>): void {
    this.push(value, attributes);
  }

  /** Convenience: the most recent measurement, or undefined when none recorded. */
  get last(): Measurement | undefined {
    return this.measurements[this.measurements.length - 1];
  }
}

/** A spied observable gauge. Holds any per-instrument callbacks plus observed values. */
class FakeObservableGauge {
  readonly name: string;
  readonly options: MetricOptions | undefined;
  readonly callbacks: Array<(result: { observe: (v: number, a?: unknown) => void }) => void> = [];
  readonly observed: Measurement[] = [];

  constructor(name: string, options?: MetricOptions) {
    this.name = name;
    this.options = options;
  }

  addCallback(cb: (result: { observe: (v: number, a?: unknown) => void }) => void): void {
    this.callbacks.push(cb);
  }

  removeCallback(): void {}
}

/**
 * A minimal mock {@link Meter} — no real OTel runtime. It records every created instrument and the
 * single batched observable callback, exposing helpers to drive a "collection" and inspect what
 * the instrumentation recorded.
 */
class MockMeter {
  readonly counters = new Map<string, FakeInstrument>();
  readonly histograms = new Map<string, FakeInstrument>();
  readonly gauges = new Map<string, FakeObservableGauge>();
  readonly batchCallbacks: Array<{
    callback: BatchObservableCallback;
    observables: Observable[];
  }> = [];

  createCounter(name: string, options?: MetricOptions): Counter {
    const inst = new FakeInstrument(name, options);
    this.counters.set(name, inst);
    return inst as unknown as Counter;
  }

  createHistogram(name: string, options?: MetricOptions): Histogram {
    const inst = new FakeInstrument(name, options);
    this.histograms.set(name, inst);
    return inst as unknown as Histogram;
  }

  createObservableGauge(name: string, options?: MetricOptions): ObservableGauge {
    const g = new FakeObservableGauge(name, options);
    this.gauges.set(name, g);
    return g as unknown as ObservableGauge;
  }

  addBatchObservableCallback(callback: BatchObservableCallback, observables: Observable[]): void {
    this.batchCallbacks.push({ callback, observables });
  }

  removeBatchObservableCallback(): void {}

  /**
   * Simulate one metric collection: invoke every registered batch callback (and any per-gauge
   * `addCallback` callbacks) so observable gauges record into their `observed` arrays. Each
   * `observe(gauge, value, attrs)` is routed to the matching {@link FakeObservableGauge}.
   */
  collect(): void {
    for (const { callback } of this.batchCallbacks) {
      const result: BatchObservableResult = {
        observe(metric: unknown, value: number, attributes?: unknown): void {
          (metric as FakeObservableGauge).observed.push({
            value,
            attributes: attributes as Record<string, unknown> | undefined,
          });
        },
      } as unknown as BatchObservableResult;
      callback(result);
    }
    // Also drive any per-instrument callbacks (covers the addCallback registration style).
    for (const g of this.gauges.values()) {
      for (const cb of g.callbacks) {
        cb({
          observe: (value: number, attributes?: unknown): void => {
            g.observed.push({ value, attributes: attributes as Record<string, unknown> });
          },
        });
      }
    }
  }

  /** Cast to the real `Meter` type for passing into the instrumentation under test. */
  asMeter(): Meter {
    return this as unknown as Meter;
  }
}

/** Build a real GCRA limiter over a deterministic ManualClock + MemoryStore. */
function makeLimiter(): { limiter: Limiter; clock: ManualClock } {
  const clock = new ManualClock(0);
  const store = new MemoryStore({ clock });
  const limiter = rateLimit({ strategy: gcra({ limit: 2, periodMs: 1000 }), clock, store });
  return { limiter, clock };
}

describe("instrumentLimiter", () => {
  it("creates the three instruments once with the expected names/unit", () => {
    const { limiter } = makeLimiter();
    const meter = new MockMeter();
    instrumentLimiter(limiter, meter.asMeter());

    expect(meter.counters.has("throttlekit.checks")).toBe(true);
    expect(meter.histograms.has("throttlekit.remaining")).toBe(true);
    const latency = meter.histograms.get("throttlekit.store.latency");
    expect(latency).toBeDefined();
    expect(latency?.options?.unit).toBe("ms");
  });

  it("passes strategy through and increments checks with allowed=true then false", async () => {
    const { limiter } = makeLimiter();
    const meter = new MockMeter();
    const inst = instrumentLimiter(limiter, meter.asMeter());

    expect(inst.strategy).toBe(limiter.strategy);
    expect(inst.strategy.name).toBe("gcra");

    const checks = meter.counters.get("throttlekit.checks");
    expect(checks).toBeDefined();

    // burst = 2: first two allowed, third denied.
    const d1 = await inst.check("k");
    const d2 = await inst.check("k");
    const d3 = await inst.check("k");
    expect(d1.allowed).toBe(true);
    expect(d2.allowed).toBe(true);
    expect(d3.allowed).toBe(false);

    expect(checks?.measurements).toHaveLength(3);
    expect(checks?.measurements.every((m) => m.value === 1)).toBe(true);
    expect(checks?.measurements[0]?.attributes).toMatchObject({
      strategy: "gcra",
      allowed: "true",
    });
    expect(checks?.measurements[2]?.attributes).toMatchObject({
      strategy: "gcra",
      allowed: "false",
    });
  });

  it("records the remaining histogram with strategy attribute and matching values", async () => {
    const { limiter } = makeLimiter();
    const meter = new MockMeter();
    const inst = instrumentLimiter(limiter, meter.asMeter());

    const remaining = meter.histograms.get("throttlekit.remaining");
    const d1 = await inst.check("k");
    const d2 = await inst.check("k");

    expect(remaining?.measurements).toHaveLength(2);
    expect(remaining?.measurements[0]?.value).toBe(d1.remaining);
    expect(remaining?.measurements[1]?.value).toBe(d2.remaining);
    expect(remaining?.measurements[0]?.attributes).toMatchObject({ strategy: "gcra" });
  });

  it("records store.latency on each check (non-negative, with strategy attribute)", async () => {
    const { limiter } = makeLimiter();
    const meter = new MockMeter();
    const inst = instrumentLimiter(limiter, meter.asMeter());
    const latency = meter.histograms.get("throttlekit.store.latency");

    await inst.check("k");
    expect(latency?.measurements).toHaveLength(1);
    expect(latency?.last?.value).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(latency?.last?.value)).toBe(true);
    expect(latency?.last?.attributes).toMatchObject({ strategy: "gcra" });
  });

  it("instruments checkSync identically to check", () => {
    const { limiter } = makeLimiter();
    const meter = new MockMeter();
    const inst = instrumentLimiter(limiter, meter.asMeter());

    const checks = meter.counters.get("throttlekit.checks");
    const remaining = meter.histograms.get("throttlekit.remaining");
    const latency = meter.histograms.get("throttlekit.store.latency");

    const d1 = inst.checkSync("k");
    expect(d1.allowed).toBe(true);
    expect(checks?.measurements).toHaveLength(1);
    expect(checks?.last?.attributes).toMatchObject({ strategy: "gcra", allowed: "true" });
    expect(remaining?.measurements).toHaveLength(1);
    expect(latency?.measurements).toHaveLength(1);
  });

  it("merges extra static attributes onto the checks counter", async () => {
    const { limiter } = makeLimiter();
    const meter = new MockMeter();
    const inst = instrumentLimiter(limiter, meter.asMeter(), {
      attributes: { region: "us-east", tier: "free" },
    });

    await inst.check("k");
    expect(meter.counters.get("throttlekit.checks")?.last?.attributes).toMatchObject({
      strategy: "gcra",
      allowed: "true",
      region: "us-east",
      tier: "free",
    });
  });

  it("lets a throwing inner checkSync propagate and records nothing", () => {
    const meter = new MockMeter();
    // An async-only store: no applySync, so checkSync throws.
    const asyncOnlyStore = {
      apply: async <S, R>(
        _key: string,
        transform: (state: S | undefined) => { result: R },
      ): Promise<R> => transform(undefined).result,
      reset: async (): Promise<void> => {},
    };
    const limiter = rateLimit({
      strategy: gcra({ limit: 2, periodMs: 1000 }),
      clock: new ManualClock(0),
      store: asyncOnlyStore,
    });
    const inst = instrumentLimiter(limiter, meter.asMeter());

    expect(() => inst.checkSync("k")).toThrow();
    expect(meter.counters.get("throttlekit.checks")?.measurements).toHaveLength(0);
    expect(meter.histograms.get("throttlekit.remaining")?.measurements).toHaveLength(0);
    expect(meter.histograms.get("throttlekit.store.latency")?.measurements).toHaveLength(0);
  });

  it("delegates reset to the inner limiter", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock });
    const limiter = rateLimit({ strategy: gcra({ limit: 1, periodMs: 1000 }), clock, store });
    const inst = instrumentLimiter(limiter, new MockMeter().asMeter());

    expect((await inst.check("k")).allowed).toBe(true);
    expect((await inst.check("k")).allowed).toBe(false); // burst exhausted
    await inst.reset("k");
    expect((await inst.check("k")).allowed).toBe(true); // reset cleared the state
  });
});

describe("instrumentGuard", () => {
  it("returns the same guard (passthrough) and registers three observable gauges", () => {
    const guard = adaptiveConcurrency({ clock: new ManualClock(0), minLimit: 5 });
    const meter = new MockMeter();
    const out = instrumentGuard(guard, meter.asMeter());

    expect(out).toBe(guard);
    expect(meter.gauges.has("throttlekit.concurrency.limit")).toBe(true);
    expect(meter.gauges.has("throttlekit.concurrency.inflight")).toBe(true);
    expect(meter.gauges.has("throttlekit.concurrency.rtt_noload")).toBe(true);
    expect(meter.gauges.get("throttlekit.concurrency.rtt_noload")?.options?.unit).toBe("ms");
  });

  it("gauge callbacks observe limit/inflight/rtt_noload from stats()", () => {
    const clock = new ManualClock(0);
    const guard = adaptiveConcurrency({ clock, minLimit: 5 });
    const meter = new MockMeter();
    instrumentGuard(guard, meter.asMeter());

    // Take a lease and record one RTT so stats() carries a non-trivial inflight/rttNoload history.
    const lease = guard.acquire();
    expect(lease.ok).toBe(true);

    // While the lease is outstanding, inflight should be observed as 1.
    meter.collect();
    const stats1 = guard.stats();
    expect(meter.gauges.get("throttlekit.concurrency.limit")?.observed.at(-1)?.value).toBe(
      stats1.limit,
    );
    expect(meter.gauges.get("throttlekit.concurrency.inflight")?.observed.at(-1)?.value).toBe(1);
    expect(meter.gauges.get("throttlekit.concurrency.inflight")?.observed.at(-1)?.value).toBe(
      stats1.inflight,
    );

    // Release with a measured RTT, then collect again: inflight drops to 0 and rttNoload appears.
    clock.advance(20);
    lease.release();

    meter.collect();
    const stats2 = guard.stats();
    expect(stats2.rttNoload).toBe(20);
    expect(meter.gauges.get("throttlekit.concurrency.inflight")?.observed.at(-1)?.value).toBe(0);
    expect(meter.gauges.get("throttlekit.concurrency.rtt_noload")?.observed.at(-1)?.value).toBe(
      stats2.rttNoload,
    );
    expect(meter.gauges.get("throttlekit.concurrency.limit")?.observed.at(-1)?.value).toBe(
      stats2.limit,
    );
  });

  it("attaches extra attributes to observed gauge values", () => {
    const guard = adaptiveConcurrency({ clock: new ManualClock(0) });
    const meter = new MockMeter();
    instrumentGuard(guard, meter.asMeter(), { attributes: { pool: "db" } });

    meter.collect();
    expect(meter.gauges.get("throttlekit.concurrency.limit")?.observed.at(-1)?.attributes).toEqual({
      pool: "db",
    });
  });
});
