import { describe, expect, it } from "vitest";
import { adaptiveConcurrency } from "../../src/concurrency/adaptive";
import type { ConcurrencyGuard } from "../../src/concurrency/adaptive";
import { ManualClock } from "../../src/core/clock";

/**
 * Envoy-style forced minRTT recalibration (opt-in `recalibration`). Under sustained load the windowed
 * rolling-min no-load baseline stays inflated (every sample carries queuing); the recalibration probe
 * clamps concurrency to drain the queue and re-measures the true no-load RTT. These tests drive the
 * guard with a `ManualClock` so each request measures an exact, injected RTT.
 */

/** One sequential request measuring exactly `rtt` (acquire → advance → release; inflight 0→1→0). */
function sample(g: ConcurrencyGuard, clock: ManualClock, rtt: number): void {
  const l = g.acquire();
  if (!l.ok) return;
  clock.advance(rtt);
  l.release();
}

describe("adaptiveConcurrency — minRTT recalibration", () => {
  describe("validation", () => {
    it("accepts an all-defaults recalibration block", () => {
      expect(() => adaptiveConcurrency({ recalibration: {} })).not.toThrow();
    });

    it("rejects out-of-range recalibration params", () => {
      expect(() => adaptiveConcurrency({ recalibration: { intervalMs: 0 } })).toThrow(RangeError);
      expect(() => adaptiveConcurrency({ recalibration: { probeLimit: 0 } })).toThrow(RangeError);
      expect(() =>
        adaptiveConcurrency({ maxLimit: 10, recalibration: { probeLimit: 20 } }),
      ).toThrow(RangeError);
      expect(() => adaptiveConcurrency({ recalibration: { probeSamples: 0 } })).toThrow(RangeError);
    });
  });

  it("re-baselines the no-load RTT down after the interval (the headline)", () => {
    const clock = new ManualClock(0);
    const g = adaptiveConcurrency({
      clock,
      minLimit: 4,
      initialLimit: 20,
      recalibration: { intervalMs: 1000, probeLimit: 2, probeSamples: 3 },
    });

    // Sustained "load": every sample is slow, so the windowed min is stuck at 100ms.
    for (let i = 0; i < 5; i++) sample(g, clock, 100);
    expect(g.stats().rttNoload).toBe(100);

    // Time passes; the next real sample trips the recalibration trigger → the guard starts probing.
    clock.advance(1000);
    sample(g, clock, 100);

    // The probe's clean low-concurrency samples reveal the true 10ms no-load RTT; after probeSamples
    // (3) of them the guard adopts it.
    sample(g, clock, 10);
    sample(g, clock, 10);
    sample(g, clock, 10);
    expect(g.stats().rttNoload).toBe(10);
  });

  it("clamps the effective ceiling to probeLimit while probing", () => {
    const clock = new ManualClock(0);
    const g = adaptiveConcurrency({
      clock,
      minLimit: 4,
      initialLimit: 20,
      recalibration: { intervalMs: 1000, probeLimit: 2, probeSamples: 50 }, // big ⇒ probe stays open
    });
    for (let i = 0; i < 3; i++) sample(g, clock, 50);
    expect(g.limit).toBeGreaterThan(2); // estimate is well above the probe clamp

    clock.advance(1000);
    sample(g, clock, 50); // trips the trigger → probing

    // While probing, acquire is held down to probeLimit even though `limit` is much higher.
    const leases = [];
    for (;;) {
      const l = g.acquire();
      if (!l.ok) break;
      leases.push(l);
    }
    expect(leases.length).toBe(2);
    expect(g.limit).toBeGreaterThan(2); // the learned estimate is preserved, only the ceiling is clamped
    for (const l of leases) l.release();
  });

  it("is opt-in: without `recalibration` the ceiling is never clamped, regardless of time", () => {
    const clock = new ManualClock(0);
    const g = adaptiveConcurrency({ clock, minLimit: 4, initialLimit: 20 });
    for (let i = 0; i < 3; i++) sample(g, clock, 50);
    clock.advance(10_000_000); // far past any interval
    sample(g, clock, 50);

    const leases = [];
    for (;;) {
      const l = g.acquire();
      if (!l.ok) break;
      leases.push(l);
    }
    expect(leases.length).toBe(g.limit); // fills the full inferred ceiling — no probe clamp
    expect(leases.length).toBeGreaterThan(2);
    for (const l of leases) l.release();
  });

  it("ignores impure (high-concurrency) samples during a probe", () => {
    const clock = new ManualClock(0);
    const g = adaptiveConcurrency({
      clock,
      minLimit: 4,
      initialLimit: 20,
      recalibration: { intervalMs: 5, probeLimit: 1, probeSamples: 2 },
    });

    // Three leases acquired at HIGH concurrency (inflightAtAcquire 1, 2, 3).
    const l1 = g.acquire();
    const l2 = g.acquire();
    const l3 = g.acquire();
    clock.advance(5); // each will measure rtt = 5 (a deceptively LOW value)

    // Releasing l1 (a normal settle) trips the trigger → probing begins; l2/l3 are still in flight.
    l1.release();
    // l2 (inflightAtAcquire 2 > probeLimit 1) and l3 (3 > 1) are impure — they must NOT be adopted,
    // even though their 5ms rtt is lower than the clean samples below.
    l2.release();
    l3.release();

    // Two clean drained samples at 50ms are the true no-load measurement.
    sample(g, clock, 50);
    sample(g, clock, 50);
    expect(g.stats().rttNoload).toBe(50); // 50, not the impure 5 — the filter held
  });

  it("resumes normal growth after a probe completes", () => {
    const clock = new ManualClock(0);
    const g = adaptiveConcurrency({
      clock,
      minLimit: 4,
      initialLimit: 8,
      recalibration: { intervalMs: 1000, probeLimit: 2, probeSamples: 2 },
    });
    for (let i = 0; i < 3; i++) sample(g, clock, 100);

    clock.advance(1000);
    sample(g, clock, 100); // trigger
    sample(g, clock, 10); // probe sample 1
    sample(g, clock, 10); // probe sample 2 → finishProbe, back to normal

    const limitAfterProbe = g.limit;
    // A fully-utilized round of fast requests against the fresh baseline grows the estimate again.
    for (let round = 0; round < 20; round++) {
      const leases = [];
      for (;;) {
        const l = g.acquire();
        if (!l.ok) break;
        leases.push(l);
      }
      clock.advance(10); // fast ⇒ healthy
      for (const l of leases) l.release();
    }
    expect(g.limit).toBeGreaterThanOrEqual(limitAfterProbe); // not stuck at the probe clamp
  });
});
