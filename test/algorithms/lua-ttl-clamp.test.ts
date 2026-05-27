import { describe, expect, it } from "vitest";
import { fixedWindow } from "../../src/algorithms/fixed-window";
import { slidingWindowLog } from "../../src/algorithms/sliding-window-log";

/**
 * TK-R03: every strategy's Lua `PEXPIRE` must receive a positive integer — like gcra/token-bucket/
 * leaky already do — so a fractional/sub-millisecond window under `useServerTime: false` can't hand
 * Redis a non-integer or zero TTL (which it rejects / treats as immediate-expire), keeping the JS and
 * Lua TTL behaviour aligned. White-box guard: the scripts ceil-and-floor their PEXPIRE argument.
 */
describe("Lua PEXPIRE clamp (TK-R03)", () => {
  it("fixedWindow clamps its PEXPIRE argument to >= 1", () => {
    const script = fixedWindow({ limit: 10, windowMs: 1000 }).lua?.script ?? "";
    expect(script).toMatch(/PEXPIRE/);
    expect(script).toMatch(/if px < 1 then px = 1 end/);
  });

  it("slidingWindowLog clamps its PEXPIRE argument to >= 1", () => {
    const script = slidingWindowLog({ limit: 10, windowMs: 1000 }).lua?.script ?? "";
    expect(script).toMatch(/PEXPIRE/);
    expect(script).toMatch(/if px < 1 then px = 1 end/);
  });
});
