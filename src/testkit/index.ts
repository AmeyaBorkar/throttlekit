/**
 * A reusable conformance suite any store author can run against their {@link Store}. It pins the
 * exact contract the limiter relies on — persistence, key isolation, reset, TTL expiry, and (the
 * load-bearing one) atomic read-modify-write under concurrency — so a new backend is "correct"
 * the moment this suite is green.
 */
import type { ApplyOutcome, LuaInvocation, LuaProgram, Store, Transform } from "../core/types";

/**
 * The slice of a test framework the conformance suite needs. Pass your runner's functions
 * (`vitest`, `jest`, `node:test` via thin shims, …). Decoupling like this keeps `throttlekit/testkit`
 * import-safe outside a test process and framework-agnostic.
 */
export interface TestHarness {
  describe(name: string, fn: () => void): void;
  it(name: string, fn: () => void | Promise<void>): void;
  beforeEach(fn: () => void | Promise<void>): void;
  afterEach(fn: () => void | Promise<void>): void;
  expect(actual: unknown): { toBe(expected: unknown): void };
}

/** Everything {@link runStoreConformance} needs to exercise one store implementation. */
export interface StoreTestContext {
  /** A fresh store under test. */
  store: Store;
  /**
   * Move the store's clock forward by `ms`. Stores driven by a real server clock (e.g. Redis)
   * cannot time-travel; they pass a no-op here and set {@link StoreTestContext.supportsTimeTravel}
   * to `false` so the TTL test skips its assertion.
   */
  advance(ms: number): void;
  /**
   * Whether {@link StoreTestContext.advance} actually moves the store's notion of time. Defaults
   * to `true`; set `false` for stores backed by an uncontrollable clock so the TTL-expiry test is
   * skipped rather than failing.
   */
  supportsTimeTravel?: boolean;
  /** Release any resources (connections, timers) opened by the context. */
  teardown?(): Promise<void> | void;
}

/** Coerce a Redis reply (integer or numeric string) to a number; `nil`/null reads as 0. */
function toCount(raw: unknown): number {
  return raw === null || raw === undefined ? 0 : Number(raw);
}

/**
 * Attach a Lua invocation to a transform so Lua-capable stores run the atomic form; stores without
 * Lua ignore it and run the function body. The TTL is baked into `program.buildArgv` rather than
 * routed through `now`, so the form is correct regardless of the store's server-time setting.
 */
function withLua(
  fn: (state: number | undefined) => ApplyOutcome<number, number>,
  program: LuaProgram,
): Transform<number, number> {
  const invocation: LuaInvocation<number> = { program, now: 0, cost: 1, decode: toCount };
  (fn as { lua?: LuaInvocation<number> }).lua = invocation;
  return fn as Transform<number, number>;
}

/**
 * A counter {@link Transform}: each apply reads the current count (absent state reads as 0),
 * increments it, and persists the new value with `ttlMs`. Returns the new count as the result, so
 * the n-th apply on a key returns `n` — exactly the read-modify-write the limiter performs, minus
 * the algorithm. Carries an atomic Lua form (`INCR` + `PEXPIRE`) so Lua-capable stores exercise
 * their real single-round-trip primitive instead of the optimistic-concurrency fallback.
 */
function counter(ttlMs: number): Transform<number, number> {
  const program: LuaProgram = {
    script: `local v = redis.call('INCR', KEYS[1])
redis.call('PEXPIRE', KEYS[1], math.max(1, tonumber(ARGV[1])))
return v`,
    buildKeys: (key) => [key],
    // TTL is captured here (not via `now`), so it is independent of useServerTime.
    buildArgv: () => [Math.max(1, Math.ceil(ttlMs))],
  };
  return withLua((state: number | undefined): ApplyOutcome<number, number> => {
    const next = (state ?? 0) + 1;
    return { state: next, result: next, ttlMs, persist: true };
  }, program);
}

/**
 * A non-mutating read {@link Transform}: returns the current count (0 when absent) without
 * persisting, so it observes state without disturbing it. Carries a `GET`-only Lua form for
 * Lua-capable stores (the in-memory store ignores it and runs the body).
 */
function readCount(): Transform<number, number> {
  const program: LuaProgram = {
    script: "return redis.call('GET', KEYS[1])",
    buildKeys: (key) => [key],
    buildArgv: () => [],
  };
  return withLua((state: number | undefined): ApplyOutcome<number, number> => {
    const current = state ?? 0;
    return { state: current, result: current, ttlMs: 0, persist: false };
  }, program);
}

/**
 * Register the store-conformance suite under `describe(name)`. `setup` is invoked fresh in
 * `beforeEach`, so each test gets an isolated store; the context's `teardown` (if any) runs in
 * `afterEach`.
 *
 * @example
 * import { describe, it, expect, beforeEach, afterEach } from "vitest";
 * runStoreConformance("MemoryStore", () => {
 *   const clock = new ManualClock(0);
 *   return { store: new MemoryStore({ clock, sweepIntervalMs: 0 }), advance: (ms) => clock.advance(ms) };
 * }, { describe, it, expect, beforeEach, afterEach });
 */
export function runStoreConformance(
  name: string,
  setup: () => StoreTestContext | Promise<StoreTestContext>,
  harness: TestHarness,
): void {
  const { describe, it, beforeEach, afterEach, expect } = harness;
  describe(name, () => {
    let ctx: StoreTestContext;

    beforeEach(async () => {
      ctx = await setup();
    });

    afterEach(async () => {
      await ctx.teardown?.();
    });

    it("persists and mutates state across applies on one key", async () => {
      expect(await ctx.store.apply("k", counter(1000))).toBe(1);
      expect(await ctx.store.apply("k", counter(1000))).toBe(2);
    });

    it("isolates independent keys", async () => {
      expect(await ctx.store.apply("a", counter(1000))).toBe(1);
      expect(await ctx.store.apply("a", counter(1000))).toBe(2);
      // A second key starts from scratch and does not see "a"'s count.
      expect(await ctx.store.apply("b", counter(1000))).toBe(1);
      // ...and the first key is unaffected by activity on the second.
      expect(await ctx.store.apply("a", counter(1000))).toBe(3);
    });

    it("reset(key) clears the stored state", async () => {
      expect(await ctx.store.apply("k", counter(1000))).toBe(1);
      expect(await ctx.store.apply("k", counter(1000))).toBe(2);
      await ctx.store.reset("k");
      // After reset the counter restarts at 1.
      expect(await ctx.store.apply("k", counter(1000))).toBe(1);
    });

    it("expires state after its TTL (state treated absent)", async () => {
      if (ctx.supportsTimeTravel === false) {
        // The store's clock cannot be advanced (e.g. a real Redis server clock); skip rather than
        // assert against uncontrollable time.
        return;
      }
      const ttl = 1000;
      expect(await ctx.store.apply("k", counter(ttl))).toBe(1);
      ctx.advance(ttl + 1);
      // The entry has expired, so the counter restarts at 1 instead of advancing to 2.
      expect(await ctx.store.apply("k", counter(ttl))).toBe(1);
    });

    it("applies atomically: N concurrent increments lose no updates", async () => {
      const N = 200;
      const applies = Array.from({ length: N }, () => ctx.store.apply("k", counter(60_000)));
      await Promise.all(applies);
      // A non-atomic read-modify-write would interleave and drop writes; an atomic store lands
      // exactly N. Read it back without mutating.
      const final = await ctx.store.apply("k", readCount());
      expect(final).toBe(N);
    });
  });
}
