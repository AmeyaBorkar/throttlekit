import { describe, expect, it } from "vitest";
import { sketchRateLimit } from "../../src/sketch";

/**
 * TK-R04: the sketch stores counts in a Uint32Array, so a fractional `cost` would truncate on `add`
 * and let a key admit more than `limit` true units — weakening the never-over-admit guarantee.
 * The limiter therefore requires an integer cost (like `tokenBudget`'s tokens).
 */
describe("sketchRateLimit — cost validation (TK-R04)", () => {
  const mk = () => sketchRateLimit({ limit: 100, windowMs: 1000 });

  it("rejects a fractional cost", () => {
    expect(() => mk().checkSync("k", 1.5)).toThrow(RangeError);
  });

  it("rejects a non-positive cost", () => {
    expect(() => mk().checkSync("k", 0)).toThrow(RangeError);
    expect(() => mk().checkSync("k", -1)).toThrow(RangeError);
  });

  it("accepts an integer cost", () => {
    expect(mk().checkSync("k", 5).allowed).toBe(true);
  });
});
