import { describe, expect, it } from "vitest";
import { fixedWindow } from "../../src/algorithms/fixed-window";
import { gcra } from "../../src/algorithms/gcra";
import { type KVNamespaceLike, KVStore } from "../../src/cloudflare/kv";
import { ManualClock } from "../../src/core/clock";
import { rateLimit } from "../../src/core/limiter";

/** A fake Workers KV namespace backed by a Map, recording put TTLs. */
class FakeKV implements KVNamespaceLike {
  readonly map = new Map<string, string>();
  readonly puts: { key: string; expirationTtl: number | undefined }[] = [];
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.map.set(key, value);
    this.puts.push({ key, expirationTtl: options?.expirationTtl });
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

// NOTE: KVStore is best-effort and NOT atomic, so it is deliberately not run through
// runStoreConformance (the 200-way concurrent RMW test). These tests cover the single-threaded,
// sequential behaviour it does guarantee.
describe("KVStore (best-effort Workers KV)", () => {
  it("counts correctly for sequential checks on one key", async () => {
    const clock = new ManualClock(1_000);
    const kv = new FakeKV();
    const limiter = rateLimit({
      strategy: fixedWindow({ limit: 3, windowMs: 1000 }),
      clock,
      store: new KVStore({ kv, clock }),
    });
    expect((await limiter.check("k")).allowed).toBe(true);
    expect((await limiter.check("k")).allowed).toBe(true);
    expect((await limiter.check("k")).allowed).toBe(true);
    expect((await limiter.check("k")).allowed).toBe(false);
  });

  it("clamps expirationTtl to KV's 60s floor, even for sub-minute windows", async () => {
    const clock = new ManualClock(0);
    const kv = new FakeKV();
    const limiter = rateLimit({
      strategy: fixedWindow({ limit: 5, windowMs: 1000 }), // 1s window
      clock,
      store: new KVStore({ kv, clock }),
    });
    await limiter.check("k");
    expect(kv.puts).toHaveLength(1);
    expect(kv.puts[0]?.expirationTtl).toBe(60); // ceil(1000ms)=1s clamped up to the 60s minimum
  });

  it("resets the window logically once its window has passed", async () => {
    const clock = new ManualClock(0);
    const kv = new FakeKV();
    const limiter = rateLimit({
      strategy: fixedWindow({ limit: 1, windowMs: 1000 }),
      clock,
      store: new KVStore({ kv, clock }),
    });
    expect((await limiter.check("k")).allowed).toBe(true);
    expect((await limiter.check("k")).allowed).toBe(false); // same window
    clock.advance(1000); // next epoch-aligned window
    expect((await limiter.check("k")).allowed).toBe(true);
  });

  it("round-trips non-object state (gcra's single number) through JSON", async () => {
    const clock = new ManualClock(0);
    const kv = new FakeKV();
    const limiter = rateLimit({
      strategy: gcra({ limit: 2, periodMs: 1000 }),
      clock,
      store: new KVStore({ kv, clock }),
    });
    expect((await limiter.check("k")).allowed).toBe(true);
    expect((await limiter.check("k")).allowed).toBe(true);
    expect((await limiter.check("k")).allowed).toBe(false); // burst of 2 exhausted
  });

  it("is async-only: checkSync throws (every check is a network round trip)", () => {
    const kv = new FakeKV();
    const limiter = rateLimit({
      strategy: fixedWindow({ limit: 3, windowMs: 1000 }),
      store: new KVStore({ kv }),
    });
    expect(() => limiter.checkSync("k")).toThrow(/synchronous store/);
  });

  it("reset clears the key", async () => {
    const clock = new ManualClock(0);
    const kv = new FakeKV();
    const limiter = rateLimit({
      strategy: fixedWindow({ limit: 1, windowMs: 60_000 }),
      clock,
      store: new KVStore({ kv, clock }),
    });
    await limiter.check("k");
    expect((await limiter.check("k")).allowed).toBe(false);
    await limiter.reset("k");
    expect((await limiter.check("k")).allowed).toBe(true);
  });
});
