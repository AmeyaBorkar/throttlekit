import { LUA_NOW } from "../core/lua";
import type { LuaProgram, Strategy, StrategyOutcome } from "../core/types";
import { requirePositive } from "../core/validate";

export interface FixedWindowOptions {
  /** Maximum requests admitted within each window. */
  limit: number;
  /** Window width in ms. Windows are aligned to epoch: `floor(now/windowMs)*windowMs`. */
  windowMs: number;
}

/** Per-key state: the active window's start (epoch-ms) and the count consumed within it. */
interface FixedWindowState {
  /** Epoch-ms start of the window this count belongs to. */
  start: number;
  /** Units consumed in the window starting at `start`. */
  count: number;
}

/**
 * Atomic Redis form. ARGV: now, limit, windowMs, cost. Both this script and the JS `check`
 * compute the same epoch-aligned `windowStart = floor(now/windowMs)*windowMs` and apply the same
 * rounding, so their decisions are bit-identical (see docs/DESIGN-NOTES.md). State lives in a
 * HASH (`s` = window start, `c` = count); both are integers and stored directly.
 */
const FIXED_WINDOW_LUA = `${LUA_NOW}
local limit = tonumber(ARGV[2])
local window = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local window_start = math.floor(now / window) * window
local reset_at = window_start + window
local h = redis.call('HMGET', KEYS[1], 's', 'c')
local start = tonumber(h[1])
local count = tonumber(h[2])
if start == nil or start ~= window_start then count = 0 end
if count + cost <= limit then
  local new_count = count + cost
  redis.call('HSET', KEYS[1], 's', window_start, 'c', new_count)
  local px = math.ceil(reset_at - now)
  if px < 1 then px = 1 end
  redis.call('PEXPIRE', KEYS[1], px)
  return {1, limit, limit - new_count, reset_at, 0}
end
local remaining = limit - count
if remaining < 0 then remaining = 0 end
return {0, limit, remaining, reset_at, math.ceil(reset_at - now)}`;

/**
 * Fixed window counter — counts requests within fixed, epoch-aligned windows of `windowMs`,
 * denying once `limit` is reached. O(1) memory, trivially cheap.
 *
 * Documented property: because windows reset on hard boundaries, a client can spend the full
 * `limit` at the end of one window and another full `limit` at the start of the next, admitting
 * up to **2×limit** requests across a single boundary. (For smooth pacing use GCRA or token
 * bucket; for boundary-free accuracy use a sliding window.) As with the other strategies, a
 * denied request does not consume — `remaining` stays meaningful.
 */
export function fixedWindow(options: FixedWindowOptions): Strategy<FixedWindowState> {
  requirePositive("fixedWindow.limit", options.limit);
  requirePositive("fixedWindow.windowMs", options.windowMs);

  const limit = options.limit;
  const windowMs = options.windowMs;
  const ttlMs = windowMs;

  const lua: LuaProgram = {
    script: FIXED_WINDOW_LUA,
    buildKeys: (key) => [key],
    buildArgv: (nowArg, cost) => [nowArg, limit, windowMs, cost],
  };

  return {
    name: "fixedWindow",
    limit,
    windowMs,
    ttlMs,
    lua,
    check(
      state: FixedWindowState | undefined,
      now: number,
      cost: number,
    ): StrategyOutcome<FixedWindowState> {
      const windowStart = Math.floor(now / windowMs) * windowMs;
      const resetAt = windowStart + windowMs;
      // Missing state, or a stale window, both mean a fresh count of 0.
      const count = state && state.start === windowStart ? state.count : 0;

      if (count + cost <= limit) {
        const newCount = count + cost;
        return {
          state: { start: windowStart, count: newCount },
          decision: {
            allowed: true,
            limit,
            remaining: Math.max(0, Math.floor(limit - newCount)),
            resetAt: Math.ceil(resetAt),
            retryAfterMs: 0,
          },
          // Tighten the persisted TTL to exactly the remaining window.
          ttlMs: Math.max(1, resetAt - now),
          persist: true,
        };
      }

      return {
        state,
        decision: {
          allowed: false,
          limit,
          remaining: Math.max(0, Math.floor(limit - count)),
          resetAt: Math.ceil(resetAt),
          retryAfterMs: Math.ceil(resetAt - now),
        },
        ttlMs,
        persist: false,
      };
    },
  };
}
