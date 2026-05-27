import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type DurableObjectStateLike,
  type DurableObjectStorageLike,
  DurableObjectStore,
} from "../../src/cloudflare";
import { ManualClock } from "../../src/core/clock";
import type { ApplyOutcome, Transform } from "../../src/core/types";
import { runStoreConformance } from "../../src/testkit";

/**
 * In-memory fake of a Cloudflare Durable Object `state`: a Map for storage plus a
 * `blockConcurrencyWhile` that serializes critical sections through a promise chain — exactly the
 * gating a real Durable Object provides, which is what makes the store's read-modify-write atomic.
 */
function fakeDoState(): DurableObjectStateLike {
  const map = new Map<string, unknown>();
  let chain: Promise<unknown> = Promise.resolve();
  const storage: DurableObjectStorageLike = {
    get: <T>(k: string): Promise<T | undefined> => Promise.resolve(map.get(k) as T | undefined),
    put: <T>(k: string, v: T): Promise<void> => {
      map.set(k, v);
      return Promise.resolve();
    },
    delete: (k: string): Promise<boolean> => Promise.resolve(map.delete(k)),
  };
  return {
    storage,
    blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
      const run = chain.then(() => fn());
      chain = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}

/** A minimal counter transform (no Lua form — the DO store runs the JS body, like every backend). */
const counter =
  (ttlMs = 1000): Transform<number, number> =>
  (state: number | undefined): ApplyOutcome<number, number> => {
    const next = (state ?? 0) + 1;
    return { state: next, result: next, ttlMs, persist: true };
  };

// The load-bearing test: a Durable Object's single-threaded gating makes apply atomic, so the
// conformance suite (incl. the 200-way concurrent RMW) passes with no optimistic-retry loop.
runStoreConformance(
  "DurableObjectStore",
  () => {
    const clock = new ManualClock(0);
    return {
      store: new DurableObjectStore(fakeDoState(), { clock }),
      advance: (ms: number) => clock.advance(ms),
    };
  },
  { describe, it, expect, beforeEach, afterEach },
);

describe("DurableObjectStore — specifics", () => {
  it("namespaces keys by prefix on a shared object (no cross-prefix collision)", async () => {
    const clock = new ManualClock(0);
    const shared = fakeDoState();
    const a = new DurableObjectStore(shared, { clock, prefix: "a" });
    const b = new DurableObjectStore(shared, { clock, prefix: "b" });
    expect(await a.apply("k", counter())).toBe(1);
    expect(await b.apply("k", counter())).toBe(1); // independent bucket despite the same raw key
    expect(await a.apply("k", counter())).toBe(2);
    expect(await b.apply("k", counter())).toBe(2);
  });

  it("reset clears state", async () => {
    const clock = new ManualClock(0);
    const store = new DurableObjectStore(fakeDoState(), { clock });
    expect(await store.apply("k", counter())).toBe(1);
    await store.reset("k");
    expect(await store.apply("k", counter())).toBe(1);
  });

  it("expires lazily by the injected clock", async () => {
    const clock = new ManualClock(0);
    const store = new DurableObjectStore(fakeDoState(), { clock });
    expect(await store.apply("k", counter(1000))).toBe(1);
    clock.advance(1001);
    expect(await store.apply("k", counter(1000))).toBe(1); // prior entry expired → restarts
  });
});
