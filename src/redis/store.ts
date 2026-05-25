import { createHash } from "node:crypto";
import { StoreUnavailableError } from "../core/errors";
import type { Store, Transform } from "../core/types";

/**
 * The minimal surface ThrottleKit needs from a Redis client. `ioredis` satisfies this
 * structurally; any compatible client (same method shapes) works too.
 */
export interface RedisClientLike {
  evalsha(sha: string, numkeys: number, ...args: Array<string | number>): Promise<unknown>;
  eval(script: string, numkeys: number, ...args: Array<string | number>): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  watch(...keys: string[]): Promise<unknown>;
  unwatch(): Promise<unknown>;
  multi(): RedisMultiLike;
}

/** The subset of a Redis transaction (`MULTI`) used by the optimistic-concurrency fallback. */
export interface RedisMultiLike {
  set(key: string, value: string, mode: "PX", ttlMs: number): RedisMultiLike;
  exec(): Promise<Array<[Error | null, unknown]> | null>;
}

export interface RedisStoreOptions {
  /** An `ioredis` (or compatible) client. */
  client: RedisClientLike;
  /** Storage key namespace. */
  prefix?: string;
  /** Use the atomic Lua path for strategies that ship one. Default true. */
  useLua?: boolean;
  /**
   * Derive `now` from the Redis server clock (`TIME`) inside the script, so node clock skew can't
   * corrupt shared state. Default true. Set false for deterministic tests that pass an explicit
   * `now`. (Affects only the absolute `resetAt`; the duration fields stay skew-free either way.)
   */
  useServerTime?: boolean;
  /** Bounded retries for the optimistic-concurrency fallback (custom strategies). Default 5. */
  maxRetries?: number;
}

function isNoScript(err: unknown): boolean {
  return err instanceof Error && /NOSCRIPT/.test(err.message);
}

/**
 * Distributed store backed by Redis. Built-in strategies run their atomic Lua form in a single
 * `EVALSHA` round trip (with an `EVAL` fallback on `NOSCRIPT`); strategies without a Lua form fall
 * back to optimistic concurrency (`WATCH`/`MULTI`/`EXEC`) with bounded retries — correct
 * everywhere, just not single-round-trip.
 */
export class RedisStore implements Store {
  readonly #client: RedisClientLike;
  readonly #prefix: string;
  readonly #useLua: boolean;
  readonly #useServerTime: boolean;
  readonly #maxRetries: number;
  readonly #shaCache = new Map<string, string>();

  constructor(options: RedisStoreOptions) {
    this.#client = options.client;
    this.#prefix = options.prefix ?? "";
    this.#useLua = options.useLua ?? true;
    this.#useServerTime = options.useServerTime ?? true;
    this.#maxRetries = options.maxRetries ?? 5;
  }

  #key(key: string): string {
    return this.#prefix.length > 0 ? `${this.#prefix}:${key}` : key;
  }

  #sha(script: string): string {
    let sha = this.#shaCache.get(script);
    if (sha === undefined) {
      sha = createHash("sha1").update(script).digest("hex");
      this.#shaCache.set(script, sha);
    }
    return sha;
  }

  async #eval(script: string, keys: string[], argv: Array<string | number>): Promise<unknown> {
    const sha = this.#sha(script);
    try {
      return await this.#client.evalsha(sha, keys.length, ...keys, ...argv);
    } catch (err) {
      if (isNoScript(err)) {
        // Script cache was flushed (restart/failover). EVAL re-caches it for next time.
        return await this.#client.eval(script, keys.length, ...keys, ...argv);
      }
      throw err;
    }
  }

  async apply<S, R>(key: string, transform: Transform<S, R>): Promise<R> {
    const baseKey = this.#key(key);
    const lua = transform.lua;
    if (lua !== undefined && this.#useLua) {
      const keys = lua.program.buildKeys(baseKey);
      const nowArg = this.#useServerTime ? 0 : lua.now;
      const argv = lua.program.buildArgv(nowArg, lua.cost);
      const raw = await this.#eval(lua.program.script, keys, argv);
      return lua.decode(raw);
    }
    return this.#applyOcc(baseKey, transform);
  }

  /** Optimistic-concurrency fallback for strategies without a Lua form. State is JSON-encoded. */
  async #applyOcc<S, R>(key: string, transform: Transform<S, R>): Promise<R> {
    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      await this.#client.watch(key);
      const raw = await this.#client.get(key);
      const state = raw !== null ? (JSON.parse(raw) as S) : undefined;
      const out = transform(state);

      if (!out.persist) {
        await this.#client.unwatch();
        return out.result;
      }

      const ttl = Math.max(1, Math.ceil(out.ttlMs));
      const res = await this.#client.multi().set(key, JSON.stringify(out.state), "PX", ttl).exec();
      // `exec` returns null when a watched key changed under us — retry.
      if (res !== null) return out.result;
    }
    throw new StoreUnavailableError(
      `optimistic concurrency exhausted ${this.#maxRetries} retries for key`,
    );
  }

  async reset(key: string): Promise<void> {
    await this.#client.del(this.#key(key));
  }
}
