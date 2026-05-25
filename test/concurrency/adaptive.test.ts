import { describe, expect, it } from "vitest";
import { adaptiveConcurrency } from "../../src/concurrency/adaptive";
import type { ConcurrencyGuard, Lease } from "../../src/concurrency/adaptive";
import { ManualClock } from "../../src/core/clock";

/**
 * Establish the rolling-min "no-load" baseline with a single fast sample. After this the guard
 * knows its best-observed RTT, so later samples can be compared against it deterministically.
 */
function baseline(g: ConcurrencyGuard, clock: ManualClock, rtt: number): void {
  const l = g.acquire();
  clock.advance(rtt);
  l.release();
}

/**
 * One fully-utilized round: fill up to the current integer ceiling, advance the clock once by
 * `rtt` (so every lease measures exactly `rtt`), then release them all. The later-acquired leases
 * carry a high `inflightAtAcquire`, so the round drives the limit as a genuinely utilized sample.
 */
function fillRound(g: ConcurrencyGuard, clock: ManualClock, rtt: number, dropped = false): number {
  const leases: Lease[] = [];
  for (;;) {
    const l = g.acquire();
    if (!l.ok) break;
    leases.push(l);
  }
  clock.advance(rtt);
  for (const l of leases) l.release({ dropped });
  return leases.length;
}

describe("adaptiveConcurrency", () => {
  describe("config validation", () => {
    it("throws RangeError on out-of-range options", () => {
      expect(() => adaptiveConcurrency({ minLimit: 0 })).toThrow(RangeError);
      expect(() => adaptiveConcurrency({ minLimit: 10, maxLimit: 5 })).toThrow(RangeError);
      expect(() => adaptiveConcurrency({ minLimit: 10, initialLimit: 5 })).toThrow(RangeError);
      expect(() => adaptiveConcurrency({ maxLimit: 8, initialLimit: 20 })).toThrow(RangeError);
      expect(() => adaptiveConcurrency({ rttWindow: 0 })).toThrow(RangeError);
      expect(() => adaptiveConcurrency({ smoothing: 0 })).toThrow(RangeError);
      expect(() => adaptiveConcurrency({ smoothing: 1.5 })).toThrow(RangeError);
      expect(() => adaptiveConcurrency({ tolerance: 0.5 })).toThrow(RangeError);
      // backoffRatio must be in [0.5, 1)
      expect(() => adaptiveConcurrency({ backoffRatio: 0.4 })).toThrow(RangeError);
      expect(() => adaptiveConcurrency({ backoffRatio: 1.0 })).toThrow(RangeError);
    });

    it("accepts boundary-valid options", () => {
      expect(() => adaptiveConcurrency({ backoffRatio: 0.5 })).not.toThrow();
      expect(() => adaptiveConcurrency({ smoothing: 1.0 })).not.toThrow();
      expect(() =>
        adaptiveConcurrency({ minLimit: 4, maxLimit: 4, initialLimit: 4 }),
      ).not.toThrow();
    });
  });

  it("starts at initialLimit (defaulting to minLimit) and reports a correct stats() shape", () => {
    const clock = new ManualClock(0);
    const g = adaptiveConcurrency({ clock, minLimit: 7 });
    expect(g.limit).toBe(7); // initialLimit defaults to minLimit
    expect(g.inflight).toBe(0);
    expect(g.stats()).toEqual({ limit: 7, inflight: 0, rttNoload: 0, lastRtt: 0 });

    const g2 = adaptiveConcurrency({ clock, minLimit: 4, initialLimit: 12 });
    expect(g2.limit).toBe(12);
  });

  it("rejects acquire once inflight reaches the integer limit; releasing frees a slot", () => {
    const clock = new ManualClock(0);
    const g = adaptiveConcurrency({ clock, minLimit: 3, initialLimit: 3 });

    const a = g.acquire();
    const b = g.acquire();
    const c = g.acquire();
    expect([a.ok, b.ok, c.ok]).toEqual([true, true, true]);
    expect(g.inflight).toBe(3);

    // Over the ceiling: rejected, holds no slot, inflight unchanged.
    const rejected = g.acquire();
    expect(rejected.ok).toBe(false);
    expect(g.inflight).toBe(3);
    // Releasing a rejected lease is a harmless no-op.
    rejected.release();
    expect(g.inflight).toBe(3);

    // Free one slot, then acquisition succeeds again.
    a.release();
    expect(g.inflight).toBe(2);
    const d = g.acquire();
    expect(d.ok).toBe(true);
    expect(g.inflight).toBe(3);
  });

  it("auto-records latency: stats reflect the measured RTT and the no-load baseline", () => {
    const clock = new ManualClock(0);
    const g = adaptiveConcurrency({ clock });
    const l = g.acquire();
    clock.advance(42);
    l.release();
    const s = g.stats();
    expect(s.lastRtt).toBe(42);
    expect(s.rttNoload).toBe(42); // first sample sets the baseline
  });

  it("ignores a double release() (inflight is not decremented twice)", () => {
    const clock = new ManualClock(0);
    const g = adaptiveConcurrency({ clock, initialLimit: 10 });
    const l = g.acquire();
    expect(g.inflight).toBe(1);
    clock.advance(5);
    l.release();
    expect(g.inflight).toBe(0);
    l.release({ dropped: true }); // second call must be a no-op
    expect(g.inflight).toBe(0);
  });

  describe("gradient2", () => {
    it("grows toward maxLimit under a healthy, utilized load and clamps there", () => {
      const clock = new ManualClock(0);
      // Large rttWindow so a long healthy run never re-baselines the no-load min.
      const g = adaptiveConcurrency({
        clock,
        minLimit: 4,
        maxLimit: 512,
        initialLimit: 4,
        rttWindow: 100_000,
      });
      baseline(g, clock, 10); // no-load = 10
      expect(g.limit).toBe(4);

      // Healthy samples (rtt == noload) at full utilization grow the limit monotonically.
      let prev = g.limit;
      for (let r = 0; r < 10; r++) {
        fillRound(g, clock, 10);
        expect(g.limit).toBeGreaterThanOrEqual(prev);
        prev = g.limit;
      }
      expect(g.limit).toBeGreaterThan(20); // climbed well off the floor

      // Keep going: it pins at the ceiling and never exceeds it.
      for (let r = 0; r < 200; r++) fillRound(g, clock, 10);
      expect(g.limit).toBe(512);
    });

    it("contracts multiplicatively under a latency spike and clamps at minLimit", () => {
      const clock = new ManualClock(0);
      // Modest ceiling so full-fill rounds stay utilized while total samples remain under the
      // (large) window — the no-load min therefore stays at the established baseline.
      const g = adaptiveConcurrency({
        clock,
        minLimit: 4,
        maxLimit: 30,
        initialLimit: 30,
        rttWindow: 100_000,
      });
      baseline(g, clock, 10); // no-load = 10
      expect(g.limit).toBe(30);

      // rtt = 500 >> noload 10: gradient pinned to its 0.5 floor, so the limit decays each round.
      let prev = g.limit;
      for (let r = 0; r < 5; r++) {
        fillRound(g, clock, 500);
        expect(g.limit).toBeLessThan(prev);
        prev = g.limit;
      }
      expect(g.stats().rttNoload).toBe(10); // baseline held (windowed min did not re-rise)

      // Sustained overload bottoms out at the floor and never undershoots it.
      for (let r = 0; r < 100; r++) fillRound(g, clock, 500);
      expect(g.limit).toBe(4);
    });

    it("contracts when requests are dropped (drop forces the gradient to its floor)", () => {
      const clock = new ManualClock(0);
      const g = adaptiveConcurrency({ clock, minLimit: 4, maxLimit: 512, initialLimit: 100 });
      // A single dropped sample at full utilization contracts immediately:
      // newLimit = 100*0.5 + 10 = 60; EMA = 100*0.8 + 60*0.2 = 92.
      const leases: Lease[] = [];
      for (let i = 0; i < 100; i++) leases.push(g.acquire());
      clock.advance(5);
      leases[99]?.release({ dropped: true });
      expect(g.limit).toBe(92);
      // (drain the rest without asserting; they are a separate, healthy signal)
      for (let i = 0; i < 99; i++) leases[i]?.release();
    });

    it("does not grow while under-utilized (inflightAtAcquire below limit/2)", () => {
      const clock = new ManualClock(0);
      const g = adaptiveConcurrency({ clock, minLimit: 4, maxLimit: 512, initialLimit: 20 });
      baseline(g, clock, 10);
      const before = g.limit;
      // One lease at a time => inflightAtAcquire = 1, far below limit/2 = 10. Healthy, but the
      // limit must stay put: a fast request seen while idle is no evidence we could go higher.
      for (let r = 0; r < 30; r++) {
        const l = g.acquire();
        clock.advance(10);
        l.release();
      }
      expect(g.limit).toBe(before);
    });
  });

  describe("aimd", () => {
    it("adds 1 on a healthy, utilized sample", () => {
      const clock = new ManualClock(0);
      const g = adaptiveConcurrency({
        clock,
        algorithm: "aimd",
        minLimit: 4,
        maxLimit: 512,
        initialLimit: 10,
      });
      baseline(g, clock, 10); // no-load = 10; this sample was under-utilized so no change
      expect(g.limit).toBe(10);

      // Fill to the ceiling, release the last (inflightAtAcquire = 10, so 2*10 >= 10): +1.
      const leases: Lease[] = [];
      for (let i = 0; i < 10; i++) leases.push(g.acquire());
      clock.advance(10);
      leases[9]?.release();
      expect(g.limit).toBe(11);
      for (let i = 0; i < 9; i++) leases[i]?.release();
    });

    it("multiplies by backoffRatio on a drop or when rtt exceeds tolerance*noload", () => {
      const clock = new ManualClock(0);
      const g = adaptiveConcurrency({
        clock,
        algorithm: "aimd",
        minLimit: 4,
        maxLimit: 512,
        initialLimit: 100,
        backoffRatio: 0.9,
      });
      baseline(g, clock, 10); // no-load = 10, tolerance default 2 => slow threshold 20ms

      // A utilized, slow sample (500 > 20) => floor(100 * 0.9) = 90.
      const leases: Lease[] = [];
      for (let i = 0; i < 99; i++) leases.push(g.acquire());
      clock.advance(500);
      leases[98]?.release();
      expect(g.limit).toBe(90);
      for (let i = 0; i < 98; i++) leases[i]?.release();

      // A drop contracts the same way regardless of measured latency.
      const g2 = adaptiveConcurrency({
        clock,
        algorithm: "aimd",
        initialLimit: 100,
        backoffRatio: 0.9,
      });
      const m: Lease[] = [];
      for (let i = 0; i < 99; i++) m.push(g2.acquire());
      clock.advance(1);
      m[98]?.release({ dropped: true });
      expect(g2.limit).toBe(90);
      for (let i = 0; i < 98; i++) m[i]?.release();
    });

    it("holds the clamps at both ends", () => {
      const clock = new ManualClock(0);
      // Healthy + utilized run pins at maxLimit.
      const up = adaptiveConcurrency({
        clock,
        algorithm: "aimd",
        minLimit: 4,
        maxLimit: 24,
        initialLimit: 4,
        rttWindow: 100_000,
      });
      baseline(up, clock, 10);
      for (let r = 0; r < 200; r++) fillRound(up, clock, 10);
      expect(up.limit).toBe(24);

      // Sustained overload bottoms out at minLimit.
      const down = adaptiveConcurrency({
        clock,
        algorithm: "aimd",
        minLimit: 4,
        maxLimit: 64,
        initialLimit: 40,
        rttWindow: 100_000,
      });
      baseline(down, clock, 10);
      for (let r = 0; r < 200; r++) fillRound(down, clock, 500);
      expect(down.limit).toBe(4);
    });
  });

  it("traces a classic sawtooth: climb while healthy, sharp drop on a spike, then recover", () => {
    const clock = new ManualClock(0);
    const g = adaptiveConcurrency({
      clock,
      minLimit: 4,
      maxLimit: 64,
      initialLimit: 8,
      rttWindow: 100_000,
    });
    baseline(g, clock, 10);

    // Climb during a healthy phase.
    for (let r = 0; r < 50; r++) fillRound(g, clock, 10);
    const peak = g.limit;
    expect(peak).toBeGreaterThan(8);

    // Latency spike: a few utilized slow rounds carve a sharp trough.
    for (let r = 0; r < 5; r++) fillRound(g, clock, 800);
    const trough = g.limit;
    expect(trough).toBeLessThan(peak);

    // Recovery: health returns, the limit climbs back.
    for (let r = 0; r < 50; r++) fillRound(g, clock, 10);
    const recovered = g.limit;
    expect(recovered).toBeGreaterThan(trough);
  });
});
