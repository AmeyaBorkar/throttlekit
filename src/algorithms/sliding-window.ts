import { LUA_NOW } from "../core/lua";
import type { Decision, LuaProgram, ReadState, Strategy, StrategyOutcome } from "../core/types";
import { requireAtLeast, requireInteger, requirePositive } from "../core/validate";

/** Read-only Lua for non-consuming introspection: returns the whole ring HASH (no write). */
const SLIDING_WINDOW_READ_LUA = "return redis.call('HGETALL', KEYS[1])";

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

/**
 * A fixed ring of `S+1` slots (plain arrays so the JS state JSON-round-trips on the Postgres path).
 * Slot `tick mod (S+1)` holds that tick's count; `i[p]` records which absolute tick owns the slot, so
 * a slot from an older lap reads as 0 — mirroring the Lua HASH ring. Replaces a per-check object rebuild.
 */
interface WindowState {
  /** Absolute tick index owning each slot (−1 = empty; real ticks are ≥ 0). Length S+1. */
  i: number[];
  /** Count at each slot. Length S+1. */
  n: number[];
}

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
export function slidingWindow(options: SlidingWindowOptions): Strategy<WindowState> {
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
    windowMs,
    ttlMs: Math.ceil(windowMs + w),
    lua,
    check(state: WindowState | undefined, now: number, cost: number): StrategyOutcome<WindowState> {
      const c = Math.floor(now / w);
      let elapsed = now - c * w;
      if (elapsed < 0) elapsed = 0;
      let weight = (w - elapsed) / w;
      if (weight < 0) weight = 0;
      if (weight > 1) weight = 1;

      const slots = S + 1;
      const ring: WindowState = state ?? {
        i: new Array<number>(slots).fill(-1),
        n: new Array<number>(slots).fill(0),
      };
      // A slot whose stored tick ≠ the queried tick reads 0 (older lap); ticks < 0 were never written.
      const get = (idx: number): number => {
        if (idx < 0) return 0;
        const p = idx % slots;
        return ring.i[p] === idx ? (ring.n[p] ?? 0) : 0;
      };

      let full = 0;
      for (let j = c - S + 1; j <= c; j++) full += get(j);
      const oldest = get(c - S);
      const estimate = full + oldest * weight;
      const projected = estimate + cost;
      const resetAt = Math.ceil((c + 1) * w + windowMs);

      if (projected <= limit) {
        // Bump the current tick's slot in place (the ring is private to this store turn).
        const p = c % slots;
        const cur = ring.i[p] === c ? (ring.n[p] ?? 0) : 0;
        ring.i[p] = c;
        ring.n[p] = cur + cost;
        let remaining = Math.floor(limit - projected);
        if (remaining < 0) remaining = 0;
        return {
          state: ring,
          result: { allowed: true, limit, remaining, resetAt, retryAfterMs: 0 },
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
        result: { allowed: false, limit, remaining, resetAt, retryAfterMs },
        ttlMs: Math.ceil(windowMs + w),
        persist: false,
      };
    },
    peek(state: WindowState | undefined, now: number): Decision {
      const c = Math.floor(now / w);
      let elapsed = now - c * w;
      if (elapsed < 0) elapsed = 0;
      let weight = (w - elapsed) / w;
      if (weight < 0) weight = 0;
      if (weight > 1) weight = 1;

      const slots = S + 1;
      const get = (idx: number): number => {
        if (idx < 0 || state === undefined) return 0;
        const p = idx % slots;
        return state.i[p] === idx ? (state.n[p] ?? 0) : 0;
      };
      let full = 0;
      for (let j = c - S + 1; j <= c; j++) full += get(j);
      const oldest = get(c - S);
      const estimate = full + oldest * weight;
      const resetAt = Math.ceil((c + 1) * w + windowMs);
      const remaining = Math.max(0, Math.floor(limit - estimate));

      if (estimate + 1 <= limit) {
        return { allowed: true, limit, remaining, resetAt, retryAfterMs: 0 };
      }
      const D = estimate + 1 - limit;
      let retryAfterMs =
        oldest > 0 && D <= oldest * weight
          ? Math.ceil((D * w) / oldest)
          : Math.ceil((c + 1) * w - now);
      if (retryAfterMs < 1) retryAfterMs = 1;
      return { allowed: false, limit, remaining, resetAt, retryAfterMs };
    },
    readState: {
      lua: { script: SLIDING_WINDOW_READ_LUA, buildKeys: (key) => [key], buildArgv: () => [] },
      decode: (raw: unknown): WindowState | undefined => {
        const flat = raw as string[] | null;
        if (flat == null || flat.length === 0) return undefined;
        const slots = S + 1;
        const i = new Array<number>(slots).fill(-1);
        const n = new Array<number>(slots).fill(0);
        // HGETALL returns a flat [field, value, …]; each value is "<tick>:<count>".
        for (let k = 0; k + 1 < flat.length; k += 2) {
          const p = Number(flat[k]);
          const v = flat[k + 1] as string;
          const sep = v.indexOf(":");
          i[p] = Number(v.slice(0, sep));
          n[p] = Number(v.slice(sep + 1));
        }
        return { i, n };
      },
    } satisfies ReadState<WindowState>,
  };
}
