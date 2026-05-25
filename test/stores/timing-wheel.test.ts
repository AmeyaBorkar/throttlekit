import { describe, expect, it } from "vitest";
import { TimingWheel } from "../../src/stores/timing-wheel";

describe("TimingWheel", () => {
  it("reports keys as live until their TTL elapses (lazy, boundary inclusive)", () => {
    const w = new TimingWheel(0, { tickMs: 100, wheelSize: 8 });
    w.set("a", 500);
    expect(w.isExpired("a", 0)).toBe(false);
    expect(w.isExpired("a", 499)).toBe(false);
    expect(w.isExpired("a", 500)).toBe(true); // exp <= now
    expect(w.isExpired("missing", 0)).toBe(true);
  });

  it("expires only due keys on advance and invokes the callback", () => {
    const w = new TimingWheel(0, { tickMs: 100, wheelSize: 8 });
    w.set("a", 500);
    w.set("b", 5000);
    const expired: string[] = [];
    w.advance(600, (k) => expired.push(k));
    expect(expired).toEqual(["a"]);
    expect(w.has("a")).toBe(false);
    expect(w.has("b")).toBe(true);
    expect(w.size).toBe(1);
  });

  it("cleans every slot in a single advance after a long idle gap", () => {
    const w = new TimingWheel(0, { tickMs: 100, wheelSize: 8 }); // span = 800ms; TTLs lap it
    for (let i = 0; i < 20; i++) w.set(`k${i}`, (i + 1) * 100);
    expect(w.size).toBe(20);
    const expired: string[] = [];
    w.advance(10_000, (k) => expired.push(k));
    expect(expired.length).toBe(20);
    expect(w.size).toBe(0);
  });

  it("reschedules via set, removing the key from its old slot", () => {
    const w = new TimingWheel(0, { tickMs: 100, wheelSize: 8 });
    w.set("a", 200);
    w.set("a", 5000); // move far out
    const expired: string[] = [];
    w.advance(400, (k) => expired.push(k));
    expect(expired).toEqual([]);
    expect(w.has("a")).toBe(true);
    expect(w.isExpired("a", 400)).toBe(false);
  });

  it("delete removes a key entirely", () => {
    const w = new TimingWheel(0, { tickMs: 100, wheelSize: 8 });
    w.set("a", 500);
    w.delete("a");
    w.delete("a"); // idempotent
    expect(w.has("a")).toBe(false);
    expect(w.size).toBe(0);
  });
});
