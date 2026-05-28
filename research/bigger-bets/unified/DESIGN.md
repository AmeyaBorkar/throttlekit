# Unified admission — design (TK-1001 / 0.9.0)

> Status: design lock for TK-1001. Implementation begins TK-1002.
> Target release: 0.9.0 — the first minor bump after the federation
> patch line (0.8.3 → 0.8.4 → 0.8.5). Read
> `research/bigger-bets/PLAN.md` §4 first — this expands it.
> Edit guideline: when implementation invalidates an assumption, edit
> the Decision summary at the bottom in place and add a one-line "Why
> changed" — same convention as `research/bigger-bets/federation/DESIGN.md`.

This document specifies a *fusion* primitive — `unifiedAdmission(...)` —
that turns the three already-shipped admission axes (rate / concurrency /
cost) into one decision. It locks the algebra, the lifecycle shape, the
Redis-Lua atomic fast path, and the research question (joint vs
marginal) that TK-1007 will answer empirically. No production code is
written here; the gate this doc opens is **TK-1002 — the
`combineDecisions` algebra + its property test**.

---

## 0  Why this doc exists

The 0.8.x line shipped three orthogonal admission primitives that all
return a `Decision` (or a `Decision`-shaped artifact):

| Axis | Primitive | Where |
|---|---|---|
| rate | `rateLimit({ strategy })` → `Limiter.check()` | `src/core/limiter.ts` |
| concurrency | `adaptiveConcurrency({...})` → `ConcurrencyGuard.acquire() → Lease` | `src/concurrency/adaptive.ts` |
| cost | `tokenBudget({...})` / `distributedTokenBudget({...})` / `rateLimit({ strategy: tokenBucket(...) })` | `src/admission/index.ts`, `src/admission/distributed-budget.ts`, `src/algorithms/token-bucket.ts` |

In production they are stacked in middleware. Each runs independently;
each produces its own `Decision`; the request gets through iff all three
allow. No primitive answers "what would happen if I admitted this
request right now, considering all three axes at once." That gap is the
0.9.0 deliverable — see §1.

This doc exists because the gap is bigger than the implementation. The
algebra of admission decisions is *load-bearing*: a sloppy
`combineDecisions` can drop `retryAfterMs` hints (degrading client retry
behavior), break order-independence (so a Lua-fused path can't share the
result with the sequential path), or leak the right `limit` to clients.
We built federation proof-first to catch the EOQ-cost-model bug at
exactly this design step on Pillar 2; unified is bigger; the cost of
finding an algebra bug after shipping `unifiedAdmission(...)` is
catastrophic.

---

## 1  Problem statement

A real API request must clear *three* orthogonal admissions:

- **rate** — `req / period` against an upstream provider quota or a
  shared backend's RPS ceiling;
- **concurrency** — bounded `parallel in-flight`, the [Little's-Law][little]
  conjugate of `rate × latency`;
- **cost** — `tokens (or weight) / budget`, especially for LLM
  completions whose cost is revealed post-hoc as they stream.

The three are **correlated** in production workloads — long completions
hold a concurrency slot *and* burn more tokens; a tenant flooding the
rate axis also dominates the concurrency axis — but the checks are
independent today. **Admit decisions that clear all three marginal
limits may collectively violate the joint envelope**, and the operator
has no observable lever for "the joint policy."

### 1.1 The LLM-gateway concrete example

A chat-completion request to a hosted LLM has:

- a **rate cost** of 1 against the provider's RPM quota (e.g. 500
  req/min);
- a **concurrency cost** of one inference seat held for the duration of
  the completion (~5–30 s for a long answer);
- a **token cost** in [input + estimated output] against the provider's
  TPM quota (e.g. 200k tok/min).

Today the gateway runs `rateLimit({ strategy: tokenBucket(...) })`
against RPM, `adaptiveConcurrency({...})` against in-flight, and
`distributedTokenBudget({...})` against TPM — three independent
calls, two round-trips to Redis under the sequential stack, no
visibility into the *binding* axis (the axis that actually rejected the
request). Operators report this as the #1 missing OTel signal for LLM
gateways: when an admission is denied, *which* axis decided?

### 1.2 The joint-vs-marginal gap

Even ignoring observability, the policy itself is sub-optimal under
correlation. The textbook example (formalized in §7):

- Two axes, rate `R = 100 req/min`, cost `C = 100k tok/min`.
- Bivariate request stream with two types: "small" (1 req, 100 tok)
  and "large" (1 req, 10k tok).
- Marginal-AND admits any request iff rate has ≥ 1 req remaining AND
  cost has ≥ `c` tokens remaining for that request's `c`. After a
  burst of small requests fills the rate axis, large requests are
  denied even though the cost axis has plenty of headroom — and a
  joint admitter that priced rate at the *binding* shadow price would
  admit more large requests earlier.

The literature on this — [Devanur-Hayes 2009][devanur-hayes],
[Mehta-2007][mehta-stochastic], [Buchbinder-Jain-Naor 2007][bjn-2007] —
establishes that a primal-dual policy with **bid prices** achieves
`1 − 1/e` competitive ratio against the clairvoyant optimum in general
random-arrival models, with no distributional assumptions. The empirical
question for 0.9.0 (TK-1007) is whether the gap is large *enough* on
production LLM-gateway workloads to motivate runtime joint-LP — see §7
and DR-19 in PLAN.md §8.

---

## 2  Lit synthesis

### 2.1 Adaptive concurrency — Little's-Law-driven feedback control

[Little's Law][little] (J.D.C. Little, 1961): in steady state for any
stationary system,
```text
   L = λ · W
```
with `L` mean in-flight, `λ` mean arrival rate, `W` mean residence time
(latency). Concurrency control exploits the contrapositive: hold `λ`
fixed; if `W` rises, `L` must have grown past system capacity — *queueing*
has begun, and the ceiling should contract.

**Netflix concurrency-limits / Gradient2.** The published reference
implementation ([Netflix/concurrency-limits][netflix-limits],
[Performance Under Load][netflix-blog]) defines a gradient
`g = (RTT_noload · tolerance) / RTT_current`, EMA-smoothed, with limit
update `L_new = L · g + √L` (where `√L` is the headroom term that lets
the limit *grow* when the system is healthy). The no-load baseline is a
rolling minimum so it can drift up after a deploy. **This is what
ThrottleKit ships today** as `adaptiveConcurrency({ algorithm:
"gradient2" })` (`src/concurrency/adaptive.ts` §159-180); the
[design notes][design-notes] cite the same paper trail. AIMD is the
TCP-congestion-control-style fallback (additive +1 / multiplicative
×0.9) for workloads where the gradient is noisy.

**Envoy adaptive concurrency.** [Envoy's HTTP filter][envoy-ac]
implements a variation: a `minRTT` recalibrated periodically (every 60s,
50 samples, p90), a `sampleRTT` computed as p90 over the live window,
and the same `new_limit = old_limit · gradient + headroom` shape. The
recalibration step (briefly reducing concurrency to 1 for the
probe — sometimes called *forced minRTT*) is the structural difference
from Netflix's running-minimum approach. ThrottleKit's rolling-minimum
matches Netflix; the Envoy-style recalibration probe is a documented
follow-up (out of scope for 0.9.0 — see §11).

**Why these matter for unified admission.** The concurrency *axis* is
already done; we don't re-derive it. What's new is the *fusion* with the
other two axes — see §4.

### 2.2 Client-side adaptive throttling — Google SRE Ch.21

The [Google SRE Book Chapter 21 "Handling Overload"][sre-ch21], the
"Client-Side Throttling" section, defines the rejection probability
```text
   p = max(0, (requests − K · accepts) / (requests + 1))
```
with `K ≥ 1` the acceptance multiplier. **ThrottleKit ships this** as
`adaptiveThrottle({...})` (`src/admission/index.ts` §117-220), with a
time-weighted sliding-window approximation so `p` doesn't lurch on a
hard window boundary. This is a *client-of-a-backend* primitive — it
fronts the unified admission stack to shed work before any of rate /
concurrency / cost checks run. It is **not** part of the unified
admission composition (it operates one layer upstream); the design doc
mentions it because operators frequently confuse "adaptive throttling"
(SRE) with "adaptive concurrency" (Netflix). They are independent: the
former is local probabilistic shedding driven by backend accept rates;
the latter is a dynamic in-flight ceiling driven by latency gradients.
Both can be composed with `unifiedAdmission(...)` (front it with
`adaptiveThrottle.request()` for SRE-style protection; pass
`adaptiveConcurrency(...)` as the concurrency axis for Netflix-style
in-flight control).

### 2.3 Multi-resource admission — the OR / online-matching backbone

The joint-LP policy's theoretical bound is *already established* in the
operations-research and online-algorithms literature (DR-19):

- **[Devanur-Hayes 2009][devanur-hayes]**, "The AdWords Problem: Online
  Keyword Matching with Budgeted Bidders Under Random Permutations." A
  one-pass *sample-then-price* algorithm: observe a small prefix to learn
  dual prices, then fix them. Yields `1 − ε` competitive ratio under
  random permutation (and `1 − 1/e` more generally under online primal-
  dual). The dual variable per *budget* is a bid price; admit iff bid
  ≥ price. **This is the formal joint admission policy** — it
  generalizes to N axes by adding one dual per axis.
- **[Mehta et al. 2007][mehta-stochastic]** ("Online matching with
  stochastic rewards") and **[Buchbinder-Jain-Naor 2007][bjn-2007]**
  ("Online primal-dual algorithms for maximizing ad-auctions revenue,"
  ESA'07) extend to general multi-resource online matching with the
  same `1 − 1/e` ratio under tightness assumptions, and formalize the
  primal-dual update rules for the dual prices.
- **[Talluri-van Ryzin 1998][tvr-1998]** ("An Analysis of Bid-Price
  Controls for Network Revenue Management," Management Science 44(11))
  proves the **martingale property** for asymptotically optimal bid
  prices in the network setting: static bid-prices derived from the
  *fluid approximation* (deterministic LP relaxation) are asymptotically
  optimal under stationary arrivals as capacity scales. Their textbook
  [The Theory and Practice of Revenue Management][tvr-book] (Springer,
  2004) is the canonical reference.

**What this buys 0.9.0.** The bound for joint admission **is not an
open theory question** — it's textbook. TK-1007's role is *empirical
calibration*: measure the gap between marginal-AND (the sequential
algebra in §4) and joint-LP (the primal-dual policy above) on
production-like LLM-gateway workloads. If the gap is ≥ 5% (the DR-19
threshold), 0.10.1 ships the joint-LP runtime; otherwise we publish the
negative result and stop. See §7.

### 2.4 Cost-axis admission — the TALE work shipped pre-0.9.0

ThrottleKit's `tokenBudget` / `learnedReservation` /
`predictiveReservation` (`src/admission/index.ts`, see
[`research/cost-uncertainty/PROPOSAL.md`](../../cost-uncertainty/PROPOSAL.md))
together cover post-hoc cost admission with a per-token-overshoot bound
of 0 and `O(√T)` regret on the reservation against the best
fixed-in-hindsight quantile (Zinkevich's projected OGD, ICML'03; see
`research/cost-uncertainty/REGRET-ANALYSIS.md`). The cost axis of
`unifiedAdmission(...)` reuses these unchanged — see §4.2.

The optional **predictions-with-safety** layer
(`predictiveReservation`, citing [Fu et al. NeurIPS'24][fu-llm-rank]
for the learn-to-rank rationale) lets a per-request output-length hint
accelerate consistency without compromising the budget bound. This
remains *cost-axis-internal*; the unified admission algebra is agnostic
to which reservation policy the cost axis uses.

### 2.5 Operational practice — what production LLM gateways do today

Recent industry coverage of [LLM gateway rate limiting][typedef-llm]
([Portkey][portkey-llm], [TrueFoundry][truefoundry-llm],
[agentgateway][agentgateway-llm]) all converge on the same three-axis
model — request rate, token rate, concurrency — but enforce them as
*independent stacked checks* with no joint optimization and no shared
observability for the binding axis. **None of the surveyed gateways
exposes a unified-decision API** comparable to what 0.9.0 ships; none
publishes a competitive bound against the joint optimum.

This is the deployment-side blocker `unifiedAdmission(...)` removes:
one primitive, one decision, observable binding axis (TK-1008), and an
empirical calibration of whether joint pricing is worth the runtime
overhead (TK-1007).

---

## 3  Inventory — what 0.8.5 already provides

```
                       ┌──────────────────────────┐
                       │ caller (express, hono,  │
                       │  fetch, lambda, …)       │
                       └────────────┬─────────────┘
                                    │
                       ┌────────────▼─────────────┐
                       │ unifiedAdmission(...)    │   ← NEW in 0.9.0
                       │   .admit({ cost? })      │
                       │   → { decision, release }│
                       └────┬───────┬───────┬─────┘
                            │       │       │
        ┌───────────────────┘       │       └────────────────────┐
        │                           │                            │
   ┌────▼──────┐         ┌──────────▼──────────┐        ┌────────▼─────────┐
   │ rateLimit │         │ adaptiveConcurrency │        │ rateLimit({      │
   │  (rate    │         │  (Lease lifecycle)  │        │   tokenBucket    │
   │   axis)   │         │                     │        │   or             │
   │           │         │  src/concurrency/   │        │  distributedToken│
   │  src/core/│         │   adaptive.ts       │        │  Budget)         │
   │  limiter  │         │                     │        │                  │
   │  .ts      │         │ Two algorithms:     │        │ src/admission/   │
   │           │         │  gradient2 (default)│        │  distributed-    │
   │ → Decision│         │  aimd               │        │  budget.ts       │
   └───────────┘         └─────────────────────┘        └──────────────────┘
        │                           │                            │
        │                           │                            │
   ┌────▼──────────────────────────▼───────────────────────────▼──┐
   │                       backend stores                          │
   │   in-memory (MemoryStore) | Redis | Postgres | DynamoDB | …   │
   └──────────────────────────────────────────────────────────────┘
```

**Already-shipped, do-not-touch surfaces:**

| Surface | Where | Used by unified as |
|---|---|---|
| `Decision { allowed, limit, remaining, resetAt, retryAfterMs }` | `src/core/types.ts` §18-29 | the **canonical output type** of `combineDecisions` |
| `Limiter.check(key, cost?) → Promise<Decision>` | `src/core/types.ts` §181-205, `src/core/limiter.ts` | the **rate-axis** input |
| `ConcurrencyGuard.acquire() → Lease` | `src/concurrency/adaptive.ts` §47-56 | the **concurrency-axis** input (via the shim, §5) |
| `tokenBucket(...)` / `tokenBudget(...)` / `distributedTokenBudget(...)` | `src/algorithms/token-bucket.ts`, `src/admission/index.ts` | the **cost-axis** input |
| `Store.apply<S,R>(key, transform) → R` + Lua attached on transform | `src/core/types.ts` §157-175 | the **transport** for the Lua-fused fast path (§6) |

**No new lower-layer primitives are added in 0.9.0.** The unified
admission code in `src/admission/unified.ts` (lands TK-1004) is pure
composition.

---

## 4  Architecture — two layers

### 4.1 Layer A — the Decision algebra

```ts
// src/core/combine.ts (lands TK-1002)
export function combineDecisions(a: Decision, b: Decision): Decision;
export const ALLOW_FULL: Decision;
```

Field-by-field aggregation rules, locked here:

| Field | Aggregation rule | Axiom |
|---|---|---|
| `allowed` | `a.allowed && b.allowed` | AND — both must allow |
| `limit` | `Math.min(a.limit, b.limit)` | binding (smaller) budget — what the client should *see* as the ceiling |
| `remaining` | `Math.min(a.remaining, b.remaining)` | binding remainder — accurate `X-RateLimit-Remaining` |
| `resetAt` | `Math.max(a.resetAt, b.resetAt)` | latest-resolution wait — when *all* axes will have refilled |
| `retryAfterMs` | `Math.max(a.retryAfterMs, b.retryAfterMs)` | dominant wait — never under-state the wait |

Rationale:
- `min(limit, remaining)` mirrors the "binding constraint" intuition
  from any LP — the axis with the smallest headroom *is* the ceiling
  the client effectively faces. This is what an honest header tells the
  client to retry against.
- `max(resetAt, retryAfterMs)` is the **safe** direction — telling a
  client to wait longer never harms safety, only utility, and a client
  retrying *too early* would be denied again.

**The neutral element.** `ALLOW_FULL` is the identity for `combine`:
```ts
export const ALLOW_FULL: Decision = {
  allowed: true,
  limit: Number.POSITIVE_INFINITY,  // (or Number.MAX_SAFE_INTEGER — see §4.1.1)
  remaining: Number.POSITIVE_INFINITY,
  resetAt: 0,
  retryAfterMs: 0,
};
```
A unified admitter with only *some* axes enabled folds in `ALLOW_FULL`
for the missing ones; the algebraic laws guarantee the result equals
the single-axis Decision.

#### 4.1.1 The 4 algebraic laws (the gate TK-1002 must prove)

For all decisions `a, b, c`:

| Law | Statement | What it buys |
|---|---|---|
| **Identity** | `combine(d, ALLOW_FULL) = d`           | optional axes are "free" — adding an unused axis can't change behavior |
| **Associativity** | `combine(combine(a,b),c) = combine(a,combine(b,c))` | N inputs reduce to one via `reduce`; nested admitters fold flat |
| **Commutativity** | `combine(a,b) = combine(b,a)`          | axis evaluation order doesn't matter for the *result* (only for short-circuit cost) |
| **Idempotency** | `combine(d, d) = d`                       | duplicate-check safety — a retried sub-check carries no risk |

Associativity + commutativity together say: `combine` extends to N
inputs via `reduce` and the order doesn't affect the result, so a
Lua-fused implementation can re-order its checks freely without
changing the result. Idempotency says a retried sub-check (network
retry, sequential→fused re-validation) is safe. Identity says optional
axes plug in cleanly.

**TK-1002 proves all four** via `fast-check` property tests at
`numRuns ≥ 500`, with `Decision` arbitraries generated from random
integers and booleans.

#### 4.1.1.1 Note on `limit`/`remaining` integer-truncation

`Decision` documents integer-valued numeric fields ("All numeric fields
are integers so the JavaScript and Redis-Lua execution paths can produce
bit-identical values" — `src/core/types.ts` §16-17). `ALLOW_FULL` uses
`Number.MAX_SAFE_INTEGER` (`2^53 − 1`) — not `+Infinity` — for the
`limit` and `remaining` fields, so the algebra never produces a
non-integer (`min(Infinity, n) = n`, but bit-identity tests prefer the
explicit ceiling). The property test (TK-1002) generates `Decision`s
from `fast-check.integer({ min: 0, max: MAX_SAFE_INTEGER })`.

### 4.2 Layer B — `unifiedAdmission(...)` and the `UnifiedAdmitter`

```ts
// src/admission/unified.ts (lands TK-1004)

import { unifiedAdmission } from "throttlekit/admission";

const admit = unifiedAdmission({
  rate:        rateLimit({ strategy: gcra({...}) }),     // optional
  concurrency: adaptiveConcurrency({...}),               // optional
  cost:        rateLimit({ strategy: tokenBucket({...}) }), // optional
  // future axes plug in here
});

const { decision, release } = admit.admit({
  key:  "tenant:abc",   // for rate / cost axes (concurrency is keyless)
  cost: 1500,           // tokens (default 1, used by the cost axis)
});

if (decision.allowed) {
  try {
    await doWork();
  } finally {
    release({ dropped: false }); // releases the concurrency lease
  }
} else {
  // 429 response with the combined Decision's retryAfterMs
}

interface UnifiedAdmitter {
  admit(opts?: {
    key?: string;
    cost?: number;
  }): {
    decision: Decision;
    release: (opts?: { dropped?: boolean }) => void;
  };
  /** Per-axis introspection for OTel / metrics; matches TK-1008's `binding_axis`. */
  lastDecisions(): Readonly<Record<"rate" | "concurrency" | "cost", Decision | undefined>>;
  /** Resource disposal — closes any owned sub-limiters. */
  close?(): Promise<void>;
}
```

**Why NOT return `Limiter`** (the locked decision, DR-08). The
concurrency axis has *lease semantics* (acquire-release) that don't fit
`Limiter`'s stateless `.check() → Decision` shape. Wrapping it as a
`Limiter` would either (a) force the concurrency slot to be released at
decision time (defeating the purpose — the whole point is to hold the
slot during work), or (b) hide a global lease registry behind the
scenes (action-at-a-distance; impossible to clean up on exception
paths). The cleanest API returns `{ decision, release }` and the caller
wires `release()` to its request lifecycle hook
(`res.on("finish", release)` in express, `defer` in custom code, a
finally block).

#### 4.2.1 Two backend modes

| Mode | When it's used | Implementation | Wire cost |
|---|---|---|---|
| **Sequential** (default) | Any store mix; mixed Redis + in-process + Postgres | Each axis runs in turn; first deny short-circuits | rate-axis RTT + cost-axis RTT (often pipelined to 1 RTT in practice on the same client) |
| **Lua-fused** (opt-in) | All Redis-backed axes (rate + cost only — concurrency is in-process) | One Lua script `tk:v1:fused-rc:check` evaluates rate + cost atomically | 1 RTT, regardless of axes |

The two modes are **proven identical** in result via the algebra laws
(§4.1.1) — see TK-1006 in §9. The opt-in is for performance; the
default is for compatibility.

#### 4.2.2 Sequential composition — the evaluation order

```text
1. concurrency.acquire()           // in-process; fastest fail
   if !ok: combine(... allowed=false ...) and return
2. rate.check(key, 1)              // network if Redis-backed
   if !allowed: release concurrency; return combined
3. cost.check(key, cost)           // network if Redis-backed
   if !allowed: release concurrency; return combined
4. return combined Decision; caller holds the release
```

Commutativity (§4.1.1) means we can re-order freely without changing
the *result*; we pick the order above because:
- **concurrency first** — it's in-process and zero-RTT; short-circuiting
  here saves the Redis trip on overload.
- **rate before cost** — typically rate's RTM ceiling is hit before
  TPM's, so we shed on the more-likely binding axis first (this is a
  *heuristic*; the result is unchanged either way).

The first deny still requires releasing whatever was already acquired.
This is what makes the shim (§5) load-bearing — the concurrency lease
released on a downstream deny must be released *correctly* (passing
`{ dropped: false }` so the RTT sample isn't poisoned by a deny-shaped
short window).

---

## 5  The Lease ↔ Decision shim

Two different lifecycle shapes:

| | `Limiter.check()` (rate / cost) | `ConcurrencyGuard.acquire()` (concurrency) |
|---|---|---|
| Decision shape | `{ allowed, limit, remaining, resetAt, retryAfterMs }` | `{ ok: boolean, release: (opts?) => void }` |
| State after admit | none (the strategy is a pure function of `(state, now, cost)`) | a held slot; consumed via `release` |
| State after deny | none | none (rejected leases hold no slot) |
| RTT sample on release | n/a | recorded via `release` for the gradient2 / AIMD update |

The shim's job (`src/admission/lease-shim.ts`, lands TK-1003):

```ts
// Land TK-1003 — pseudo-code, locked surface
function leaseShim(guard: ConcurrencyGuard, clock: Clock): {
  acquire(): {
    decision: Decision;
    release: (opts?: { dropped?: boolean }) => void;
  };
} {
  return {
    acquire() {
      const lease = guard.acquire();
      const decision: Decision = lease.ok
        ? {
            allowed: true,
            limit: guard.limit,
            remaining: Math.max(0, guard.limit - guard.inflight),
            resetAt: clock.now(),  // concurrency replenishes on release, not on a clock
            retryAfterMs: 0,
          }
        : {
            allowed: false,
            limit: guard.limit,
            remaining: 0,
            resetAt: clock.now(),
            // No clock-based wait — the slot frees when an in-flight finishes.
            // Heuristic: report the rolling p50 RTT as a best-effort hint.
            retryAfterMs: Math.max(1, Math.round(guard.stats().lastRtt || 1)),
          };
      return { decision, release: lease.release };
    },
  };
}
```

**Locked semantics:**
- A *rejected* lease (`lease.ok === false`) maps to a `Decision` with
  `allowed: false` and `retryAfterMs` = best-effort RTT hint (since the
  slot frees by *event*, not by clock). The hint is honest under
  Little's Law: average wait ≈ average RTT under saturation.
- An *accepted* lease's `release` is propagated up to the
  `UnifiedAdmitter.admit()` return so the caller can wire it to its
  lifecycle. The shim itself does not introspect; it just
  passes through.
- `release({ dropped: true })` semantics (timeout/error path) flow
  through unchanged to the underlying gradient2 / AIMD update — the
  unified layer never *hides* drop information.

#### 5.1 The "decision time vs release time" subtlety

`Decision.remaining` at the time of `admit()` says "after this
admission, what's left." For concurrency, that's
`guard.limit - guard.inflight` *immediately after* the slot was taken
(so already accounting for our admission). For rate/cost, that's the
strategy's post-consume `remaining`. Both are "after-this-call." This
makes `combineDecisions(rate, conc, cost)` honest — `min(remaining)`
across the three is the binding remaining capacity, regardless of axis
shape.

---

## 6  The Lua-fused atomic check (DR-04)

For all-Redis backends (rate + cost both backed by Redis stores;
concurrency stays in-process), one Lua script atomically evaluates both
the rate and cost transitions in a single round trip:

```text
tk:v1:fused-rc:check
   KEYS[1] = rate key
   KEYS[2] = cost key
   ARGV[1] = now (epoch-ms; 0 ⇒ use server TIME)
   ARGV[2] = rate.cost (request weight on the rate axis; usually 1)
   ARGV[3] = cost.cost (tokens; the LLM cost)
   ARGV[4..] = strategy params (limit, periodMs, capacity, refill, …)
   returns [
     allowed (0/1),                                  // AND of rate.allowed and cost.allowed
     limit, remaining, resetAt, retryAfterMs,        // combineDecisions of rate ⊕ cost
     rate_allowed (0/1), rate_remaining, rate_resetAt, rate_retryAfterMs,
     cost_allowed (0/1), cost_remaining, cost_resetAt, cost_retryAfterMs,
   ]
```

The script is **two existing pure-Lua transitions glued together** via
the field-by-field algebra in §4.1 (which is purely arithmetic — `min`,
`max`, `and` — and runs identically in Lua):
```lua
allowed = rate_allowed AND cost_allowed
limit = math.min(rate_limit, cost_limit)
remaining = math.min(rate_remaining, cost_remaining)
resetAt = math.max(rate_resetAt, cost_resetAt)
retryAfterMs = math.max(rate_retryAfterMs, cost_retryAfterMs)
```

**Why concurrency stays out of the Lua.** Its state is *temporal*
(in-flight count, RTT samples, gradient EMA) — none of which exist on
the Redis side. Fusing concurrency into Lua would require shipping the
adaptive concurrency algorithm to Lua and round-tripping every
acquire/release — a much bigger surface change and a different release
boundary (the DR-10 item). For 0.9.0, concurrency stays in-process;
the fused script handles rate + cost only.

**Wire-protocol freeze respect (DR-14).** The script is named
`tk:v1:fused-rc:check` — additive only. No existing script is renamed.
No wire-protocol freeze authorized; the `v1:` prefix is a *string
constant*, not a wire-protocol version commitment (clients don't
negotiate; the server-side `EVALSHA` is opaque).

**Equivalence of sequential vs fused (TK-1006).** Proven via the
algebra in §4.1: sequential evaluates rate then cost on the same `now`
(passed once to both, see `src/core/limiter.ts` how `applySync` reuses
a single timestamp), and `combineDecisions` is commutative —
`combine(rate, cost) = combine(cost, rate)`. The fused script computes
the same fields via the same arithmetic on the same `now`. Therefore
`Decision` streams from the two modes are bit-identical given the same
input sequence — the TK-1006 conformance test asserts this on ≥ 100
generated timelines.

---

## 7  The research question — joint vs marginal (TK-1007)

**Is the joint admission optimum strictly better than the AND of
marginal optima?**

When the three axes are correlated, a *joint* policy that prices each
axis at its **bid price** (the dual variable in the resource-allocation
LP) can admit requests that an AND-of-marginals policy would deny,
without violating any individual axis bound. The literature settles
that this *can* happen (see §2.3); TK-1007 measures *how much* it
happens on production-shaped workloads.

### 7.1 Toy model

`research/bigger-bets/unified/sim.ts` (lands TK-1007):

- **Axes**: 2 baseline (rate + cost; concurrency added later if 2-axis
  result is decisive). Poisson arrivals of two request types:
  - "small": rate-weight 1, cost-weight 100
  - "large": rate-weight 1, cost-weight 10 000
- **Correlation knob**: `ρ ∈ [−1, 1]` — the conditional probability of
  large-given-burst. `ρ = 0` = independent; `ρ = +1` = bursts of large;
  `ρ = −1` = anti-correlated.
- **Budgets**: rate `R = 100 req/min`, cost `C = 1 000 000 tok/min`.
- **Three policies**:

  | Policy | Rule |
  |---|---|
  | **Marginal-AND** (baseline = today's stacked middleware) | admit iff `rate.remaining ≥ 1 AND cost.remaining ≥ req.cost` |
  | **Joint-LP** (the candidate optimum) | static bid prices `(p_R, p_C)` from the fluid LP `max Σ_i x_i s.t. Σ_i w_R,i x_i ≤ R, Σ_i w_C,i x_i ≤ C, 0 ≤ x_i ≤ 1`; admit iff `1 ≥ p_R · w_R,i + p_C · w_C,i` |
  | **Clairvoyant oracle** | knows full arrival sequence; solves the offline LP exactly — the upper bound |

- **Figure of merit**: regret of marginal-AND against the joint-LP and
  against the clairvoyant, averaged over `ρ ∈ {−1, −0.5, 0, +0.5, +1}`
  with 20 random seeds per `ρ`. Reported as percent admit-rate gap and
  percent revenue gap (under a "small = 1 unit, large = 100 units"
  revenue model — see DR-19 for the calibration story).

### 7.2 The ε ≥ 5% threshold (DR-19)

The 0.10.1 release of the joint-LP runtime is **conditional** on TK-1007
showing `regret(marginal-AND) − regret(joint-LP) ≥ 5%` on production-
shaped workloads. Why 5%:
- Below 5%, the runtime cost of solving even a small LP every admission
  (or carrying the running primal-dual update) outweighs the gain on
  realistic workloads. Operators won't enable it.
- Above 5%, the gain is large enough to motivate the opt-in policy
  surface. Devanur-Hayes 2009 reports `1 − 1/e ≈ 37%` competitive ratio
  in the worst case, so 5% is *conservative* relative to the
  literature's bounds — we ship even modest empirical improvement.

### 7.3 Both outcomes are publishable

- **ε ≥ 5%** ⇒ 0.10.1 adds `policy: "joint-lp"` to
  `unifiedAdmission(...)`. The algebra still ships in 0.9.0 unchanged;
  joint-LP is a separate code path gated behind the opt-in flag.
- **ε ≈ 0 universally** ⇒ marginal-AND (= the algebra) is *tight* in
  practice; the negative result is itself a contribution
  (the DR-11 / DR-19 documentation track), and the 0.10.1 release
  is held with a written-up explanation.

0.9.0 ships independent of the result — the algebra is the value either
way.

---

## 8  Public API (the locked 0.9.0 surface)

All additive. No breaking changes to 0.8.5.

### 8.1 `src/core/combine.ts` (TK-1002)

```ts
import type { Decision } from "./types";

/**
 * The neutral element for {@link combineDecisions}: a decision that
 * allows unboundedly. Used as the seed for reducing N decisions.
 */
export const ALLOW_FULL: Decision;

/**
 * Combine two {@link Decision}s into one: AND on `allowed`, MIN on
 * `limit`/`remaining`, MAX on `resetAt`/`retryAfterMs`. Pure,
 * total, and obeys the four algebraic laws — see
 * `research/bigger-bets/unified/DESIGN.md` §4.1.1.
 */
export function combineDecisions(a: Decision, b: Decision): Decision;
```

Exported from the root `src/index.ts` (additive):

```ts
export { combineDecisions, ALLOW_FULL } from "./core/combine";
```

### 8.2 `src/admission/lease-shim.ts` (TK-1003)

```ts
import type { Decision, Clock } from "../core/types";
import type { ConcurrencyGuard } from "../concurrency/adaptive";

export interface LeaseAdmission {
  decision: Decision;
  release: (opts?: { dropped?: boolean }) => void;
}

/**
 * Bridge a {@link ConcurrencyGuard}'s `acquire() → Lease` into a
 * Decision-shaped check; the release stays separate (callers wire it
 * to their request lifecycle).
 */
export function leaseAsAdmission(
  guard: ConcurrencyGuard,
  clock?: Clock,
): { acquire(): LeaseAdmission };
```

Exported from `src/admission/index.ts`. The shim is also reused
internally by `unifiedAdmission(...)`.

### 8.3 `src/admission/unified.ts` (TK-1004)

```ts
import type { Limiter, Decision, Clock } from "../core/types";
import type { ConcurrencyGuard } from "../concurrency/adaptive";

export interface UnifiedAdmissionOptions {
  rate?: Limiter;
  concurrency?: ConcurrencyGuard;
  cost?: Limiter;
  /**
   * `"sequential"` (default) or `"lua-fused"`. The latter requires
   * `rate` and `cost` to both be Redis-backed limiters; throws at
   * construction otherwise.
   */
  backend?: "sequential" | "lua-fused";
  clock?: Clock;
}

export interface UnifiedAdmitOptions {
  key?: string;
  cost?: number;
}

export interface UnifiedAdmission {
  decision: Decision;
  release: (opts?: { dropped?: boolean }) => void;
}

export interface UnifiedAdmitter {
  admit(opts?: UnifiedAdmitOptions): UnifiedAdmission;
  lastDecisions(): Readonly<
    Record<"rate" | "concurrency" | "cost", Decision | undefined>
  >;
  close?(): Promise<void>;
}

export function unifiedAdmission(
  options: UnifiedAdmissionOptions,
): UnifiedAdmitter;
```

Exported from `src/admission/index.ts` and re-exported at the root
`src/index.ts`. Also available on the existing subpath
`throttlekit/admission` (already an export in `package.json`).

### 8.4 What is NOT in 0.9.0's public surface

- `Decision.bindingAxis` — would be a breaking change to the
  `Decision` shape. Stays *out*; the binding axis is exposed via
  TK-1008's OTel attribute `tk.binding_axis ∈ {"rate","concurrency","cost"}`
  and the `lastDecisions()` introspection in §8.3. Revisit at 1.0.
- `policy: "joint-lp"` — gated behind TK-1007's empirical result;
  ships in 0.10.1 if at all (DR-11, DR-19).
- Distributed adaptive concurrency — out of scope per DR-10 →
  0.10.0.
- Federated unified admission — composes naturally with `federate(...)`
  (already shipped 0.8.3); no new surface needed in 0.9.0. The
  composition pattern is: pass a `federate(...)`-backed `Limiter` as
  the rate or cost axis; the unified admitter doesn't know or care
  about the federation layer. Tested in TK-1004 against a federated
  rate limiter.

---

## 9  Sub-task gates (TK-1002..TK-1009)

Verbatim from `research/bigger-bets/PLAN.md` §4.5, expanded with the
gate this design doc locks for each:

| Task | Gate this doc locks |
|---|---|
| **TK-1002** combineDecisions + algebraic-laws property test | §4.1 algebra is binding; §4.1.1 laws are the property test's targets |
| **TK-1003** Lease ↔ Decision shim | §5 shim semantics binding; the `retryAfterMs = lastRtt` heuristic is the locked default |
| **TK-1004** unifiedAdmission sequential composition | §4.2 API binding; §4.2.2 evaluation order binding; sequential is the default |
| **TK-1005** Lua-fused admission (Redis-only opt-in) | §6 script binding; name `tk:v1:fused-rc:check` is reserved |
| **TK-1006** dual-path conformance fused ≡ sequential | §6 equivalence argument is the test's hypothesis |
| **TK-1007** joint vs marginal toy model + analysis | §7 toy model + 5% threshold binding; both outcomes are publishable |
| **TK-1008** OTel `tk.binding_axis` attribute + docs sweep | §4.2 `lastDecisions()` is the data source; TK-1008 designs the attribute names |
| **TK-1009** Release 0.9.0 | full release prep — pin SCOREBOARD test count; wiki Unified-Admission page |

Each task's commit must pass `npm run check` standalone (the standing
PLAN.md §2 rule). The chain is linear: each task assumes the prior
task's surfaces exist.

---

## 10  Failure modes (vs 0.8.5 baseline)

| Failure shape | 0.8.5 behavior | 0.9.0 behavior under `unifiedAdmission` |
|---|---|---|
| Rate-axis store unreachable | `Limiter` throws or denies per `failMode` | sequential mode: per-axis `failMode` honored; fused mode: deny-closed (the script can't partial-execute under `EVALSHA` outage) |
| Cost-axis store unreachable | as above | same |
| Concurrency-axis: nothing (in-process) | — | n/a — concurrency has no store |
| All three axes return | three independent Decisions; caller combines manually (or, more commonly, stops at the first deny in middleware) | one `Decision` via the algebra; `lastDecisions()` exposes per-axis for observability |
| Mixed-backend (Redis rate + Postgres cost + in-process conc) | works; sequential by necessity | works; throws at construction if `backend: "lua-fused"` is requested |
| Caller forgets to call `release()` | concurrency leak (in-flight count grows monotonically) | same — the unified layer can't enforce caller's lifecycle |
| Caller double-`release()`s | `Lease.release` is documented idempotent (no-op on second call) | unchanged (the shim passes through to `Lease.release`) |

**Bound preserved across the addition.** The per-axis bounds (rate's
per-window admit ceiling, concurrency's adaptive in-flight ceiling,
cost's per-token-overshoot-of-0 bound) all hold independently within
the unified composition — the algebra only *combines* the decisions; it
never relaxes any axis. The unified layer is *more restrictive* than
any single axis (it's an AND), never less.

---

## 11  Out of scope for 0.9.0 (deferred work)

These items have explicit owners and target releases — see PLAN.md §6
and §8.

| Item | Why deferred | Target |
|---|---|---|
| **Distributed adaptive concurrency** | Each region's concurrency state as a leased counter against a global limit — a federation-composition story, not part of fusion (DR-10). | 0.10.0 (TK-1314..TK-1318) |
| **Joint-LP runtime policy** | Gated on TK-1007's empirical result (DR-11, DR-19) | 0.10.1 (TK-1319..TK-1323), conditional |
| **Federated unified admission** | Composes for free via §8.4's pattern; no new surface needed. Eval can land in 0.10.x if there's demand. | — |
| **Envoy-style minRTT forced recalibration** | A concurrency-axis polish item, not unification work. | follow-up patch |
| **Dynamic axis discovery** | `unifiedAdmission(...)` takes a fixed `{ rate?, concurrency?, cost? }` shape. Users who want to add new axes (memory budget, etc.) write a `Limiter`-shaped adapter and pass it as `rate` or `cost` — the algebra is shape-agnostic. | 1.0 candidate (more axes ⇒ wider input type) |
| **`Decision.bindingAxis` field** | Breaking change to `Decision` shape; would force every limiter to populate it. Use TK-1008's OTel attribute + `lastDecisions()` introspection instead. | 1.0 candidate |
| **Predictions-with-safety hooks at the unified layer** | `predictiveReservation` is cost-axis-internal — `unifiedAdmission` doesn't observe per-axis policies. | n/a — design preserved as-is |

---

## 12  Definition of done (TK-1001)

- `research/bigger-bets/unified/DESIGN.md` (this file) committed.
- §4.1 algebra is fixed: the field-by-field rules and the 4 algebraic
  laws are stated unambiguously enough that TK-1002's property test can
  encode them directly from this doc.
- §4.2 `UnifiedAdmitter` interface is locked: TK-1003..TK-1005 can
  implement against the signatures in §8 without re-design.
- §6 Lua-fused script `tk:v1:fused-rc:check` is reserved (the name is
  in this doc; the script lands TK-1005).
- §7 toy model + 5% threshold are committed; TK-1007 implements the sim
  to match this spec.
- Lit synthesis (§2) cites authoritative sources for each
  load-bearing claim:
  - Netflix gradient2 and Envoy adaptive concurrency for the
    concurrency axis;
  - Google SRE Ch.21 for adaptive throttling (clarified as upstream
    of unified, not part of it);
  - Devanur-Hayes / Talluri-van Ryzin / Mehta / Buchbinder-Jain-Naor
    for the joint-LP optimality literature;
  - Little's Law for the rate↔concurrency conjugate;
  - existing ThrottleKit cost-uncertainty work for the cost axis.
- No code added; `npm run check` continues to pass at 913 tests (0.8.5
  baseline). Commit: `docs(research): unified admission design doc +
  algebra spec + lit synthesis (TK-1001)`.

---

## 13  References

### 13.1 Internal

- `src/core/types.ts` — `Decision`, `Limiter`, `Strategy`, `Store`,
  `Clock`. The `Decision` shape is the canonical output of every
  primitive in the library and the type that `combineDecisions`
  operates over (§4.1).
- `src/core/limiter.ts` — `rateLimit(...)`. The rate-axis input.
- `src/concurrency/adaptive.ts` — `adaptiveConcurrency(...)`. The
  concurrency-axis input. Gradient2 (default) + AIMD; both algorithms
  are documented in `docs/DESIGN-NOTES.md` ("Adaptive concurrency").
- `src/admission/index.ts` — `adaptiveThrottle` (SRE-style, separate
  from unified), `fairShare` / `weightedFairShare` (tenant-fairness
  layer, separate from unified), `tokenBudget` /
  `distributedTokenBudget` (cost-axis inputs), `learnedReservation` /
  `predictiveReservation` (cost-axis-internal reservation policies).
- `src/algorithms/token-bucket.ts` — the rate / cost-axis strategy
  most commonly used.
- `research/cost-uncertainty/PROPOSAL.md`,
  `research/cost-uncertainty/REGRET-ANALYSIS.md` — TALE work the
  cost-axis composition reuses; the per-token-overshoot-of-0 bound
  holds in unified.
- `research/bigger-bets/federation/DESIGN.md` — the *composition*
  pattern (each region as a leased node), which §8.4 reuses for
  federated unified admission.
- `research/bigger-bets/PLAN.md` §4 — the canonical roadmap for
  unified; this doc expands §4.

### 13.2 External (literature)

[little]: https://en.wikipedia.org/wiki/Little%27s_law
[netflix-limits]: https://github.com/Netflix/concurrency-limits
[netflix-blog]: https://netflixtechblog.medium.com/performance-under-load-3e6fa9a60581
[envoy-ac]: https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/adaptive_concurrency_filter
[design-notes]: ../../../docs/DESIGN-NOTES.md
[sre-ch21]: https://sre.google/sre-book/handling-overload/
[devanur-hayes]: https://www.nikhildevanur.com/pubs/Adwords.pdf
[mehta-stochastic]: https://research.google.com/pubs/archive/40363.pdf
[bjn-2007]: https://link.springer.com/chapter/10.1007/978-3-540-75520-3_24
[tvr-1998]: https://pubsonline.informs.org/doi/10.1287/mnsc.44.11.1577
[tvr-book]: https://link.springer.com/book/10.1007/b139000
[fu-llm-rank]: https://arxiv.org/abs/2408.15792
[typedef-llm]: https://www.typedef.ai/resources/handle-token-limits-rate-limits-large-scale-llm-inference
[portkey-llm]: https://portkey.ai/blog/rate-limiting-for-llm-applications/
[truefoundry-llm]: https://www.truefoundry.com/blog/rate-limiting-in-llm-gateway
[agentgateway-llm]: https://agentgateway.dev/docs/kubernetes/2.2.x/llm/rate-limit/

- **J.D.C. Little (1961).** "A Proof for the Queuing Formula:
  L = λW." *Operations Research* 9(3): 383-387. The original
  derivation of Little's Law; modern restatement at [the Wikipedia
  article][little].
- **Netflix concurrency-limits.** Repository at
  [Netflix/concurrency-limits][netflix-limits]; algorithmic write-up at
  [Performance Under Load][netflix-blog]. The gradient2 reference
  implementation in `Gradient2Limit.java`. ThrottleKit's
  `adaptiveConcurrency({ algorithm: "gradient2" })` follows the same
  EMA + rolling-min-RTT shape.
- **Envoy adaptive concurrency filter** ([HTTP filter docs][envoy-ac]).
  A variation on the Netflix algorithm with periodic forced minRTT
  recalibration (50 samples / 60s / p90).
- **Beyer, Jones, Petoff, Murphy, eds.** *Site Reliability Engineering*,
  O'Reilly 2016. Chapter 21 "Handling Overload"
  ([online][sre-ch21]) — Client-Side Throttling section, the
  `p = max(0, (req − K·acc)/(req+1))` formula ThrottleKit's
  `adaptiveThrottle({...})` implements.
- **N.R. Devanur, T.P. Hayes (2009).** "The AdWords Problem: Online
  Keyword Matching with Budgeted Bidders Under Random Permutations."
  *EC'09: Proc. 10th ACM Conf. on Electronic Commerce*. PDF:
  [Devanur's page][devanur-hayes]. The sample-then-price algorithm;
  `1 − ε` competitive ratio under random permutation; foundational for
  the joint-LP policy (DR-19).
- **A. Mehta, A. Saberi, U. Vazirani, V. Vazirani (2007).** "AdWords
  and Generalized Online Matching." *J. ACM* 54(5). Extended treatment
  of multi-resource matching; the `1 − 1/e` bound. See also
  [Mehta-2007 (stochastic rewards)][mehta-stochastic] for the
  stochastic-arrival extension.
- **N. Buchbinder, K. Jain, S. Naor (2007).** "Online Primal-Dual
  Algorithms for Maximizing Ad-Auctions Revenue." *ESA'07: Proc. 15th
  European Symp. Algorithms*, LNCS 4698, pp. 253-264. PDF on
  [SpringerLink][bjn-2007]. Generalizes the AdWords analysis to general
  multi-resource auctions; the primal-dual update rule for bid prices.
- **K. Talluri, G. van Ryzin (1998).** "An Analysis of Bid-Price
  Controls for Network Revenue Management." *Management Science*
  44(11), pp. 1577-1593. [INFORMS][tvr-1998]. Martingale property of
  asymptotically optimal bid prices from the fluid LP relaxation.
- **K. Talluri, G. van Ryzin (2004).** *The Theory and Practice of
  Revenue Management.* International Series in Operations Research &
  Management Science, Springer. [SpringerLink][tvr-book]. Canonical
  textbook reference for the bid-price framework.
- **Y. Fu et al. (2024).** "Efficient LLM Scheduling by Learning to
  Rank." *NeurIPS 2024*. [arXiv][fu-llm-rank]. The learn-to-rank
  rationale `predictiveReservation` cites for blending per-request
  length hints with the robust learner.
- **M. Zinkevich (2003).** "Online Convex Programming and Generalized
  Infinitesimal Gradient Ascent." *ICML'03*. The projected OGD
  algorithm `learnedReservation` uses; canonical regret bound
  `R_T ≤ (3/2) · D · G · √T` (see `research/cost-uncertainty/REGRET-ANALYSIS.md`).

### 13.3 Industry LLM-gateway practice

Surveyed during the lit pass to confirm the gap §1 / §2.5 closes is real
in deployed systems:

- [TypeDef — Handle Token & Rate Limits in Large-Scale LLM Inference][typedef-llm]
- [Portkey — Rate limiting for LLM applications][portkey-llm]
- [TrueFoundry — Rate Limiting in AI Gateway: The Ultimate Guide][truefoundry-llm]
- [agentgateway docs — Rate limiting for LLMs][agentgateway-llm]

None publishes a unified-decision API with shared binding-axis
observability or a competitive bound against a joint optimum — the gap
0.9.0 closes.

---

## 14  Decision summary (revisitable)

Locked here (cross-referenced from PLAN.md §8). Edit in place if
implementation revisits — add a one-line "Why changed."

| ID | Decision | Source | Status |
|---|---|---|---|
| **D-U1** | `combineDecisions` aggregation = AND on `allowed`, MIN on `limit`/`remaining`, MAX on `resetAt`/`retryAfterMs`. | §4.1 | Locked unless the property test (TK-1002) finds a law violation forces a re-derivation |
| **D-U2** | The 4 algebraic laws (identity, associativity, commutativity, idempotency) are the binding spec for TK-1002's property test (`numRuns ≥ 500`). | §4.1.1 | Locked |
| **D-U3** | `ALLOW_FULL` uses `Number.MAX_SAFE_INTEGER` for `limit`/`remaining` (not `+Infinity`), so the algebra produces only integers. | §4.1.1.1 | Locked unless bit-identity tests show a counter-example |
| **D-U4** | `unifiedAdmission(...)` returns `UnifiedAdmitter` with `.admit() → { decision, release }`, NOT `Limiter`. | §4.2, restating PLAN.md DR-08 | Locked |
| **D-U5** | Sequential mode is the default backend; `backend: "lua-fused"` is opt-in and requires Redis-backed rate + cost. Concurrency stays in-process either way. | §4.2.1, PLAN.md DR-04 | Locked |
| **D-U6** | Sequential evaluation order: concurrency → rate → cost. Commutativity (D-U2) makes the *result* order-independent; the choice is a heuristic-fastest-fail. | §4.2.2 | Locked unless a benchmark shows a different order universally cheaper |
| **D-U7** | Lease ↔ Decision shim: rejected lease → `retryAfterMs = max(1, round(lastRtt))` (Little's-Law honest hint, since the slot frees by event not by clock). | §5 | Locked unless the property test (TK-1003) flags non-monotonicity |
| **D-U8** | Lua-fused script name is `tk:v1:fused-rc:check` — additive only; no rename of existing scripts; no wire-protocol freeze (DR-14). | §6 | Locked |
| **D-U9** | Sequential ≡ Lua-fused dual-path: bit-identical `Decision` streams under TK-1006 (≥ 100 generated timelines × {rate-only, cost-only, rate+cost}). | §6 | Locked — the algebra proof in §6 is the testable hypothesis |
| **D-U10** | TK-1007 toy model = 2-axis (rate + cost) Poisson + bivariate type stream, `ρ ∈ {−1, −0.5, 0, +0.5, +1}`, 20 seeds, three policies (marginal-AND, joint-LP static fluid prices, clairvoyant). | §7.1 | Locked unless the 2-axis result is too noisy to call, in which case extend to 3-axis |
| **D-U11** | 0.10.1 joint-LP runtime ships iff `regret(marginal-AND) − regret(joint-LP) ≥ 5%` on TK-1007's calibration workload, else hold and document the negative result (DR-11, DR-19). | §7.2 | Locked — threshold is the gate, not the result |
| **D-U12** | `Decision.bindingAxis` is OUT of 0.9.0 (breaking change). Use OTel attribute `tk.binding_axis` (TK-1008) and `UnifiedAdmitter.lastDecisions()` instead. Revisit at 1.0. | §8.4 | Locked unless 1.0 ships |

When implementation reveals a decision needs to change, edit the row in
place and add a one-line "Why changed" — do not silently rewrite. Same
convention as PLAN.md §8 and the federation / regional-escrow
design docs.
