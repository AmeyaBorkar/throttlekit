import { decodeDecision } from "./lua";
import type { Decision, LuaInvocation, Strategy, Transform } from "./types";

/**
 * Build the store {@link Transform} for one rate-limit check: it wraps the strategy's pure
 * transition and, when the strategy ships a Lua form, attaches the atomic invocation so a
 * Lua-capable store collapses the check to a single round trip. Shared by the limiter and the
 * two-tier engine.
 */
export function decisionTransform<S>(
  strategy: Strategy<S>,
  now: number,
  cost: number,
): Transform<S, Decision> {
  const fn = (state: S | undefined) => {
    const r = strategy.check(state, now, cost);
    return { state: r.state, result: r.decision, ttlMs: r.ttlMs, persist: r.persist };
  };
  if (strategy.lua !== undefined) {
    const invocation: LuaInvocation<Decision> = {
      program: strategy.lua,
      now,
      cost,
      decode: decodeDecision,
    };
    (fn as { lua?: LuaInvocation<Decision> }).lua = invocation;
  }
  return fn as Transform<S, Decision>;
}
