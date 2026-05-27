import { LUA_NOW } from "../core/lua";
import type { LuaProgram, Strategy, StrategyOutcome } from "../core/types";
import { requireInteger, requirePositive } from "../core/validate";
import { type CalendarCadence, MS_PER_DAY, calendarPeriod } from "./calendar";
import { slidingWindow } from "./sliding-window";

/** How a {@link quota}'s budget resets. */
export type QuotaCadence = CalendarCadence | "fixed" | "rolling";

export interface QuotaOptions {
  /** Units admitted per billing period. */
  limit: number;
  /**
   * When the budget resets:
   * - `"calendar-month"` — on the 1st of each civil month (the canonical "1M calls/month" quota);
   * - `"calendar-week"` — on `weekStartsOn` each week;
   * - `"calendar-day"` — at local midnight;
   * - `"fixed"` — every `periodMs` from `anchor` (epoch-aligned by default);
   * - `"rolling"` — a trailing `periodMs` window (delegates to {@link slidingWindow}).
   */
  resetCadence: QuotaCadence;
  /** Period width in ms. Required for `"fixed"` and `"rolling"`; ignored by calendar cadences. */
  periodMs?: number;
  /** `"fixed"` windows align to this epoch-ms anchor. Default `0` (epoch-aligned). */
  anchor?: number;
  /**
   * Fixed UTC offset, in minutes, applied to calendar cadences (e.g. `330` for IST, `-300` for
   * EST). Default `0` (UTC). This is a **fixed offset, not a DST-aware zone** — see {@link
   * calendarPeriod}; a fixed offset is the only calendar math reproducible bit-identically in the
   * Redis Lua form.
   */
  offsetMinutes?: number;
  /** For `"calendar-week"`, the weekday the week starts on (`0`=Sun … `6`=Sat). Default `1` (Mon). */
  weekStartsOn?: number;
  /** For `"rolling"`, the number of sub-buckets (accuracy vs memory). Default `10`. */
  buckets?: number;
}

/** Per-key state: the active period's start (epoch-ms) and the units consumed within it. */
interface QuotaState {
  /** Epoch-ms start of the period this count belongs to. */
  start: number;
  /** Units consumed in the period starting at `start`. */
  count: number;
}

const MODE = { "calendar-month": 1, "calendar-week": 2, "calendar-day": 3, fixed: 4 } as const;

/**
 * Atomic Redis form for the windowed-counter cadences (calendar-* and fixed). It recomputes the
 * very same `[period_start, reset_at)` boundary the JS path computes — including the civil-calendar
 * arithmetic for monthly resets — from `now` alone, so the two paths are bit-identical even when the
 * store substitutes the Redis server clock. State lives in a HASH (`s` = period start, `c` = count).
 *
 * ARGV: now, limit, cost, mode(1..4), periodMs, anchor, offsetMs, weekStartsOn.
 */
const QUOTA_LUA = `${LUA_NOW}
local limit = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local mode = tonumber(ARGV[4])
local periodMs = tonumber(ARGV[5])
local anchor = tonumber(ARGV[6])
local offsetMs = tonumber(ARGV[7])
local weekStartsOn = tonumber(ARGV[8])
local DAY = 86400000
local function days_from_civil(y, m, d)
  local yy = y - (m <= 2 and 1 or 0)
  local era = math.floor((yy >= 0 and yy or (yy - 399)) / 400)
  local yoe = yy - era * 400
  local doy = math.floor((153 * (m + (m > 2 and -3 or 9)) + 2) / 5) + d - 1
  local doe = yoe * 365 + math.floor(yoe / 4) - math.floor(yoe / 100) + doy
  return era * 146097 + doe - 719468
end
local function civil_from_days(z)
  local zz = z + 719468
  local era = math.floor((zz >= 0 and zz or (zz - 146096)) / 146097)
  local doe = zz - era * 146097
  local yoe = math.floor((doe - math.floor(doe / 1460) + math.floor(doe / 36524) - math.floor(doe / 146096)) / 365)
  local y = yoe + era * 400
  local doy = doe - (365 * yoe + math.floor(yoe / 4) - math.floor(yoe / 100))
  local mp = math.floor((5 * doy + 2) / 153)
  local m = mp < 10 and (mp + 3) or (mp - 9)
  if m <= 2 then y = y + 1 end
  return y, m
end
local period_start
local reset_at
if mode == 4 then
  local k = math.floor((now - anchor) / periodMs)
  period_start = anchor + k * periodMs
  reset_at = period_start + periodMs
else
  local localnow = now + offsetMs
  local day = math.floor(localnow / DAY)
  if mode == 3 then
    period_start = day * DAY - offsetMs
    reset_at = (day + 1) * DAY - offsetMs
  elseif mode == 2 then
    local dow = (day + 4) % 7
    local shift = (dow - weekStartsOn) % 7
    local start_day = day - shift
    period_start = start_day * DAY - offsetMs
    reset_at = (start_day + 7) * DAY - offsetMs
  else
    local y, m = civil_from_days(day)
    local start_day = days_from_civil(y, m, 1)
    local ny = m == 12 and (y + 1) or y
    local nm = m == 12 and 1 or (m + 1)
    local reset_day = days_from_civil(ny, nm, 1)
    period_start = start_day * DAY - offsetMs
    reset_at = reset_day * DAY - offsetMs
  end
end
local h = redis.call('HMGET', KEYS[1], 's', 'c')
local start = tonumber(h[1])
local count = tonumber(h[2])
if start == nil or start ~= period_start then count = 0 end
if count + cost <= limit then
  local new_count = count + cost
  redis.call('HSET', KEYS[1], 's', period_start, 'c', new_count)
  local px = math.ceil(reset_at - now)
  if px < 1 then px = 1 end
  redis.call('PEXPIRE', KEYS[1], px)
  return {1, limit, limit - new_count, reset_at, 0}
end
local remaining = limit - count
if remaining < 0 then remaining = 0 end
return {0, limit, remaining, reset_at, math.ceil(reset_at - now)}`;

/**
 * First-class billing-period **quota** — a budget that resets on a real calendar boundary, distinct
 * from a sliding rate limit. The motivating case is "1,000,000 calls/month, resetting on the 1st":
 * `Decision.remaining` is the quota left this period and `Decision.resetAt` is the *true* next
 * boundary (the next civil 1st, leap-year-correct), not an approximation.
 *
 * Runs the pure {@link Strategy} contract (`check` + atomic Lua) so it is bit-identical on every
 * store. Calendar boundaries are computed at a fixed UTC offset (`offsetMinutes`); see {@link
 * calendarPeriod} for why DST-aware zones are out of scope. The `"rolling"` cadence delegates to the
 * proven {@link slidingWindow}. As with the other strategies, a denied request never consumes —
 * `remaining` stays meaningful.
 */
export function quota(options: QuotaOptions): Strategy {
  requirePositive("quota.limit", options.limit);
  const limit = options.limit;
  const cadence = options.resetCadence;

  if (cadence === "rolling") {
    requirePositive("quota.periodMs", options.periodMs as number);
    const sw = slidingWindow({
      limit,
      windowMs: options.periodMs as number,
      buckets: options.buckets ?? 10,
    });
    // Same trailing-window math as slidingWindow, surfaced under the quota policy name.
    return { ...sw, name: "quota" };
  }

  // Narrow once into a local so the nested closures below keep the non-"rolling" type (TS resets
  // control-flow narrowing of an outer variable at every function boundary).
  const cal: CalendarCadence | "fixed" = cadence;
  const offsetMs = (options.offsetMinutes ?? 0) * 60_000;
  const weekStartsOn = options.weekStartsOn ?? 1;
  const anchor = options.anchor ?? 0;
  let periodMs = 0;

  if (options.offsetMinutes !== undefined) {
    requireInteger("quota.offsetMinutes", options.offsetMinutes);
    if (options.offsetMinutes < -840 || options.offsetMinutes > 840) {
      throw new RangeError("quota.offsetMinutes must be within ±840 (±14h)");
    }
  }
  if (options.weekStartsOn !== undefined) {
    requireInteger("quota.weekStartsOn", options.weekStartsOn);
    if (options.weekStartsOn < 0 || options.weekStartsOn > 6) {
      throw new RangeError("quota.weekStartsOn must be 0..6 (0=Sun … 6=Sat)");
    }
  }
  if (options.anchor !== undefined) requireInteger("quota.anchor", options.anchor);
  if (cal === "fixed") {
    requirePositive("quota.periodMs", options.periodMs as number);
    periodMs = options.periodMs as number;
  }

  const mode = MODE[cal];
  const ttlMs =
    cal === "calendar-month"
      ? 31 * MS_PER_DAY
      : cal === "calendar-week"
        ? 7 * MS_PER_DAY
        : cal === "calendar-day"
          ? MS_PER_DAY
          : periodMs;

  const bounds = (now: number): { start: number; reset: number } => {
    if (cal === "fixed") {
      const start = anchor + Math.floor((now - anchor) / periodMs) * periodMs;
      return { start, reset: start + periodMs };
    }
    return calendarPeriod(cal, now, offsetMs, weekStartsOn);
  };

  const lua: LuaProgram = {
    script: QUOTA_LUA,
    buildKeys: (key) => [key],
    buildArgv: (nowArg, cost) => [
      nowArg,
      limit,
      cost,
      mode,
      periodMs,
      anchor,
      offsetMs,
      weekStartsOn,
    ],
  };

  const check = (
    state: QuotaState | undefined,
    now: number,
    cost: number,
  ): StrategyOutcome<QuotaState> => {
    const { start, reset } = bounds(now);
    const resetAt = Math.ceil(reset);
    const count = state && state.start === start ? state.count : 0;

    if (count + cost <= limit) {
      const newCount = count + cost;
      return {
        state: { start, count: newCount },
        result: {
          allowed: true,
          limit,
          remaining: Math.max(0, Math.floor(limit - newCount)),
          resetAt,
          retryAfterMs: 0,
        },
        ttlMs: Math.max(1, reset - now),
        persist: true,
      };
    }

    return {
      state,
      result: {
        allowed: false,
        limit,
        remaining: Math.max(0, Math.floor(limit - count)),
        resetAt,
        retryAfterMs: Math.ceil(reset - now),
      },
      ttlMs,
      persist: false,
    };
  };

  const base: Strategy<QuotaState> = { name: "quota", limit, ttlMs, lua, check };
  // `fixed` has a constant period; surface it as the policy window. Calendar periods vary, so they
  // intentionally report no fixed `windowMs`.
  return cal === "fixed" ? { ...base, windowMs: periodMs } : base;
}
