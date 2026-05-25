import { StoreUnavailableError } from "../core/errors";
import type { RedisClientLike, RedisMultiLike } from "./store";

/**
 * Client adapters.
 *
 * {@link RedisStore} speaks one shape internally — the `ioredis` shape captured by
 * {@link RedisClientLike}: `evalsha(sha, numkeys, ...keys, ...args)`. The two other clients people
 * actually deploy don't match it:
 *
 * - **`@upstash/redis`** (the REST client for serverless/edge — Vercel, Cloudflare, Deno, Bun):
 *   `evalsha(sha, keys[], args[])` — arrays, no `numkeys`. No interactive `WATCH`/`MULTI` over REST.
 * - **`redis`** (node-redis, the official client): `evalSha(sha, { keys, arguments })` — camelCase,
 *   options object.
 *
 * These factories translate each foreign client *into* the `ioredis` shape, so `RedisStore` itself
 * stays unchanged and every built-in strategy's atomic Lua works identically across all three
 * clients. Pass the result as the store's `client`:
 *
 * ```ts
 * new RedisStore({ client: fromUpstash(upstash) })   // serverless / edge
 * new RedisStore({ client: fromNodeRedis(node) })    // node-redis
 * new RedisStore({ client: ioredis })                // ioredis works directly
 * ```
 */

/** Split the `ioredis`-flattened `(...keys, ...args)` tail back into arrays of strings. */
function splitKeysArgs(
  numkeys: number,
  rest: Array<string | number>,
): { keys: string[]; args: string[] } {
  // `.map(String)` is load-bearing: node-redis `arguments` and the Upstash REST body require
  // strings, and every built-in strategy's ARGV is integer-valued, so this round-trips exactly.
  return {
    keys: rest.slice(0, numkeys).map(String),
    args: rest.slice(numkeys).map(String),
  };
}

/** The slice of `@upstash/redis` ThrottleKit uses. `Redis` from `@upstash/redis` satisfies it. */
export interface UpstashRedisLike {
  evalsha(sha: string, keys: string[], args: unknown[]): Promise<unknown>;
  eval(script: string, keys: string[], args: unknown[]): Promise<unknown>;
  get<TData = string>(key: string): Promise<TData | null>;
  del(...keys: string[]): Promise<number>;
}

/**
 * Adapt an `@upstash/redis` REST client. Built-in strategies (all Lua-backed) work fully. Custom
 * strategies that need optimistic concurrency can't run on the REST API — there is no interactive
 * `WATCH`/`MULTI` — so those methods throw a clear error rather than corrupt state silently.
 */
export function fromUpstash(client: UpstashRedisLike): RedisClientLike {
  const noOcc = (): never => {
    throw new StoreUnavailableError(
      "the Upstash REST client supports only Lua-backed (built-in) strategies; custom strategies " +
        "needing optimistic concurrency (WATCH/MULTI) require ioredis or node-redis",
    );
  };
  return {
    evalsha(sha, numkeys, ...rest) {
      const { keys, args } = splitKeysArgs(numkeys, rest);
      return client.evalsha(sha, keys, args);
    },
    eval(script, numkeys, ...rest) {
      const { keys, args } = splitKeysArgs(numkeys, rest);
      return client.eval(script, keys, args);
    },
    get(key) {
      return client.get<string>(key);
    },
    del(...keys) {
      return client.del(...keys);
    },
    watch: noOcc,
    unwatch: noOcc,
    multi: noOcc,
  };
}

/** The subset of a node-redis `MULTI` chain ThrottleKit uses. */
export interface NodeRedisMultiLike {
  set(key: string, value: string, options: { PX: number }): NodeRedisMultiLike;
  exec(): Promise<unknown[]>;
}

/** The slice of node-redis (`redis`) ThrottleKit uses. A `RedisClientType` satisfies it. */
export interface NodeRedisLike {
  evalSha(sha: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(keys: string | string[]): Promise<number>;
  watch(keys: string | string[]): Promise<string>;
  unwatch(): Promise<string>;
  multi(): NodeRedisMultiLike;
}

function isWatchError(err: unknown): boolean {
  // node-redis rejects `MULTI.exec()` with a `WatchError` when a watched key changed under us.
  return err instanceof Error && err.name === "WatchError";
}

/** Adapt the official node-redis (`redis`) client. Both the Lua and OCC paths work. */
export function fromNodeRedis(client: NodeRedisLike): RedisClientLike {
  return {
    evalsha(sha, numkeys, ...rest) {
      const { keys, args } = splitKeysArgs(numkeys, rest);
      return client.evalSha(sha, { keys, arguments: args });
    },
    eval(script, numkeys, ...rest) {
      const { keys, args } = splitKeysArgs(numkeys, rest);
      return client.eval(script, { keys, arguments: args });
    },
    get(key) {
      return client.get(key);
    },
    del(...keys) {
      return client.del(keys);
    },
    watch(...keys) {
      return client.watch(keys);
    },
    unwatch() {
      return client.unwatch();
    },
    multi() {
      const m = client.multi();
      const wrapped: RedisMultiLike = {
        set(key, value, _mode, ttlMs) {
          m.set(key, value, { PX: ttlMs });
          return wrapped;
        },
        async exec() {
          try {
            const res = await m.exec();
            // Normalize to ioredis' [err, reply] tuples. RedisStore only checks for `null`
            // (the conflict signal), so a non-null array means the transaction committed.
            return res.map((reply) => [null, reply] as [Error | null, unknown]);
          } catch (err) {
            if (isWatchError(err)) return null; // watched key changed → RedisStore retries
            throw err;
          }
        },
      };
      return wrapped;
    },
  };
}

/**
 * Identity adapter for `ioredis`. `ioredis` already matches {@link RedisClientLike}, so this is
 * only here so all three clients read uniformly in docs/examples; you can also pass `ioredis`
 * straight to `new RedisStore({ client })`.
 */
export function fromIoredis(client: RedisClientLike): RedisClientLike {
  return client;
}
