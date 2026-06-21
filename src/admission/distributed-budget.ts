import { systemClock } from "../core/clock";
import { ThrottleKitError } from "../core/errors";
import { LUA_NOW, decodeDecision } from "../core/lua";
import type {
  ApplyOutcome,
  Clock,
  Decision,
  LuaInvocation,
  LuaProgram,
  Store,
  Transform,
} from "../core/types";
import { requireAtLeast, requireInteger, requirePositive } from "../core/validate";

/** Options for {@link distributedTokenBudget}. */
export interface DistributedTokenBudgetOptions {
  /** Token budget `L` enforced over each window, **shared across the whole fleet**. Floored to a positive integer. */
  budget: number;
  /** Window width in ms. Windows are epoch-aligned: `floor(now/windowMs)*windowMs`. */
  windowMs: number;
  /**
   * The atomic shared counter every gateway debits. Use any distributed {@link Store} (Redis,
   * Postgres, DynamoDB, D1, Deno KV); a {@link MemoryStore} keeps it process-local (equivalent to the
   * in-process {@link tokenBudget}). Built-in stores make the debit atomic, which is what bounds the
   * overshoot independent of fleet size.
   */
  store: Store;
  /**
   * The counter's key in the store, so one store can back many independent budgets. All gateways
   * sharing a budget must use the **same** key. Default `"tokenBudget"`.
   */
  key?: string;
  /**
   * Time source. Defaults to {@link systemClock}. On Redis the budget's window is rolled by the
   * *server* clock (skew-proof); on other stores it is rolled by this clock, so gateways should be
   * roughly NTP-synced (skew only shifts the window boundary, never the per-window total).
   */
  clock?: Clock;
}

/**
 * A fleet-shared windowed token-budget meter — the distributed face of {@link tokenBudget}. `debit`
 * the *actual* tokens each stream produces; the budget is enforced across every gateway at once.
 */
export interface DistributedTokenBudgetMeter {
  /** Atomically debit `tokens` (default 1, a positive integer) against the shared window. */
  debit(tokens?: number): Promise<Decision>;
  /**
   * Synchronous {@link DistributedTokenBudgetMeter.debit}. Only available when the configured store
   * supports synchronous atomic apply (e.g. {@link MemoryStore}); throws otherwise.
   */
  debitSync(tokens?: number): Decision;
  /** Tokens remaining in the current shared window (`>= 0`); rolls the window but does not debit. */
  remaining(): Promise<number>;
  /** Forget the shared usage; the next debit starts a fresh window. */
  reset(): Promise<void>;
}

/** Per-budget state: the active window's start (epoch-ms) and the tokens served fleet-wide within it. */
interface BudgetState {
  /** Epoch-ms start of the window this count belongs to. */
  w: number;
  /** Tokens served fleet-wide in the window starting at `w`. */
  s: number;
}

/**
 * Atomic Redis form. ARGV: now, windowMs, L, tokens. Mirrors the JS transform exactly (same
 * epoch-aligned window roll, same stop-at-boundary rule, same rounding), so decisions are
 * bit-identical. State lives in a HASH (`s` = served, `w` = window start); both integers.
 */
const DISTRIBUTED_TOKEN_BUDGET_LUA = `${LUA_NOW}
local windowMs = tonumber(ARGV[2])
local L = tonumber(ARGV[3])
local tokens = tonumber(ARGV[4])
local h = redis.call('HMGET', KEYS[1], 's', 'w')
local served = tonumber(h[1])
local windowStart = tonumber(h[2])
if served == nil or windowStart == nil or now >= windowStart + windowMs then
  windowStart = math.floor(now / windowMs) * windowMs
  served = 0
end
local resetAt = math.ceil(windowStart + windowMs)
if served >= L then
  local retry = math.ceil(resetAt - now)
  if retry < 0 then retry = 0 end
  return {0, L, 0, resetAt, retry}
end
local newServed = served + tokens
redis.call('HSET', KEYS[1], 's', newServed, 'w', windowStart)
local px = math.ceil(windowStart + windowMs - now)
if px < 1 then px = 1 end
redis.call('PEXPIRE', KEYS[1], px)
local remaining = L - newServed
if remaining < 0 then remaining = 0 end
return {1, L, remaining, resetAt, 0}`;

/**
 * Read-only Redis form of the peek. ARGV: now, windowMs, L. The state lives in a HASH (the debit Lua
 * writes `s`/`w`), so the read MUST go through Lua too — a no-Lua transform would route to the store's
 * OCC `GET` path and throw `WRONGTYPE` on the hash key. Mirrors `rolled()` + `max(0, L - served)` and
 * never writes (no HSET/PEXPIRE), so a peek can't mutate the window or its TTL.
 */
const DISTRIBUTED_TOKEN_BUDGET_PEEK_LUA = `${LUA_NOW}
local windowMs = tonumber(ARGV[2])
local L = tonumber(ARGV[3])
local h = redis.call('HMGET', KEYS[1], 's', 'w')
local served = tonumber(h[1])
local windowStart = tonumber(h[2])
if served == nil or windowStart == nil or now >= windowStart + windowMs then
  served = 0
end
local remaining = L - served
if remaining < 0 then remaining = 0 end
return remaining`;

/**
 * **Distributed streaming token-budget meter** — enforce a budget of `L` tokens per window across a
 * *fleet* of gateways, when each request's cost is revealed only as it streams (the LLM-gateway
 * problem; see {@link tokenBudget} for the single-process version and the cost model).
 *
 * Each {@link DistributedTokenBudgetMeter.debit} runs one **atomic** read-modify-write against a
 * shared counter in `store`: it rolls the epoch-aligned window, then applies the same
 * *stop-at-boundary* rule as {@link tokenBudget} — admitted iff the fleet-wide `served < L` before
 * this debit; the single debit that crosses `L` is counted in full, then every later debit in the
 * window is refused. Because the check-and-increment is atomic in the store (Redis `EVAL`, Postgres
 * advisory lock, DynamoDB/D1/Deno KV compare-and-set), only the *one* crossing debit per window can
 * exceed `L`, no matter how many gateways meter concurrently:
 *
 * ```text
 *   worst-case overshoot  Δ  ≤  (largest single debit) − 1     — independent of the gateway count C
 * ```
 *
 * so per-token debiting (`tokens = 1`) holds the fleet to **exactly `L` tokens per window, Δ = 0**.
 * This is the `B = 1` instantiation of GALE window-coupled leasing with the token as the unit (see
 * `research/cost-uncertainty/PROPOSAL.md` and `test/cost/distributed-budget.ts`): the shared counter
 * resets each window, so leased-but-unspent budget cannot carry across the boundary, which is exactly
 * what makes the bound fleet-size-independent.
 *
 * The window is rolled inside the atomic step from a single shared key (like {@link fixedWindow}, not
 * a per-window key), so on Redis the *server* clock decides the window and gateway clock skew can
 * never split one logical window into two counters.
 *
 * @example
 * ```ts
 * import { RedisStore } from "throttlekit/redis";
 * import { distributedTokenBudget } from "throttlekit";
 *
 * // Construct the SAME budget (same key + Redis) on every gateway in the fleet.
 * const meter = distributedTokenBudget({
 *   budget: 1_000_000, windowMs: 60_000, store: new RedisStore({ client }), key: "tpm:acme",
 * });
 * for await (const tok of completion) {
 *   if (!(await meter.debit(1)).allowed) break; // fleet budget spent — stop generating
 *   emit(tok);
 * }
 * ```
 */
export function distributedTokenBudget(
  options: DistributedTokenBudgetOptions,
): DistributedTokenBudgetMeter {
  requirePositive("distributedTokenBudget.budget", options.budget);
  // Mirrors tokenBudget: the budget floors to an integer L, so it must be >= 1 — a fractional budget in
  // (0,1) would floor to L=0 and the `served >= L` rule would silently deny every debit. Fail fast.
  requireAtLeast("distributedTokenBudget.budget", options.budget, 1);
  requirePositive("distributedTokenBudget.windowMs", options.windowMs);

  const L = Math.floor(options.budget);
  const windowMs = options.windowMs;
  const store = options.store;
  const clock = options.clock ?? systemClock;
  const key = options.key ?? "tokenBudget";

  const lua: LuaProgram = {
    script: DISTRIBUTED_TOKEN_BUDGET_LUA,
    buildKeys: (k) => [k],
    buildArgv: (nowArg, tokens) => [nowArg, windowMs, L, tokens],
  };

  const peekLua: LuaProgram = {
    script: DISTRIBUTED_TOKEN_BUDGET_PEEK_LUA,
    buildKeys: (k) => [k],
    buildArgv: (nowArg) => [nowArg, windowMs, L],
  };

  /** Resolve the live window's (served, windowStart) from stored state at `now`, rolling if stale. */
  function rolled(
    state: BudgetState | undefined,
    now: number,
  ): { served: number; windowStart: number } {
    if (state === undefined || now >= state.w + windowMs) {
      return { served: 0, windowStart: Math.floor(now / windowMs) * windowMs };
    }
    return { served: state.s, windowStart: state.w };
  }

  /** The stop-at-boundary debit as a store transform, carrying the atomic Lua form for Redis. */
  function debitTransform(now: number, tokens: number): Transform<BudgetState, Decision> {
    const fn = (state: BudgetState | undefined): ApplyOutcome<BudgetState, Decision> => {
      const { served, windowStart } = rolled(state, now);
      const resetAt = Math.ceil(windowStart + windowMs);

      if (served >= L) {
        return {
          state,
          result: {
            allowed: false,
            limit: L,
            remaining: 0,
            resetAt,
            retryAfterMs: Math.max(0, Math.ceil(resetAt - now)),
          },
          ttlMs: windowMs,
          persist: false,
        };
      }
      const newServed = served + tokens;
      return {
        state: { w: windowStart, s: newServed },
        result: {
          allowed: true,
          limit: L,
          remaining: Math.max(0, L - newServed),
          resetAt,
          retryAfterMs: 0,
        },
        ttlMs: Math.max(1, resetAt - now),
        persist: true,
      };
    };
    const invocation: LuaInvocation<Decision> = {
      program: lua,
      now,
      cost: tokens,
      decode: decodeDecision,
    };
    (fn as { lua?: LuaInvocation<Decision> }).lua = invocation;
    return fn as Transform<BudgetState, Decision>;
  }

  /** Read-only peek: report remaining for the (rolled) window without debiting or persisting. */
  function peekTransform(now: number): Transform<BudgetState, number> {
    const fn = (state: BudgetState | undefined): ApplyOutcome<BudgetState, number> => {
      const { served } = rolled(state, now);
      return { state, result: Math.max(0, L - served), ttlMs: windowMs, persist: false };
    };
    // Attach the read-only Lua so a Lua-capable store (Redis) reads the HASH via HMGET instead of
    // routing to its OCC GET fallback — a plain GET on the hash-typed key throws WRONGTYPE.
    const invocation: LuaInvocation<number> = {
      program: peekLua,
      now,
      cost: 0,
      decode: (raw) => Number(raw),
    };
    (fn as { lua?: LuaInvocation<number> }).lua = invocation;
    return fn as Transform<BudgetState, number>;
  }

  function validateTokens(tokens: number): void {
    requirePositive("distributedTokenBudget.tokens", tokens);
    requireInteger("distributedTokenBudget.tokens", tokens);
  }

  return {
    debit(tokens = 1): Promise<Decision> {
      try {
        validateTokens(tokens);
      } catch (err) {
        return Promise.reject(err);
      }
      return store.apply(key, debitTransform(clock.now(), tokens));
    },

    debitSync(tokens = 1): Decision {
      validateTokens(tokens);
      if (store.applySync === undefined) {
        throw new ThrottleKitError(
          "debitSync requires a synchronous store (e.g. MemoryStore); the configured store is async-only",
        );
      }
      const now = clock.now();
      return store.applySync(key, debitTransform(now, tokens), now);
    },

    remaining(): Promise<number> {
      return store.apply(key, peekTransform(clock.now()));
    },

    async reset(): Promise<void> {
      await store.reset(key);
    },
  };
}
