import { LUA_NOW } from "../core/lua";
import type { LuaProgram, Strategy, StrategyOutcome } from "../core/types";
import { requireAtLeast, requireInteger, requirePositive } from "../core/validate";

export interface SlidingWindowOptions {
  /** Maximum units within any trailing `windowMs`. */
  limit: number;
  /** The rolling window length, in ms. */
  windowMs: number;
  /**
   * Number of sub-buckets the window is divided into. More buckets → smaller approximation error
   * (bounded by ~1/buckets of the window) at O(buckets) memory. Default 10. `buckets: 1` recovers
   * the classic single-previous-window weighted estimator.
   */
  buckets?: number;
}

type Buckets = Record<number, number>;

/**
 * Atomic Redis form. State lives in a HASH used as a ring of `S+1` slots: field `idx % (S+1)`
 * holds `"<idx>:<count>"`, so a slot from an older lap reads as 0. Both paths derive `w`, `c`,
 * `elapsed`, and `weight` from the same integer ARGV with identical float ops and identical clamps,
 * so their decisions match bit-for-bit. retryAfter is an advisory approximation (documented).
 */
const SLIDING_WINDOW_LUA = `${LUA_NOW}
local windowMs = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local S = tonumber(ARGV[5])
local key = KEYS[1]
local w = windowMs / S
local c = math.floor(now / w)
local elapsed = now - c * w
if elapsed < 0 then elapsed = 0 end
local weight = (w - elapsed) / w
if weight < 0 then weight = 0 end
if weight > 1 then weight = 1 end
local slots = S + 1
local function getCount(idx)
  local v = redis.call('HGET', key, idx % slots)
  if not v then return 0 end
  local sep = string.find(v, ':')
  if tonumber(string.sub(v, 1, sep - 1)) ~= idx then return 0 end
  return tonumber(string.sub(v, sep + 1))
end
local full = 0
for j = c - S + 1, c do full = full + getCount(j) end
local oldest = getCount(c - S)
local estimate = full + oldest * weight
local projected = estimate + cost
local resetAt = math.ceil((c + 1) * w + windowMs)
if projected <= limit then
  local cur = getCount(c)
  redis.call('HSET', key, c % slots, c .. ':' .. (cur + cost))
  redis.call('PEXPIRE', key, math.ceil(windowMs + w))
  local remaining = math.floor(limit - projected)
  if remaining < 0 then remaining = 0 end
  return {1, limit, remaining, resetAt, 0}
end
local D = projected - limit
local retry
if oldest > 0 and D <= oldest * weight then
  retry = math.ceil(D * w / oldest)
else
  retry = math.ceil((c + 1) * w - now)
end
if retry < 1 then retry = 1 end
local remaining = math.floor(limit - estimate)
if remaining < 0 then remaining = 0 end
return {0, limit, remaining, resetAt, retry}`;

/**
 * Sliding window counter (sub-bucketed) — near-exact rolling window at any limit with bounded
 * O(buckets) memory. Error is bounded by one bucket (~1/buckets of the window). The sweet spot
 * between fixed window (cheap, 2× error) and the exact log (precise, unbounded memory).
 * See docs/DESIGN-NOTES.md for the estimator and citations.
 */
export function slidingWindow(options: SlidingWindowOptions): Strategy<Buckets> {
  requirePositive("slidingWindow.limit", options.limit);
  requirePositive("slidingWindow.windowMs", options.windowMs);
  const S = options.buckets ?? 10;
  requireInteger("slidingWindow.buckets", S);
  requireAtLeast("slidingWindow.buckets", S, 1);

  const limit = options.limit;
  const windowMs = options.windowMs;
  const w = windowMs / S;

  const lua: LuaProgram = {
    script: SLIDING_WINDOW_LUA,
    buildKeys: (key) => [key],
    buildArgv: (nowArg, cost) => [nowArg, windowMs, limit, cost, S],
  };

  return {
    name: "slidingWindow",
    limit,
    ttlMs: Math.ceil(windowMs + w),
    lua,
    check(state: Buckets | undefined, now: number, cost: number): StrategyOutcome<Buckets> {
      const c = Math.floor(now / w);
      let elapsed = now - c * w;
      if (elapsed < 0) elapsed = 0;
      let weight = (w - elapsed) / w;
      if (weight < 0) weight = 0;
      if (weight > 1) weight = 1;

      const buckets = state ?? {};
      let full = 0;
      for (let j = c - S + 1; j <= c; j++) full += buckets[j] ?? 0;
      const oldest = buckets[c - S] ?? 0;
      const estimate = full + oldest * weight;
      const projected = estimate + cost;
      const resetAt = Math.ceil((c + 1) * w + windowMs);

      if (projected <= limit) {
        const next: Buckets = {};
        for (let j = c - S; j <= c; j++) {
          const v = buckets[j];
          if (v !== undefined) next[j] = v;
        }
        next[c] = (next[c] ?? 0) + cost;
        let remaining = Math.floor(limit - projected);
        if (remaining < 0) remaining = 0;
        return {
          state: next,
          decision: { allowed: true, limit, remaining, resetAt, retryAfterMs: 0 },
          ttlMs: Math.ceil(windowMs + w),
          persist: true,
        };
      }

      const D = projected - limit;
      let retryAfterMs: number;
      if (oldest > 0 && D <= oldest * weight) {
        retryAfterMs = Math.ceil((D * w) / oldest);
      } else {
        retryAfterMs = Math.ceil((c + 1) * w - now);
      }
      if (retryAfterMs < 1) retryAfterMs = 1;
      let remaining = Math.floor(limit - estimate);
      if (remaining < 0) remaining = 0;
      return {
        state,
        decision: { allowed: false, limit, remaining, resetAt, retryAfterMs },
        ttlMs: Math.ceil(windowMs + w),
        persist: false,
      };
    },
  };
}
