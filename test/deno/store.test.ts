import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ManualClock } from "../../src/core/clock";
import type { ApplyOutcome, Transform } from "../../src/core/types";
import {
  type AtomicOperationLike,
  type DenoKvLike,
  DenoKvStore,
  type KvCheckLike,
  type KvCommitResultLike,
  type KvEntryLike,
  type KvKeyLike,
} from "../../src/deno";
import { runStoreConformance } from "../../src/testkit";

/**
 * In-memory fake of a `Deno.Kv`. The decisive property: `commit()` evaluates every staged `check`
 * and applies every staged mutation **synchronously and all-or-nothing** inside the call, so — JS
 * being single-threaded — no two atomic commits interleave. That is exactly Deno KV's atomic
 * guarantee, the basis of the store's versionstamp CAS. A failing check resolves `{ ok: false }`
 * without mutating, like the real API. `dump()` exposes the backing store for assertions.
 */
function fakeKv(): DenoKvLike & { dump(): Map<string, { value: unknown; versionstamp: string }> } {
  const map = new Map<string, { value: unknown; versionstamp: string }>();
  let seq = 0;
  const enc = (key: KvKeyLike): string => JSON.stringify(key);
  const nextStamp = (): string => (++seq).toString().padStart(20, "0");

  const get = <T = unknown>(key: KvKeyLike): Promise<KvEntryLike<T>> => {
    const e = map.get(enc(key));
    return Promise.resolve(
      e === undefined
        ? { key, value: null, versionstamp: null }
        : { key, value: structuredClone(e.value) as T, versionstamp: e.versionstamp },
    );
  };

  const atomic = (): AtomicOperationLike => {
    const checks: KvCheckLike[] = [];
    const sets: { key: KvKeyLike; value: unknown }[] = [];
    const dels: KvKeyLike[] = [];
    const op: AtomicOperationLike = {
      check: (...c: KvCheckLike[]): AtomicOperationLike => {
        checks.push(...c);
        return op;
      },
      set: (key: KvKeyLike, value: unknown): AtomicOperationLike => {
        sets.push({ key, value });
        return op;
      },
      delete: (key: KvKeyLike): AtomicOperationLike => {
        dels.push(key);
        return op;
      },
      commit: (): Promise<KvCommitResultLike> => {
        for (const chk of checks) {
          const cur = map.get(enc(chk.key));
          const curStamp = cur === undefined ? null : cur.versionstamp;
          if (curStamp !== chk.versionstamp) return Promise.resolve({ ok: false });
        }
        const stamp = nextStamp();
        for (const s of sets)
          map.set(enc(s.key), { value: structuredClone(s.value), versionstamp: stamp });
        for (const d of dels) map.delete(enc(d));
        return Promise.resolve({ ok: true });
      },
    };
    return op;
  };

  return {
    get,
    atomic,
    delete: (key: KvKeyLike): Promise<void> => {
      map.delete(enc(key));
      return Promise.resolve();
    },
    dump: () => map,
  };
}

/** A minimal counter transform (no Lua form — the Deno KV store runs the JS body via its CAS loop). */
const counter =
  (ttlMs = 1000): Transform<number, number> =>
  (state: number | undefined): ApplyOutcome<number, number> => {
    const next = (state ?? 0) + 1;
    return { state: next, result: next, ttlMs, persist: true };
  };

/** A non-mutating read: observe the count without writing. */
const read =
  (): Transform<number, number> =>
  (state: number | undefined): ApplyOutcome<number, number> => ({
    state,
    result: state ?? 0,
    ttlMs: 0,
    persist: false,
  });

// The load-bearing suite. Same-isolate applies are coalesced, so the 200-way concurrent RMW lands
// exactly 200 with clean versionstamp bumps; the cross-isolate CAS path is exercised separately below.
runStoreConformance(
  "DenoKvStore",
  () => {
    const clock = new ManualClock(0);
    return {
      store: new DenoKvStore({ kv: fakeKv(), clock }),
      advance: (ms: number) => clock.advance(ms),
    };
  },
  { describe, it, expect, beforeEach, afterEach },
);

describe("DenoKvStore — specifics", () => {
  it("namespaces keys by prefix on a shared KV (no cross-prefix collision)", async () => {
    const clock = new ManualClock(0);
    const kv = fakeKv();
    const a = new DenoKvStore({ kv, clock, prefix: "a" });
    const b = new DenoKvStore({ kv, clock, prefix: "b" });
    expect(await a.apply("k", counter())).toBe(1);
    expect(await b.apply("k", counter())).toBe(1); // independent bucket despite the same raw key
    expect(await a.apply("k", counter())).toBe(2);
    expect(await b.apply("k", counter())).toBe(2);
    // Distinct KV keys: ["a","k"] and ["b","k"].
    expect(kv.dump().has(JSON.stringify(["a", "k"]))).toBe(true);
    expect(kv.dump().has(JSON.stringify(["b", "k"]))).toBe(true);
  });

  it("uses a bare [key] when no prefix is set", async () => {
    const clock = new ManualClock(0);
    const kv = fakeKv();
    const store = new DenoKvStore({ kv, clock });
    await store.apply("k", counter());
    expect(kv.dump().has(JSON.stringify(["k"]))).toBe(true);
  });

  it("reset clears state", async () => {
    const clock = new ManualClock(0);
    const store = new DenoKvStore({ kv: fakeKv(), clock });
    expect(await store.apply("k", counter())).toBe(1);
    await store.reset("k");
    expect(await store.apply("k", counter())).toBe(1);
  });

  it("expires lazily by the injected clock, overwriting the stale entry in place", async () => {
    const clock = new ManualClock(0);
    const kv = fakeKv();
    const store = new DenoKvStore({ kv, clock });
    expect(await store.apply("k", counter(1000))).toBe(1);
    const v1 = kv.dump().get(JSON.stringify(["k"]))?.versionstamp;
    clock.advance(1001);
    expect(await store.apply("k", counter(1000))).toBe(1); // prior entry expired → restarts
    const v2 = kv.dump().get(JSON.stringify(["k"]))?.versionstamp;
    expect(v2).not.toBe(v1); // CAS-overwritten (new versionstamp), not duplicated
  });

  it("resolves cross-isolate races via the versionstamp CAS (two stores, one KV)", async () => {
    // Separate store instances do NOT share the in-process lock, so their applies genuinely race at
    // the shared KV and must be reconciled by the atomic check + retry.
    const clock = new ManualClock(0);
    const kv = fakeKv();
    const a = new DenoKvStore({ kv, clock });
    const b = new DenoKvStore({ kv, clock });
    const applies = [
      ...Array.from({ length: 50 }, () => a.apply("k", counter(60_000))),
      ...Array.from({ length: 50 }, () => b.apply("k", counter(60_000))),
    ];
    await Promise.all(applies);
    expect(await a.apply("k", read())).toBe(100); // no lost updates across the two isolates
  });

  it("throws StoreUnavailableError when CAS retries are exhausted", async () => {
    const clock = new ManualClock(0);
    // A KV whose atomic commits never succeed (ok always false) forces retry exhaustion.
    const stuck: DenoKvLike = {
      get: <T = unknown>(key: KvKeyLike): Promise<KvEntryLike<T>> =>
        Promise.resolve({ key, value: null, versionstamp: null }),
      atomic: (): AtomicOperationLike => {
        const op: AtomicOperationLike = {
          check: () => op,
          set: () => op,
          delete: () => op,
          commit: (): Promise<KvCommitResultLike> => Promise.resolve({ ok: false }),
        };
        return op;
      },
      delete: (): Promise<void> => Promise.resolve(),
    };
    const store = new DenoKvStore({ kv: stuck, clock, maxRetries: 2 });
    await expect(store.apply("k", counter())).rejects.toThrow(/optimistic concurrency exhausted/);
  });
});
