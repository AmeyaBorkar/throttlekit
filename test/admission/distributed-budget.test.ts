import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { distributedTokenBudget } from "../../src/admission";
import { ManualClock } from "../../src/core/clock";
import { ThrottleKitError } from "../../src/core/errors";
import type { Store } from "../../src/core/types";
import { RedisStore } from "../../src/redis/store";
import { MemoryStore } from "../../src/stores/memory";

function meter(opts: { budget: number; windowMs?: number; clock: ManualClock; store?: Store }) {
  return distributedTokenBudget({
    budget: opts.budget,
    windowMs: opts.windowMs ?? 60_000,
    clock: opts.clock,
    store: opts.store ?? new MemoryStore({ clock: opts.clock, sweepIntervalMs: 0 }),
  });
}

describe("distributedTokenBudget", () => {
  it("validates options", () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock, sweepIntervalMs: 0 });
    expect(() => distributedTokenBudget({ budget: 0, windowMs: 1000, store })).toThrow(RangeError);
    expect(() => distributedTokenBudget({ budget: 10, windowMs: 0, store })).toThrow(RangeError);
  });

  it("rejects non-positive / non-integer token debits", async () => {
    const m = meter({ budget: 100, clock: new ManualClock(0) });
    await expect(m.debit(0)).rejects.toThrow(RangeError);
    await expect(m.debit(-5)).rejects.toThrow(RangeError);
    await expect(m.debit(1.5)).rejects.toThrow(RangeError);
  });

  it("stops at the boundary: per-token debits admit exactly `budget`, then deny", async () => {
    const m = meter({ budget: 5, clock: new ManualClock(0) });
    for (let i = 0; i < 5; i++) {
      const d = await m.debit(1);
      expect(d.allowed).toBe(true);
      expect(d.remaining).toBe(4 - i);
    }
    const denied = await m.debit(1);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
  });

  it("counts the crossing debit in full (overshoot ≤ tokens − 1), then refuses", async () => {
    const m = meter({ budget: 10, clock: new ManualClock(0) });
    expect((await m.debit(7)).allowed).toBe(true); // served 7
    const crossing = await m.debit(7); // served 7 < 10 ⇒ admitted, served becomes 14
    expect(crossing.allowed).toBe(true);
    expect(crossing.remaining).toBe(0);
    expect((await m.debit(1)).allowed).toBe(false); // budget now spent
    // Overshoot is 14 − 10 = 4, within the bound (largest debit 7) − 1 = 6.
    expect(await m.remaining()).toBe(0);
  });

  it("holds the fleet to exactly `budget` under heavy concurrency (per-token Δ = 0)", async () => {
    // One shared store + key is the fleet's atomic counter. 250 concurrent per-token debits, budget
    // 100 ⇒ exactly 100 admitted no matter the interleaving (the atomic RMW serializes them).
    const m = meter({ budget: 100, clock: new ManualClock(0) });
    const results = await Promise.all(Array.from({ length: 250 }, () => m.debit(1)));
    expect(results.filter((d) => d.allowed).length).toBe(100);
    expect(results.filter((d) => !d.allowed).length).toBe(150);
  });

  it("shares one budget across two gateways pointed at the same store + key", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock, sweepIntervalMs: 0 });
    const a = distributedTokenBudget({
      budget: 10,
      windowMs: 60_000,
      clock,
      store,
      key: "tpm:acme",
    });
    const b = distributedTokenBudget({
      budget: 10,
      windowMs: 60_000,
      clock,
      store,
      key: "tpm:acme",
    });
    let admitted = 0;
    for (let i = 0; i < 8; i++) {
      if ((await a.debit(1)).allowed) admitted++;
      if ((await b.debit(1)).allowed) admitted++;
    }
    expect(admitted).toBe(10); // the two gateways together admit exactly the shared budget
    expect((await a.debit(1)).allowed).toBe(false);
    expect((await b.debit(1)).allowed).toBe(false);
  });

  it("keeps independent budgets under distinct keys in one store", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock, sweepIntervalMs: 0 });
    const a = distributedTokenBudget({ budget: 2, windowMs: 60_000, clock, store, key: "a" });
    const b = distributedTokenBudget({ budget: 2, windowMs: 60_000, clock, store, key: "b" });
    expect((await a.debit(2)).allowed).toBe(true);
    expect((await a.debit(1)).allowed).toBe(false); // a is spent
    expect((await b.debit(2)).allowed).toBe(true); // b is untouched
  });

  it("rolls the window: a fresh budget after the boundary", async () => {
    const clock = new ManualClock(0);
    const m = meter({ budget: 3, windowMs: 1000, clock });
    for (let i = 0; i < 3; i++) expect((await m.debit(1)).allowed).toBe(true);
    expect((await m.debit(1)).allowed).toBe(false);
    clock.advance(1000); // next epoch-aligned window
    expect((await m.debit(1)).allowed).toBe(true);
    expect(await m.remaining()).toBe(2);
  });

  it("remaining() peeks without debiting; reset() clears the shared usage", async () => {
    const clock = new ManualClock(0);
    const m = meter({ budget: 10, clock });
    await m.debit(4);
    expect(await m.remaining()).toBe(6);
    expect(await m.remaining()).toBe(6); // peeking does not consume
    await m.reset();
    expect(await m.remaining()).toBe(10);
  });

  it("debitSync works on a synchronous store and matches debit", async () => {
    const clock = new ManualClock(0);
    const m = meter({ budget: 3, clock });
    expect(m.debitSync(1).allowed).toBe(true);
    expect(m.debitSync(1).remaining).toBe(1);
    expect(m.debitSync(1).allowed).toBe(true);
    expect(m.debitSync(1).allowed).toBe(false); // budget spent
  });

  it("debitSync throws on an async-only store", () => {
    const clock = new ManualClock(0);
    const asyncOnly: Store = {
      // debitSync throws before this is reached; it exists only to satisfy the async-only Store shape.
      apply: () => Promise.reject(new Error("unused")),
      reset: () => Promise.resolve(),
    };
    const m = distributedTokenBudget({ budget: 10, windowMs: 60_000, clock, store: asyncOnly });
    expect(() => m.debitSync(1)).toThrow(ThrottleKitError);
  });
});

const REDIS_URL = process.env.THROTTLEKIT_TEST_REDIS;
const dRedis = REDIS_URL ? describe : describe.skip;

dRedis("distributedTokenBudget over RedisStore", () => {
  let client: Redis;
  beforeAll(() => {
    // DB 7 is the sanctioned flush-free co-tenancy (see test/redis/db-allocation.test.ts): this file
    // never FLUSHDBs and uses a unique per-run `tpm:` key, so it shares DB 7 without collision.
    client = new Redis(REDIS_URL as string, { db: 7, maxRetriesPerRequest: 2 });
  });
  afterAll(async () => {
    await client?.quit();
  });

  it("remaining() peeks after a debit without throwing WRONGTYPE (regression)", async () => {
    // The debit Lua stores state in a HASH; remaining()'s peek had no Lua form, so on Redis it routed
    // to the OCC GET fallback and a GET on the hash key threw WRONGTYPE. The peek now reads via HMGET.
    const key = `tpm:${Date.now().toString(36)}.${Math.floor(Math.random() * 1e6).toString(36)}`;
    await client.del(key);
    const meter = distributedTokenBudget({
      budget: 100,
      windowMs: 60_000,
      store: new RedisStore({ client }),
      key,
    });
    expect(await meter.remaining()).toBe(100);
    const d = await meter.debit(5); // writes a HASH at `key`
    expect(d.allowed).toBe(true);
    expect(await meter.remaining()).toBe(95); // no WRONGTYPE; matches the decision's remaining
    await client.del(key);
  });
});
