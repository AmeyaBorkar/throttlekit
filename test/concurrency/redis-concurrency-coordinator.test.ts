/**
 * Store-less unit checks for `RedisConcurrencyCoordinator`'s wire contract — they run in the default
 * CI gate (no live Redis). The end-to-end heartbeat-aggregate-split semantics are exercised against a
 * real server by the gated dual-path conformance suite (`coordinator-conformance.test.ts`).
 *
 * The eviction `now` regression: the coordinator used to pass the calling node's `Date.now()` as the
 * Lua's `now`, so it compared each peer's `expiresAt` (stamped on THAT peer's clock) against the
 * caller's clock — a node whose clock ran ahead prematurely evicted a healthy peer and reclaimed its
 * budget, breaking `Σ inflight ≤ L_global`. The fix anchors `now` to the Redis server clock by
 * default (the `0` sentinel), like `PostgresConcurrencyCoordinator` and `RedisStore`. Here we pin
 * exactly that wire decision; the conformance suite proves the resulting eviction behavior on Redis.
 */

import { describe, expect, it } from "vitest";
import { RedisConcurrencyCoordinator } from "../../src/concurrency/redis-concurrency-coordinator";
import type { RedisClientLike } from "../../src/redis/store";

/** A fake client that records the ARGV of the last EVALSHA/EVAL (the KEYS are stripped). */
function argvRecorder(): { client: RedisClientLike; lastArgv: () => Array<string | number> } {
  let argv: Array<string | number> = [];
  const run = (numkeys: number, args: Array<string | number>): Promise<unknown> => {
    argv = args.slice(numkeys);
    return Promise.resolve([5, 10, 1, 0]); // {share, lGlobal, nodes, gen}
  };
  const client = {
    evalsha: (_sha: string, n: number, ...a: Array<string | number>) => run(n, a),
    eval: (_s: string, n: number, ...a: Array<string | number>) => run(n, a),
    get: async () => null,
    del: async () => 0,
    watch: async () => "OK",
    unwatch: async () => "OK",
    multi: () => {
      throw new Error("unused");
    },
  } as unknown as RedisClientLike;
  return { client, lastArgv: () => argv };
}

const REPORT = { key: "k", nodeId: "A", lLocal: 10, inflight: 1, expiresAt: 999_999_999_999 };
const NOW_SLOT = 4; // ARGV[5] (0-based after the KEYS are stripped)

describe("RedisConcurrencyCoordinator — eviction now-anchor (regression)", () => {
  it("defers `now` to the Redis server clock by default (the 0 sentinel)", async () => {
    const { client, lastArgv } = argvRecorder();
    await new RedisConcurrencyCoordinator({ client }).heartbeat(REPORT);
    // Was the calling node's Date.now() before the fix — a peer clock could over-evict a live node.
    expect(lastArgv()[NOW_SLOT]).toBe(0);
  });

  it("falls back to the node wall clock only when useServerTime is explicitly false", async () => {
    const { client, lastArgv } = argvRecorder();
    const before = Date.now();
    await new RedisConcurrencyCoordinator({ client, useServerTime: false }).heartbeat(REPORT);
    const after = Date.now();
    const now = Number(lastArgv()[NOW_SLOT]);
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });
});
