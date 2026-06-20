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

  it("CLOCK eviction keeps recently-accessed keys (approximate-LRU)", () => {
    const store = new MemoryStore({ clock: new ManualClock(0), sweepIntervalMs: 0, maxKeys: 2 });
    store.applySync("a", inc());
    store.applySync("b", inc());
    store.applySync("a", inc()); // touch "a" — sets its reference bit
    store.applySync("c", inc()); // ring full ⇒ "a" gets a second chance, "b" is evicted
    expect(store.has("a")).toBe(true);
    expect(store.has("b")).toBe(false);
    expect(store.has("c")).toBe(true);
    expect(store.size).toBe(2);
  });

  it("reuses freed slots after reset/expiry without growing the ring", () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock, sweepIntervalMs: 0, maxKeys: 2 });
    store.applySync("a", inc());
    store.applySync("b", inc());
    store.resetSync("a"); // frees a slot (tombstone)
    store.applySync("c", inc()); // reuses the freed slot, no eviction of "b"
    expect(store.has("b")).toBe(true);
    expect(store.has("c")).toBe(true);
    expect(store.size).toBe(2);
  });

  it("does not evict a live key when a freed slot exists away from the CLOCK hand (regression)", () => {
    // Regression: the previous test frees the slot AT the hand (slot 0), so the eviction scan reuses it
    // by luck. Here the freed slot (1) is NOT where the hand sits (0, the live unreferenced "a"). The
    // ring length is still maxKeys, so the next insert took the evict path; the hand walked into the live
    // "a" and sacrificed it — a silent rate-limit reset / over-admission below maxKeys. The insert must
    // reuse the free slot 1 instead.
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock, sweepIntervalMs: 0, maxKeys: 2 });
    store.applySync("a", inc(100_000)); // slot 0
    store.applySync("b", inc(100_000)); // slot 1
    store.resetSync("b"); // tombstone slot 1; the hand is still at slot 0 ("a", live, ref bit clear)
    expect(store.applySync("c", inc(100_000))).toBe(1); // fresh key C
    expect(store.has("a")).toBe(true); // "a" must survive — a free slot was available
    expect(store.has("c")).toBe(true);
    expect(store.size).toBe(2);
    expect(store.applySync("a", inc(100_000))).toBe(2); // "a"'s counter is intact (no silent reset)
  });

  it("does not evict a live key when an expired-but-unswept key sits at the CLOCK hand (regression)", () => {
    // Regression: a short-TTL key whose real expiry has already passed within the current wheel tick
    // is NOT swept (the wheel clamps sub-tick TTLs to a future tick and advance() is a no-op until it
    // elapses), so its map entry is still present. The eviction scan saw a present entry with its ref
    // bit set and granted it a "second chance", diverting the hand onto the genuinely-live key next to
    // it and destroying that key's counter — a silent rate-limit reset / over-admission. An expired
    // entry must be reclaimed like a stale slot, never consume a second chance.
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock, sweepIntervalMs: 0, maxKeys: 2 });
    store.applySync("E", inc(500)); // slot 0, short TTL (expires at 500)
    store.applySync("E", inc(500)); // touch E so its ref bit is set
    store.applySync("L", inc(100_000)); // slot 1, long-TTL LIVE key
    clock.advance(600); // now=600: E expired (exp=500), but tickMs=1000 so the wheel doesn't sweep it
    expect(store.applySync("N", inc(100_000))).toBe(1); // ring full ⇒ evict; E (expired) must go, not L
    expect(store.has("L")).toBe(true); // the live key must survive
    expect(store.applySync("L", inc(100_000))).toBe(2); // L's counter is intact (no silent reset)
  });

  it("close clears state and stops the sweep timer", async () => {
    const store = new MemoryStore({ clock: new ManualClock(0), sweepIntervalMs: 0 });
    store.applySync("k", inc());
    await store.close();
    expect(store.size).toBe(0);
  });
});
