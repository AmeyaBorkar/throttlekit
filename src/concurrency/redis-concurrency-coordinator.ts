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
  /**
   * ACKNOWLEDGED HANDOFF (D-DAC-19) — opt-in, default `false`. The Lua twin of
   * {@link TestConcurrencyCoordinatorOptions.acknowledgedHandoff}: the cap reserves
   * each peer's MAX UN-ACKNOWLEDGED grant (via the grant-generation echo) unioned
   * with its reported in-flight, making `Σ inflight ≤ L_global` a HARD instantaneous
   * bound under async lag (TLA⁺ `GaleHeartbeatHandoff` + BFS twin TK-1330), at the
   * cost of ramp latency. `false` keeps the 0.10.0 occupancy cap (D-DAC-18). All
   * nodes/coordinators on a key MUST agree (like {@link aggregate}); enable only once
   * every guard echoes `appliedGen`. The per-field value widens from 4 to 7 ints when
   * enabled (additive; the parser reads legacy 4-int values as gen/maxSeq/high = 0).
   */
  acknowledgedHandoff?: boolean;
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
 *   ARGV[7] = seq         (acknowledged handoff: heartbeat sequence; -1 if absent)
 *   ARGV[8] = appliedGen  (acknowledged handoff: gen the guard enforces; -1 if absent)
 *   ARGV[9] = handoff     ("1" = acknowledged handoff cap, "0" = D-DAC-18 occupancy cap)
 *
 * Per-node field value is space-joined integers. Default (handoff off): four —
 * `"lLocal inflight expiresAt share"` (unchanged from 0.10.0). Acknowledged handoff
 * (D-DAC-19): seven — `"… share committedGen maxSeq unackedHigh"`, where committedGen
 * bumps only on a share-VALUE change, maxSeq is the freshest heartbeat seq (stale-
 * report gate), and unackedHigh is the reserve floor (max un-acked grant). The parser
 * reads a legacy 4-int value as gen/maxSeq/unackedHigh = 0. The cap reserves each peer
 * `max(share, inflight)` by default, or `max(unackedHigh, inflight)` under handoff.
 *
 * Returns: { share, lGlobal, N, gen } as a flat array (all integers; gen = 0 off).
 */
const HEARTBEAT_LUA = `local nodeId = ARGV[1]
local lLocal = tonumber(ARGV[2])
local inflight = tonumber(ARGV[3])
local expiresAt = tonumber(ARGV[4])
local now = tonumber(ARGV[5])
local aggregate = ARGV[6]
local seq = tonumber(ARGV[7])
local appliedGen = tonumber(ARGV[8])
local handoff = ARGV[9] == '1'

-- parse a field value into 7 ints; a legacy 4-int value yields gen/maxSeq/unacked = 0.
-- order: lLocal inflight expiresAt share [committedGen maxSeq unackedHigh]
local function parseVal(val)
  local p = {}
  local pos = 1
  while true do
    local sp = string.find(val, ' ', pos, true)
    if sp then
      p[#p + 1] = tonumber(string.sub(val, pos, sp - 1))
      pos = sp + 1
    else
      p[#p + 1] = tonumber(string.sub(val, pos))
      break
    end
  end
  return p[1], p[2], p[3], p[4], p[5] or 0, p[6] or 0, p[7] or 0
end

-- encode a field value: 7 ints under handoff, the legacy 4 otherwise.
local function encode(ll, inf, exp, sh, gen, ms, uh)
  if handoff then
    return ll .. ' ' .. inf .. ' ' .. exp .. ' ' .. sh .. ' ' .. gen .. ' ' .. ms .. ' ' .. uh
  end
  return ll .. ' ' .. inf .. ' ' .. exp .. ' ' .. sh
end

-- 1. upsert self, carrying forward prior grant state (0 if new). Freshness gate
--    (handoff): a reordered/stale heartbeat (seq <= maxSeq) must not regress
--    committed state nor pull reported inflight backward.
local priorVal = redis.call('HGET', KEYS[1], nodeId)
local priorShare, priorGen, priorMaxSeq, priorUnacked = 0, 0, 0, 0
local priorInflight = inflight
if priorVal then
  local _, pInf, _, pSh, pGen, pMs, pUh = parseVal(priorVal)
  priorInflight = pInf
  priorShare = pSh
  priorGen = pGen
  priorMaxSeq = pMs
  priorUnacked = pUh
end
local fresh = (not handoff) or seq < 0 or seq > priorMaxSeq
local useInflight = fresh and inflight or priorInflight
local newMaxSeq = 0
if handoff then newMaxSeq = (priorMaxSeq > seq and priorMaxSeq or seq) end
redis.call('HSET', KEYS[1], nodeId, encode(lLocal, useInflight, expiresAt, priorShare, priorGen, newMaxSeq, priorUnacked))

-- 2. HGETALL; parse; evict every field with expiresAt < now. Retain each live
--    node's share + inflight + unackedHigh for the cap (step 5). Self always
--    survives (just renewed); an evicted node leaves the live sum, reclaiming budget.
local flat = redis.call('HGETALL', KEYS[1])
local limits = {}
local ids = {}
local sharesById = {}
local inflightById = {}
local unackedById = {}
local maxExpiresAt = 0
for i = 1, #flat, 2 do
  local id = flat[i]
  local fLl, fInf, fExp, fSh, fGen, fMs, fUh = parseVal(flat[i + 1])
  if fExp < now then
    redis.call('HDEL', KEYS[1], id)
  else
    limits[#limits + 1] = fLl
    ids[#ids + 1] = id
    sharesById[id] = fSh
    inflightById[id] = fInf
    unackedById[id] = fUh
    if fExp > maxExpiresAt then maxExpiresAt = fExp end
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

-- 5. CAP the grant at the budget no OTHER live node is currently HOLDING. Default
--    (D-DAC-18): max(share, inflight). Acknowledged handoff (D-DAC-19):
--    max(unackedHigh, inflight) — the max un-acked grant the peer could still apply
--    unioned with its occupancy, making Sum(inflight) <= lGlobal a hard async bound.
--    Steady state collapses both to max(share, inflight) (D-DAC-17 preserved).
local others = 0
for i = 1, N do
  if ids[i] ~= nodeId then
    local f = inflightById[ids[i]]
    local hold
    if handoff then
      local u = unackedById[ids[i]]
      hold = u > f and u or f
    else
      local s = sharesById[ids[i]]
      hold = s > f and s or f
    end
    others = others + hold
  end
end
local share = lGlobal - others
if target < share then share = target end
if share < 0 then share = 0 end

-- 6. record the grant (+ handoff generation/reserve-floor bookkeeping on a fresh
--    heartbeat) so other nodes' heartbeats see it committed.
local gen = priorGen
if handoff then
  if fresh then
    local newGen = priorGen
    if share ~= priorShare then newGen = priorGen + 1 end
    local newUnacked = (priorUnacked > share and priorUnacked or share)
    if appliedGen >= newGen then newUnacked = share end
    gen = newGen
    redis.call('HSET', KEYS[1], nodeId, encode(lLocal, useInflight, expiresAt, share, newGen, newMaxSeq, newUnacked))
  else
    -- stale heartbeat: return current committed share/gen; state carried in step 1.
    share = priorShare
    gen = priorGen
  end
else
  redis.call('HSET', KEYS[1], nodeId, encode(lLocal, inflight, expiresAt, share, 0, 0, 0))
end

-- 7. GC PEXPIRE (longest-lived member outlives the key); return {share,lGlobal,N,gen}
local pexp = maxExpiresAt - now
if pexp < 1 then pexp = 1 end
redis.call('PEXPIRE', KEYS[1], pexp)

return { share, lGlobal, N, gen }`;

/** Atomic LEAVE script (DESIGN §10.2): `HDEL key nodeId`. */
const HDEL_LUA = `return redis.call('HDEL', KEYS[1], ARGV[1])`;

function isNoScript(err: unknown): boolean {
  return err instanceof Error && /NOSCRIPT/.test(err.message);
}

export class RedisConcurrencyCoordinator implements ConcurrencyCoordinator {
  readonly #client: RedisClientLike;
  readonly #aggregate: "min" | "median";
  readonly #prefix: string;
  readonly #acknowledgedHandoff: boolean;
  readonly #shaCache = new Map<string, string>();

  constructor(options: RedisConcurrencyCoordinatorOptions) {
    this.#client = options.client;
    this.#aggregate = options.aggregate ?? "median";
    this.#prefix = options.prefix ?? DEFAULT_PREFIX;
    this.#acknowledgedHandoff = options.acknowledgedHandoff ?? false;
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
          // Acknowledged handoff (D-DAC-19). -1 sentinels for an old guard that
          // doesn't echo seq/appliedGen ⇒ the script treats it as always-fresh and
          // never resets its reserve floor (the SAFE, over-reserving direction).
          report.seq ?? -1,
          report.appliedGen ?? -1,
          this.#acknowledgedHandoff ? "1" : "0",
        ],
      );
      const arr = raw as [number, number, number, number];
      return {
        share: Number(arr[0]),
        lGlobal: Number(arr[1]),
        nodes: Number(arr[2]),
        ...(this.#acknowledgedHandoff ? { gen: Number(arr[3]) } : {}),
      };
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
