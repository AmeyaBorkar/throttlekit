import { describe, expect, it } from "vitest";
import { StoreUnavailableError } from "../../src/core/errors";
import {
  type NodeRedisLike,
  type NodeRedisMultiLike,
  type UpstashRedisLike,
  fromIoredis,
  fromNodeRedis,
  fromUpstash,
} from "../../src/redis/clients";

/**
 * The adapters translate the foreign client shapes into the `ioredis` shape `RedisStore` speaks.
 * These tests pin the exact translated call shapes — keys/args splitting, numeric stringification,
 * options-object construction, and the conflict (`WATCH`) signalling — without any live service.
 * End-to-end correctness against a real server is covered by the gated conformance test, which runs
 * the *identical* Lua script the store ships regardless of which client carries it.
 */

interface Call {
  method: string;
  args: unknown[];
}

function makeUpstashFake(): { client: UpstashRedisLike; calls: Call[] } {
  const calls: Call[] = [];
  const client: UpstashRedisLike = {
    evalsha(sha, keys, args) {
      calls.push({ method: "evalsha", args: [sha, keys, args] });
      return Promise.resolve([1, 100, 99, 1_700_000_000_000, 0]);
    },
    eval(script, keys, args) {
      calls.push({ method: "eval", args: [script, keys, args] });
      return Promise.resolve([1, 100, 99, 1_700_000_000_000, 0]);
    },
    get<TData = string>(key: string) {
      calls.push({ method: "get", args: [key] });
      return Promise.resolve(null as TData | null);
    },
    del(...keys) {
      calls.push({ method: "del", args: keys });
      return Promise.resolve(keys.length);
    },
  };
  return { client, calls };
}

function makeNodeFake(execImpl?: () => Promise<unknown[]>): {
  client: NodeRedisLike;
  calls: Call[];
  multiSets: Array<{ key: string; value: string; options: { PX: number } }>;
} {
  const calls: Call[] = [];
  const multiSets: Array<{ key: string; value: string; options: { PX: number } }> = [];
  const client: NodeRedisLike = {
    evalSha(sha, options) {
      calls.push({ method: "evalSha", args: [sha, options] });
      return Promise.resolve([1, 100, 99, 1_700_000_000_000, 0]);
    },
    eval(script, options) {
      calls.push({ method: "eval", args: [script, options] });
      return Promise.resolve([1, 100, 99, 1_700_000_000_000, 0]);
    },
    get(key) {
      calls.push({ method: "get", args: [key] });
      return Promise.resolve(null);
    },
    del(keys) {
      calls.push({ method: "del", args: [keys] });
      return Promise.resolve(Array.isArray(keys) ? keys.length : 1);
    },
    watch(keys) {
      calls.push({ method: "watch", args: [keys] });
      return Promise.resolve("OK");
    },
    unwatch() {
      calls.push({ method: "unwatch", args: [] });
      return Promise.resolve("OK");
    },
    multi() {
      const chain: NodeRedisMultiLike = {
        set(key, value, options) {
          multiSets.push({ key, value, options });
          return chain;
        },
        exec: execImpl ?? (() => Promise.resolve(["OK"])),
      };
      return chain;
    },
  };
  return { client, calls, multiSets };
}

class WatchError extends Error {
  constructor() {
    super("One (or more) of the watched keys has been changed");
    this.name = "WatchError";
  }
}

describe("fromUpstash", () => {
  it("splits the flattened (numkeys, ...keys, ...args) tail into arrays and stringifies args", async () => {
    const { client, calls } = makeUpstashFake();
    const a = fromUpstash(client);

    await a.evalsha("sha1", 1, "user:42", 1_700_000_000_000, 3);

    expect(calls[0]).toEqual({
      method: "evalsha",
      args: ["sha1", ["user:42"], ["1700000000000", "3"]],
    });
  });

  it("translates eval the same way", async () => {
    const { client, calls } = makeUpstashFake();
    await fromUpstash(client).eval("return 1", 2, "k1", "k2", 7);
    expect(calls[0]).toEqual({ method: "eval", args: ["return 1", ["k1", "k2"], ["7"]] });
  });

  it("passes del through variadically", async () => {
    const { client, calls } = makeUpstashFake();
    const n = await fromUpstash(client).del("a", "b", "c");
    expect(n).toBe(3);
    expect(calls[0]).toEqual({ method: "del", args: ["a", "b", "c"] });
  });

  it("rejects optimistic-concurrency methods with a clear error (REST has no WATCH/MULTI)", () => {
    const a = fromUpstash(makeUpstashFake().client);
    expect(() => a.watch("k")).toThrow(StoreUnavailableError);
    expect(() => a.unwatch()).toThrow(StoreUnavailableError);
    expect(() => a.multi()).toThrow(StoreUnavailableError);
    expect(() => a.watch("k")).toThrow(/only Lua-backed/);
  });
});

describe("fromNodeRedis", () => {
  it("builds the { keys, arguments } options object and stringifies args", async () => {
    const { client, calls } = makeNodeFake();
    await fromNodeRedis(client).evalsha("sha1", 2, "k1", "k2", 1_700_000_000_000, 3);
    expect(calls[0]).toEqual({
      method: "evalSha",
      args: ["sha1", { keys: ["k1", "k2"], arguments: ["1700000000000", "3"] }],
    });
  });

  it("translates eval the same way", async () => {
    const { client, calls } = makeNodeFake();
    await fromNodeRedis(client).eval("return 1", 1, "k1", 7);
    expect(calls[0]).toEqual({
      method: "eval",
      args: ["return 1", { keys: ["k1"], arguments: ["7"] }],
    });
  });

  it("passes watched keys and del as arrays", async () => {
    const { client, calls } = makeNodeFake();
    const a = fromNodeRedis(client);
    await a.watch("k1", "k2");
    await a.del("k1", "k2");
    expect(calls[0]).toEqual({ method: "watch", args: [["k1", "k2"]] });
    expect(calls[1]).toEqual({ method: "del", args: [["k1", "k2"]] });
  });

  it("translates MULTI.set to the { PX } options form and returns a non-null array on commit", async () => {
    const { client, multiSets } = makeNodeFake();
    const m = fromNodeRedis(client).multi();
    m.set("k", "state", "PX", 500);
    const res = await m.exec();
    expect(multiSets[0]).toEqual({ key: "k", value: "state", options: { PX: 500 } });
    expect(res).not.toBeNull();
  });

  it("maps a WatchError on exec to null so RedisStore retries", async () => {
    const { client } = makeNodeFake(() => Promise.reject(new WatchError()));
    const res = await fromNodeRedis(client).multi().set("k", "v", "PX", 1).exec();
    expect(res).toBeNull();
  });

  it("re-throws non-WatchError exec failures", async () => {
    const { client } = makeNodeFake(() => Promise.reject(new Error("connection lost")));
    await expect(fromNodeRedis(client).multi().set("k", "v", "PX", 1).exec()).rejects.toThrow(
      /connection lost/,
    );
  });
});

describe("fromIoredis", () => {
  it("is an identity adapter (ioredis already matches the internal shape)", () => {
    const client = makeUpstashFake().client as unknown as Parameters<typeof fromIoredis>[0];
    expect(fromIoredis(client)).toBe(client);
  });
});
