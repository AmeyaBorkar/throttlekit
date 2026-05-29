/**
 * `RedisConcurrencyCoordinator` — the production-ready
 * {@link ConcurrencyCoordinator}. Backed by a single global Redis instance;
 * the event-release sibling of `RedisCoordinator` (federation). One Lua script
 * does heartbeat-aggregate-split atomically (DESIGN §10.2) — no read-modify-
 * write race.
 *
 * Layout — one HASH per coordinator key (`<prefix>conc:<key>`), one field per
 * live node:
 *
 *     field = nodeId
 *     value = "<lLocal> <inflight> <expiresAt> <share>"   (space-joined integers)
 *
 * The stored `share` is the value this node's last grant returned; the script
 * carries it forward across heartbeats so the budget cap (D-DAC-17) can see what
 * every other live node currently holds. The HASH carries a GC PEXPIRE derived
 * from the longest-lived member's `expiresAt`, so a fully-abandoned key
 * self-drops with no extra bookkeeping. Per-node eviction is exact
 * (`expiresAt < now`) inside the script, independent of that GC ttl.
 *
 * Heartbeat is one EVALSHA per round-trip (EVAL fallback on NOSCRIPT). The
 * script: upserts self (carrying forward its stored `share`, 0 if first-seen),
 * evicts expired fields, aggregates the live `lLocal` values into `lGlobal`
 * (`min` or lower-`median`, per the `aggregate` arg — DESIGN §7), computes this
 * node's equal-split TARGET across the sorted live nodeIds (DESIGN §6), CAPS the
 * grant at the budget no other live node is currently HOLDING
 * (`max(0, min(target, lGlobal − Σ_other max(share, inflight)))` — D-DAC-17 for
 * the `share` term / D-DAC-18 for the `inflight` term), stores the capped share
 * back, and returns this node's `{share, lGlobal, N}`. All arithmetic is integer.
 *
 * This is the Lua transcription of `TestConcurrencyCoordinator`'s reference
 * algorithm (DESIGN §10.1); the two MUST return identical `{share, lGlobal,
 * nodes}` for identical report sequences (the dual-path conformance test).
 *
 * Mirrors `RedisCoordinator`'s client abstraction (`RedisClientLike`/`#eval`),
 * its EVALSHA-with-EVAL-fallback load pattern, and its `StoreUnavailableError`
 * mapping (DESIGN §10.2).
 */

import { createHash } from "node:crypto";
import { StoreUnavailableError } from "../core/errors";
import type { RedisClientLike } from "../redis/store";
import type { ConcurrencyCoordinator, ConcurrencyGrant, ConcurrencyReport } from "./coordinator";

/** Default Redis key prefix. */
const DEFAULT_PREFIX = "tk:fed";

export interface RedisConcurrencyCoordinatorOptions {
  /** An `ioredis` (or compatible) client. Use the adapters in `throttlekit/redis` for other clients. */
  client: RedisClientLike;
  /**
   * Fleet-wide aggregation rule folding live nodes' `lLocal` into `L_global`
   * (DESIGN §7). `"median"` (default) takes the lower median; `"min"` takes the
   * minimum (the conservative extreme). Every node fronting a key MUST agree on
   * one rule — that is why it lives on the coordinator (D-DAC-8).
   */
  aggregate?: "min" | "median";
  /** Redis key prefix. Default `"tk:fed"`. */
  prefix?: string;
}

/**
 * Atomic HEARTBEAT script (DESIGN §10.2) — the Lua twin of
 * `TestConcurrencyCoordinator.heartbeat` (DESIGN §10.1). Both MUST return the
 * same `{share, lGlobal, N}` for identical report sequences.
 *
 *   KEYS[1] = coordinator key (the HASH)
 *   ARGV[1] = nodeId
 *   ARGV[2] = lLocal
 *   ARGV[3] = inflight
 *   ARGV[4] = expiresAt (epoch-ms)
 *   ARGV[5] = now (epoch-ms)
 *   ARGV[6] = aggregate ("min" | "median")
 *
 * Per-node field value is four space-joined integers
 * `"lLocal inflight expiresAt share"`; `share` is the value this node's last
 * grant returned (0 for a first-seen node) and `inflight` its last-reported
 * in-flight count, both carried forward so the budget cap below sees what every
 * other live node currently holds — `max(share, inflight)` (D-DAC-17 + D-DAC-18).
 *
 * Returns: { share, lGlobal, N } as a flat array (all integers).
 */
const HEARTBEAT_LUA = `local nodeId = ARGV[1]
local lLocal = tonumber(ARGV[2])
local inflight = tonumber(ARGV[3])
local expiresAt = tonumber(ARGV[4])
local now = tonumber(ARGV[5])
local aggregate = ARGV[6]

-- 1. upsert self, carrying forward any share we already granted it (0 if new).
local priorVal = redis.call('HGET', KEYS[1], nodeId)
local priorShare = 0
if priorVal then
  local p3 = 0
  for j = 1, 3 do p3 = string.find(priorVal, ' ', p3 + 1, true) end
  priorShare = tonumber(string.sub(priorVal, p3 + 1))
end
redis.call('HSET', KEYS[1], nodeId, lLocal .. ' ' .. inflight .. ' ' .. expiresAt .. ' ' .. priorShare)

-- 2. HGETALL; parse; evict every field with expiresAt < now. Retain each live
--    node's stored share for the cap (step 5). Self always survives (it just
--    renewed); an evicted node's share leaves the live sum, reclaiming budget.
local flat = redis.call('HGETALL', KEYS[1])
local limits = {}
local ids = {}
local sharesById = {}
local inflightById = {}
local maxExpiresAt = 0
for i = 1, #flat, 2 do
  local id = flat[i]
  local val = flat[i + 1]
  local sp1 = string.find(val, ' ', 1, true)
  local sp2 = string.find(val, ' ', sp1 + 1, true)
  local sp3 = string.find(val, ' ', sp2 + 1, true)
  local fieldLLocal = tonumber(string.sub(val, 1, sp1 - 1))
  local fieldInflight = tonumber(string.sub(val, sp1 + 1, sp2 - 1))
  local fieldExpiresAt = tonumber(string.sub(val, sp2 + 1, sp3 - 1))
  local fieldShare = tonumber(string.sub(val, sp3 + 1))
  if fieldExpiresAt < now then
    redis.call('HDEL', KEYS[1], id)
  else
    -- live node
    limits[#limits + 1] = fieldLLocal
    ids[#ids + 1] = id
    sharesById[id] = fieldShare
    inflightById[id] = fieldInflight
    if fieldExpiresAt > maxExpiresAt then maxExpiresAt = fieldExpiresAt end
  end
end

-- 3. lGlobal = aggregate(live lLocal) — DESIGN §7
table.sort(limits)
local n = #limits
local lGlobal
if aggregate == 'min' then
  lGlobal = limits[1]
else
  -- lower median: index floor((n-1)/2), 1-based
  lGlobal = limits[math.floor((n - 1) / 2) + 1]
end

-- 4. equal-split TARGET for self — DESIGN §6: base + 1 for the first \`rem\` by sorted id.
table.sort(ids)
local N = #ids
local base = math.floor(lGlobal / N)
local rem = lGlobal - base * N
local rank = 0
for i = 1, N do
  if ids[i] == nodeId then rank = i - 1 end
end
local target = base + (rank < rem and 1 or 0)

-- 5. CAP the grant at the budget no OTHER live node is currently HOLDING:
--    reserve each peer's max(share, inflight), not just share (D-DAC-18). A
--    peer's in-flight is non-revocable, so until it drains that capacity is
--    occupied and is not re-granted to a joiner. The share term keeps
--    Sum(share) <= lGlobal (D-DAC-17); the inflight term ELIMINATES the
--    synchronous rebalance overshoot (hard in the synchronous model; a bounded
--    async residual remains — DESIGN section 9.3 / D-DAC-18). Steady state
--    (inflight==share) == the share-only cap.
local others = 0
for i = 1, N do
  if ids[i] ~= nodeId then
    local s = sharesById[ids[i]]
    local f = inflightById[ids[i]]
    others = others + (s > f and s or f)
  end
end
local share = lGlobal - others
if target < share then share = target end
if share < 0 then share = 0 end

-- 6. record the grant so subsequent heartbeats by other nodes see it committed.
redis.call('HSET', KEYS[1], nodeId, lLocal .. ' ' .. inflight .. ' ' .. expiresAt .. ' ' .. share)

-- 7. GC PEXPIRE (longest-lived member outlives the key); return {share,lGlobal,N}
local pexp = maxExpiresAt - now
if pexp < 1 then pexp = 1 end
redis.call('PEXPIRE', KEYS[1], pexp)

return { share, lGlobal, N }`;

/** Atomic LEAVE script (DESIGN §10.2): `HDEL key nodeId`. */
const HDEL_LUA = `return redis.call('HDEL', KEYS[1], ARGV[1])`;

function isNoScript(err: unknown): boolean {
  return err instanceof Error && /NOSCRIPT/.test(err.message);
}

export class RedisConcurrencyCoordinator implements ConcurrencyCoordinator {
  readonly #client: RedisClientLike;
  readonly #aggregate: "min" | "median";
  readonly #prefix: string;
  readonly #shaCache = new Map<string, string>();

  constructor(options: RedisConcurrencyCoordinatorOptions) {
    this.#client = options.client;
    this.#aggregate = options.aggregate ?? "median";
    this.#prefix = options.prefix ?? DEFAULT_PREFIX;
  }

  async heartbeat(report: ConcurrencyReport): Promise<ConcurrencyGrant> {
    const redisKey = `${this.#prefix}conc:${report.key}`;
    try {
      const raw = await this.#eval(
        HEARTBEAT_LUA,
        [redisKey],
        [
          report.nodeId,
          report.lLocal,
          report.inflight,
          report.expiresAt,
          Date.now(),
          this.#aggregate,
        ],
      );
      const arr = raw as [number, number, number];
      return { share: Number(arr[0]), lGlobal: Number(arr[1]), nodes: Number(arr[2]) };
    } catch (err) {
      throw new StoreUnavailableError(
        `RedisConcurrencyCoordinator.heartbeat failed for key "${report.key}": ${(err as Error).message}`,
        { cause: err },
      );
    }
  }

  async leave(args: { key: string; nodeId: string }): Promise<void> {
    const redisKey = `${this.#prefix}conc:${args.key}`;
    try {
      await this.#eval(HDEL_LUA, [redisKey], [args.nodeId]);
    } catch (err) {
      throw new StoreUnavailableError(
        `RedisConcurrencyCoordinator.leave failed for key "${args.key}": ${(err as Error).message}`,
        { cause: err },
      );
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
