import { describe, expect, it } from "vitest";
import { fixedWindow } from "../../src/algorithms/fixed-window";
import { gcra } from "../../src/algorithms/gcra";
import { withAnalytics } from "../../src/analytics";
import { ManualClock } from "../../src/core/clock";
import { rateLimit } from "../../src/core/limiter";
import type { Decision, Limiter, Strategy } from "../../src/core/types";
import { MemoryStore } from "../../src/stores/memory";

/** An allow/deny pattern an inner fake will replay, so counts/top-K are fully deterministic. */
type Plan = (key: string, cost: number) => boolean;

/**
 * A minimal fake {@link Limiter} whose verdict is decided by `plan`. It records every call so
 * passthrough (key/cost/return value) can be asserted, and builds a real-shaped {@link Decision}
 * so the wrapper sees nothing unusual. `syncable: false` models an async-only store (checkSync
 * throws), mirroring `rateLimit` over a store without `applySync`.
 */
function fakeLimiter(
  plan: Plan,
  opts: { syncable?: boolean } = {},
): {
  limiter: Limiter;
  calls: Array<{ via: "check" | "checkSync"; key: string; cost: number }>;
} {
  const syncable = opts.syncable ?? true;
  const calls: Array<{ via: "check" | "checkSync"; key: string; cost: number }> = [];
  const strategy = { name: "fake", limit: 100, ttlMs: 1000 } as unknown as Strategy;

  const decide = (allowed: boolean): Decision => ({
    allowed,
    limit: 100,
    remaining: allowed ? 99 : 0,
    resetAt: 1000,
    retryAfterMs: allowed ? 0 : 500,
  });

  const limiter: Limiter = {
    strategy,
    async check(key: string, cost = 1): Promise<Decision> {
      calls.push({ via: "check", key, cost });
      return decide(plan(key, cost));
    },
    checkSync(key: string, cost = 1): Decision {
      if (!syncable) throw new Error("async-only store: checkSync unsupported");
      calls.push({ via: "checkSync", key, cost });
      return decide(plan(key, cost));
    },
    checkMany(keys: readonly string[], cost = 1): Promise<Decision[]> {
      return Promise.all(keys.map((k) => this.check(k, cost)));
    },
    checkManySync(keys: readonly string[], cost = 1): Decision[] {
      return keys.map((k) => this.checkSync(k, cost));
    },
    async reset(): Promise<void> {},
  };
  return { limiter, calls };
}

describe("withAnalytics — options & validation", () => {
  it("validates topK and windowMs", () => {
    const { limiter } = fakeLimiter(() => true);
    expect(() => withAnalytics(limiter, { topK: 0 })).toThrow(RangeError);
    expect(() => withAnalytics(limiter, { windowMs: 0 })).toThrow(RangeError);
    expect(() => withAnalytics(limiter, { windowMs: -1 })).toThrow(RangeError);
  });

  it("defaults windowMs to 60_000 and starts an empty current window", () => {
    const clock = new ManualClock(0);
    const { limiter } = fakeLimiter(() => true);
    const a = withAnalytics(limiter, { clock });
    const snap = a.analytics();
    expect(snap.windowMs).toBe(60_000);
    expect(snap.total).toBe(0);
    expect(snap.allowed).toBe(0);
    expect(snap.denied).toBe(0);
    expect(snap.denyRate).toBe(0);
    expect(snap.topRequested).toEqual([]);
    expect(snap.topDenied).toEqual([]);
  });
});

describe("withAnalytics — counts (test 1)", () => {
  it("tracks allowed/denied/total/denyRate over a controlled sequence (sync)", () => {
    const clock = new ManualClock(0);
    // Allow the first three, deny the rest.
    let n = 0;
    const { limiter } = fakeLimiter(() => {
      n += 1;
      return n <= 3;
    });
    const a = withAnalytics(limiter, { clock });

    for (let i = 0; i < 5; i++) a.checkSync("k");

    const snap = a.analytics();
    expect(snap.allowed).toBe(3);
    expect(snap.denied).toBe(2);
    expect(snap.total).toBe(5);
    expect(snap.denyRate).toBeCloseTo(2 / 5, 12);
  });

  it("tracks counts over a real fixedWindow limiter driven past its limit (async)", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock });
    const inner = rateLimit({ strategy: fixedWindow({ limit: 3, windowMs: 1000 }), clock, store });
    // Wider analytics window so all checks land in one analytics window.
    const a = withAnalytics(inner, { clock, windowMs: 10_000 });

    const decisions: Decision[] = [];
    for (let i = 0; i < 5; i++) decisions.push(await a.check("user"));

    // fixedWindow(limit 3): first three allowed, then denied.
    expect(decisions.map((d) => d.allowed)).toEqual([true, true, true, false, false]);

    const snap = a.analytics();
    expect(snap.allowed).toBe(3);
    expect(snap.denied).toBe(2);
    expect(snap.total).toBe(5);
    expect(snap.denyRate).toBeCloseTo(2 / 5, 12);
  });

  it("denyRate is 0 when no traffic has been seen", () => {
    const { limiter } = fakeLimiter(() => true);
    const snap = withAnalytics(limiter, { clock: new ManualClock(0) }).analytics();
    expect(snap.total).toBe(0);
    expect(snap.denyRate).toBe(0);
  });
});

describe("withAnalytics — top-K heavy hitters (test 2)", () => {
  it("surfaces hot keys in count-descending order among many cold keys (requested)", () => {
    const clock = new ManualClock(0);
    const { limiter } = fakeLimiter(() => true); // everything allowed
    // Space-Saving's accuracy guarantee holds when topK exceeds the number of true heavy hitters,
    // so the cold tail competes for the *spare* slots instead of evicting real hitters. With 3 hot
    // keys we give comfortable headroom (topK 10, the default). Cold keys are fed FIRST so they
    // initially occupy slots the hot keys must then reclaim — exercising eviction, not gaming it.
    const a = withAnalytics(limiter, { clock, topK: 10 });

    for (let i = 0; i < 200; i++) a.checkSync(`cold-${i}`); // 200 distinct singletons
    for (let i = 0; i < 100; i++) a.checkSync("hot-a");
    for (let i = 0; i < 50; i++) a.checkSync("hot-b");
    for (let i = 0; i < 25; i++) a.checkSync("hot-c");

    const top = a.analytics().topRequested;
    expect(top.length).toBeLessThanOrEqual(10);
    // The three genuine heavy hitters are surfaced, in the right order, ahead of any cold key.
    expect(top.slice(0, 3).map((h) => h.key)).toEqual(["hot-a", "hot-b", "hot-c"]);
    // Space-Saving over-estimates only: an estimate is never below the true count.
    expect(top[0]?.count).toBeGreaterThanOrEqual(100);
    expect(top[1]?.count).toBeGreaterThanOrEqual(50);
    expect(top[2]?.count).toBeGreaterThanOrEqual(25);
  });

  it("a dominant key is never evicted even with topK smaller than the key universe", () => {
    const clock = new ManualClock(0);
    const { limiter } = fakeLimiter(() => true);
    const a = withAnalytics(limiter, { clock, topK: 2 });

    // "whale" is hit far more than the combined cold churn that follows it.
    for (let i = 0; i < 500; i++) a.checkSync("whale");
    for (let i = 0; i < 100; i++) a.checkSync(`cold-${i}`);

    const top = a.analytics().topRequested;
    expect(top).toHaveLength(2); // bounded by topK
    // A key whose true count exceeds the eviction floor (here, the running minimum) is retained:
    // Space-Saving guarantees any element with true frequency > N/topK survives. whale qualifies.
    expect(top[0]?.key).toBe("whale");
    expect(top[0]?.count).toBeGreaterThanOrEqual(500);
  });

  it("topDenied reflects only the keys that were actually denied", () => {
    const clock = new ManualClock(0);
    // Deny everything addressed to "spammer"; allow the rest.
    const { limiter } = fakeLimiter((key) => key !== "spammer");
    const a = withAnalytics(limiter, { clock, topK: 5 });

    for (let i = 0; i < 30; i++) a.checkSync("spammer"); // all denied
    for (let i = 0; i < 10; i++) a.checkSync("good-user"); // all allowed
    for (let i = 0; i < 3; i++) a.checkSync("rare"); // all allowed

    const snap = a.analytics();
    // Requested sees everyone; denied sees only the spammer.
    expect(snap.topRequested.map((h) => h.key)).toContain("good-user");
    expect(snap.topDenied).toHaveLength(1);
    expect(snap.topDenied[0]?.key).toBe("spammer");
    expect(snap.topDenied[0]?.count).toBe(30);
    expect(snap.denied).toBe(30);
    expect(snap.allowed).toBe(13);
  });

  it("a real gcra limiter: the over-budget key dominates topDenied", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock });
    // burst 2 => the 3rd+ immediate request for a key is denied.
    const inner = rateLimit({ strategy: gcra({ limit: 2, periodMs: 1000 }), clock, store });
    const a = withAnalytics(inner, { clock, windowMs: 10_000, topK: 5 });

    // Hammer one key well past its burst; touch two others lightly (within burst => allowed).
    for (let i = 0; i < 10; i++) await a.check("flooder");
    await a.check("alice");
    await a.check("bob");

    const snap = a.analytics();
    expect(snap.topDenied[0]?.key).toBe("flooder");
    // 10 attempts, burst 2 allowed => 8 denied for the flooder; alice/bob allowed.
    expect(snap.topDenied[0]?.count).toBe(8);
    expect(snap.denied).toBe(8);
    expect(snap.allowed).toBe(4); // 2 (flooder) + alice + bob
  });
});

describe("withAnalytics — bounded memory (test 3)", () => {
  it("never tracks more than topK entries even after 10,000 distinct keys", () => {
    const clock = new ManualClock(0);
    const { limiter } = fakeLimiter(() => false); // deny all => feed BOTH summaries
    const topK = 8;
    const a = withAnalytics(limiter, { clock, topK });

    for (let i = 0; i < 10_000; i++) a.checkSync(`key-${i}`);

    const snap = a.analytics();
    expect(snap.total).toBe(10_000);
    expect(snap.denied).toBe(10_000);
    // The whole point of Space-Saving: both summaries stay bounded by topK regardless of
    // distinct-key cardinality.
    expect(snap.topRequested.length).toBeLessThanOrEqual(topK);
    expect(snap.topDenied.length).toBeLessThanOrEqual(topK);
    expect(snap.topRequested).toHaveLength(topK);
    expect(snap.topDenied).toHaveLength(topK);
  });

  it("Space-Saving inherits the evicted minimum as the new key's count (count = min + 1)", () => {
    const clock = new ManualClock(0);
    const { limiter } = fakeLimiter(() => true);
    const a = withAnalytics(limiter, { clock, topK: 2 });

    // Fill two slots: a=3, b=2.
    for (let i = 0; i < 3; i++) a.checkSync("a");
    for (let i = 0; i < 2; i++) a.checkSync("b");
    // New key "c": summary full, min is b(count 2) => c becomes count = 2 + 1 = 3.
    a.checkSync("c");

    const top = a.analytics().topRequested;
    expect(top).toHaveLength(2);
    // a (3, exact) and c (3, an over-estimate inheriting b's 2). Tie broken by key asc.
    expect(top.map((h) => h.key)).toEqual(["a", "c"]);
    expect(top[0]?.count).toBe(3);
    expect(top[1]?.count).toBe(3);
  });
});

describe("withAnalytics — window roll (test 4)", () => {
  it("resets counts and summaries on the epoch-aligned boundary", () => {
    const clock = new ManualClock(0);
    const { limiter } = fakeLimiter((key) => key !== "x"); // deny "x"
    const a = withAnalytics(limiter, { clock, windowMs: 1000, topK: 5 });

    a.checkSync("x"); // denied
    a.checkSync("y"); // allowed
    let snap = a.analytics();
    expect(snap.windowStartedAt).toBe(0);
    expect(snap.total).toBe(2);
    expect(snap.denied).toBe(1);
    expect(snap.topDenied[0]?.key).toBe("x");

    // Still inside window [0,1000): counts accumulate.
    clock.set(999);
    a.checkSync("y");
    snap = a.analytics();
    expect(snap.windowStartedAt).toBe(0);
    expect(snap.total).toBe(3);

    // Cross into window [1000,2000): everything resets.
    clock.set(1000);
    snap = a.analytics();
    expect(snap.windowStartedAt).toBe(1000);
    expect(snap.total).toBe(0);
    expect(snap.allowed).toBe(0);
    expect(snap.denied).toBe(0);
    expect(snap.topRequested).toEqual([]);
    expect(snap.topDenied).toEqual([]);

    // New traffic counts against the new window.
    a.checkSync("z");
    snap = a.analytics();
    expect(snap.windowStartedAt).toBe(1000);
    expect(snap.total).toBe(1);
  });

  it("windowStartedAt is epoch-aligned for a non-aligned clock", () => {
    const clock = new ManualClock(7_250);
    const { limiter } = fakeLimiter(() => true);
    const a = withAnalytics(limiter, { clock, windowMs: 1000 });
    a.checkSync("k");
    expect(a.analytics().windowStartedAt).toBe(7_000); // floor(7250/1000)*1000
  });

  it("a check after a boundary lands in the fresh window (roll observed on check too)", () => {
    const clock = new ManualClock(0);
    const { limiter } = fakeLimiter(() => true);
    const a = withAnalytics(limiter, { clock, windowMs: 1000 });

    a.checkSync("a");
    a.checkSync("a");
    expect(a.analytics().total).toBe(2);

    clock.set(2000); // skip a full window
    a.checkSync("a"); // this check rolls the window itself
    const snap = a.analytics();
    expect(snap.windowStartedAt).toBe(2000);
    expect(snap.total).toBe(1);
    expect(snap.topRequested).toEqual([{ key: "a", count: 1 }]);
  });
});

describe("withAnalytics — drop-in parity (test 5)", () => {
  it("exposes the inner strategy unchanged", () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock });
    const inner = rateLimit({ strategy: gcra({ limit: 2, periodMs: 1000 }), clock, store });
    const a = withAnalytics(inner, { clock });
    expect(a.strategy).toBe(inner.strategy);
    expect(a.strategy.name).toBe("gcra");
  });

  it("check/checkSync delegate key+cost and return the inner Decision by value", async () => {
    const clock = new ManualClock(0);
    const { limiter, calls } = fakeLimiter(() => true);
    const a = withAnalytics(limiter, { clock });

    const dSync = a.checkSync("alpha", 2);
    const dAsync = await a.check("beta", 3);

    expect(calls).toEqual([
      { via: "checkSync", key: "alpha", cost: 2 },
      { via: "check", key: "beta", cost: 3 },
    ]);
    // The exact inner Decision is returned untouched.
    expect(dSync).toEqual({
      allowed: true,
      limit: 100,
      remaining: 99,
      resetAt: 1000,
      retryAfterMs: 0,
    });
    expect(dAsync).toEqual({
      allowed: true,
      limit: 100,
      remaining: 99,
      resetAt: 1000,
      retryAfterMs: 0,
    });
  });

  it("reset delegates to the inner limiter (state actually cleared)", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock });
    const inner = rateLimit({ strategy: gcra({ limit: 1, periodMs: 1000 }), clock, store });
    const a = withAnalytics(inner, { clock });

    expect((await a.check("k")).allowed).toBe(true);
    expect((await a.check("k")).allowed).toBe(false); // burst exhausted
    await a.reset("k");
    expect((await a.check("k")).allowed).toBe(true); // reset cleared inner state
  });

  it("checkSync throws when the inner store is async-only, and records nothing", () => {
    const clock = new ManualClock(0);
    const { limiter } = fakeLimiter(() => true, { syncable: false });
    const a = withAnalytics(limiter, { clock });

    expect(() => a.checkSync("k")).toThrow();
    const snap = a.analytics();
    expect(snap.total).toBe(0);
    expect(snap.topRequested).toEqual([]);
  });

  it("checkSync throws on a real async-only-store limiter (rateLimit without applySync)", () => {
    const asyncOnlyStore = {
      apply: async <S, R>(
        _key: string,
        transform: (state: S | undefined) => { result: R },
      ): Promise<R> => transform(undefined).result,
      reset: async (): Promise<void> => {},
    };
    const inner = rateLimit({
      strategy: gcra({ limit: 2, periodMs: 1000 }),
      clock: new ManualClock(0),
      store: asyncOnlyStore,
    });
    const a = withAnalytics(inner, { clock: new ManualClock(0) });
    expect(() => a.checkSync("k")).toThrow();
  });
});

describe("withAnalytics — determinism & passthrough (test 6)", () => {
  it("is fully deterministic under a ManualClock", () => {
    const run = (): ReturnType<ReturnType<typeof withAnalytics>["analytics"]> => {
      const clock = new ManualClock(0);
      const { limiter } = fakeLimiter((key) => key === "ok");
      const a = withAnalytics(limiter, { clock, windowMs: 1000, topK: 3 });
      const keys = ["ok", "bad", "ok", "bad", "bad", "ok", "other"];
      for (const k of keys) a.checkSync(k);
      return a.analytics();
    };
    expect(run()).toEqual(run());
  });

  it("does not mutate or wrap the inner Decision", async () => {
    const clock = new ManualClock(0);
    let captured: Decision | undefined;
    const inner: Limiter = {
      strategy: { name: "fake", limit: 1, ttlMs: 1 } as unknown as Strategy,
      async check(): Promise<Decision> {
        captured = { allowed: false, limit: 1, remaining: 0, resetAt: 42, retryAfterMs: 7 };
        return captured;
      },
      checkSync(): Decision {
        captured = { allowed: false, limit: 1, remaining: 0, resetAt: 42, retryAfterMs: 7 };
        return captured;
      },
      async checkMany(keys: readonly string[]): Promise<Decision[]> {
        return Promise.all(keys.map((k) => this.check(k)));
      },
      checkManySync(keys: readonly string[]): Decision[] {
        return keys.map((k) => this.checkSync(k));
      },
      async reset(): Promise<void> {},
    };
    const a = withAnalytics(inner, { clock });
    const out = await a.check("k");
    expect(out).toBe(captured); // same reference: not copied/wrapped
    expect(out).toEqual({ allowed: false, limit: 1, remaining: 0, resetAt: 42, retryAfterMs: 7 });
  });
});

describe("withAnalytics — resetAnalytics", () => {
  it("clears counters and both summaries without touching inner state", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock });
    const inner = rateLimit({ strategy: gcra({ limit: 1, periodMs: 1000 }), clock, store });
    const a = withAnalytics(inner, { clock, windowMs: 10_000 });

    await a.check("k"); // allowed
    await a.check("k"); // denied (burst 1 exhausted)
    expect(a.analytics().total).toBe(2);

    a.resetAnalytics();
    const snap = a.analytics();
    expect(snap.total).toBe(0);
    expect(snap.allowed).toBe(0);
    expect(snap.denied).toBe(0);
    expect(snap.topRequested).toEqual([]);
    expect(snap.topDenied).toEqual([]);

    // Inner limiter state is untouched: "k" is still over budget.
    expect((await a.check("k")).allowed).toBe(false);
    // ...and that post-reset check is now reflected in analytics.
    expect(a.analytics().total).toBe(1);
  });
});
