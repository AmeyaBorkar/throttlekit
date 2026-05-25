import type { Decision } from "./types";

/**
 * Shared Lua preamble. Resolves `now` (epoch-ms) from `ARGV[1]`; the sentinel `0` means "use
 * the Redis server clock" so node clock skew never corrupts shared state. Scripts that include
 * this compute every returned field from this `now`, keeping replies self-consistent.
 */
export const LUA_NOW = `local now = tonumber(ARGV[1])
if now == 0 then
  local t = redis.call('TIME')
  now = t[1] * 1000 + math.floor(t[2] / 1000)
end`;

/**
 * Decode the standard ThrottleKit reply tuple `[allowed, limit, remaining, resetAt,
 * retryAfterMs]` (all integers) into a {@link Decision}. Shared by every Lua strategy.
 */
export function decodeDecision(raw: unknown): Decision {
  const a = raw as [number, number, number, number, number];
  return {
    allowed: a[0] === 1,
    limit: a[1],
    remaining: a[2],
    resetAt: a[3],
    retryAfterMs: a[4],
  };
}
