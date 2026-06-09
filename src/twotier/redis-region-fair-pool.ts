/**
 * `RedisRegionFairPool` — the production {@link AsyncRegionFairPool} (DR-FWFE-1): the cross-region
 * weighted-fair reservation pool with its region→{weight,granted} state in a **shared Redis hash**, so a
 * fleet of separate region processes draws from ONE global budget `L`. It is the weighted analog of
 * {@link RedisRegionalEscrow}, using the same atomic-EVALSHA-with-EVAL-fallback pattern one layer up.
 *
 * The grant is a single atomic Lua script that runs **the exact arithmetic of the in-process
 * {@link regionFairPool}** — weighted-max-min with reservation + borrow — so `Σ_r granted ≤ L` holds across
 * the fleet regardless of region count or interleaving. The conformance test pins it grant-for-grant against
 * the in-process oracle.
 *
 * Layout — one HASH per pool key:
 *
 *     ws            : the active window's start (epoch-ms, epoch-aligned)
 *     w:<region>    : that region's current active aggregate weight
 *     g:<region>    : that region's total grant this window (monotonic)
 *
 * The HASH carries PEXPIRE to the window boundary, so a rolled window auto-drops the prior state (and the
 * GRANT script clears it explicitly on the first touch after a roll, mirroring `regionFairPool.rollWindow`).
 * `useServerTime: true` (the default) makes the script read Redis `TIME` so node-clock skew never moves a
 * window boundary on the shared state — exactly as `RedisCoordinator` / `RedisRegionalEscrow` do.
 */

import { createHash } from "node:crypto";
import { systemClock } from "../core/clock";
import { StoreUnavailableError } from "../core/errors";
import { LUA_NOW } from "../core/lua";
import type { Clock } from "../core/types";
import type { RedisClientLike } from "../redis/store";
import type { AsyncRegionFairPool, RegionFairPoolStats } from "./federated-weighted-fair-escrow";

/** Default Redis key prefix — distinct from the coordinator/escrow prefixes so they can share one Redis. */
const DEFAULT_PREFIX = "tk:rfp";

/** Options for {@link RedisRegionFairPool}. */
export interface RedisRegionFairPoolOptions {
  /** An `ioredis` (or compatible) client. Use the adapters in `throttlekit/redis` for other clients. */
  client: RedisClientLike;
  /** Global per-window budget `L`, shared across ALL regions. Floored to an integer; must be > 0. */
  limit: number;
  /** Window width in ms (epoch-aligned). Must be > 0. All regions on this pool share it. */
  windowMs: number;
  /**
   * The single pool key the regions share (the federation key — e.g. the policy name). Every region's
   * `federatedWeightedFairEscrow` on this pool MUST resolve the same key, or they hold separate budgets.
   */
  key: string;
  /** Redis key prefix. Default `"tk:rfp"`. */
  prefix?: string;
  /**
   * Use the Redis server clock (`TIME`) for the `now` in the grant's window math. Default `true` — protects
   * the shared window boundary from node clock skew. Set `false` in deterministic tests passing an explicit
   * `now` (the conformance suite does this with a `ManualClock`). NOTE: `now === 0` is the shared `LUA_NOW`
   * "use server TIME" sentinel, so a deterministic `now` must be **non-zero** (use a window-aligned epoch).
   */
  useServerTime?: boolean;
  /**
   * The clock {@link federatedWeightedFairEscrow} uses for its OWN per-tenant window + decide timing. Default
   * {@link systemClock}. Independent of `useServerTime` (which governs only the shared region-window math);
   * with NTP the two stay within a few ms, as the coordinator/escrow layers already assume.
   */
  clock?: Clock;
}

/**
 * Atomic GRANT script — the region-level weighted-max-min reservation. Runs the byte-identical arithmetic
 * of `regionFairPool.grant`, transactionally, over the shared hash.
 *
 *   KEYS[1] = pool HASH key
 *   ARGV[1] = now (0 = use server TIME)   ARGV[2] = windowMs   ARGV[3] = L (limit)
 *   ARGV[4] = region                      ARGV[5] = weight     ARGV[6] = wantTotal
 *
 * Returns: this region's new total grant for the active window (monotonic; `Σ_r granted ≤ L`).
 */
const GRANT_LUA = `${LUA_NOW}
local windowMs = tonumber(ARGV[2])
local L = tonumber(ARGV[3])
local region = ARGV[4]
local weight = tonumber(ARGV[5])
local wantTotal = tonumber(ARGV[6])

-- Load the current window's state.
local data = redis.call('HGETALL', KEYS[1])
local ws = nil
local weights = {}
local granted = {}
for i = 1, #data, 2 do
  local k = data[i]
  local v = data[i + 1]
  if k == 'ws' then
    ws = tonumber(v)
  elseif string.sub(k, 1, 2) == 'w:' then
    weights[string.sub(k, 3)] = tonumber(v)
  elseif string.sub(k, 1, 2) == 'g:' then
    granted[string.sub(k, 3)] = tonumber(v)
  end
end

-- Roll the window (epoch-aligned), clearing ALL region state — mirrors regionFairPool.rollWindow.
if ws == nil or now >= ws + windowMs then
  redis.call('DEL', KEYS[1])
  ws = math.floor(now / windowMs) * windowMs
  weights = {}
  granted = {}
end

-- Upsert this region's weight; default its grant to 0.
weights[region] = weight
local myGranted = granted[region]
if myGranted == nil then myGranted = 0 end

local pexp = ws + windowMs - now
if pexp < 1 then pexp = 1 end

-- Already holds enough — monotonic; just refresh weight + expiry and return.
if wantTotal <= myGranted then
  redis.call('HSET', KEYS[1], 'ws', ws, 'w:' .. region, weight, 'g:' .. region, myGranted)
  redis.call('PEXPIRE', KEYS[1], pexp)
  return myGranted
end

-- Total active weight across ALL regions (self included — its weight was upserted above).
local totalWeight = 0
for r, w in pairs(weights) do
  totalWeight = totalWeight + w
end

-- othersHold = Σ_{j≠self} max(grantedⱼ, gⱼ), with gⱼ = floor(wⱼ·L / totalWeight) (the reserved guarantee).
local othersHold = 0
for r, w in pairs(weights) do
  if r ~= region then
    local gj = 0
    if totalWeight > 0 then gj = math.floor((w * L) / totalWeight) end
    local heldR = granted[r]
    if heldR == nil then heldR = 0 end
    if gj > heldR then
      othersHold = othersHold + gj
    else
      othersHold = othersHold + heldR
    end
  end
end

-- ceiling = max(myGranted, L - othersHold); newGranted = min(wantTotal, ceiling), clamped at 0.
local ceiling = L - othersHold
if myGranted > ceiling then ceiling = myGranted end
local newGranted = wantTotal
if ceiling < newGranted then newGranted = ceiling end
if newGranted < 0 then newGranted = 0 end

redis.call('HSET', KEYS[1], 'ws', ws, 'w:' .. region, weight, 'g:' .. region, newGranted)
redis.call('PEXPIRE', KEYS[1], pexp)
return newGranted`;

/**
 * RELEASE script — drop a region from the active set (its grant returns to the pool). Mirrors
 * `regionFairPool.release`: roll first (a rolled window clears everything), else remove just this region.
 *
 *   KEYS[1] = pool HASH key   ARGV[1] = now (0 = server TIME)   ARGV[2] = windowMs   ARGV[3] = region
 */
const RELEASE_LUA = `${LUA_NOW}
local windowMs = tonumber(ARGV[2])
local region = ARGV[3]
local ws = tonumber(redis.call('HGET', KEYS[1], 'ws'))
if ws == nil or now >= ws + windowMs then
  redis.call('DEL', KEYS[1])
  return 0
end
redis.call('HDEL', KEYS[1], 'w:' .. region, 'g:' .. region)
return 0`;

/** STATS script — return the whole pool hash as a flat `[field, value, ...]` array (read-only). */
const STATS_LUA = "return redis.call('HGETALL', KEYS[1])";

function isNoScript(err: unknown): boolean {
  return err instanceof Error && /NOSCRIPT/.test(err.message);
}

/** A store-backed {@link AsyncRegionFairPool}: the in-process pool's arithmetic, atomic over a Redis hash. */
export class RedisRegionFairPool implements AsyncRegionFairPool {
  readonly isAsync = true as const;
  readonly limit: number;
  readonly windowMs: number;
  readonly clock: Clock;
  readonly #client: RedisClientLike;
  readonly #key: string;
  readonly #prefix: string;
  readonly #useServerTime: boolean;
  readonly #shaCache = new Map<string, string>();

  constructor(options: RedisRegionFairPoolOptions) {
    if (!Number.isFinite(options.limit) || options.limit <= 0) {
      throw new RangeError(`limit must be a finite number > 0, got ${String(options.limit)}`);
    }
    if (!Number.isFinite(options.windowMs) || options.windowMs < 1) {
      throw new RangeError(
        `windowMs must be a finite number >= 1, got ${String(options.windowMs)}`,
      );
    }
    if (typeof options.key !== "string" || options.key.length === 0) {
      throw new RangeError(`key must be a non-empty string, got ${String(options.key)}`);
    }
    this.limit = Math.floor(options.limit);
    this.windowMs = options.windowMs;
    this.clock = options.clock ?? systemClock;
    this.#client = options.client;
    this.#key = options.key;
    this.#prefix = options.prefix ?? DEFAULT_PREFIX;
    this.#useServerTime = options.useServerTime ?? true;
  }

  async grant(region: string, weight: number, wantTotal: number, now: number): Promise<number> {
    if (typeof region !== "string" || region.length === 0) {
      throw new RangeError(`region must be a non-empty string, got ${String(region)}`);
    }
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new RangeError(`weight must be a finite number > 0, got ${String(weight)}`);
    }
    if (!Number.isFinite(wantTotal) || wantTotal < 0) {
      throw new RangeError(
        `wantTotal must be a non-negative finite number, got ${String(wantTotal)}`,
      );
    }
    const nowArg = this.#useServerTime ? 0 : now;
    try {
      const raw = await this.#eval(
        GRANT_LUA,
        [this.#redisKey()],
        [nowArg, this.windowMs, this.limit, region, weight, wantTotal],
      );
      return Number(raw);
    } catch (err) {
      throw new StoreUnavailableError(
        `RedisRegionFairPool.grant failed for region "${region}": ${(err as Error).message}`,
        { cause: err },
      );
    }
  }

  async release(region: string, now: number): Promise<void> {
    const nowArg = this.#useServerTime ? 0 : now;
    try {
      await this.#eval(RELEASE_LUA, [this.#redisKey()], [nowArg, this.windowMs, region]);
    } catch (err) {
      throw new StoreUnavailableError(
        `RedisRegionFairPool.release failed for region "${region}": ${(err as Error).message}`,
        { cause: err },
      );
    }
  }

  async stats(): Promise<RegionFairPoolStats> {
    // Read-only — mirrors regionFairPool.stats (no window roll; a rolled window's hash has already PEXPIREd).
    const raw = await this.#eval(STATS_LUA, [this.#redisKey()], []);
    const flat: unknown[] = Array.isArray(raw) ? raw : [];
    let windowStart = Number.NEGATIVE_INFINITY;
    const byRegion = new Map<string, { weight: number; granted: number }>();
    for (let i = 0; i < flat.length; i += 2) {
      const k = String(flat[i]);
      const v = flat[i + 1];
      if (k === "ws") {
        windowStart = Number(v);
      } else if (k.startsWith("w:")) {
        const r = k.slice(2);
        const cur = byRegion.get(r) ?? { weight: 0, granted: 0 };
        cur.weight = Number(v);
        byRegion.set(r, cur);
      } else if (k.startsWith("g:")) {
        const r = k.slice(2);
        const cur = byRegion.get(r) ?? { weight: 0, granted: 0 };
        cur.granted = Number(v);
        byRegion.set(r, cur);
      }
    }
    let totalGranted = 0;
    const regions: Array<{ region: string; weight: number; granted: number }> = [];
    for (const [region, e] of byRegion) {
      totalGranted += e.granted;
      regions.push({ region, weight: e.weight, granted: e.granted });
    }
    return { windowStart, limit: this.limit, totalGranted, regions };
  }

  // ---- internals ----

  #redisKey(): string {
    return `${this.#prefix}:${this.#key}`;
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
