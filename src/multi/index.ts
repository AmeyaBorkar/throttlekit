import { systemClock } from "../core/clock";
import { ThrottleKitError } from "../core/errors";
import { LUA_NOW, decodeDecision } from "../core/lua";
import type {
  Clock,
  Decision,
  LuaInvocation,
  LuaProgram,
  Store,
  Strategy,
  StrategyOutcome,
  Transform,
} from "../core/types";
import { requireCost } from "../core/validate";
import { MemoryStore } from "../stores/memory";

/** One axis of a multi-dimensional limit. */
export interface Dimension<Ctx, S = unknown> {
  /** Derive this dimension's key from the request context (e.g. the client IP). */
  key: (ctx: Ctx) => string;
  /** The algorithm enforced on this dimension. */
  strategy: Strategy<S>;
  /** Optional per-dimension weight; multiplied by the global cost. Default 1. */
  cost?: (ctx: Ctx) => number;
}

export type Dimensions<Ctx> = Record<string, Dimension<Ctx>>;

/** A composite of named dimensions plus a combine mode. Build with {@link all} / {@link any}. */
export interface MultiStrategy<Ctx> {
  readonly mode: "all" | "any";
  readonly dimensions: Dimensions<Ctx>;
}

/** Allow only if **every** dimension allows; consume nothing unless all allow (no partial consume). */
export function all<Ctx>(dimensions: Dimensions<Ctx>): MultiStrategy<Ctx> {
  return { mode: "all", dimensions };
}

/** Allow if **any** dimension allows; consume only the dimensions that individually allow. */
export function any<Ctx>(dimensions: Dimensions<Ctx>): MultiStrategy<Ctx> {
  return { mode: "any", dimensions };
}

export interface MultiRateLimitOptions<Ctx> {
  strategy: MultiStrategy<Ctx>;
  store?: Store;
  clock?: Clock;
  prefix?: string;
}

export interface MultiLimiter<Ctx> {
  check(ctx: Ctx, cost?: number): Promise<Decision>;
  /** Synchronous check; requires a synchronous store (e.g. MemoryStore). */
  checkSync(ctx: Ctx, cost?: number): Decision;
  reset(ctx: Ctx): Promise<void>;
}

const TYPE: Record<string, number> = { gcra: 1, tokenBucket: 2, fixedWindow: 3 };

interface DimResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterMs: number;
}

/**
 * Combine per-dimension results into one binding decision, matching the fused Lua exactly:
 * - all + all-allow → min-remaining dimension (the tightest headroom)
 * - all + any-deny → denying dimension with the largest retryAfter (the binding constraint)
 * - any + any-allow → allowing dimension with the most remaining
 * - any + all-deny → dimension with the smallest retryAfter (soonest recovery)
 */
function combine(mode: "all" | "any", results: DimResult[]): Decision {
  if (mode === "all") {
    const allAllowed = results.every((r) => r.allowed);
    if (allAllowed) {
      let b = results[0] as DimResult;
      for (const r of results) if (r.remaining < b.remaining) b = r;
      return {
        allowed: true,
        limit: b.limit,
        remaining: b.remaining,
        resetAt: b.resetAt,
        retryAfterMs: 0,
      };
    }
    let b: DimResult | undefined;
    for (const r of results) {
      if (!r.allowed && (b === undefined || r.retryAfterMs > b.retryAfterMs)) b = r;
    }
    const d = b as DimResult;
    return {
      allowed: false,
      limit: d.limit,
      remaining: d.remaining,
      resetAt: d.resetAt,
      retryAfterMs: d.retryAfterMs,
    };
  }
  // any
  const anyAllowed = results.some((r) => r.allowed);
  if (anyAllowed) {
    let b: DimResult | undefined;
    for (const r of results) {
      if (r.allowed && (b === undefined || r.remaining > b.remaining)) b = r;
    }
    const d = b as DimResult;
    return {
      allowed: true,
      limit: d.limit,
      remaining: d.remaining,
      resetAt: d.resetAt,
      retryAfterMs: 0,
    };
  }
  let b = results[0] as DimResult;
  for (const r of results) if (r.retryAfterMs < b.retryAfterMs) b = r;
  return {
    allowed: false,
    limit: b.limit,
    remaining: b.remaining,
    resetAt: b.resetAt,
    retryAfterMs: b.retryAfterMs,
  };
}

/**
 * Fused multi-dimensional Lua: evaluates every dimension over its (hash-tag co-located) key in a
 * single round trip, commits state only per the combine rule (no partial consume), and returns the
 * binding decision. Supports gcra / tokenBucket / fixedWindow dimensions. Per-type math mirrors the
 * standalone scripts so the JS and Lua composite decisions are bit-identical.
 *
 * ARGV: now, mode(1=all/0=any), n, then per dim [type, cost, p1, p2, p3].
 */
const MULTI_LUA = `${LUA_NOW}
local mode = tonumber(ARGV[2])
local n = tonumber(ARGV[3])
local al = {}
local lim = {}
local rem = {}
local rst = {}
local rty = {}
local wtype = {}
local wval = {}
local wttl = {}
for i = 1, n do
  local o = 3 + (i - 1) * 5
  local typ = tonumber(ARGV[o + 1])
  local cost = tonumber(ARGV[o + 2])
  local p1 = tonumber(ARGV[o + 3])
  local p2 = tonumber(ARGV[o + 4])
  local p3 = tonumber(ARGV[o + 5])
  local key = KEYS[i]
  if typ == 1 then
    local T = p1 / p2
    local tau = T * p3
    local inc = T * cost
    local tat = tonumber(redis.call('GET', key) or now)
    if tat < now then tat = now end
    local nt = tat + inc
    local aa = nt - tau
    lim[i] = p3
    if now < aa then
      al[i] = 0
      local r = math.floor((tau - (tat - now)) / T); if r < 0 then r = 0 end
      rem[i] = r; rst[i] = math.ceil(tat); rty[i] = math.ceil(aa - now)
    else
      al[i] = 1
      local r = math.floor((tau - (nt - now)) / T); if r < 0 then r = 0 end
      rem[i] = r; rst[i] = math.ceil(nt); rty[i] = 0
      wtype[i] = 1; wval[i] = string.format('%.17g', nt); wttl[i] = math.ceil(nt - now); if wttl[i] < 1 then wttl[i] = 1 end
    end
  elseif typ == 2 then
    local refill = p2 / 1000
    local h = redis.call('HMGET', key, 't', 'l')
    local tk = tonumber(h[1]); local ls = tonumber(h[2])
    if tk == nil then tk = p1 end
    if ls == nil then ls = now end
    local el = now - ls; if el < 0 then el = 0 end
    tk = tk + el * refill; if tk > p1 then tk = p1 end
    lim[i] = p1
    local ttl = math.ceil(p1 / refill); if ttl < 1 then ttl = 1 end
    if tk >= cost then
      al[i] = 1
      local ntk = tk - cost
      local r = math.floor(ntk); if r < 0 then r = 0 end
      rem[i] = r; rst[i] = now + math.ceil((p1 - ntk) / refill); rty[i] = 0
      wtype[i] = 2; wval[i] = string.format('%.17g', ntk) .. '|' .. string.format('%.17g', now); wttl[i] = ttl
    else
      al[i] = 0
      local r = math.floor(tk); if r < 0 then r = 0 end
      rem[i] = r; rst[i] = now + math.ceil((p1 - tk) / refill); rty[i] = math.ceil((cost - tk) / refill)
    end
  else
    local ws = math.floor(now / p2) * p2
    local rsa = ws + p2
    local h = redis.call('HMGET', key, 's', 'c')
    local st = tonumber(h[1]); local ct = tonumber(h[2])
    if st == nil or st ~= ws then ct = 0 end
    lim[i] = p1; rst[i] = rsa
    if ct + cost <= p1 then
      al[i] = 1
      local r = p1 - (ct + cost); if r < 0 then r = 0 end
      rem[i] = r; rty[i] = 0
      wtype[i] = 3; wval[i] = ws .. '|' .. (ct + cost); wttl[i] = math.ceil(rsa - now)
    else
      al[i] = 0
      local r = p1 - ct; if r < 0 then r = 0 end
      rem[i] = r; rty[i] = math.ceil(rsa - now)
    end
  end
end
-- combine
local out_allowed, out_limit, out_rem, out_rst, out_rty
local commitAll = false
local commitAllowed = false
if mode == 1 then
  local allYes = true
  for i = 1, n do if al[i] == 0 then allYes = false end end
  if allYes then
    commitAll = true
    local bi = 1
    for i = 1, n do if rem[i] < rem[bi] then bi = i end end
    out_allowed = 1; out_limit = lim[bi]; out_rem = rem[bi]; out_rst = rst[bi]; out_rty = 0
  else
    local bi = 0
    for i = 1, n do if al[i] == 0 and (bi == 0 or rty[i] > rty[bi]) then bi = i end end
    out_allowed = 0; out_limit = lim[bi]; out_rem = rem[bi]; out_rst = rst[bi]; out_rty = rty[bi]
  end
else
  local anyYes = false
  for i = 1, n do if al[i] == 1 then anyYes = true end end
  if anyYes then
    commitAllowed = true
    local bi = 0
    for i = 1, n do if al[i] == 1 and (bi == 0 or rem[i] > rem[bi]) then bi = i end end
    out_allowed = 1; out_limit = lim[bi]; out_rem = rem[bi]; out_rst = rst[bi]; out_rty = 0
  else
    local bi = 1
    for i = 1, n do if rty[i] < rty[bi] then bi = i end end
    out_allowed = 0; out_limit = lim[bi]; out_rem = rem[bi]; out_rst = rst[bi]; out_rty = rty[bi]
  end
end
if commitAll or commitAllowed then
  for i = 1, n do
    local doWrite = (commitAll or al[i] == 1) and wtype[i] ~= nil
    if doWrite then
      local key = KEYS[i]
      if wtype[i] == 1 then
        redis.call('SET', key, wval[i], 'PX', wttl[i])
      else
        local sep = string.find(wval[i], '|')
        local a = string.sub(wval[i], 1, sep - 1)
        local b = string.sub(wval[i], sep + 1)
        if wtype[i] == 2 then redis.call('HSET', key, 't', a, 'l', b)
        else redis.call('HSET', key, 's', a, 'c', b) end
        redis.call('PEXPIRE', key, wttl[i])
      end
    end
  end
end
return {out_allowed, out_limit, out_rem, out_rst, out_rty}`;

/** Extract the fused per-dimension param slots `[type, p1, p2, p3]` from a built-in strategy. */
function encodeDim(strategy: Strategy): { type: number; params: [number, number, number] } {
  const type = TYPE[strategy.name];
  if (type === undefined || strategy.lua === undefined) {
    throw new ThrottleKitError(
      `multi-dimensional limiting on an async store supports gcra/tokenBucket/fixedWindow dimensions; got "${strategy.name}"`,
    );
  }
  // buildArgv(0, 1) = [nowArg=0, ...params, cost=1]; the params are the middle.
  const argv = strategy.lua.buildArgv(0, 1).map(Number);
  const params = argv.slice(1, -1);
  return {
    type,
    params: [params[0] ?? 0, params[1] ?? 0, params[2] ?? 0],
  };
}

/**
 * Multi-dimensional limiter: evaluate per-IP ∧ per-user ∧ per-route (etc.) atomically. On a
 * synchronous store it reads all dimensions, decides, then commits all-or-none in one
 * uninterrupted turn (no partial consume); on Redis it fuses every dimension into a single Lua
 * round trip. See THROTTLEKIT.md §9.
 */
export function multiRateLimit<Ctx>(options: MultiRateLimitOptions<Ctx>): MultiLimiter<Ctx> {
  const multi = options.strategy;
  const clock = options.clock ?? systemClock;
  const store: Store =
    options.store ?? new MemoryStore(options.clock !== undefined ? { clock: options.clock } : {});
  const prefix = options.prefix;
  const entries = Object.entries(multi.dimensions);
  const mode = multi.mode;

  const keyOf = (name: string, raw: string): string =>
    prefix !== undefined && prefix.length > 0 ? `${prefix}:${name}:${raw}` : `${name}:${raw}`;

  const dimCost = (dim: Dimension<Ctx>, ctx: Ctx, globalCost: number): number =>
    (dim.cost ? dim.cost(ctx) : 1) * globalCost;

  // Synchronous, atomic-by-single-thread path for sync stores (read all, decide, commit none/all).
  const runSync = (ctx: Ctx, globalCost: number): Decision => {
    const now = clock.now();
    if (store.applySync === undefined) {
      throw new ThrottleKitError("multi-dimensional checkSync requires a synchronous store");
    }
    const captured: { fk: string; out: StrategyOutcome<unknown> }[] = [];
    const results: DimResult[] = [];
    for (const [name, dim] of entries) {
      const fk = keyOf(name, dim.key(ctx));
      const cost = dimCost(dim, ctx, globalCost);
      let out: StrategyOutcome<unknown> | undefined;
      const peek = ((state: unknown) => {
        out = dim.strategy.check(state, now, cost);
        return { state, result: out.decision, ttlMs: out.ttlMs, persist: false };
      }) as Transform<unknown, Decision>;
      store.applySync(fk, peek);
      const o = out as StrategyOutcome<unknown>;
      captured.push({ fk, out: o });
      results.push(o.decision);
    }
    const decision = combine(mode, results);
    const commitAll = mode === "all" && decision.allowed;
    const commitAny = mode === "any" && decision.allowed;
    if (commitAll || commitAny) {
      for (let i = 0; i < captured.length; i++) {
        const c = captured[i] as { fk: string; out: StrategyOutcome<unknown> };
        const res = results[i] as DimResult;
        const write = commitAll || res.allowed;
        if (write && c.out.persist) {
          const commit = (() => ({
            state: c.out.state,
            result: c.out.decision,
            ttlMs: c.out.ttlMs,
            persist: true,
          })) as Transform<unknown, Decision>;
          store.applySync(c.fk, commit);
        }
      }
    }
    return decision;
  };

  const runLua = (ctx: Ctx, globalCost: number): Promise<Decision> => {
    const now = clock.now();
    const keys: string[] = [];
    const perDim: number[] = [];
    for (const [name, dim] of entries) {
      keys.push(keyOf(name, dim.key(ctx)));
      const { type, params } = encodeDim(dim.strategy);
      perDim.push(type, dimCost(dim, ctx, globalCost), params[0], params[1], params[2]);
    }
    const program: LuaProgram = {
      script: MULTI_LUA,
      buildKeys: () => keys,
      buildArgv: (nowArg) => [nowArg, mode === "all" ? 1 : 0, entries.length, ...perDim],
    };
    const transform = (() => {
      throw new ThrottleKitError("multi-dimensional limiting requires a Lua-capable store");
    }) as Transform<unknown, Decision>;
    (transform as { lua?: LuaInvocation<Decision> }).lua = {
      program,
      now,
      cost: globalCost,
      decode: decodeDecision,
    };
    return store.apply(keys[0] ?? "tk:multi", transform);
  };

  return {
    async check(ctx: Ctx, cost = 1): Promise<Decision> {
      requireCost(cost);
      return store.applySync !== undefined ? runSync(ctx, cost) : runLua(ctx, cost);
    },
    checkSync(ctx: Ctx, cost = 1): Decision {
      requireCost(cost);
      return runSync(ctx, cost);
    },
    async reset(ctx: Ctx): Promise<void> {
      await Promise.all(entries.map(([name, dim]) => store.reset(keyOf(name, dim.key(ctx)))));
    },
  };
}
