import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fixedWindow } from "../../src/algorithms/fixed-window";
import { ManualClock } from "../../src/core/clock";
import { rateLimit } from "../../src/core/limiter";
import type { RedisClientLike } from "../../src/redis/store";
import { RedisStore } from "../../src/redis/store";

/**
 * Offline coverage for the `ttlFloorMs` pipeline path (#3): when the client supports pipelining
 * (`pipeline()`, as ioredis does), `RedisStore` coalesces the consuming strategy `EVALSHA` and the
 * `TTL_FLOOR` `EVALSHA` into ONE round trip instead of two sequential ones. The strategy is consuming,
 * so the load-bearing safety property is that it runs EXACTLY ONCE on every path — including the two
 * NOSCRIPT branches (script cache flushed), which nothing else exercises. A fresh real-Redis run keeps
 * scripts cached, so these paths are only reachable with a fake that can force NOSCRIPT deterministically.
 */

const sha1 = (s: string): string => createHash("sha1").update(s).digest("hex");

// Replica of RedisStore's internal TTL_FLOOR script (not exported); we only need its sha to tell the
// floor command apart from the strategy command — every other sha is "the strategy".
const TTL_FLOOR_LUA =
  "local f = tonumber(ARGV[1]) for i=1,#KEYS do if redis.call('PTTL', KEYS[i]) < f then redis.call('PEXPIRE', KEYS[i], f) end end return 1";
const FLOOR_SHA = sha1(TTL_FLOOR_LUA);

const NATIVE_PX = 600; // the short physical TTL the strategy itself sets, before the floor extends it
const CANNED = [1, 100, 99, 0, 0]; // a valid fixedWindow reply shape; value is irrelevant to these tests

interface Fake {
  client: RedisClientLike;
  consumed(): number; // how many times the consuming strategy actually executed
  pttl(): number;
  pipelineExecs(): number;
  evalCalls(): number;
}

/**
 * A fake Redis modelling EVALSHA/EVAL script-cache semantics + an optional pipeline. `loaded` controls
 * which scripts are in the cache: an EVALSHA for an unloaded script throws NOSCRIPT (it does NOT run);
 * EVAL always runs and loads. `withPipeline:false` models a client without `pipeline()` (e.g. node-redis).
 */
function makeFake(opts: {
  strategyLoaded: boolean;
  floorLoaded: boolean;
  withPipeline: boolean;
}): Fake {
  let strategyLoaded = opts.strategyLoaded;
  let floorLoaded = opts.floorLoaded;
  let consumed = 0;
  let pttl = -2;
  let pipelineExecs = 0;
  let evalCalls = 0;

  const noScript = (): never => {
    throw new Error("NOSCRIPT No matching script. Please use EVAL.");
  };
  // Run a script by sha; throws NOSCRIPT when that script is not loaded (real EVALSHA semantics).
  const runSha = (sha: string, floorMs: number): unknown => {
    if (sha === FLOOR_SHA) {
      if (!floorLoaded) return noScript();
      if (pttl < floorMs) pttl = floorMs;
      return 1;
    }
    if (!strategyLoaded) return noScript();
    consumed++;
    pttl = NATIVE_PX;
    return CANNED;
  };
  // EVAL always runs and loads the script into the cache.
  const runScript = (script: string, floorMs: number): unknown => {
    evalCalls++;
    if (script === TTL_FLOOR_LUA) {
      floorLoaded = true;
      if (pttl < floorMs) pttl = floorMs;
      return 1;
    }
    strategyLoaded = true;
    consumed++;
    pttl = NATIVE_PX;
    return CANNED;
  };
  const floorArg = (sha: string, rest: Array<string | number>): number =>
    sha === FLOOR_SHA ? Number(rest[rest.length - 1]) : 0;

  const client: RedisClientLike = {
    async evalsha(sha, _numkeys, ...rest) {
      return runSha(sha, floorArg(sha, rest));
    },
    async eval(script, _numkeys, ...rest) {
      return runScript(script, sha1(script) === FLOOR_SHA ? Number(rest[rest.length - 1]) : 0);
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

  if (opts.withPipeline) {
    (client as { pipeline?: () => unknown }).pipeline = () => {
      const ops: Array<{ sha: string; rest: Array<string | number> }> = [];
      const p = {
        evalsha(sha: string, _numkeys: number, ...rest: Array<string | number>) {
          ops.push({ sha, rest });
          return p;
        },
        async exec() {
          pipelineExecs++;
          return ops.map(({ sha, rest }) => {
            try {
              return [null, runSha(sha, floorArg(sha, rest))] as [Error | null, unknown];
            } catch (e) {
              return [e as Error, null] as [Error | null, unknown];
            }
          });
        },
      };
      return p;
    };
  }

  return {
    client,
    consumed: () => consumed,
    pttl: () => pttl,
    pipelineExecs: () => pipelineExecs,
    evalCalls: () => evalCalls,
  };
}

function consumingCheck(fake: Fake) {
  return rateLimit({
    strategy: fixedWindow({ limit: 100, windowMs: 1000 }),
    store: new RedisStore({
      client: fake.client,
      ttlFloorMs: 30_000,
      useServerTime: false,
      prefix: "fp",
    }),
    clock: new ManualClock(1_000_000),
  });
}

describe("RedisStore ttlFloorMs pipeline path (#3, offline)", () => {
  it("happy path: coalesces strategy + floor into ONE pipelined round trip, consuming once", async () => {
    const fake = makeFake({ strategyLoaded: true, floorLoaded: true, withPipeline: true });
    await consumingCheck(fake).check("k");
    expect(fake.consumed()).toBe(1); // the strategy ran exactly once
    expect(fake.pttl()).toBe(30_000); // the floor was applied (raised above the native 600ms PX)
    expect(fake.pipelineExecs()).toBe(1); // a single pipeline carried both commands...
    expect(fake.evalCalls()).toBe(0); // ...and no sequential EVAL fallback was needed
  });

  it("strategy NOSCRIPT: falls back to the sequential path WITHOUT double-consuming", async () => {
    // The strategy script is not cached, so its pipelined EVALSHA errors (it never ran). The store must
    // re-run it via the sequential #eval (one consume), not assume the pipeline consumed it.
    const fake = makeFake({ strategyLoaded: false, floorLoaded: true, withPipeline: true });
    await consumingCheck(fake).check("k");
    expect(fake.consumed()).toBe(1); // exactly once, despite the pipeline EVALSHA attempt
    expect(fake.pttl()).toBe(30_000); // floor still applied
  });

  it("floor NOSCRIPT: keeps the strategy's single result and re-applies only the (idempotent) floor", async () => {
    // The strategy ran in the pipeline (one consume); only the floor EVALSHA NOSCRIPT'd, so the store
    // re-applies the floor alone — it must NOT re-run the strategy.
    const fake = makeFake({ strategyLoaded: true, floorLoaded: false, withPipeline: true });
    await consumingCheck(fake).check("k");
    expect(fake.consumed()).toBe(1); // strategy not re-run when only the floor needed re-applying
    expect(fake.pttl()).toBe(30_000); // floor re-applied via the sequential fallback
  });

  it("client without pipeline(): still applies the floor sequentially, consuming once", async () => {
    const fake = makeFake({ strategyLoaded: true, floorLoaded: true, withPipeline: false });
    await consumingCheck(fake).check("k");
    expect(fake.consumed()).toBe(1);
    expect(fake.pttl()).toBe(30_000); // floor applied via the two-round-trip path (node-redis-style client)
    expect(fake.pipelineExecs()).toBe(0); // no pipeline was used
  });
});
