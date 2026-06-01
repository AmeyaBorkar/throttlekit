# 07 · Unified admission

> Composing rate, concurrency, and cost into one decision and one lease lifecycle — plus the optional
> revenue-management bid-price policy that layers on top. Source: `src/admission/`, `src/core/combine.ts`.

## Purpose

A real API request must clear several orthogonal admission axes at once: a **rate** (req/min), a
**concurrency** ceiling (in-flight), and a **cost** budget (tokens/window). `unifiedAdmission` composes
them into one `UnifiedAdmission` with a single combined `Decision`, a single observable *binding axis*,
and a single lease lifecycle — so a caller does one `admit()` instead of hand-chaining limiters and leaking
concurrency slots. It is the shape an LLM gateway needs.

## The decision algebra (`combineDecisions`)

Composition rests on a four-law algebra over `Decision` (`src/core/combine.ts:53`):

```
combine(a, b) = {
  allowed:      a.allowed && b.allowed,   // AND
  limit:        min(a.limit, b.limit),    // the binding ceiling
  remaining:    min(a.remaining, b.remaining),
  resetAt:      max(a.resetAt, b.resetAt),     // never under-state the wait
  retryAfterMs: max(a.retryAfterMs, b.retryAfterMs),
}
```

The neutral element `ALLOW_FULL` uses `Number.MAX_SAFE_INTEGER` (not `+Infinity`) so the algebra stays
integer-only and preserves JS↔Lua bit-identity. It obeys four laws, proven by property tests:

| Law | Consequence |
|---|---|
| **Identity** `combine(d, ALLOW_FULL) = d` | optional axes are free |
| **Associativity** | extends to N axes via `reduce`, in any grouping |
| **Commutativity** | a Lua-fused path may reorder its checks and stay byte-identical |
| **Idempotency** | a retried sub-check is safe |

These laws are not decoration — associativity and commutativity are precisely what *license* the Lua-fused
path to reorder its checks and still match the sequential path exactly.

## Sequential composition

`unifiedAdmission` evaluates **concurrency → rate → cost**, short-circuiting on the first deny
(`src/admission/unified.ts:254`). Commutativity guarantees the *result* is order-independent; the order
only sets the short-circuit cost (concurrency is in-process — the cheapest fail). The lease lifecycle:

- the concurrency slot is acquired first (via the lease shim);
- if a later axis denies, the held slot is released immediately with `dropped: false` (the deny is
  upstream, not an overload), and the caller's returned `release` becomes a no-op;
- on a triple-success, `release` is wired to the real lease (idempotent);
- an outer try/catch releases the slot if a rate/cost limiter *throws*, so the slot never leaks.

**`bindingAxis`.** Per-axis `lastDecisions` is reset at the start of each `admit`, so a short-circuit
leaves the downstream axes `undefined` and the caller can see *which* axis bound. `deriveBindingAxis`
returns concurrency → rate → cost (first denial wins, mirroring evaluation order) and is attached to the
result; it equals the OTel `throttlekit.binding_axis` attribute, both derived from the same function
([10](10-observability.md)). A joint-LP policy denial instead sets `policyDenied: true` and leaves
`bindingAxis` absent (no single axis denied).

**The lease shim** bridges a `ConcurrencyGuard.acquire() → Lease` into a Decision-shaped
`{ decision, release }`. A rejected acquire reports `retryAfterMs = max(1, round(lastRtt))` — a Little's-
Law-honest hint, since a concurrency slot frees by *event*, not by clock — and `resetAt = now`, so the
MAX-aggregation lets the rate/cost axis's real reset dominate.

## The Lua-fused path

`backend: "lua-fused"` collapses **rate (GCRA) + cost (token bucket)** into one atomic `EVALSHA` over two
keys (concurrency stays in-process — its state is local). The script runs the *same* algebra in Lua
(AND/min/min/max/max) and returns a 13-int tuple: the combined decision plus each per-axis decision. Each
axis writes its own state per its own admit decision (rate advances its TAT even if cost denies), exactly
mirroring sequential's "first deny still consumes the earlier axes" — so **fused ≡ sequential**, with
atomicity as the strong guarantee fused buys over sequential's two interleavable round trips. Scope today:
gcra + tokenBucket only; other pairs throw at construction.

## The joint-LP bid-price policy (optional)

Marginal-AND composition admits whenever *each* axis independently has slack — but it is blind to the
*joint* value of spending a scarce cost/concurrency unit on a low-value request. The joint-LP policy prices
the scarce budgets and rejects low-value spends.

**The filter** (`src/admission/unified.ts:571`). Admit iff `value ≥ p_R + p_C·cost` (plus `p_K·hold` for
the 3-axis form). It runs **before** any rate/cost debit — those `check()`s consume budget on success with
no rollback, so filtering *after* would let a rejected low-value request drain the very budget the policy
exists to preserve. The filter is pure JS (only value, cost, and the dual prices), so it composes
identically over the sequential and fused backends, and it is strictly *more* selective than marginal — it
only ever removes admits, so it cannot break any limit or safety property.

**The solver** (`src/admission/fluid-lp.ts`). It solves the fluid relaxation of the revenue-management LP
**through the dual** (zero dependencies, no LP library): the dual is convex and piecewise-linear, so its
minimum sits at a vertex of the bid-line arrangement; the solver evaluates the dual at every candidate
vertex and takes the minimizer, breaking ties toward the *most selective* dual (the revenue-management
convention). Solving via the dual rather than primal vertex enumeration is what makes it robust to the
degeneracies (equal values, equal costs, density ties) that defeat a naive primal approach. A 3-axis form
adds a concurrency shadow price `p_K` (a concurrency-seconds budget via Little's law), solving each 3×3
candidate by Cramer's rule; a non-finite or negative `hold` contributes 0 (fail-open — a bad estimate
never wrongly rejects, and a hog can't dodge the price with a negative hold).

**Online dual refinement** (opt-in) prices with the construction prior during a sample window while tallying
the observed `(cost, value)` mixture, then re-solves and adopts the learned duals **only if they strictly
beat the prior on the buffered sample** (replayed under the window-scaled budget) — else keeps the prior,
then freezes. So it is never worse than the static prior on the observed sample, yet can escape a
catastrophically misspecified one.

## Design decisions & rationale

- **An algebra, not ad-hoc chaining.** The laws license the dual-path equivalence claim — associativity +
  commutativity let the fused path reorder freely; idempotency makes retries safe; identity makes optional
  axes free.
- **`ALLOW_FULL = MAX_SAFE_INTEGER`** keeps every combined field an integer for JS↔Lua bit-identity.
- **Concurrency split into `{ decision, release }`.** A `Decision` is point-in-time, but a concurrency slot
  has *temporal* state held until the work completes — it doesn't fit `Limiter.check() → Decision`, so the
  shim surfaces the lifecycle obligation at the call site.
- **Filter before debit**, because rate/cost `check()` consumes on success with no rollback; filtering
  afterward would defeat the policy's purpose.
- **Joint vs marginal**, and **solve via the dual** — the policy is strictly more selective (so provably
  safe to layer on), and the dual formulation is zero-dep and robust to the degeneracies a primal solver
  mishandles.
- **Adopt-online-only-if-strictly-better** — guarantees never-worse-than-prior on the observed sample while
  still rescuing a broken prior.

## Caveats

- `admitSync` is unavailable in lua-fused mode (Redis `EVALSHA` is async) and throws if any configured axis
  lacks a sync path.
- Joint-LP non-inferiority is on the *observed sample* only, not full-horizon dominance — under
  non-stationary/autocorrelated arrivals an adopted dual can do slightly worse over the full stream
  (bounded and small; the honest caveat is deliberately guarded by a foil regression test).
- The 3-axis form and the online refinement aren't yet combinable (construction throws if both are set).
- The bare-`duals` escape hatch validates each shadow price is finite and ≥ 0 (a NaN/negative would silently
  admit or deny everything).
- Fused mode is gcra + tokenBucket only.

## What proves it

- `test/core/combine.test.ts` — the four algebraic laws via property tests (≥ 500 runs each).
- `test/admission/unified.test.ts` — the sequential composition matrix (each axis as the binding axis, lease
  release on a downstream deny, the `lastDecisions` short-circuit, admit/admitSync parity).
- `test/admission/binding-axis.test.ts` — `bindingAxis` never disagrees with `bindingAxisOf(lastDecisions())`
  or the OTel attribute, on every deny axis + allow + policy-deny.
- `test/admission/fused-conformance.test.ts` — dual-path sequential ≡ lua-fused across 300 timeline
  assertions (Redis-gated).
- `test/admission/fluid-lp.test.ts` — a fixture of exact duals, an independent KKT optimality certificate, a
  lower-bound sampler, and a tie-heavy brute-force-oracle cross-check (the degenerate regression class).
- `test/admission/joint-lp-properties.test.ts`, `joint-lp-regret.test.ts` (the ship gate — joint beats
  marginal across arrival mixtures, with the ρ=+1 foil guarded), `joint-lp-3axis.test.ts`,
  `joint-lp-adaptive.test.ts`, `joint-lp-budget.test.ts`, `joint-lp-dual-path.test.ts`, `lease-shim.test.ts`.

## Source map

`src/admission/unified.ts` (sequential composition, lifecycle, the policy filter) · `fused-lua.ts` (the
atomic fused path) · `lease-shim.ts` (the concurrency shim) · `fluid-lp.ts` (the dual solver) ·
`src/core/combine.ts` (the algebra) · `src/observability/otel.ts` (`bindingAxisOf`).
