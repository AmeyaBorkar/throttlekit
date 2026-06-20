import { createHash } from "node:crypto";
import { StoreUnavailableError } from "../core/errors";
import { prefixer } from "../core/key";
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
  /**
   * Open a dedicated, isolated connection for one optimistic-concurrency transaction. `WATCH` is
   * *connection-global* and `EXEC`/`UNWATCH` clear the whole watch set, so concurrent OCC applies that
   * share one connection cross-contaminate (a lost update, or a spurious abort). The fix runs each
   * `WATCH`/`MULTI`/`EXEC` on its own connection, released via {@link RedisClientLike.disconnect}.
   * Optional: when absent, OCC falls back to the shared connection (correct for serialized use, not
   * for concurrent applies on the same store — e.g. `checkMany`).
   */
  duplicate?(): RedisClientLike;
  /** Release a connection opened by {@link RedisClientLike.duplicate}. Optional. */
  disconnect?(): void | Promise<void>;
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
  /**
   * Floor (ms) on the **physical** key TTL, decoupling Redis GC from the strategy's logical window.
   * Default 0 (the strategy's own TTL is used verbatim — no extra work).
   *
   * A strategy sets the physical `PEXPIRE` to its logical window (e.g. a sliding window's `windowMs`),
   * which is a *real-time* duration. That is correct under the default `useServerTime: true` (logical
   * time == the Redis clock that runs the PEXPIRE). But with `useServerTime: false` the logical clock is
   * a node-supplied `now` decoupled from Redis real time, so a slow real interval between two same-window
   * writes can let the physical key expire while the logical clock is still inside the window — Redis then
   * reads a cold window and diverges from an in-memory store on the same logical clock. Set a floor well
   * above the window so a logically-live key is never reclaimed by real-time GC (lazy logical expiry —
   * the `start != window_start` reset — still drives every decision, so decisions are unchanged).
   */
  ttlFloorMs?: number;
}

function isNoScript(err: unknown): boolean {
  return err instanceof Error && /NOSCRIPT/.test(err.message);
}

/**
 * Raise each touched key's physical TTL to at least `ARGV[1]` ms — only ever EXTENDS (never shortens),
 * so it can't shorten a strategy's intended expiry. Used by the optional `ttlFloorMs` to keep a
 * logically-live key from being GC'd by real-time PEXPIRE under a decoupled (`useServerTime:false`) clock.
 */
const TTL_FLOOR_LUA =
  "local f = tonumber(ARGV[1]) for i=1,#KEYS do if redis.call('PTTL', KEYS[i]) < f then redis.call('PEXPIRE', KEYS[i], f) end end return 1";

/**
 * Distributed store backed by Redis. Built-in strategies run their atomic Lua form in a single
 * `EVALSHA` round trip (with an `EVAL` fallback on `NOSCRIPT`); strategies without a Lua form fall
 * back to optimistic concurrency (`WATCH`/`MULTI`/`EXEC`) with bounded retries — correct
 * everywhere, just not single-round-trip.
 */
export class RedisStore implements Store {
  readonly #client: RedisClientLike;
  readonly #prefixKey: (key: string) => string;
  readonly #useLua: boolean;
  readonly #useServerTime: boolean;
  readonly #maxRetries: number;
  readonly #ttlFloorMs: number;
  readonly #shaCache = new Map<string, string>();

  constructor(options: RedisStoreOptions) {
    this.#client = options.client;
    this.#prefixKey = prefixer(options.prefix);
    this.#useLua = options.useLua ?? true;
    this.#useServerTime = options.useServerTime ?? true;
    this.#maxRetries = options.maxRetries ?? 5;
    this.#ttlFloorMs = Math.max(0, Math.floor(options.ttlFloorMs ?? 0));
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
    const baseKey = this.#prefixKey(key);
    const lua = transform.lua;
    if (lua !== undefined && this.#useLua) {
      const keys = lua.program.buildKeys(baseKey);
      const nowArg = this.#useServerTime ? 0 : lua.now;
      const argv = lua.program.buildArgv(nowArg, lua.cost);
      const raw = await this.#eval(lua.program.script, keys, argv);
      // Optional: keep a logically-live key from real-time GC (see ttlFloorMs). Only extends the TTL,
      // so it never alters a decision; one extra round trip, taken only when the floor is configured.
      if (this.#ttlFloorMs > 0) await this.#eval(TTL_FLOOR_LUA, keys, [this.#ttlFloorMs]);
      return lua.decode(raw);
    }
    return this.#applyOcc(baseKey, transform);
  }

  /** Optimistic-concurrency fallback for strategies without a Lua form. State is JSON-encoded. */
  async #applyOcc<S, R>(key: string, transform: Transform<S, R>): Promise<R> {
    // WATCH is connection-global and EXEC/UNWATCH clear the whole watch set, so this whole sequence
    // must own its connection — otherwise a concurrent apply on the same store (checkMany) tears down
    // this transaction's watch (lost update) or is falsely aborted by it. Use a dedicated connection
    // when the client supports duplicate(); fall back to the shared one (legacy, serialized-only) when
    // it doesn't.
    const conn = this.#client.duplicate?.() ?? this.#client;
    try {
      for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
        await conn.watch(key);
        const raw = await conn.get(key);
        const state = raw !== null ? (JSON.parse(raw) as S) : undefined;
        const out = transform(state);

        if (!out.persist) {
          await conn.unwatch();
          return out.result;
        }

        const ttl = Math.max(1, Math.ceil(out.ttlMs), this.#ttlFloorMs);
        const res = await conn.multi().set(key, JSON.stringify(out.state), "PX", ttl).exec();
        // `exec` returns null when a watched key changed under us — retry.
        if (res !== null) return out.result;
      }
      throw new StoreUnavailableError(
        `optimistic concurrency exhausted ${this.#maxRetries} retries for key`,
      );
    } finally {
      if (conn !== this.#client) await conn.disconnect?.();
    }
  }

  async reset(key: string): Promise<void> {
    await this.#client.del(this.#prefixKey(key));
  }
}
