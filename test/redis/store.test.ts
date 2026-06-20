import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fixedWindow } from "../../src/algorithms/fixed-window";
import { ManualClock } from "../../src/core/clock";
import { rateLimit } from "../../src/core/limiter";
import type { RedisClientLike } from "../../src/redis/store";
import { RedisStore } from "../../src/redis/store";

/**
 * RedisStore behavior that needs no live server, via a recording fake client. The focus here is the
 * write-freeness of the introspection path under `ttlFloorMs`: `peek()`/`forecast()` are contractually
 * non-consuming reads, so the optional physical-TTL floor (a PEXPIRE) must NOT fire on them — only on
 * a consuming, persisting `check()`.
 */

const sha1 = (s: string): string => createHash("sha1").update(s).digest("hex");

/** A recording fake that models just enough Redis for fixedWindow + the TTL floor: a HASH and a PTTL. */
function makeFake(): { client: RedisClientLike; commands: string[]; setPttl(ms: number): void } {
  const hash = new Map<string, string>(); // the single key's HMGET fields
  let pttl = -2; // -2 == key absent (Redis convention)
  const commands: string[] = [];

  // Reconstruct which script ran from its sha. The store evalsha's the strategy's scripts and the
  // TTL_FLOOR script; we only need to tell the read-only HMGET apart from the floor's PTTL/PEXPIRE.
  const TTL_FLOOR_LUA =
    "local f = tonumber(ARGV[1]) for i=1,#KEYS do if redis.call('PTTL', KEYS[i]) < f then redis.call('PEXPIRE', KEYS[i], f) end end return 1";
  const READ_LUA = "return redis.call('HMGET', KEYS[1], 's', 'c')";
  const shaFloor = sha1(TTL_FLOOR_LUA);
  const shaRead = sha1(READ_LUA);

  const run = (sha: string, argv: Array<string | number>): unknown => {
    if (sha === shaRead) {
      commands.push("READ: HMGET s,c");
      return [hash.get("s") ?? null, hash.get("c") ?? null];
    }
    if (sha === shaFloor) {
      const f = Number(argv[0]);
      commands.push(`FLOOR: PTTL=${pttl}`);
      if (pttl < f) {
        pttl = f;
        commands.push(`FLOOR: PEXPIRE ${f}  <-- WRITE`);
      }
      return 1;
    }
    // The consuming fixedWindow script: just record that it ran (not exercised in these tests).
    commands.push("CHECK: fixedWindow");
    return [1, 100, 99, 0, 0];
  };

  const client: RedisClientLike = {
    async evalsha(sha, _numkeys, ...rest) {
      // rest = [...keys, ...argv]; the floor script passes exactly one argv (the floor ms).
      return run(sha, rest.slice(rest.length - (sha === shaFloor ? 1 : 0)));
    },
    async eval(script, _numkeys, ...rest) {
      return run(sha1(script), rest.slice(rest.length - (sha1(script) === shaFloor ? 1 : 0)));
    },
    async get() {
      return null;
    },
    async del() {
      return 0;
    },
    async watch() {
      return "OK";
    },
    async unwatch() {
      return "OK";
    },
    multi() {
      throw new Error("not used");
    },
  };

  return {
    client,
    commands,
    setPttl(ms: number) {
      pttl = ms;
    },
  };
}

describe("RedisStore ttlFloorMs (offline)", () => {
  it("peek() with a floor set issues only the read-only Lua, never a PEXPIRE (write-free)", async () => {
    const fake = makeFake();
    // The key's physical TTL has decayed below the floor — exactly when the floor would fire.
    fake.setPttl(100);
    const limiter = rateLimit({
      strategy: fixedWindow({ limit: 100, windowMs: 60_000 }),
      clock: new ManualClock(1_700_000_000_000),
      store: new RedisStore({ client: fake.client, ttlFloorMs: 60_000, useServerTime: false }),
    });

    await limiter.peek?.("user:42");

    // A non-consuming read must touch nothing but the read-only HMGET — no TTL floor write.
    expect(fake.commands).toEqual(["READ: HMGET s,c"]);
    expect(fake.commands.some((c) => c.includes("PEXPIRE"))).toBe(false);
  });

  it("forecast() with a floor set is likewise write-free", async () => {
    const fake = makeFake();
    fake.setPttl(100);
    const limiter = rateLimit({
      strategy: fixedWindow({ limit: 100, windowMs: 60_000 }),
      clock: new ManualClock(1_700_000_000_000),
      store: new RedisStore({ client: fake.client, ttlFloorMs: 60_000, useServerTime: false }),
    });

    await limiter.forecast?.("user:42");

    expect(fake.commands).toEqual(["READ: HMGET s,c"]);
    expect(fake.commands.some((c) => c.includes("PEXPIRE"))).toBe(false);
  });
});
