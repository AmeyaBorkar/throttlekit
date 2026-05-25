import { describe, expect, it } from "vitest";
import { ManualClock, systemClock } from "../../src/core/clock";

describe("ManualClock", () => {
  it("starts at the provided time (default 0)", () => {
    expect(new ManualClock().now()).toBe(0);
    expect(new ManualClock(123).now()).toBe(123);
  });

  it("advances monotonically", () => {
    const c = new ManualClock(0);
    c.advance(500);
    expect(c.now()).toBe(500);
    c.advance(0);
    expect(c.now()).toBe(500);
    c.advance(1.5);
    expect(c.now()).toBe(501.5);
  });

  it("rejects negative or non-finite advances", () => {
    const c = new ManualClock(0);
    expect(() => c.advance(-1)).toThrow(RangeError);
    expect(() => c.advance(Number.NaN)).toThrow(RangeError);
    expect(() => c.advance(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("can jump to an absolute time (clock-jump simulation)", () => {
    const c = new ManualClock(1000);
    c.set(500);
    expect(c.now()).toBe(500);
    expect(() => c.set(Number.NaN)).toThrow(RangeError);
  });
});

describe("systemClock", () => {
  it("tracks Date.now()", () => {
    const before = Date.now();
    const t = systemClock.now();
    const after = Date.now();
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(after);
  });
});
