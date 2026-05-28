/**
 * TK-1005 — Lua-fused admission dispatcher.
 *
 * The `tk:v1:fused-rc:check` atomic Lua script + the dispatcher that
 * pumps `EVALSHA → EVAL on NOSCRIPT` against an arbitrary
 * {@link RedisClientLike}. The script atomically evaluates the rate
 * axis (GCRA on `KEYS[1]`) and the cost axis (tokenBucket on `KEYS[2]`)
 * inside one Redis round trip, then combines their results via the
 * algebra in `combineDecisions` (TK-1002) and returns the combined
 * Decision plus the per-axis Decisions for `UnifiedAdmitter.lastDecisions`.
 *
 * Semantic match to sequential: **each axis writes its own state per its
 * own admit decision**, independent of the other axis's outcome. So a
 * rate-admits-but-cost-denies admission still advances rate's TAT — same
 * as calling `rateLimit({...}).check()` then `rateLimit({...}).check()`
 * sequentially. The combined Decision still denies. This preserves the
 * byte-identity claim in DESIGN.md §6 with sequential mode.
 *
 * **Atomicity vs sequential.** Both rate and cost transitions run inside
 * the single Redis EVAL — so concurrent admits cannot interleave between
 * the rate-write and cost-write. This is the strong atomicity guarantee
 * fused mode buys over sequential's two-RTT-with-potential-interleave.
 *
 * **0.9.0 scope (D-U14).** This file ships the *gcra + tokenBucket* pair
 * only — the LLM-gateway combination. The constructor enforces strategy
 * names. Other pairs land as 0.9.x patches when there is demand.
 */

import { createHash } from "node:crypto";

import { LUA_NOW } from "../core/lua";
import type { Decision } from "../core/types";
import type { RedisClientLike } from "../redis/store";

/**
 * Atomic fused script. Two keys, two strategy parameter blocks, one
 * combined return tuple.
 *
 *   KEYS[1] = rate key (GCRA TAT, SET string `%.17g`)
 *   KEYS[2] = cost key (tokenBucket HASH, fields `t` / `l`)
 *
 *   ARGV[1]  = now (epoch-ms; 0 ⇒ use server TIME — LUA_NOW sentinel)
 *   ARGV[2]  = rate.cost (request weight on the rate axis; usually 1)
 *   ARGV[3]  = rate.periodMs
 *   ARGV[4]  = rate.limit
 *   ARGV[5]  = rate.burst
 *   ARGV[6]  = cost.cost (cost-axis tokens for this request)
 *   ARGV[7]  = cost.capacity
 *   ARGV[8]  = cost.refillPerSec
 *
 * Returns: a 13-element array of integers
 *   [ allowed,                                              -- 1: combined AND
 *     limit, remaining, resetAt, retryAfterMs,              -- 4: combined MIN / MIN / MAX / MAX
 *     rate_allowed, rate_remaining, rate_resetAt, rate_retryAfterMs,   -- 4: per-axis rate
 *     cost_allowed, cost_remaining, cost_resetAt, cost_retryAfterMs ]  -- 4: per-axis cost
 *
 * Per-axis `limit` is omitted from the tuple — the dispatcher fills it
 * in from the configured `burst` / `capacity` (constant per script
 * instance, so no point round-tripping it).
 *
 * Each axis writes its own state independently of the combined result:
 *   - rate writes its new TAT iff rate_allowed == 1
 *   - cost writes its new tokens iff cost_allowed == 1
 *
 * This matches the *sequential* mode's per-axis-consume behavior — the
 * algebra layer's first-deny short-circuit in sequential consumes
 * earlier axes regardless of downstream denial, and the fused script
 * intentionally mirrors that (D-U9 in DESIGN.md §14).
 */
export const FUSED_GCRA_TOKEN_BUCKET_LUA = `${LUA_NOW}
-- ── Rate axis: GCRA on KEYS[1] ──────────────────────────────────────────
local rate_cost = tonumber(ARGV[2])
local rate_period = tonumber(ARGV[3])
local rate_limit = tonumber(ARGV[4])
local rate_burst = tonumber(ARGV[5])
local rate_T = rate_period / rate_limit
local rate_tau = rate_T * rate_burst
local rate_inc = rate_T * rate_cost
local rate_tat = tonumber(redis.call('GET', KEYS[1]) or now)
if rate_tat < now then rate_tat = now end
local rate_new_tat = rate_tat + rate_inc
local rate_allow_at = rate_new_tat - rate_tau

local rate_allowed
local rate_remaining
local rate_resetAt
local rate_retryAfterMs

if now < rate_allow_at then
  -- Denied: report what's remaining (against the unchanged TAT) and the wait.
  rate_remaining = math.floor((rate_tau - (rate_tat - now)) / rate_T)
  if rate_remaining < 0 then rate_remaining = 0 end
  rate_allowed = 0
  rate_resetAt = math.ceil(rate_tat)
  rate_retryAfterMs = math.ceil(rate_allow_at - now)
else
  -- Allowed: advance the TAT and persist with a PX TTL through the burst window.
  rate_remaining = math.floor((rate_tau - (rate_new_tat - now)) / rate_T)
  if rate_remaining < 0 then rate_remaining = 0 end
  rate_allowed = 1
  rate_resetAt = math.ceil(rate_new_tat)
  rate_retryAfterMs = 0
  local rate_px = math.ceil(rate_new_tat - now)
  if rate_px < 1 then rate_px = 1 end
  redis.call('SET', KEYS[1], string.format('%.17g', rate_new_tat), 'PX', rate_px)
end

-- ── Cost axis: tokenBucket on KEYS[2] ───────────────────────────────────
local cost_cost = tonumber(ARGV[6])
local cost_capacity = tonumber(ARGV[7])
local cost_refill_per_sec = tonumber(ARGV[8])
local cost_refill_per_ms = cost_refill_per_sec / 1000

local cost_h = redis.call('HMGET', KEYS[2], 't', 'l')
local cost_tokens = tonumber(cost_h[1])
local cost_last = tonumber(cost_h[2])
if cost_tokens == nil then cost_tokens = cost_capacity end
if cost_last == nil then cost_last = now end
local cost_elapsed = now - cost_last
if cost_elapsed < 0 then cost_elapsed = 0 end
cost_tokens = cost_tokens + cost_elapsed * cost_refill_per_ms
if cost_tokens > cost_capacity then cost_tokens = cost_capacity end
local cost_ttl = math.ceil(cost_capacity / cost_refill_per_ms)
if cost_ttl < 1 then cost_ttl = 1 end

local cost_allowed
local cost_remaining
local cost_resetAt
local cost_retryAfterMs

if cost_tokens >= cost_cost then
  local cost_new_tokens = cost_tokens - cost_cost
  cost_remaining = math.floor(cost_new_tokens)
  if cost_remaining < 0 then cost_remaining = 0 end
  redis.call('HSET', KEYS[2], 't', string.format('%.17g', cost_new_tokens), 'l', string.format('%.17g', now))
  redis.call('PEXPIRE', KEYS[2], cost_ttl)
  cost_allowed = 1
  cost_resetAt = now + math.ceil((cost_capacity - cost_new_tokens) / cost_refill_per_ms)
  cost_retryAfterMs = 0
else
  cost_remaining = math.floor(cost_tokens)
  if cost_remaining < 0 then cost_remaining = 0 end
  cost_allowed = 0
  cost_resetAt = now + math.ceil((cost_capacity - cost_tokens) / cost_refill_per_ms)
  cost_retryAfterMs = math.ceil((cost_cost - cost_tokens) / cost_refill_per_ms)
end

-- ── Combine via the algebra (combineDecisions in Lua) ──────────────────
local allowed
if rate_allowed == 1 and cost_allowed == 1 then
  allowed = 1
else
  allowed = 0
end
local limit = rate_burst
if cost_capacity < limit then limit = cost_capacity end
local remaining = rate_remaining
if cost_remaining < remaining then remaining = cost_remaining end
local resetAt = rate_resetAt
if cost_resetAt > resetAt then resetAt = cost_resetAt end
local retryAfterMs = rate_retryAfterMs
if cost_retryAfterMs > retryAfterMs then retryAfterMs = cost_retryAfterMs end

return {allowed, limit, remaining, resetAt, retryAfterMs,
        rate_allowed, rate_remaining, rate_resetAt, rate_retryAfterMs,
        cost_allowed, cost_remaining, cost_resetAt, cost_retryAfterMs}`;

/** Rate-axis (GCRA) parameter block passed to the fused dispatcher. */
export interface FusedRateConfig {
  /** Strategy discriminator — must be `"gcra"` in 0.9.0 (D-U14). */
  strategy: "gcra";
  /** Sustained rate: requests per `periodMs`. */
  limit: number;
  /** The period over which `limit` applies, in ms. */
  periodMs: number;
  /** Maximum requests admissible instantaneously (burst). Defaults to `limit`. */
  burst?: number;
  /** Optional key namespace; matches the rate Limiter's prefix. */
  prefix?: string;
}

/** Cost-axis (tokenBucket) parameter block passed to the fused dispatcher. */
export interface FusedCostConfig {
  /** Strategy discriminator — must be `"tokenBucket"` in 0.9.0 (D-U14). */
  strategy: "tokenBucket";
  /** Bucket capacity: the maximum tokens held, and the largest instantaneous burst. */
  capacity: number;
  /** Sustained refill rate in tokens per second (may be fractional; must be > 0). */
  refillPerSec: number;
  /** Optional key namespace; matches the cost Limiter's prefix. */
  prefix?: string;
}

/** The fused option group on {@link unifiedAdmission} when `backend: "lua-fused"`. */
export interface FusedAdmissionOptions {
  /** The shared Redis client backing both axes (the same client used by the rate / cost limiters). */
  client: RedisClientLike;
  /** Rate-axis config. */
  rate: FusedRateConfig;
  /** Cost-axis config. */
  cost: FusedCostConfig;
  /**
   * Use the Redis server clock (`TIME`) for `now` inside the script.
   * Default `true` — protects against node clock skew corrupting state.
   * Set `false` in deterministic tests that pass an explicit `now` (use
   * {@link FusedDispatcher.dispatchAt} for that path).
   */
  useServerTime?: boolean;
}

/**
 * One combined-plus-per-axis admit outcome from the fused script. Used
 * to populate the {@link UnifiedAdmitter.lastDecisions} snapshot.
 */
export interface FusedAdmissionResult {
  /** The combined Decision: AND of allowed, MIN of limit/remaining, MAX of resetAt/retryAfterMs. */
  combined: Decision;
  /** The rate axis's standalone Decision (as if `rateLimit({...}).check()` had run). */
  rate: Decision;
  /** The cost axis's standalone Decision (as if `rateLimit({...}).check()` had run). */
  cost: Decision;
}

/**
 * Pumps the fused Lua script with EVALSHA → EVAL on NOSCRIPT. One
 * dispatcher per (client, rate config, cost config); SHA1 is computed
 * once and cached so the steady-state cost is one EVALSHA per admit.
 */
export class FusedDispatcher {
  readonly #client: RedisClientLike;
  readonly #ratePeriodMs: number;
  readonly #rateLimit: number;
  readonly #rateBurst: number;
  readonly #costCapacity: number;
  readonly #costRefillPerSec: number;
  readonly #rateKeyOf: (key: string) => string;
  readonly #costKeyOf: (key: string) => string;
  readonly #useServerTime: boolean;
  readonly #sha: string;

  constructor(options: FusedAdmissionOptions) {
    // Validate strategy choices up-front (D-U14 — 0.9.0 ships gcra+tokenBucket only).
    if (options.rate.strategy !== "gcra") {
      throw new RangeError(
        `unifiedAdmission (lua-fused): rate.strategy must be "gcra" in 0.9.0, got "${String(
          options.rate.strategy,
        )}"`,
      );
    }
    if (options.cost.strategy !== "tokenBucket") {
      throw new RangeError(
        `unifiedAdmission (lua-fused): cost.strategy must be "tokenBucket" in 0.9.0, got "${String(
          options.cost.strategy,
        )}"`,
      );
    }
    if (!Number.isFinite(options.rate.limit) || options.rate.limit <= 0) {
      throw new RangeError(
        `rate.limit must be a positive finite number, got ${options.rate.limit}`,
      );
    }
    if (!Number.isFinite(options.rate.periodMs) || options.rate.periodMs <= 0) {
      throw new RangeError(
        `rate.periodMs must be a positive finite number, got ${options.rate.periodMs}`,
      );
    }
    if (!Number.isFinite(options.cost.capacity) || options.cost.capacity <= 0) {
      throw new RangeError(
        `cost.capacity must be a positive finite number, got ${options.cost.capacity}`,
      );
    }
    if (!Number.isFinite(options.cost.refillPerSec) || options.cost.refillPerSec <= 0) {
      throw new RangeError(
        `cost.refillPerSec must be a positive finite number, got ${options.cost.refillPerSec}`,
      );
    }

    this.#client = options.client;
    this.#ratePeriodMs = options.rate.periodMs;
    this.#rateLimit = options.rate.limit;
    this.#rateBurst = options.rate.burst ?? options.rate.limit;
    this.#costCapacity = options.cost.capacity;
    this.#costRefillPerSec = options.cost.refillPerSec;
    this.#useServerTime = options.useServerTime ?? true;
    this.#rateKeyOf = makePrefixer(options.rate.prefix);
    this.#costKeyOf = makePrefixer(options.cost.prefix);
    this.#sha = createHash("sha1").update(FUSED_GCRA_TOKEN_BUCKET_LUA).digest("hex");
  }

  /** The per-axis `limit` reported in the per-axis Decisions. */
  get rateLimit(): number {
    return this.#rateBurst;
  }
  /** The per-axis `limit` reported in the per-axis Decisions. */
  get costLimit(): number {
    return this.#costCapacity;
  }

  /**
   * Run the fused atomic admit for `key` with the given cost-axis weight.
   * The rate-axis weight is always 1 — the unified admitter's API
   * doesn't expose a per-axis weight knob.
   */
  async dispatch(key: string, costTokens = 1): Promise<FusedAdmissionResult> {
    const nowArg = this.#useServerTime ? 0 : Date.now();
    return this.dispatchAt(key, costTokens, nowArg);
  }

  /**
   * Like {@link FusedDispatcher.dispatch} but uses an explicit `now`
   * (in epoch-ms). Used in tests that pin a deterministic clock — the
   * Lua's `LUA_NOW` sentinel translates `0` to the server clock, so a
   * non-zero value pins it instead.
   */
  async dispatchAt(key: string, costTokens: number, now: number): Promise<FusedAdmissionResult> {
    if (!Number.isFinite(costTokens) || costTokens <= 0) {
      throw new RangeError(`costTokens must be a positive finite number, got ${costTokens}`);
    }

    const rateKey = this.#rateKeyOf(key);
    const costKey = this.#costKeyOf(key);
    const argv: Array<string | number> = [
      now,
      1, // rate.cost — fixed at 1 (the unified API has no per-axis weight knob)
      this.#ratePeriodMs,
      this.#rateLimit,
      this.#rateBurst,
      costTokens,
      this.#costCapacity,
      this.#costRefillPerSec,
    ];

    let raw: unknown;
    try {
      raw = await this.#client.evalsha(this.#sha, 2, rateKey, costKey, ...argv);
    } catch (err) {
      if (isNoScript(err)) {
        // Cache flushed (Redis restart / failover); EVAL re-loads and re-caches.
        raw = await this.#client.eval(FUSED_GCRA_TOKEN_BUCKET_LUA, 2, rateKey, costKey, ...argv);
      } else {
        throw err;
      }
    }

    return decode(raw, this.#rateBurst, this.#costCapacity);
  }
}

/** Same prefix join format as {@link prefixer} in `src/core/key.ts`: `${prefix}:${key}` (or identity). */
function makePrefixer(prefix?: string): (key: string) => string {
  return prefix !== undefined && prefix.length > 0
    ? (key: string): string => `${prefix}:${key}`
    : (key: string): string => key;
}

function isNoScript(err: unknown): boolean {
  return err instanceof Error && /NOSCRIPT/.test(err.message);
}

/** Decode the 13-integer tuple returned by the fused script. */
function decode(raw: unknown, rateLimit: number, costLimit: number): FusedAdmissionResult {
  const a = raw as [
    number, // [0]  combined.allowed (0/1)
    number, // [1]  combined.limit
    number, // [2]  combined.remaining
    number, // [3]  combined.resetAt
    number, // [4]  combined.retryAfterMs
    number, // [5]  rate.allowed (0/1)
    number, // [6]  rate.remaining
    number, // [7]  rate.resetAt
    number, // [8]  rate.retryAfterMs
    number, // [9]  cost.allowed (0/1)
    number, // [10] cost.remaining
    number, // [11] cost.resetAt
    number, // [12] cost.retryAfterMs
  ];
  return {
    combined: {
      allowed: a[0] === 1,
      limit: a[1],
      remaining: a[2],
      resetAt: a[3],
      retryAfterMs: a[4],
    },
    rate: {
      allowed: a[5] === 1,
      limit: rateLimit,
      remaining: a[6],
      resetAt: a[7],
      retryAfterMs: a[8],
    },
    cost: {
      allowed: a[9] === 1,
      limit: costLimit,
      remaining: a[10],
      resetAt: a[11],
      retryAfterMs: a[12],
    },
  };
}
