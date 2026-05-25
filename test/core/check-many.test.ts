import { describe, expect, it } from "vitest";
import { gcra } from "../../src/algorithms/gcra";
import { ManualClock } from "../../src/core/clock";
import { rateLimit } from "../../src/core/limiter";
import type { Store, Transform } from "../../src/core/types";
import { MemoryStore } from "../../src/stores/memory";

/**
 * checkMany / checkManySync: a decision per key in input order, every key evaluated at one
 * consistent timestamp, and identical to calling check/checkSync per key.
 */

describe("checkMany / checkManySync (MemoryStore)", () => {
  function freshPair() {
    const clock = new ManualClock(1_000);
    const opts = { strategy: gcra({ limit: 100, periodMs: 60_000, burst: 20 }), clock } as const;
    return {
      clock,
      // Two independent limiters with independent stores so a batch on one cannot perturb the
      // per-key reference computed on the other.
      batch: rateLimit({ ...opts, store: new MemoryStore({ clock, sweepIntervalMs: 0 }) }),
      ref: rateLimit({ ...opts, store: new MemoryStore({ clock, sweepIntervalMs: 0 }) }),
    };
  }

  it("returns one decision per key, in order", () => {
    const { batch } = freshPair();
    const out = batch.checkManySync(["a", "b", "c"]);
    expect(out.length).toBe(3);
    for (const d of out) expect(d.allowed).toBe(true);
  });

  it("matches per-key checkSync exactly (distinct keys)", () => {
    const { batch, ref } = freshPair();
    const keys = ["u1", "u2", "u3", "u4"];
    const many = batch.checkManySync(keys, 3);
    const one = keys.map((k) => ref.checkSync(k, 3));
    expect(many).toEqual(one);
  });

  it("treats repeated keys in a batch like sequential checks on that key", () => {
    const { batch, ref } = freshPair();
    // burst is 20; spend cost 5 four times on the same key within the batch -> the 5th would deny,
    // but here 4×5=20 exactly fills the burst, all allowed, remaining hits 0.
    const many = batch.checkManySync(["k", "k", "k", "k"], 5);
    const one = [0, 1, 2, 3].map(() => ref.checkSync("k", 5));
    expect(many).toEqual(one);
    expect(many[3]?.remaining).toBe(0);
  });

  it("evaluates the whole batch at a single timestamp", () => {
    // Two keys checked in one batch must see the same `now`: with a fresh GCRA cell, both get the
    // identical resetAt for the same cost, proving no clock advance happened mid-batch.
    const { batch } = freshPair();
    const [a, b] = batch.checkManySync(["x", "y"]);
    expect(a?.resetAt).toBe(b?.resetAt);
  });

  it("empty input yields an empty result", async () => {
    const { batch } = freshPair();
    expect(batch.checkManySync([])).toEqual([]);
    expect(await batch.checkMany([])).toEqual([]);
  });

  it("async checkMany matches checkManySync on a sync store", async () => {
    const { batch, ref } = freshPair();
    const keys = ["p", "q", "r"];
    const asyncOut = await batch.checkMany(keys, 2);
    const syncOut = ref.checkManySync(keys, 2);
    expect(asyncOut).toEqual(syncOut);
  });

  it("rejects a non-positive cost", async () => {
    const { batch } = freshPair();
    expect(() => batch.checkManySync(["a"], 0)).toThrow(RangeError);
    await expect(batch.checkMany(["a"], -1)).rejects.toBeInstanceOf(RangeError);
  });

  it("checkManySync throws on an async-only store", () => {
    // A store with no applySync (like RedisStore) must make the sync batch throw, not silently fail.
    const asyncOnly: Store = {
      apply<S, R>(_key: string, t: Transform<S, R>): Promise<R> {
        return Promise.resolve(t(undefined).result);
      },
      reset(): Promise<void> {
        return Promise.resolve();
      },
    };
    const limiter = rateLimit({ strategy: gcra({ limit: 10, periodMs: 1000 }), store: asyncOnly });
    expect(() => limiter.checkManySync(["a", "b"])).toThrow(/requires a synchronous store/);
  });
});
