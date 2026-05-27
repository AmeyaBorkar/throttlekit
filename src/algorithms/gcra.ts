import { LUA_NOW } from "../core/lua";
import type { Decision, LuaProgram, ReadState, Strategy, StrategyOutcome } from "../core/types";
import { requireAtLeast, requirePositive } from "../core/validate";

/** Read-only Lua for non-consuming introspection: returns the stored TAT string (no write). */
const GCRA_READ_LUA = "return redis.call('GET', KEYS[1])";

export interface GcraOptions {
  /** Sustained rate: requests per `periodMs`. */
  limit: number;
  /** The period over which `limit` applies, in ms. */
  periodMs: number;
  /**
   * Maximum requests admissible instantaneously from a cold/idle state (the burst allowance).
   * Defaults to `limit`. A cold bucket admits exactly `burst` requests, then paces at `1/T`;
   * request `burst + 1` is denied. (Note: a request whose `cost` exceeds `burst` can never be
   * satisfied.)
   */
  burst?: number;
}

/**
 * Atomic Redis form. ARGV: now, periodMs, limit, burst, cost. Both this script and the JS
 * `check` derive `T`, `tau`, and `inc` from the same integer inputs and apply the same rounding,
 * so their decisions are bit-identical (see docs/DESIGN-NOTES.md). The TAT is stored at full
 * double precision via `%.17g` so it round-trips through Redis exactly.
 */
const GCRA_LUA = `${LUA_NOW}
local period = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local burst = tonumber(ARGV[4])
local cost = tonumber(ARGV[5])
local T = period / limit
local tau = T * burst
local inc = T * cost
local tat = tonumber(redis.call('GET', KEYS[1]) or now)
if tat < now then tat = now end
local new_tat = tat + inc
local allow_at = new_tat - tau
if now < allow_at then
  local remaining = math.floor((tau - (tat - now)) / T)
  if remaining < 0 then remaining = 0 end
  return {0, burst, remaining, math.ceil(tat), math.ceil(allow_at - now)}
end
local remaining = math.floor((tau - (new_tat - now)) / T)
if remaining < 0 then remaining = 0 end
local px = math.ceil(new_tat - now)
if px < 1 then px = 1 end
redis.call('SET', KEYS[1], string.format('%.17g', new_tat), 'PX', px)
return {1, burst, remaining, math.ceil(new_tat), 0}`;

/**
 * GCRA (Generic Cell Rate Algorithm) — the default strategy. Tracks a single number per key
 * (the theoretical arrival time), paces traffic smoothly with a configurable burst, and costs
 * O(1) memory and CPU. See docs/DESIGN-NOTES.md for the verified math and citations.
 */
export function gcra(options: GcraOptions): Strategy<number> {
  requirePositive("gcra.limit", options.limit);
  requirePositive("gcra.periodMs", options.periodMs);
  const burst = options.burst ?? options.limit;
  requireAtLeast("gcra.burst", burst, 1);

  const period = options.periodMs;
  const limit = options.limit;
  const T = period / limit; // emission interval (ms per request)
  const tau = T * burst; // burst tolerance window
  const ttlMs = Math.ceil(tau);

  const lua: LuaProgram = {
    script: GCRA_LUA,
    buildKeys: (key) => [key],
    buildArgv: (nowArg, cost) => [nowArg, period, limit, burst, cost],
  };

  return {
    name: "gcra",
    limit: burst,
    windowMs: period,
    ttlMs,
    lua,
    check(state: number | undefined, now: number, cost: number): StrategyOutcome<number> {
      const inc = T * cost;
      const tat = state ?? now;
      const tatEff = tat > now ? tat : now; // max(tat, now): jump-safe
      const newTat = tatEff + inc;
      const allowAt = newTat - tau;

      if (now < allowAt) {
        let remaining = Math.floor((tau - (tatEff - now)) / T);
        if (remaining < 0) remaining = 0;
        return {
          state,
          result: {
            allowed: false,
            limit: burst,
            remaining,
            resetAt: Math.ceil(tatEff),
            retryAfterMs: Math.ceil(allowAt - now),
          },
          ttlMs,
          persist: false,
        };
      }

      let remaining = Math.floor((tau - (newTat - now)) / T);
      if (remaining < 0) remaining = 0;
      return {
        state: newTat,
        result: {
          allowed: true,
          limit: burst,
          remaining,
          resetAt: Math.ceil(newTat),
          retryAfterMs: 0,
        },
        ttlMs: Math.max(1, Math.ceil(newTat - now)),
        persist: true,
      };
    },
    peek(state: number | undefined, now: number): Decision {
      const tat = state ?? now;
      const tatEff = tat > now ? tat : now;
      let remaining = Math.floor((tau - (tatEff - now)) / T);
      if (remaining < 0) remaining = 0;
      const allowed = remaining >= 1; // a cost-1 request would be admitted
      return {
        allowed,
        limit: burst,
        remaining,
        resetAt: Math.ceil(tatEff), // full burst restored once `now` catches up to the TAT
        retryAfterMs: allowed ? 0 : Math.ceil(tatEff + T - tau - now),
      };
    },
    readState: {
      lua: { script: GCRA_READ_LUA, buildKeys: (key) => [key], buildArgv: () => [] },
      decode: (raw: unknown): number | undefined =>
        raw === null || raw === undefined ? undefined : Number(raw),
    } satisfies ReadState<number>,
  };
}
