import { LUA_NOW } from "../core/lua";
import type { LuaProgram, Strategy, StrategyOutcome } from "../core/types";
import { requirePositive } from "../core/validate";

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
local key = KEYS[1]
local windowStart = now - windowMs
redis.call('ZREMRANGEBYSCORE', key, '-inf', windowStart)
local count = redis.call('ZCARD', key)
if count + cost <= limit then
  for i = 1, cost do
    redis.call('ZADD', key, now, now .. '-' .. (count + i))
  end
  redis.call('PEXPIRE', key, windowMs)
  local first = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local oldest = now
  if first[2] then oldest = tonumber(first[2]) end
  local remaining = limit - (count + cost)
  if remaining < 0 then remaining = 0 end
  return {1, limit, remaining, math.ceil(oldest + windowMs), 0}
end
local retry
if count == 0 then
  retry = windowMs
else
  local kMin = count + cost - limit
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
      const log = (state ?? []).filter((ts) => ts > windowStart); // ascending; survivors only
      const count = log.length;

      if (count + cost <= limit) {
        const newLog = log.slice();
        for (let i = 0; i < cost; i++) newLog.push(now);
        const oldest = newLog.length > 0 ? (newLog[0] as number) : now;
        let remaining = limit - (count + cost);
        if (remaining < 0) remaining = 0;
        return {
          state: newLog,
          decision: {
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

      let retryAfterMs: number;
      if (count === 0) {
        retryAfterMs = windowMs; // cost exceeds limit: unsatisfiable in one window
      } else {
        let kMin = count + cost - limit;
        if (kMin < 1) kMin = 1;
        if (kMin > count) kMin = count;
        const ref = log[kMin - 1] ?? now;
        retryAfterMs = Math.ceil(ref + windowMs - now);
        if (retryAfterMs < 1) retryAfterMs = 1;
      }
      const oldest = count > 0 ? (log[0] as number) : now;
      let remaining = limit - count;
      if (remaining < 0) remaining = 0;
      return {
        state,
        decision: {
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
  };
}
