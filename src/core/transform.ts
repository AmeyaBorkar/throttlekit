import { decodeDecision } from "./lua";
import type { ApplyOutcome, Decision, LuaInvocation, Strategy, Transform } from "./types";

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
  // strategy.check already returns the ApplyOutcome shape (its `result` is the Decision), so pass it
  // straight through — no per-check re-wrap object.
  const fn = (state: S | undefined) => strategy.check(state, now, cost);
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

/**
 * Build a **non-mutating** {@link Transform} for introspection (`peek`/`forecast`): it returns
 * `project(state, now)` with `persist: false`, so no store ever writes. A non-Lua store hands the
 * decoded state straight to `project`; a Lua-capable store runs the strategy's read-only
 * {@link Strategy.readState} Lua (which only reads, never the consuming `check` script) and decodes
 * its raw reply before projecting. Shared by {@link Limiter.peek} and {@link Limiter.forecast}.
 */
export function readOnlyTransform<S, R>(
  strategy: Strategy<S>,
  project: (state: S | undefined, now: number) => R,
  now: number,
): Transform<S, R> {
  const fn = (state: S | undefined): ApplyOutcome<S, R> => ({
    state,
    result: project(state, now),
    ttlMs: 0,
    persist: false,
  });
  const rs = strategy.readState;
  if (rs !== undefined) {
    const invocation: LuaInvocation<R> = {
      program: rs.lua,
      now,
      cost: 0,
      decode: (raw) => project(rs.decode(raw), now),
    };
    (fn as { lua?: LuaInvocation<R> }).lua = invocation;
  }
  return fn as Transform<S, R>;
}
