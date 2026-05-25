import { describe, expect, it } from "vitest";
import { ManualClock } from "../../src/core/clock";
import type { Transform } from "../../src/core/types";
import { MemoryStore } from "../../src/stores/memory";

/** A test transform that increments a numeric counter. */
function inc(ttlMs = 1000, persist = true): Transform<number, number> {
  return ((state: number | undefined) => {
    const next = (state ?? 0) + 1;
    return { state: next, result: next, ttlMs, persist };
  }) as Transform<number, number>;
}

describe("MemoryStore", () => {
  it("persists and mutates state across applies (sync)", () => {
    const store = new MemoryStore({ clock: new ManualClock(0), sweepIntervalMs: 0 });
    expect(store.applySync("k", inc())).toBe(1);
    expect(store.applySync("k", inc())).toBe(2);
    expect(store.applySync("j", inc())).toBe(1); // independent key
  });

  it("async apply mirrors applySync", async () => {
    const store = new MemoryStore({ clock: new ManualClock(0), sweepIntervalMs: 0 });
    expect(await store.apply("k", inc())).toBe(1);
    expect(await store.apply("k", inc())).toBe(2);
  });

  it("lazily expires state after its TTL", () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock, sweepIntervalMs: 0 });
    store.applySync("k", inc(1000));
    clock.advance(999);
    expect(store.applySync("k", inc(1000))).toBe(2); // still alive
    clock.advance(1001);
    expect(store.applySync("k", inc(1000))).toBe(1); // expired -> restarts
  });

  it("does not write when persist is false", () => {
    const store = new MemoryStore({ clock: new ManualClock(0), sweepIntervalMs: 0 });
    expect(store.applySync("k", inc(1000, false))).toBe(1);
    expect(store.size).toBe(0);
  });

  it("sweeps expired keys via the wheel without re-reading them", () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock, sweepIntervalMs: 0, tickMs: 100, wheelSize: 16 });
    store.applySync("k", inc(500));
    expect(store.size).toBe(1);
    clock.advance(5000);
    store.applySync("other", inc(500)); // triggers advance, which sweeps "k"
    expect(store.size).toBe(1);
  });

  it("reset forgets a key", () => {
    const store = new MemoryStore({ clock: new ManualClock(0), sweepIntervalMs: 0 });
    store.applySync("k", inc());
    store.resetSync("k");
    expect(store.size).toBe(0);
    expect(store.applySync("k", inc())).toBe(1);
  });

  it("bounds memory with maxKeys", () => {
    const store = new MemoryStore({ clock: new ManualClock(0), sweepIntervalMs: 0, maxKeys: 3 });
    for (let i = 0; i < 10; i++) store.applySync(`k${i}`, inc());
    expect(store.size).toBeLessThanOrEqual(3);
  });

  it("close clears state and stops the sweep timer", async () => {
    const store = new MemoryStore({ clock: new ManualClock(0), sweepIntervalMs: 0 });
    store.applySync("k", inc());
    await store.close();
    expect(store.size).toBe(0);
  });
});
