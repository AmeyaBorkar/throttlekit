import type { Decision } from "./types";

/**
 * The neutral element for {@link combineDecisions}: a {@link Decision} that
 * allows unboundedly. Used as the seed for reducing N decisions, and as the
 * placeholder for an *unused* axis in `unifiedAdmission(...)` (so an admitter
 * with only `{ rate }` configured is provably indistinguishable from one with
 * `{ rate, concurrency: ALLOW_FULL, cost: ALLOW_FULL }`).
 *
 * `limit` and `remaining` use {@link Number.MAX_SAFE_INTEGER} (not `+Infinity`)
 * so the algebra produces only integers — preserving bit-identity between the
 * JavaScript and Redis-Lua execution paths the rest of the library guarantees.
 *
 * See `research/bigger-bets/unified/DESIGN.md` §4.1.1.1 (D-U3).
 */
export const ALLOW_FULL: Decision = {
  allowed: true,
  limit: Number.MAX_SAFE_INTEGER,
  remaining: Number.MAX_SAFE_INTEGER,
  resetAt: 0,
  retryAfterMs: 0,
};

/**
 * Combine two {@link Decision}s into one — the pure algebra at the heart of
 * `unifiedAdmission(...)`. Field-by-field aggregation:
 *
 * | Field | Rule | Why |
 * |---|---|---|
 * | `allowed` | `a.allowed && b.allowed` | AND — both must allow |
 * | `limit` | `min(a.limit, b.limit)` | binding (smaller) ceiling — what the client should see |
 * | `remaining` | `min(a.remaining, b.remaining)` | binding remainder — accurate `X-RateLimit-Remaining` |
 * | `resetAt` | `max(a.resetAt, b.resetAt)` | latest-resolution wait — when *all* axes have refilled |
 * | `retryAfterMs` | `max(a.retryAfterMs, b.retryAfterMs)` | dominant wait — never under-state the wait |
 *
 * Total, pure, and obeys four algebraic laws (proven in
 * `test/core/combine.test.ts` via fast-check at `numRuns ≥ 500`):
 *
 * - **Identity** — `combine(d, ALLOW_FULL) = d`
 * - **Associativity** — `combine(combine(a,b),c) = combine(a,combine(b,c))`
 * - **Commutativity** — `combine(a,b) = combine(b,a)`
 * - **Idempotency** — `combine(d, d) = d`
 *
 * Associativity + commutativity together mean: `combineDecisions` extends to
 * N inputs via `reduce` and the order doesn't change the result, so a
 * Lua-fused implementation can re-order its checks freely without changing
 * the decision. Idempotency makes a retried sub-check safe. Identity makes
 * optional axes free to add.
 *
 * See `research/bigger-bets/unified/DESIGN.md` §4.1 (the algebra) and §4.1.1
 * (the laws). The decision records are D-U1..D-U3 in §14 of that doc.
 */
export function combineDecisions(a: Decision, b: Decision): Decision {
  return {
    allowed: a.allowed && b.allowed,
    limit: Math.min(a.limit, b.limit),
    remaining: Math.min(a.remaining, b.remaining),
    resetAt: Math.max(a.resetAt, b.resetAt),
    retryAfterMs: Math.max(a.retryAfterMs, b.retryAfterMs),
  };
}
