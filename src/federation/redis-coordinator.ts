/**
 * `RedisCoordinator` — the production-ready `GlobalCoordinator`. Backed by
 * a single global Redis instance; **documented SPOF** until alternative
 * impls (`PostgresCoordinator`, Raft-via-etcd) land in 0.9.x.
 *
 * Layout — one HASH per coordinator key (`<prefix>:<key>`):
 *
 *     budget          : remaining global budget for the active window
 *     expiresAt       : when the active window ends (epoch-ms)
 *     rec_<windowStart>: idempotency markers for reconcile (per windowStart)
 *
 * The HASH has PEXPIRE set to the window boundary, so a window roll auto-
 * drops the prior window's state with no extra bookkeeping.
 *
 * Lease is one EVALSHA per cross-region trip. Reconcile is one EVALSHA;
 * idempotency is enforced inside the script via the `rec_<windowStart>`
 * field (so retries through a partition converge to the correct global
 * state — DESIGN.md §3.1 / §5.5).
 *
 * `useServerTime: true` (the default) makes the script read Redis's `TIME`
 * for the `now` value used in PEXPIRE math, so node-clock skew can never
 * shorten a lease's lifetime below the formal window boundary.
 *
 * **windowMs** is taken at construction. The Lua scripts use it to derive
 * the active window's `expiresAt` from `now`, so reconcile can correctly
 * initialize a fresh window if the prior window's HASH has already TTL'd
 * out (the race between the engine's fire-and-forget reconcile and its
 * next lease, which arrive in Redis in unspecified order).
 */

import { createHash } from "node:crypto";
import { StoreUnavailableError } from "../core/errors";
import { LUA_NOW } from "../core/lua";
import type { RedisClientLike } from "../redis/store";
import type { GlobalCoordinator } from "./types";

/** Default Redis key prefix. */
const DEFAULT_PREFIX = "tk:fed";
/** Default budget per window when no per-key override is configured. */
const DEFAULT_BUDGET = 1000;

export interface RedisCoordinatorOptions {
  /** An `ioredis` (or compatible) client. Use the adapters in `throttlekit/redis` for other clients. */
  client: RedisClientLike;
  /**
   * Window length in ms — MUST match the strategy's `windowMs` you federate.
   * Used by the Lua scripts to derive the active window's `expiresAt` from
   * `now` (`floor(now/windowMs)·windowMs + windowMs`), so reconcile can
   * initialize a fresh window if the prior window's HASH has TTL'd out.
   */
  windowMs: number;
  /** Default budget per window for any key without an override. Default 1000. */
  budgetPerWindow?: number;
  /** Redis key prefix. Default `"tk:fed"`. */
  prefix?: string;
  /**
   * Use the Redis server clock (TIME) for the `now` used in PEXPIRE math.
   * Default true — protects against node clock skew shortening leases
   * (which would tighten the federation bound but cost availability).
   * Set false in deterministic tests that pass an explicit `now`.
   */
  useServerTime?: boolean;
}

/**
 * Atomic LEASE script.
 *
 *   KEYS[1] = federation key (the HASH)
 *   ARGV[1] = now (epoch-ms, or 0 to use server TIME — LUA_NOW sentinel)
 *   ARGV[2] = tokens requested
 *   ARGV[3] = windowMs (for deriving the active window's expiresAt)
 *   ARGV[4] = perKeyBudget (initialize the budget if this is a fresh window)
 *
 * Returns: {granted, expiresAt} — granted (integer, 0..tokens) and the
 * authoritative window boundary (epoch-ms) the grant was drained against. The
 * scalar `lease()` reads element 1; `leaseWindowed()` reads both.
 */
const LEASE_LUA = `${LUA_NOW}
local tokens = tonumber(ARGV[2])
local windowMs = tonumber(ARGV[3])
local perKeyBudget = tonumber(ARGV[4])

local windowStart = math.floor(now / windowMs) * windowMs
local expiresAt = windowStart + windowMs

local h = redis.call('HMGET', KEYS[1], 'budget', 'expiresAt')
local budget = tonumber(h[1])
local storedExpiresAt = tonumber(h[2])

-- Initialize or window-roll. Wipe any stale reconcile markers from the
-- prior window via DEL (PEXPIRE will rebuild from scratch).
if budget == nil or storedExpiresAt ~= expiresAt then
  redis.call('DEL', KEYS[1])
  budget = perKeyBudget
end

local granted = tokens
if granted > budget then granted = budget end
budget = budget - granted

redis.call('HSET', KEYS[1], 'budget', budget, 'expiresAt', expiresAt)
local pexp = expiresAt - now
if pexp < 1 then pexp = 1 end
redis.call('PEXPIRE', KEYS[1], pexp)

return {granted, expiresAt}`;

/**
 * Atomic RECONCILE script.
 *
 *   KEYS[1] = federation key
 *   ARGV[1] = now (or 0 for server TIME)
 *   ARGV[2] = leftover (units to return)
 *   ARGV[3] = windowStart (the EXPIRED window's start — used for idempotency)
 *   ARGV[4] = windowMs (derives the CURRENT window's expiresAt)
 *   ARGV[5] = perKeyBudget (cap)
 *
 * Returns: 1 if credited, 0 if no-op (forfeit, or already reconciled this windowStart).
 *
 * Semantics: **window-coupled** — leftover is credited back ONLY if it belongs to the still-active
 * window (`windowStart == currentWindowStart`); leftover from an already-rolled window is FORFEIT, exactly
 * as the formal `Roll` expires regional escrow (spec/GaleFederatedLeasing.tla). This is what makes the
 * federation actually achieve `admitted <= Limit` per window: crediting a rolled window's leftover into a
 * later, already-draining window would let cumulative admissions exceed the budget (the K-dependent
 * `L + K·(B−1)` overshoot the federation is designed to eliminate). The credit caps at perKeyBudget; the
 * `rec_<windowStart>` field marks idempotency for the in-window-skew case (reconcile racing the boundary).
 */
const RECONCILE_LUA = `${LUA_NOW}
local leftover = tonumber(ARGV[2])
local windowStart = tonumber(ARGV[3])
local windowMs = tonumber(ARGV[4])
local perKeyBudget = tonumber(ARGV[5])

local currentWindowStart = math.floor(now / windowMs) * windowMs
local currentExpiresAt = currentWindowStart + windowMs

-- Window-coupling guard: forfeit leftover whose window has already rolled (it must not refill a later
-- window). Only an in-window reconcile (skew/boundary race, windowStart == current) restores budget.
if windowStart ~= currentWindowStart then
  return 0  -- rolled window — forfeit, exactly as the formal Roll expires escrow
end

local recField = 'rec_' .. windowStart
if redis.call('HEXISTS', KEYS[1], recField) == 1 then
  return 0  -- already reconciled this windowStart
end

local h = redis.call('HMGET', KEYS[1], 'budget', 'expiresAt')
local budget = tonumber(h[1])
local storedExpiresAt = tonumber(h[2])

if budget == nil or storedExpiresAt ~= currentExpiresAt then
  -- Fresh current window (or HASH was empty / stale). Initialize to perKeyBudget.
  redis.call('DEL', KEYS[1])
  budget = perKeyBudget
end

budget = budget + leftover
if budget > perKeyBudget then budget = perKeyBudget end

redis.call('HSET', KEYS[1], 'budget', budget, 'expiresAt', currentExpiresAt, recField, 1)
local pexp = currentExpiresAt - now
if pexp < 1 then pexp = 1 end
redis.call('PEXPIRE', KEYS[1], pexp)

return 1`;

function isNoScript(err: unknown): boolean {
  return err instanceof Error && /NOSCRIPT/.test(err.message);
}

export class RedisCoordinator implements GlobalCoordinator {
  readonly #client: RedisClientLike;
  readonly #defaultBudget: number;
  readonly #prefix: string;
  readonly #useServerTime: boolean;
  readonly #windowMs: number;
  readonly #perKeyBudget = new Map<string, number>();
  readonly #shaCache = new Map<string, string>();

  constructor(options: RedisCoordinatorOptions) {
    if (!Number.isFinite(options.windowMs) || options.windowMs < 1) {
      throw new RangeError(
        `windowMs must be a finite number >= 1, got ${String(options.windowMs)}`,
      );
    }
    if (
      options.budgetPerWindow !== undefined &&
      (!Number.isFinite(options.budgetPerWindow) || options.budgetPerWindow < 1)
    ) {
      throw new RangeError(
        `budgetPerWindow must be a finite number >= 1, got ${String(options.budgetPerWindow)}`,
      );
    }
    this.#client = options.client;
    this.#windowMs = options.windowMs;
    this.#defaultBudget = options.budgetPerWindow ?? DEFAULT_BUDGET;
    this.#prefix = options.prefix ?? DEFAULT_PREFIX;
    this.#useServerTime = options.useServerTime ?? true;
  }

  /** Override the per-window budget for a specific key. In-memory only. */
  setBudget(key: string, budgetPerWindow: number): void {
    if (!Number.isFinite(budgetPerWindow) || budgetPerWindow < 1) {
      throw new RangeError(
        `budgetPerWindow must be a finite number >= 1, got ${String(budgetPerWindow)}`,
      );
    }
    this.#perKeyBudget.set(key, budgetPerWindow);
  }

  /** The configured per-key budget (override > default). Used internally and by tests. */
  budgetFor(key: string): number {
    return this.#perKeyBudget.get(key) ?? this.#defaultBudget;
  }

  async lease(key: string, tokens: number, _expiresAt: number): Promise<number> {
    if (!Number.isFinite(tokens) || tokens < 0) {
      throw new RangeError(
        `lease tokens must be a non-negative finite number, got ${String(tokens)}`,
      );
    }
    if (tokens === 0) return 0;

    return (await this.#leaseWindowed(key, tokens)).granted;
  }

  /**
   * Lease + return the authoritative window boundary the budget drained against (the Redis-`TIME`-derived
   * `expiresAt`, NOT a node-clock value), so a Tier-2 client can discard leftover credits at exactly that
   * instant — closing the node↔store skew gap that {@link lease}'s ignored `expiresAt` argument leaves open.
   */
  async leaseWindowed(
    key: string,
    tokens: number,
  ): Promise<{ granted: number; expiresAt: number }> {
    if (!Number.isFinite(tokens) || tokens < 0) {
      throw new RangeError(
        `lease tokens must be a non-negative finite number, got ${String(tokens)}`,
      );
    }
    return this.#leaseWindowed(key, tokens);
  }

  async #leaseWindowed(
    key: string,
    tokens: number,
  ): Promise<{ granted: number; expiresAt: number }> {
    const redisKey = `${this.#prefix}:${key}`;
    const nowArg = this.#useServerTime ? 0 : Date.now();
    try {
      const raw = (await this.#eval(
        LEASE_LUA,
        [redisKey],
        [nowArg, tokens, this.#windowMs, this.budgetFor(key)],
      )) as [unknown, unknown];
      return { granted: Number(raw[0]), expiresAt: Number(raw[1]) };
    } catch (err) {
      throw new StoreUnavailableError(
        `RedisCoordinator.lease failed for key "${key}": ${(err as Error).message}`,
        { cause: err },
      );
    }
  }

  async reconcile(key: string, leftover: number, windowStart: number): Promise<void> {
    if (!Number.isFinite(leftover) || leftover < 0) {
      throw new RangeError(`reconcile leftover must be non-negative, got ${String(leftover)}`);
    }
    if (leftover === 0) return;

    const redisKey = `${this.#prefix}:${key}`;
    const nowArg = this.#useServerTime ? 0 : Date.now();
    try {
      await this.#eval(
        RECONCILE_LUA,
        [redisKey],
        [nowArg, leftover, windowStart, this.#windowMs, this.budgetFor(key)],
      );
    } catch (err) {
      throw new StoreUnavailableError(
        `RedisCoordinator.reconcile failed for key "${key}": ${(err as Error).message}`,
        { cause: err },
      );
    }
  }

  async isHealthy(): Promise<boolean> {
    // Lightweight liveness via a no-op GET of a dummy key. Returning the
    // operation completed without throwing is enough; we don't inspect the result.
    try {
      await this.#client.get(`${this.#prefix}:__health__`);
      return true;
    } catch {
      return false;
    }
  }

  // ---- internals ----

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
