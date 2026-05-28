/**
 * `RedisRegionalEscrow` — the production-ready {@link RegionalEscrow} (the
 * federation L2 between the engine's in-process L1 cache and the global L3
 * coordinator). Backed by a regional Redis instance; same atomic-Lua pattern
 * as {@link RedisCoordinator}, mirrored one layer down.
 *
 * Layout — one HASH per (region, federation-key):
 *
 *     balance         : remaining L2 escrow for the active window
 *     expires_at      : when the active window ends (epoch-ms)
 *     source_lease    : the L3 coordinator's windowStart this balance is from
 *
 * The HASH has PEXPIRE set to the window boundary, so a window roll auto-
 * drops the prior window's state with no extra bookkeeping.
 *
 * Three EVALSHA scripts (one trip each, with EVAL fallback on NOSCRIPT):
 * - REGIONAL_LEASE — consume from balance; returns granted (0..tokens)
 * - REGIONAL_REFILL — add to balance from an L3 grant; idempotent on
 *   sourceWindowStart (drops stale-window grants)
 * - REGIONAL_RELEASE — capture and zero the balance at window roll; only
 *   the first caller per (key, sourceWindowStart) sees the non-zero value
 *
 * `useServerTime: true` (the default) makes scripts read Redis's `TIME` so
 * node-clock skew never shortens a lease's lifetime below the formal window
 * boundary (same rationale as RedisCoordinator).
 */

import { createHash } from "node:crypto";
import { StoreUnavailableError } from "../core/errors";
import { LUA_NOW } from "../core/lua";
import type { RedisClientLike } from "../redis/store";
import type { RegionalEscrow } from "./types";

/** Default Redis key prefix — distinct from RedisCoordinator's so L2 and L3 can share a Redis without collision. */
const DEFAULT_PREFIX = "tk:l2";

export interface RedisRegionalEscrowOptions {
  /** An `ioredis` (or compatible) client. Use the adapters in `throttlekit/redis` for other clients. */
  client: RedisClientLike;
  /**
   * Window length in ms — MUST match the strategy's `windowMs` you federate.
   * Used by the Lua scripts to derive the active window's `expiresAt` from
   * `now` (`floor(now/windowMs)·windowMs + windowMs`), so window-coupling
   * works regardless of when the HASH was last touched.
   */
  windowMs: number;
  /**
   * Region identity — distinguishes L2 escrows when two regions point at the
   * same regional Redis (rare but possible). Embedded in the HASH key as
   * `<prefix>:<region>:<key>`. Should equal the `region` passed to
   * `federate(...)`.
   */
  region: string;
  /** Redis key prefix. Default `"tk:l2"`. */
  prefix?: string;
  /**
   * Use the Redis server clock (TIME) for the `now` used in PEXPIRE math.
   * Default true — protects against node clock skew shortening leases.
   * Set false in deterministic tests that pass an explicit `now`.
   */
  useServerTime?: boolean;
}

/**
 * Atomic LEASE script. Consumes from L2 balance for the active window.
 *
 *   KEYS[1] = regional escrow HASH key
 *   ARGV[1] = now (0 = use server TIME)
 *   ARGV[2] = tokens requested
 *
 * Returns: granted (0..tokens). 0 if no entry, window expired, or balance empty.
 */
const REGIONAL_LEASE_LUA = `${LUA_NOW}
local tokens = tonumber(ARGV[2])

local h = redis.call('HMGET', KEYS[1], 'balance', 'expires_at')
local balance = tonumber(h[1])
local expiresAt = tonumber(h[2])

if balance == nil or expiresAt == nil or now >= expiresAt then
  return 0
end

local granted = tokens
if granted > balance then granted = balance end
if granted <= 0 then return 0 end

balance = balance - granted
redis.call('HSET', KEYS[1], 'balance', balance)
local pexp = expiresAt - now
if pexp < 1 then pexp = 1 end
redis.call('PEXPIRE', KEYS[1], pexp)

return granted`;

/**
 * Atomic REFILL script. Adds an L3 grant to L2's balance; idempotent on
 * sourceWindowStart (stale grants are dropped).
 *
 *   KEYS[1] = regional escrow HASH key
 *   ARGV[1] = now (0 = server TIME)
 *   ARGV[2] = granted (from coordinator.lease)
 *   ARGV[3] = sourceWindowStart (the coordinator's window the grant is for)
 *   ARGV[4] = windowMs
 *
 * Returns: 1 if refilled, 0 if the grant is for a stale window (dropped).
 *
 * Additive semantics: if the L2 already has `source_lease == sourceWindowStart`,
 * the granted amount is ADDED to the existing balance (so multiple processes'
 * coord-grants accumulate in the shared L2). If the L2 is stale or empty,
 * the entry is initialized fresh with `balance = granted`.
 */
const REGIONAL_REFILL_LUA = `${LUA_NOW}
local granted = tonumber(ARGV[2])
local sourceWindowStart = tonumber(ARGV[3])
local windowMs = tonumber(ARGV[4])

local expiresAt = sourceWindowStart + windowMs

-- Window-coupled: drop refills for already-expired windows.
if now >= expiresAt then
  return 0
end

local h = redis.call('HMGET', KEYS[1], 'balance', 'source_lease')
local balance = tonumber(h[1])
local oldSourceLease = tonumber(h[2])

if balance == nil or oldSourceLease ~= sourceWindowStart then
  -- Fresh or stale entry. Initialize.
  redis.call('DEL', KEYS[1])
  balance = granted
else
  -- Same window: accumulate.
  balance = balance + granted
end

redis.call('HSET', KEYS[1], 'balance', balance, 'expires_at', expiresAt, 'source_lease', sourceWindowStart)
local pexp = expiresAt - now
if pexp < 1 then pexp = 1 end
redis.call('PEXPIRE', KEYS[1], pexp)

return 1`;

/**
 * Atomic RELEASE script. Captures the L2 balance at window roll and zeroes
 * the entry so subsequent callers for the same windowStart see 0 (idempotency
 * at the regional layer).
 *
 *   KEYS[1] = regional escrow HASH key
 *   ARGV[1] = now (0 = server TIME)
 *   ARGV[2] = sourceWindowStart (the window being closed)
 *
 * Returns: balance captured (0 if window mismatch, expired, or already released).
 */
const REGIONAL_RELEASE_LUA = `${LUA_NOW}
local sourceWindowStart = tonumber(ARGV[2])

local h = redis.call('HMGET', KEYS[1], 'balance', 'source_lease')
local balance = tonumber(h[1])
local sourceLease = tonumber(h[2])

if balance == nil or sourceLease == nil or sourceLease ~= sourceWindowStart then
  return 0
end

-- Capture, then atomically remove so subsequent callers get 0.
redis.call('DEL', KEYS[1])

return balance`;

function isNoScript(err: unknown): boolean {
  return err instanceof Error && /NOSCRIPT/.test(err.message);
}

export class RedisRegionalEscrow implements RegionalEscrow {
  readonly #client: RedisClientLike;
  readonly #windowMs: number;
  readonly #region: string;
  readonly #prefix: string;
  readonly #useServerTime: boolean;
  readonly #shaCache = new Map<string, string>();

  constructor(options: RedisRegionalEscrowOptions) {
    if (!Number.isFinite(options.windowMs) || options.windowMs < 1) {
      throw new RangeError(
        `windowMs must be a finite number >= 1, got ${String(options.windowMs)}`,
      );
    }
    if (typeof options.region !== "string" || options.region.length === 0) {
      throw new RangeError(`region must be a non-empty string, got ${String(options.region)}`);
    }
    this.#client = options.client;
    this.#windowMs = options.windowMs;
    this.#region = options.region;
    this.#prefix = options.prefix ?? DEFAULT_PREFIX;
    this.#useServerTime = options.useServerTime ?? true;
  }

  async lease(key: string, tokens: number): Promise<number> {
    if (!Number.isFinite(tokens) || tokens < 0) {
      throw new RangeError(
        `lease tokens must be a non-negative finite number, got ${String(tokens)}`,
      );
    }
    if (tokens === 0) return 0;

    const redisKey = this.#redisKey(key);
    const nowArg = this.#useServerTime ? 0 : Date.now();
    try {
      const raw = await this.#eval(REGIONAL_LEASE_LUA, [redisKey], [nowArg, tokens]);
      return Number(raw);
    } catch (err) {
      throw new StoreUnavailableError(
        `RedisRegionalEscrow.lease failed for key "${key}": ${(err as Error).message}`,
        { cause: err },
      );
    }
  }

  async refill(key: string, granted: number, sourceWindowStart: number): Promise<boolean> {
    if (!Number.isFinite(granted) || granted < 0) {
      throw new RangeError(
        `refill granted must be a non-negative finite number, got ${String(granted)}`,
      );
    }
    if (!Number.isFinite(sourceWindowStart) || sourceWindowStart < 0) {
      throw new RangeError(
        `refill sourceWindowStart must be a non-negative finite number, got ${String(sourceWindowStart)}`,
      );
    }
    if (granted === 0) return true; // no-op, but a successful one (caller's grant was 0)

    const redisKey = this.#redisKey(key);
    const nowArg = this.#useServerTime ? 0 : Date.now();
    try {
      const raw = await this.#eval(
        REGIONAL_REFILL_LUA,
        [redisKey],
        [nowArg, granted, sourceWindowStart, this.#windowMs],
      );
      return Number(raw) === 1;
    } catch (err) {
      throw new StoreUnavailableError(
        `RedisRegionalEscrow.refill failed for key "${key}": ${(err as Error).message}`,
        { cause: err },
      );
    }
  }

  async release(key: string, sourceWindowStart: number): Promise<number> {
    if (!Number.isFinite(sourceWindowStart) || sourceWindowStart < 0) {
      throw new RangeError(
        `release sourceWindowStart must be a non-negative finite number, got ${String(sourceWindowStart)}`,
      );
    }

    const redisKey = this.#redisKey(key);
    const nowArg = this.#useServerTime ? 0 : Date.now();
    try {
      const raw = await this.#eval(REGIONAL_RELEASE_LUA, [redisKey], [nowArg, sourceWindowStart]);
      return Number(raw);
    } catch (err) {
      throw new StoreUnavailableError(
        `RedisRegionalEscrow.release failed for key "${key}": ${(err as Error).message}`,
        { cause: err },
      );
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      await this.#client.get(`${this.#prefix}:${this.#region}:__health__`);
      return true;
    } catch {
      return false;
    }
  }

  // ---- internals ----

  /** Build the Redis HASH key for `key`. Includes region for cross-region-sharing-the-same-Redis safety. */
  #redisKey(key: string): string {
    return `${this.#prefix}:${this.#region}:${key}`;
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
        return await this.#client.eval(script, keys.length, ...keys, ...argv);
      }
      throw err;
    }
  }
}
