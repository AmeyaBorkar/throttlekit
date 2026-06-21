import { LUA_NOW } from "../core/lua";
import type {
  Decision,
  Forecast,
  LuaProgram,
  ReadState,
  Strategy,
  StrategyOutcome,
} from "../core/types";
import { requirePositive } from "../core/validate";

/** Read-only Lua for non-consuming introspection: returns all timestamps with scores (no write). */
const SLIDING_LOG_READ_LUA = "return redis.call('ZRANGE', KEYS[1], 0, -1, 'WITHSCORES')";

export interface SlidingWindowLogOptions {
  /** Maximum accepted units within any trailing `windowMs`. */
  limit: number;
  /** The rolling window length, in ms. */
  windowMs: number;
}

/**
 * Atomic Redis form backed by a sorted set: prune expired scores, count, and (on allow) add `cost`
 * members at score `now`. Member names are `now-<rank>` where rank derives from the live count, so
 * they are unique without any non-deterministic command. The decision depends only on the multiset
 * of scores, which matches the JS array exactly.
 */
const SLIDING_LOG_LUA = `${LUA_NOW}
local windowMs = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
-- A log stores one stamp per unit, so a fractional cost is charged as whole units (ceil) — matching the
-- JS path. Charging the raw fractional cost would ZADD floor(cost) members (and 0 for cost < 1), diverging
-- from JS and over-admitting.
local units = math.ceil(cost)
local key = KEYS[1]
local windowStart = now - windowMs
redis.call('ZREMRANGEBYSCORE', key, '-inf', windowStart)
local count = redis.call('ZCARD', key)
if count + units <= limit then
  for i = 1, units do
    redis.call('ZADD', key, now, now .. '-' .. (count + i))
  end
  local px = math.ceil(windowMs)
  if px < 1 then px = 1 end
  redis.call('PEXPIRE', key, px)
  local first = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local oldest = now
  if first[2] then oldest = tonumber(first[2]) end
  local remaining = limit - (count + units)
  if remaining < 0 then remaining = 0 end
  return {1, limit, remaining, math.ceil(oldest + windowMs), 0}
end
local retry
if count == 0 then
  retry = windowMs
else
  local kMin = count + units - limit
  if kMin < 1 then kMin = 1 end
  if kMin > count then kMin = count end
  local ref = redis.call('ZRANGE', key, kMin - 1, kMin - 1, 'WITHSCORES')
  local refScore = now
  if ref[2] then refScore = tonumber(ref[2]) end
  retry = math.ceil(refScore + windowMs - now)
  if retry < 1 then retry = 1 end
end
local firstD = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local oldestD = now
if firstD[2] then oldestD = tonumber(firstD[2]) end
local remaining = limit - count
if remaining < 0 then remaining = 0 end
return {0, limit, remaining, math.ceil(oldestD + windowMs), retry}`;

/**
 * Sliding window log — exact "N accepted in the trailing window". Stores the timestamp of every
 * accepted unit and counts those within `windowMs`. O(limit) memory per key; use for low/moderate
 * limits where precision matters (e.g. 5 password resets / hour). See docs/DESIGN-NOTES.md.
 */
export function slidingWindowLog(options: SlidingWindowLogOptions): Strategy<number[]> {
  requirePositive("slidingWindowLog.limit", options.limit);
  requirePositive("slidingWindowLog.windowMs", options.windowMs);
  const limit = options.limit;
  const windowMs = options.windowMs;

  const lua: LuaProgram = {
    script: SLIDING_LOG_LUA,
    buildKeys: (key) => [key],
    buildArgv: (nowArg, cost) => [nowArg, windowMs, limit, cost],
  };

  return {
    name: "slidingWindowLog",
    limit,
    windowMs,
    ttlMs: windowMs,
    lua,
    check(state: number[] | undefined, now: number, cost: number): StrategyOutcome<number[]> {
      const windowStart = now - windowMs;
      const prev = state ?? [];
      // Timestamps are ascending, so survivors are a suffix: skip the stale prefix by index, with
      // no filter closure and no intermediate array.
      let firstLive = 0;
      while (firstLive < prev.length && (prev[firstLive] as number) <= windowStart) firstLive++;
      const count = prev.length - firstLive;
      // A log stores one timestamp per unit, so a fractional cost is charged as whole units (ceil) on BOTH
      // backends — otherwise the JS `for i<cost` loop (ceil-toward) and the Lua `for i=1,cost` loop
      // (floor-toward) would persist a different stamp count for the same cost, splitting state across
      // MemoryStore and Redis (and `cost < 1` would ZADD nothing in Lua → unbounded admission).
      const units = Math.ceil(cost);

      if (count + units <= limit) {
        // One copy of the survivors, then append `units` stamps — no filter array, no second copy.
        const newLog = prev.slice(firstLive);
        for (let i = 0; i < units; i++) newLog.push(now);
        const oldest = newLog.length > 0 ? (newLog[0] as number) : now;
        let remaining = limit - (count + units);
        if (remaining < 0) remaining = 0;
        return {
          state: newLog,
          result: {
            allowed: true,
            limit,
            remaining,
            resetAt: Math.ceil(oldest + windowMs),
            retryAfterMs: 0,
          },
          ttlMs: windowMs,
          persist: true,
        };
      }

      // Denied: index into the survivors directly (prev[firstLive..]) — no allocation.
      let retryAfterMs: number;
      if (count === 0) {
        retryAfterMs = windowMs; // cost exceeds limit: unsatisfiable in one window
      } else {
        let kMin = count + units - limit;
        if (kMin < 1) kMin = 1;
        if (kMin > count) kMin = count;
        const ref = prev[firstLive + kMin - 1] ?? now;
        retryAfterMs = Math.ceil(ref + windowMs - now);
        if (retryAfterMs < 1) retryAfterMs = 1;
      }
      const oldest = count > 0 ? (prev[firstLive] as number) : now;
      let remaining = limit - count;
      if (remaining < 0) remaining = 0;
      return {
        state,
        result: {
          allowed: false,
          limit,
          remaining,
          resetAt: Math.ceil(oldest + windowMs),
          retryAfterMs,
        },
        ttlMs: windowMs,
        persist: false,
      };
    },
    peek(state: number[] | undefined, now: number): Decision {
      const windowStart = now - windowMs;
      const prev = state ?? [];
      let firstLive = 0;
      while (firstLive < prev.length && (prev[firstLive] as number) <= windowStart) firstLive++;
      const count = prev.length - firstLive;
      const oldest = count > 0 ? (prev[firstLive] as number) : now;
      const resetAt = Math.ceil(oldest + windowMs);
      const remaining = Math.max(0, limit - count);

      if (count + 1 <= limit) {
        return { allowed: true, limit, remaining, resetAt, retryAfterMs: 0 };
      }
      let retryAfterMs: number;
      if (count === 0) {
        retryAfterMs = windowMs;
      } else {
        let kMin = count + 1 - limit;
        if (kMin < 1) kMin = 1;
        if (kMin > count) kMin = count;
        const ref = prev[firstLive + kMin - 1] ?? now;
        retryAfterMs = Math.ceil(ref + windowMs - now);
        if (retryAfterMs < 1) retryAfterMs = 1;
      }
      return { allowed: false, limit, remaining, resetAt, retryAfterMs };
    },
    forecast(state: number[] | undefined, now: number, cost: number): Forecast {
      const windowStart = now - windowMs;
      const prev = state ?? [];
      let firstLive = 0;
      while (firstLive < prev.length && (prev[firstLive] as number) <= windowStart) firstLive++;
      const count = prev.length - firstLive;
      const available = Math.max(0, limit - count);
      const hasLive = count > 0;
      // Capacity returns as each stamp ages out: the oldest frees one unit, the newest frees the last.
      return {
        spendableNow: Math.floor(available / cost),
        nextReplenishAt: hasLive ? Math.ceil((prev[firstLive] as number) + windowMs) : now,
        fullAt: hasLive ? Math.ceil((prev[prev.length - 1] as number) + windowMs) : now,
      };
    },
    readState: {
      lua: { script: SLIDING_LOG_READ_LUA, buildKeys: (key) => [key], buildArgv: () => [] },
      decode: (raw: unknown): number[] | undefined => {
        const flat = raw as string[] | null;
        if (flat == null || flat.length === 0) return undefined;
        // ZRANGE … WITHSCORES → [member, score, …] ascending by score; keep the scores.
        const out: number[] = [];
        for (let k = 1; k < flat.length; k += 2) out.push(Number(flat[k]));
        return out;
      },
    } satisfies ReadState<number[]>,
  };
}
