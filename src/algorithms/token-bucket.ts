import { LUA_NOW } from "../core/lua";
import type { LuaProgram, Strategy, StrategyOutcome } from "../core/types";
import { requirePositive } from "../core/validate";

export interface TokenBucketOptions {
  /** Bucket capacity: the maximum tokens held, and the largest instantaneous burst. */
  capacity: number;
  /** Sustained refill rate in tokens per second (may be fractional). */
  refillPerSec: number;
}

/** Per-key state: the current token count and the epoch-ms of the last refill. */
interface TokenBucketState {
  /** Tokens available (fractional; lazily refilled on each check). */
  tokens: number;
  /** Epoch-ms the `tokens` figure was last brought current. */
  last: number;
}

/**
 * Atomic Redis form. ARGV: now, capacity, refillPerSec, cost. Both this script and the JS
 * `check` derive `refillPerMs = refillPerSec / 1000` from the same input and apply the same
 * rounding, so their decisions are bit-identical (see docs/DESIGN-NOTES.md). State lives in a
 * HASH (`t` = tokens, `l` = last); the fractional token count is stored via `%.17g` so it
 * round-trips through Redis exactly.
 */
const TOKEN_BUCKET_LUA = `${LUA_NOW}
local capacity = tonumber(ARGV[2])
local refill_per_sec = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local refill_per_ms = refill_per_sec / 1000
local h = redis.call('HMGET', KEYS[1], 't', 'l')
local tokens = tonumber(h[1])
local last = tonumber(h[2])
if tokens == nil then tokens = capacity end
if last == nil then last = now end
local elapsed = now - last
if elapsed < 0 then elapsed = 0 end
tokens = tokens + elapsed * refill_per_ms
if tokens > capacity then tokens = capacity end
local ttl = math.ceil(capacity / refill_per_ms)
if ttl < 1 then ttl = 1 end
if tokens >= cost then
  local new_tokens = tokens - cost
  local remaining = math.floor(new_tokens)
  if remaining < 0 then remaining = 0 end
  redis.call('HSET', KEYS[1], 't', string.format('%.17g', new_tokens), 'l', string.format('%.17g', now))
  redis.call('PEXPIRE', KEYS[1], ttl)
  return {1, capacity, remaining, now + math.ceil((capacity - new_tokens) / refill_per_ms), 0}
end
local remaining = math.floor(tokens)
if remaining < 0 then remaining = 0 end
return {0, capacity, remaining, now + math.ceil((capacity - tokens) / refill_per_ms), math.ceil((cost - tokens) / refill_per_ms)}`;

/**
 * Token bucket — a bucket of `capacity` tokens refilled continuously at `refillPerSec`. A check
 * succeeds when at least `cost` tokens are present and consumes them; otherwise it is denied and
 * nothing is consumed. Lazily refilled (no background timer), O(1) memory and CPU. Reports an
 * explicit token count, unlike GCRA. See docs/DESIGN-NOTES.md for the verified math.
 */
export function tokenBucket(options: TokenBucketOptions): Strategy<TokenBucketState> {
  requirePositive("tokenBucket.capacity", options.capacity);
  requirePositive("tokenBucket.refillPerSec", options.refillPerSec);

  const capacity = options.capacity;
  const refillPerSec = options.refillPerSec;
  const refillPerMs = refillPerSec / 1000; // tokens per ms; identical division in JS and Lua
  const ttlMs = Math.max(1, Math.ceil(capacity / refillPerMs)); // time to refill from empty

  const lua: LuaProgram = {
    script: TOKEN_BUCKET_LUA,
    buildKeys: (key) => [key],
    buildArgv: (nowArg, cost) => [nowArg, capacity, refillPerSec, cost],
  };

  return {
    name: "tokenBucket",
    limit: capacity,
    windowMs: ttlMs,
    ttlMs,
    lua,
    check(
      state: TokenBucketState | undefined,
      now: number,
      cost: number,
    ): StrategyOutcome<TokenBucketState> {
      // Cold start: a full bucket as of `now`.
      const prevTokens = state?.tokens ?? capacity;
      const last = state?.last ?? now;
      const elapsed = now > last ? now - last : 0; // max(0, now - last): jump-safe
      const tokens = Math.min(capacity, prevTokens + elapsed * refillPerMs);

      if (tokens >= cost) {
        const newTokens = tokens - cost;
        let remaining = Math.floor(newTokens);
        if (remaining < 0) remaining = 0;
        return {
          state: { tokens: newTokens, last: now },
          decision: {
            allowed: true,
            limit: capacity,
            remaining,
            resetAt: now + Math.ceil((capacity - newTokens) / refillPerMs),
            retryAfterMs: 0,
          },
          ttlMs,
          persist: true,
        };
      }

      let remaining = Math.floor(tokens);
      if (remaining < 0) remaining = 0;
      return {
        state,
        decision: {
          allowed: false,
          limit: capacity,
          remaining,
          resetAt: now + Math.ceil((capacity - tokens) / refillPerMs),
          retryAfterMs: Math.ceil((cost - tokens) / refillPerMs),
        },
        ttlMs,
        persist: false,
      };
    },
  };
}
