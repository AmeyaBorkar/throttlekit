import { describe, expect, it } from "vitest";
import { TimingWheel } from "../../src/stores/timing-wheel";

/**
 * TK-P04: TimingWheel.set rescheduled a key by allocating a fresh {exp,slot} every persisted check.
 * It now mutates the existing entry in place (and only touches the slot Sets when the slot changes).
 * These assertions pin the behaviour that mutation must preserve.
 */
describe("TimingWheel.set in-place reschedule (TK-P04)", () => {
  it("rescheduling a key updates its expiry and keeps exactly one entry", () => {
    const w = new TimingWheel(0, { tickMs: 1000, wheelSize: 8 });
    w.set("k", 1500);
    expect(w.isExpired("k", 1499)).toBe(false);

    // Reschedule the same key later — the in-place mutation must reflect the new expiry.
    w.set("k", 3500);
    expect(w.isExpired("k", 1600)).toBe(false); // old 1500 expiry no longer applies
    expect(w.isExpired("k", 3499)).toBe(false);
    expect(w.isExpired("k", 3500)).toBe(true);
    expect(w.size).toBe(1); // no duplicate entry

    // Reschedule within the same tick (slot unchanged) — still correct.
    w.set("k", 3600);
    expect(w.isExpired("k", 3500)).toBe(false);
    expect(w.isExpired("k", 3600)).toBe(true);
    expect(w.size).toBe(1);
  });

  it("still expires a rescheduled key on advance", () => {
    const w = new TimingWheel(0, { tickMs: 1000, wheelSize: 8 });
    w.set("k", 1200);
    w.set("k", 2200); // moved to a later slot
    const expired: string[] = [];
    w.advance(5000, (k) => expired.push(k));
    expect(expired).toEqual(["k"]);
    expect(w.size).toBe(0);
  });
});
