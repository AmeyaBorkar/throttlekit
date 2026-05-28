# Bigger bets — roadmap & ROI plan

> Status: 0.8.3 (federation, #77) SHIPPED 2026-05-28. This doc updated post-ship
> to drive the next two bets: #79 (unified admission, 0.9.0) and #78 (polyglot,
> 1.0.0). Implementation begins on TK-1001.
> Maintainer of this doc: whoever picks up the next task in [Tasks](#tasks).
> Edit guideline: this is a *living* roadmap — when a design decision is
> revisited (e.g. an experiment invalidates an assumption), update the
> "Decision records" section in place rather than dropping a new doc.

This file is the single source of truth for ordering, cross-cutting decisions,
and per-bet design notes for the three "bigger bets" tracked in `MEMORY.md`
and the task system. It survives session compaction and is the doc the
implementer reads first.

---

## 0  Why this doc exists

The 0.8.x line is feature-complete relative to `THROTTLEKIT.md` and the GALE /
TALE shipping map (`memory/throttlekit-research-direction.md`). Federation
(#77) shipped as **0.8.3** on 2026-05-28 (`npm view throttlekit version` =
`0.8.3`). Two bigger bets remain:

| # | Bet | Status |
|---|---|---|
| #77 | Cross-cluster federation | **✅ shipped 0.8.3** (federate, RedisCoordinator, K-independent bound, real-cluster eval committed) |
| #79 | Unified admission (rate ⊕ concurrency ⊕ cost) | **next — target 0.9.0** |
| #78 | Versioned Lua wire protocol + Go/Rust ports | **after #79 — target 1.0.0** |

The remaining two are large enough that each warrants its own minor release.
The order is fixed by ROI: #79 ships first because it has the higher dual
payoff (paper-track AND user-facing); #78 freezes a wire protocol that #79
may still evolve, so it lands last.

This doc fixes ordering, locks the architecturally load-bearing decisions, and
enumerates the bisectable commits each release decomposes into.

---

## 1  ROI ordering & rationale (post-0.8.3)

| Order | Bet | Target release | Why this position |
|---|---|---|---|
| ~~0~~ | ~~#77 Cross-cluster federation~~ | ~~0.8.3~~ | **✅ shipped 2026-05-28**; eval committed under `research/bigger-bets/federation/eval/`; HotNets paper material is now concrete, not promissory. *Versioned as a patch within the 0.8 line — see DR-07.* |
| 1 | **#79 Unified admission** (rateLimit + adaptiveConcurrency + tokenBudget fusion) | **0.9.0** | Highest-leverage user-facing primitive for LLM gateways — they want one decision, not three. Carries a genuine open theory question (joint vs marginal optimum). 0.9.0 is the first minor bump post-federation — appropriate for a NEW abstraction (`unifiedAdmission`) layered over additive concurrency / cost surfaces. The existing `adaptiveConcurrency()` primitive is already shipped (`src/concurrency/adaptive.ts`); the work is fusion, not new infrastructure. |
| 2 | **#78 Versioned Lua wire protocol + Go/Rust ports** | **1.0.0** | Pure adoption work; weakly coupled to the research story. Doing it last lets #79 evolve the wire protocol freely (the fused-admission script in TK-1005 may add a v1 entry); locking it down then is the natural `1.0` moment. The wire-protocol freeze is itself a major-version commitment (Stripe / protobuf model). |

**Order rationale.** #79 ships before #78 because (a) it produces a
paper-track result regardless of outcome (positive joint ⇒ algorithmic
contribution; negative joint ⇒ "marginal-AND is tight" is itself
publishable), (b) operators are asking for it loudly (LLM gateways are the
loudest customer segment post-federation), and (c) the substrate
(`adaptiveConcurrency`) is already shipped. #78 is real value but
adoption-only, and freezing a wire protocol while #79 may still add Lua
scripts would force a v1 amendment dance immediately after the freeze.

**What would invalidate the order:**
- LLM-vendor customer asking for Go/Rust NOW → #78 jumps to #1.
- HotNets reviewer feedback requiring a fused-admission eval before
  notification → TK-1007 (joint-vs-marginal sim) becomes time-critical
  against the paper deadline.
- TK-1007 yields a clean negative result (joint = marginal universally) →
  #79 demotes to feature-only and ships faster (skip the joint-LP planning;
  algebra + sequential + fused is the deliverable).

## 1a  Parallel track: the HotNets '26 paper

**Submission Jul 16, 2026 AoE — ~7 weeks from this plan.** Status update
post-0.8.3:

The federation eval (`research/bigger-bets/federation/eval/RESULTS.md`) is
now the paper's **primary empirical result**. Δ = 0 across the skew sweep,
U_capacity = 1.000 at max skew (vs static-partition's 0.333), TLA⁺-pinned
BFS twin in `test/gale/federated/`. The narrative arc is concrete and the
numbers are committed. Prose draft (`research/hotnets2026/DRAFT.md`) was
written against promissory numbers; the federation section now needs a
single editorial pass to replace TBDs with the committed eval numbers.

What's left is *assembly*, not research:
1. LaTeX'ify the prose (the body is already double-blind-clean and the
   federation numbers slot in cleanly).
2. Set up the anonymized mirror (`anonymous.4open.science`).
3. Tighten to ≤6 pp 10 pt.
4. Confirm the '26 format rules when the CFP posts.

Effort: ~5 focused days. This **runs in parallel** with bet #79; the bets
are the deep work and the paper is the assembly. Do not let the bets crowd
out the paper — the deadline is hard. If TK-1007's joint-vs-marginal sim
lands by ~Jul 1 with a positive result, fold it in as a secondary
contribution; otherwise paper goes federation-only (which is itself a
HotNets-grade result on its own).

A separate task (TK-1200) tracks the paper. Treat it as a parallel
single-developer track, not a serial dependency.

---

## 2  Cross-cutting decisions (apply to every bet)

These are the standing rules — they're not bet-specific.

| Decision | Choice | Why |
|---|---|---|
| **Commit granularity** | Every commit must pass `npm run check` (lint + tsc + vitest) | Bisectability — `git bisect` must give a useful answer |
| **Co-author trailers** | Never | Project rule (`memory/no-coauthor-commits.md`) |
| **Wiki coupling** | Wiki commits accumulate locally on `tk-wiki` master, **pushed only at release tag time** | Public docs must not lead npm; user has confirmed this rule three times now (0.8.1, 0.8.2, 0.8.3) |
| **Release authorization** | Explicit user OK before `git push origin vX.Y.Z` | npm publish is irreversible |
| **Proof-first** | New formal-bounded primitives (federation, fused admission) ship with the TLA⁺ / BFS proof *before* the production code | GALE pillars were built this way; it caught the EOQ-cost-model bug |
| **Dual-path conformance** | Every Lua-backed primitive must have a JS↔Lua dual-path test (seeded grid *and* shrinkable property fuzz) | `test/conformance/{conformance,lua-property}.test.ts` are the templates |
| **Eval reproducibility** | Every measured number that lands in a paper / SCOREBOARD must be regeneratable by a script committed under `research/<bet>/` | Already established by `research/hotnets2026/fig2.ts` |
| **Wire-protocol versioning** | `tk:v1:*` is the current implicit version; #78 freezes it. Any wire change before #78 is a *minor* compatible add (new script name); breaking changes wait until v2 / a major release | Avoids a wire churn before the polyglot freeze |
| **Zero runtime deps** | Stays. New peers continue to be optional. | Project value |

---

## 3  Bet #77 — Cross-cluster federation [SHIPPED 0.8.3 — historical]

> **Status: SHIPPED 2026-05-28 as 0.8.3** (per DR-07 patch decision).
> Detailed design + proofs + eval live at
> `research/bigger-bets/federation/{DESIGN.md, RESULTS.md, baselines.md}`.
> Sub-tasks TK-901..TK-912 closed; meta TK-823 closed. The full original
> plan (architecture, sub-tasks, definition of done) is retained below as
> historical reference — useful for understanding what locked in vs what
> changed at ship time.

**Eval headline numbers (post-ship):**
- Δ = 0 on every measured configuration (skew 0..1, RTT 1ms..100ms)
- U_capacity = 1.000 at max skew (vs 0.333 for static-partition baseline) — **+0.667 utilization recovery**
- 38 coordinator round trips per 600 admissions at batch=16 (1/batch amortization confirmed)
- BFS twin pinned TLC counts byte-for-byte (8 / 27 / 112 distinct states for K=2/3/5)

What changed from the original plan during implementation:
- DR-07 logged: 0.9.0 → 0.8.3 patch decision, because the surface turned
  out purely additive (no Decision-shape changes, new subpath export).
- `regional-only` outage mode accepted at construction but currently
  collapses to `fail-closed` (full implementation deferred to multi-process
  regional escrow follow-up).

---

### 3.0 ORIGINAL PLAN (retained for audit / history)

> **Target release: 0.8.3** (originally planned as 0.9.0; downgraded to a patch ship per DR-07 — surface is purely additive). Estimated effort: 3–4 weeks of focused work.

### 3.1 The problem

`twoTier(leased)` assumes a single L2 store. Real deployments span regions:
US-East ↔ EU-West cross-region latency is ~80–150 ms, far too high to round-trip
per request. Operators today either (a) **shard** the budget per region —
losing pooling and over-throttling under skew — or (b) **let each region run
its own counter** and accept unbounded multi-region Δ. **No published or
deployed limiter has a tight, fleet-size-independent overshoot bound across
regions.** This is the open gap the GALE archival paper aims at.

### 3.2 Architecture choice (decision lock)

Four options were considered:

| Option | Δ bound | U cost | Coordination cost | Verdict |
|---|---|---|---|---|
| A. Sharded (each region gets `L/K`) | 0 | high under skew | none | Rejected — loses pooling, no research delta |
| B. Primary-replica (one region authoritative) | 0 | low | high cross-region per check | Rejected — global SPOF, defeats federation |
| C. Active-active CRDT (gossip + merge) | bounded by staleness | low | gossip-tick | Rejected for MVP — needs CRDT proofs; staleness-Δ tradeoff is its own research |
| **D. Federated escrow (each region holds a sub-budget; reconciles at the window boundary)** | `Δ = L` (window-coupled) or `L + K·(B−1)` (carryover) | low | once-per-window | **Selected** — direct extension of GALE window-coupling to a coordinate quorum; the trilemma transfers |

**Why D is optimal.** The math just lifts: each *region* plays the role of a
*leasing node* in the existing GALE windowCoupled model, and the global L2
plays the role of the *shared store*. The published TLA⁺ proof
(`spec/GaleWindowCoupledLeasing.tla`) re-checks unchanged with one re-labeling
(`Node → Region`, `LocalBudget → RegionalEscrow`). The bound is the same:
`Δ = 0` when uncommitted regional escrow expires at the window boundary, with
exactly **one coordination event per region per window**.

**The recursive twoTier insight.** A `FederatedStore` is *literally* an L1 +
L2 + global-L3 stack: per-region L1 (memory), per-region L2 (regional Redis),
global L3 (the federation coordinator). This is just twoTier with two layers
of leasing. We get the existing proofs for free.

### 3.3 The global coordinator — interface, not commitment

The global coordinator (the "L3") is *abstracted* behind a small interface,
not committed to one backend. The default ships with Redis; users can plug
Postgres or etcd or a Raft service.

```ts
interface GlobalCoordinator {
  // Lease `tokens` for one window from the global budget. Returns the granted
  // amount (may be less under contention). The grant expires at `expiresAt`
  // — that's the window-coupling commitment.
  lease(key: string, tokens: number, expiresAt: number): Promise<number>;
  // Reconcile leftover credits back to the global budget at window rollover.
  // Idempotent on `windowStart` (so retries on partition are safe).
  reconcile(key: string, leftover: number, windowStart: number): Promise<void>;
}
```

MVP ships `RedisCoordinator` (single global Redis). Documented SPOF.
`PostgresCoordinator` and the Raft-via-etcd option are follow-ups.

### 3.4 Failure semantics

- **Region partitioned from the global coordinator.** Fail-closed inside the
  region (existing twoTier behavior). The region's last-leased sub-budget
  serves locally; once exhausted, denies. **No silent over-admission.**
- **Coordinator crash, recovery before next window.** Reconciliation is
  idempotent on `windowStart`, so retries converge.
- **Coordinator unavailable across a window boundary.** Worst case: a region
  carries forward uncommitted escrow ⇒ Δ ≤ `K·(B−1)` (the *non*-windowed
  bound). Documented; this is the "windowCoupled requires the coordinator to
  be reachable at boundary" caveat.

### 3.5 Subtasks (bisectable commits)

| Task | Commit shape | Pass-`check` gate |
|---|---|---|
| **TK-901** `docs(research): federation design doc + TLA⁺ extension` | Adds `research/bigger-bets/federation/DESIGN.md`, `spec/GaleFederatedLeasing.tla`, TLC-checked counts | TLA⁺ runs offline; check unchanged |
| **TK-902** `feat(federation): GlobalCoordinator interface + FederatedStore skeleton` | New `src/federation/{coordinator,store}.ts`; no behavior yet — interfaces + types + thrown `NotImplementedError` | tsc clean; no new tests yet |
| **TK-903** `feat(federation): static-partition implementation + dual-path tests` | Each region gets `L/K`; trivial correctness; serves as MVP baseline; full conformance + property test | Tests pass; new tests for skew degradation visible |
| **TK-904** `feat(federation): window-coupled federated leasing` | The actual GALE-lifted implementation; one Lua per region's lease; expiry at window boundary | Conformance + property tests; new `test/gale/federated/leasing.test.ts` mirrors `test/twotier/window-coupled.test.ts` |
| **TK-905** `test(federation): TLA⁺ BFS twin in test/gale/federated/` | The self-validating BFS twin (the GALE pattern) | New tests pass |
| **TK-906** `feat(federation): RedisCoordinator default implementation` | Global Redis-backed coordinator with PEXPIRE-anchored leases | Tests against `tk-redis-test:6380` |
| **TK-907** `feat(federation): cross-region failure modes (partition, coordinator-crash)` | Documented fail-closed behavior + tests | Tests force partitions, assert no Δ leak |
| **TK-908** `test(federation): property-based dual-path with simulated cross-region latency` | fast-check timelines with injected latency between regional store + coordinator | Tests pass at 50 runs × 6 strategies |
| **TK-909** `chore(eval): fly.io / GCP eval scaffolding (Docker compose + replay harness)` | `research/bigger-bets/federation/eval/{docker-compose.yml, replay.ts}` | Local docker compose smoke test; cloud eval is separate |
| **TK-910** `docs(eval): run real-cluster eval; commit measured numbers under research/` | Runs the eval on 3 regions; commits the JSON + writeup | Eval data committed; markdown writeup |
| **TK-911** `docs: update FAILURE-MODES.md + new wiki Federation page + example` | Docs sweep | Wiki commits accumulate locally |
| **TK-912** `chore(release): prepare 0.8.3` | Version bump, CHANGELOG, README/SCOREBOARD touch-ups | Full release prep |

### 3.6 Definition of done (the 0.8.3 release gate)

- `federate({ regions, coordinator, ... })` ships in `src/federation`; public
  exports added to `src/index.ts`
- TLA⁺ `GaleFederatedLeasing.tla` checked at small-state counts; BFS twin
  green in CI
- Dual-path conformance: JS ≡ Lua across all 6 strategies, in 3+ region
  setup, ≥ 50 fast-check timelines per strategy
- Real-cluster eval committed under `research/bigger-bets/federation/eval/`
  with raw data + writeup; Δ = 0 across 3 regions confirmed
- `docs/FAILURE-MODES.md` updated with federation rows
- Wiki: new `Federation` page; `Distributed-and-Provable` updated; `Home`
  bullet updated
- Example: `examples/federation.ts` showing a 3-region setup against
  Docker-composed Redis
- CHANGELOG `[0.8.3]` entry; release authorized + published

### 3.7 What I'm explicitly not doing in 0.8.3

- **CRDT-style gossip coordinator** — option (C) above. Worth the follow-up
  but the staleness-Δ math is its own research.
- **PostgresCoordinator** — straightforward to add but not on the critical
  path; left as a 0.9.x follow-up.
- **Federated weighted-fair leasing** — orthogonal to federation per se;
  combines #77 + (already-shipped WFE).
- **Coordinator failover (Raft / Sentinel HA)** — operators can layer Redis
  Sentinel under `RedisCoordinator` themselves.

---

## 4  Bet #79 — Unified admission decision

> **Target release: 0.9.0.** Estimated effort: 4–6 weeks of focused work.

### 4.1 The problem

A real API request must clear *three* orthogonal admissions:
- **rate** — `req / period`
- **concurrency** — `parallel in-flight`
- **cost** — `tokens (or weight) / budget`

Today these are independent primitives composed by middleware stacking —
three round trips, three Decisions, no shared reasoning. **No single
decision answers "what would happen if I admitted this request right now?"**

This matters most for **LLM gateways**: a chat completion has a rate cost
(req/min against the provider quota), a concurrency cost (one inference
seat held for ~30 s), AND a token cost (TPM against the provider's token
quota). The three are *correlated* — long completions hold the seat AND
burn more tokens — but the checks are independent today. Admit decisions
that clear all three marginal limits may collectively violate the joint
envelope, and the operator has no observable lever for "the joint policy."

### 4.2 What already exists (post-0.8.3 inventory)

- **`adaptiveConcurrency()` is shipped** (`src/concurrency/adaptive.ts`).
  Two algorithms: `gradient2` (default — Netflix concurrency-limits-style
  RTT-gradient inference) and `aimd` (additive-increase /
  multiplicative-decrease). Returns a `ConcurrencyGuard` with
  `acquire() → Lease` semantics; the `Lease` has `ok: boolean` and
  `release({ dropped? })`. Both algorithms have unit + property coverage and
  documented math (`docs/DESIGN-NOTES.md` § adaptive concurrency).
- **`rateLimit()` is shipped** — returns a `Limiter` with
  `.check() → Decision`.
- **Token budget (TALE L1)** is shipped via `tokenBucket()` with the
  cost-axis hookup; the windowed cost path (`distributed-budget.test.ts`)
  is already proven to be GALE-equivalent.

What's MISSING for unified admission (the actual work of 0.9.0):
1. A *composition* primitive that fuses the three into one decision.
2. A `combineDecisions(a, b): Decision` pure-function algebra.
3. A `Lease ↔ Decision` shim (the two primitives have different lifecycle
   shapes — Lease is acquire-release; Decision is point-in-time).
4. A Redis-Lua-fused atomic check (one EVALSHA for rate + cost;
   concurrency stays in-process because Lease has temporal state).
5. An answer to the open theory question: does joint admission strictly
   beat marginal-AND admission, and under what correlation regimes?

### 4.3 The architecture (two layers)

#### Layer A — Decision algebra (pure functions)

A canonical `combineDecisions(a: Decision, b: Decision): Decision`:

| Field | Aggregation rule | Axiom |
|---|---|---|
| `allowed` | `a.allowed && b.allowed` | AND (both must allow) |
| `limit` | `min(a.limit, b.limit)` | binding budget |
| `remaining` | `min(a.remaining, b.remaining)` | binding remainder |
| `resetAt` | `max(a.resetAt, b.resetAt)` | latest-resolution wait |
| `retryAfterMs` | `max(a.retryAfterMs, b.retryAfterMs)` | dominant wait |

**Algebraic laws to prove** (fast-check property tests at numRuns ≥ 500):
- **Identity** — `combine(d, ALLOW_FULL) = d` for the neutral element
  `ALLOW_FULL = { allowed: true, limit: ∞, remaining: ∞, resetAt: 0,
  retryAfterMs: 0 }`.
- **Associativity** — `combine(combine(a,b),c) = combine(a,combine(b,c))`.
- **Idempotency** — `combine(d, d) = d`.
- **Commutativity** — `combine(a,b) = combine(b,a)`.

These four laws together mean: `combineDecisions` extends to N inputs via
reduce, and a Lua-fusion implementation can re-order its checks freely
without changing the result. (Associativity + commutativity ⇒ order
independence; idempotency ⇒ duplicate-check safety; identity ⇒ optional
axes are free to add.)

#### Layer B — `unifiedAdmission(...)` primitive

```ts
import { unifiedAdmission } from "throttlekit/admission";

const admit = unifiedAdmission({
  rate:        rateLimit({ ... }),         // Limiter
  concurrency: adaptiveConcurrency({...}), // ConcurrencyGuard (already shipped)
  cost:        rateLimit({ cost: true, ... }), // cost-axis Limiter
  // future axes plug in here
});

const { decision, release } = admit.admit({ cost: 1500 /* tokens */ });
if (decision.allowed) {
  try { /* work */ } finally { release({ dropped: false }); }
}

interface UnifiedAdmitter {
  admit(opts?: { cost?: number }): {
    decision: Decision;          // the combined Decision (combineDecisions of all axes)
    release: (opts?: { dropped?: boolean }) => void;
                                 // releases the concurrency lease + commits cost
  };
}
```

**Why NOT return `Limiter` directly** (DR-08): the concurrency axis has
*lease semantics* (acquire-release) that don't fit Limiter's stateless
`.check() → Decision` shape. Wrapping it as a Limiter would either (a)
force the concurrency slot to be released at decision time (defeating the
purpose — the whole point is to hold the slot during work), or (b) hide a
global lease registry behind the scenes (action-at-a-distance; impossible
to clean up on exception paths). The cleanest API returns
`{ decision, release }` and the caller wires `release()` to its request
lifecycle hook (e.g. `res.on("finish", release)` in express adapter,
deferred via Go-style `defer` in custom code).

**Two backend modes:**
- **Sequential (default).** Each axis runs in turn; first deny
  short-circuits. Works with ANY store mix (in-process concurrency + Redis
  rate + Postgres cost). The default — universal compatibility.
- **Lua-fused (Redis-only, opt-in).** One Lua script (`tk:v1:fused-rc:check`)
  atomically evaluates rate + cost in a single EVALSHA; concurrency stays
  in-process (its state is local). Same result as sequential (proven via
  the algebra in §4.3); ~1 RTT vs ~2 RTTs under contention.

### 4.4 The research question (TK-1007)

**Is the joint admission optimum strictly better than the AND of marginal
optima?**

When the three axes are correlated — cost correlates with
concurrency-time-product (long calls eat more tokens); rate correlates
with concurrency (most callers, most of the time) — a *joint* policy that
solves a small LP at admission time can admit requests that an
AND-of-marginals policy would deny, without violating any individual axis
bound.

**Toy model + simulation** in `research/bigger-bets/unified/`:
- 2-axis baseline (rate + cost). Poisson arrivals; request-weights drawn
  from a bivariate distribution with controllable correlation ρ ∈ [-1, 1].
- Three policies under comparison:
  - **Marginal-AND** — separate budgets, admit iff BOTH have capacity.
    The baseline (today's stacked-middleware behavior).
  - **Joint-LP** — solve a small linear program at each admission step;
    admit iff feasible. The candidate optimum.
  - **Clairvoyant oracle** — knows future arrivals; admits optimally.
    The upper bound.
- Figure of merit: regret of marginal-AND against the joint optimum,
  averaged over a workload sweep across ρ ∈ [-1, 1].

**Possible outcomes:**
- ε > 0 gap for ρ ≠ 0 ⇒ joint is the right policy for correlated workloads.
  0.9.x adds `unifiedAdmission({ ..., policy: "joint" })` as opt-in.
- ε ≈ 0 universally ⇒ marginal-AND is tight; the algebra is sufficient.
  The negative result is itself a contribution.

Either outcome ships. Negative results inform the user (don't bother with
joint; the algebra is sufficient) — and are publishable.

### 4.5 Subtasks (bisectable commits)

| Task | Commit shape | Pass-`check` gate |
|---|---|---|
| **TK-1001** `docs(research): unified admission design doc + algebra spec` | Adds `research/bigger-bets/unified/DESIGN.md` (lit synthesis: Netflix concurrency-limits, Envoy adaptive concurrency, Google SRE ch.21, Little's Law; the architecture; the algebra; the research question); no code | `check` unchanged |
| **TK-1002** `feat(core): combineDecisions + algebraic-laws property test` | New `src/core/combine.ts` exporting `combineDecisions` + `ALLOW_FULL`; `test/core/combine.test.ts` proves the 4 laws via fast-check (numRuns ≥ 500) | Property tests pass |
| **TK-1003** `feat(admission): Lease↔Decision shim` | New `src/admission/lease-shim.ts` bridging `ConcurrencyGuard.acquire() → Lease` to a Decision-shaped check with the release returned separately; tests cover acquire-release round trips + dropped-request paths | Tests pass |
| **TK-1004** `feat(admission): unifiedAdmission sequential composition` | New `src/admission/unified.ts`; root + `throttlekit/admission` subpath export; works for ANY combination of {rate, concurrency, cost}; tests cover each pair + the triple | New `test/admission/unified.test.ts` |
| **TK-1005** `feat(admission): Lua-fused admission (Redis-only opt-in)` | New `tk:v1:fused-rc:check` Lua script in the embedded-string form (the same form #78 will later extract); tests against `tk-redis-test:6380` | Redis-gated tests pass |
| **TK-1006** `test(admission): dual-path conformance fused ≡ sequential` | Property test: same fast-check timeline → byte-identical Decision streams across sequential and fused backends, for 100 timelines × {rate-only, cost-only, rate+cost} | Tests pass at 100 timelines |
| **TK-1007** `research(unified): joint vs marginal — toy model + analysis` | `research/bigger-bets/unified/THEORY.md` + `research/bigger-bets/unified/sim.ts`; runs the toy model; commits regret curves under ρ ∈ [-1, 1]; documents positive / negative outcome | Sim runs; result documented |
| **TK-1008** `feat(observability): unified-decision OTel attribute + docs sweep` | Adds `tk.binding_axis ∈ {"rate","concurrency","cost"}` OTel attribute; new wiki `Unified-Admission` page; `examples/unified.ts` LLM-gateway scenario; FAILURE-MODES update | Tests cover the attribute |
| **TK-1009** `chore(release): prepare 0.9.0` | Version bump, CHANGELOG `[0.9.0]`, README, SCOREBOARD touch-ups; runs the standard release-prep cadence | Full release prep |

### 4.6 Definition of done (the 0.9.0 release gate)

- `unifiedAdmission(...)` shipped in `src/admission/`; root export AND
  `throttlekit/admission` subpath
- `combineDecisions` proven against the 4 algebraic laws (numRuns ≥ 500)
- Sequential ≡ fused dual-path: bit-identical Decision streams across
  ≥ 100 generated timelines per axis-combination
- `research/bigger-bets/unified/THEORY.md` with the joint-vs-marginal
  finding (positive or negative); raw sim numbers committed
- OTel `tk.binding_axis` attribute documented + tested
- Wiki: new `Unified-Admission` page; `Home` bullet + sidebar updated
- Example: `examples/unified.ts` showing LLM-gateway-style rate +
  concurrency + cost admission with `release()` on `res.finish`
- CHANGELOG `[0.9.0]` entry; release authorized + published

### 4.7 What I'm explicitly not doing in 0.9.0

- **Distributed adaptive concurrency** (DR-10). In-process only at 0.9.0.
  The recursive-twoTier insight — each region's concurrency state is a
  leased counter against a global limit, i.e. specialized federation — is
  a 0.10.x follow-up. Documented as a known gap.
- **Joint-LP policy as a runtime option** (DR-11). The research result
  (TK-1007) ships; the *implementation* of the joint-LP policy waits for
  0.10.x conditional on a sufficiently-positive empirical result.
- **Federated unified admission**. Composes naturally (#77 + #79 are
  orthogonal); eval comes in a 0.10.x point release if there's demand.
- **Dynamic axis discovery**. `unifiedAdmission` takes a fixed shape; users
  who want to add new axes (e.g. memory budget) write a small adapter that
  exposes a `Limiter`-shaped check.
- **Tighten `Decision` shape with `bindingAxis`**. Stays optional via the
  OTel attribute; adding it to Decision proper would be a breaking change.
  Revisit at 1.0.

---

## 5  Bet #78 — Versioned Lua wire protocol + Go / Rust ports

> **Target release: 1.0.0.** Estimated effort: 5–7 weeks (two new SDKs, two
> new release flows, cross-language CI). Unblocks polyglot fleets.

### 5.1 The problem

The atomic Lua decisions exist only as JS-embedded strings (today; verified
post-0.8.3: no `src/lua/` directory; each strategy's Lua is inlined in its
TS file). A Go or Rust service in the same fleet cannot share the budget
without round-tripping through a JS sidecar. Polyglot adoption is blocked.
The 0.8.x line earned us strong correctness guarantees (Δ = 0,
K-independent); the 1.0 line should make those guarantees available to
non-Node consumers.

### 5.2 What ships

1. **`docs/WIRE-PROTOCOL.md`** — the frozen v1 spec: script naming
   (`tk:v1:<strategy>:<op>`), KEYS layout per strategy, ARGV layout per
   strategy, Decision tuple encoding `[allowed, limit, remaining, resetAt,
   retryAfterMs]`, state encoding (HASH / STRING / ZSET conventions),
   key-prefix rules.
2. **Lua extraction to source files.** Move embedded JS strings to
   `src/lua/v1/*.lua` source files; tsup includes them in `dist/lua/v1/`;
   commit `dist/lua/v1/manifest.json` with sha256-per-script. The inline
   strings in TS modules become `readFileSync`-loaded constants at module
   init (no fs-at-runtime — bundled into dist via tsup).
3. **Version negotiation in the JS client.** Each strategy declares
   `wireVersion: 1`; the store records it on first EVALSHA; a mismatch
   throws `ThrottleKitError` with a clear migration message. The path to
   v2 is "introduce `tk:v2:<strategy>` alongside, keep v1 working until
   clients migrate."
4. **`throttlekit-go`** in a separate repo
   (`github.com/AmeyaBorkar/throttlekit-go`) — vendored Lua + sha256
   verify in CI.
5. **`throttlekit-rs`** in a separate repo
   (`github.com/AmeyaBorkar/throttlekit-rs`) — same.
6. **Cross-language conformance CI** — docker-compose; one Redis; the
   three clients hammer the same key against a seeded timeline; assert
   bit-identical Decisions across all 6 strategies.

### 5.3 The Lua-script distribution decision (DR-12)

Three options for how the Go/Rust ports get their Lua:

| Option | Mechanics | Verdict |
|---|---|---|
| **Vendor (copy + sha256 verify)** | Each port repo embeds its own copy of `src/lua/v1/*.lua`; CI verifies sha256 against the canonical manifest in the JS repo | **Selected for MVP (DR-12)** — simplest; CI catches drift; no runtime dependency on the JS repo |
| Separate `@throttlekit/lua` npm/Go/Rust package | Single source; all ports depend on it as a versioned package | Future — needs versioning policy + 3-language packaging story (scoped npm, Go module, Rust crate, separate semver) |
| Network-fetch from CDN | Ports download Lua on init | Rejected — runtime dependency, opaque failures, security blind spot, breaks offline |

### 5.4 Repo structure decision (DR-13)

Separate repos (`throttlekit-go`, `throttlekit-rs`) NOT subdirs of this
monorepo. Reasoning:
- **Prior art**: gRPC, protobuf, Stripe, Sentry all use this pattern for
  polyglot SDKs. The exceptions (Sentry's per-language monorepos) still
  separate the *language* boundary at the repo level.
- **CI cleanliness**: each language has its own matrix, toolchain, and
  release cadence; sharing in a monorepo forces a single CI pipeline to
  swap between toolchains per job.
- **Idiom expectations**: Go's `go.mod` at root, Rust's Cargo workspace
  layout, and JS's tsup + npm-pack each expect a clean repo root. Forcing
  them into subdirs adds gymnastic config.
- **Cross-repo drift** is mitigated by the sha256 vendoring rule (DR-12)
  and the cross-language conformance CI (TK-1108).

### 5.5 Subtasks (bisectable commits)

| Task | Commit shape | Repo |
|---|---|---|
| **TK-1101** `docs(wire): WIRE-PROTOCOL.md v1 spec` (KEYS, ARGV, return shapes, key-prefix rules per strategy) | throttlekit |
| **TK-1102** `refactor(lua): extract embedded scripts to src/lua/v1/*.lua + dist/lua/v1/manifest.json sha256 manifest` | throttlekit |
| **TK-1103** `feat(redis): wireVersion negotiation + clear-error on mismatch` | throttlekit |
| **TK-1104** `chore: throttlekit-go repo init + module skeleton + Limiter/Decision/Store types + Lua loader (vendored + sha256 verify)` | throttlekit-go |
| **TK-1105** `feat(go): all 6 strategies + Redis store + dual-path conformance against JS reference` | throttlekit-go |
| **TK-1106** `chore: throttlekit-rs crate init + types + Lua loader (vendored + sha256 verify)` | throttlekit-rs |
| **TK-1107** `feat(rs): all 6 strategies + Redis store + dual-path conformance against JS reference` | throttlekit-rs |
| **TK-1108** `ci: cross-language conformance harness (docker-compose; JS / Go / Rust all hammer one Redis with seeded timelines; assert bit-identical Decisions)` | throttlekit + go + rs |
| **TK-1109** `release: throttlekit-go v0.1.0 + throttlekit-rs v0.1.0` | throttlekit-go, throttlekit-rs |
| **TK-1110** `docs: wiki Polyglot page + README polyglot sections (all 3 repos) + WIRE-PROTOCOL link from each` | all 3 |
| **TK-1111** `chore(release): prepare 1.0.0 (wire-protocol freeze; major-version commitment)` | throttlekit |

### 5.6 Definition of done (the 1.0.0 release gate)

- `docs/WIRE-PROTOCOL.md` v1 frozen (KEYS, ARGV, return shapes, key-prefix
  conventions; all 6 strategies + federation lease/reconcile + the
  TK-1005 fused-rc script)
- `src/lua/v1/*.lua` source files + `dist/lua/v1/manifest.json` with
  sha256 per script
- `throttlekit-go v0.1.0` published; `go get github.com/AmeyaBorkar/throttlekit-go`
- `throttlekit-rs v0.1.0` on crates.io
- Cross-language conformance CI green: JS / Go / Rust agree on Decision
  streams across all 6 strategies × 100 generated timelines × 3 K values
- README + wiki polyglot pages live; CHANGELOG `[1.0.0]` entry;
  user-authorized 1.0.0 release

### 5.7 What I'm explicitly not doing in 1.0.0

- **Python / Java / Ruby ports.** Three is the right number; expand later
  based on demand. Each adds a CI matrix.
- **A separate `@throttlekit/lua` package.** Vendoring + sha256 is enough
  for v1; the package abstraction adds versioning complexity that doesn't
  pay back yet.
- **Removing the JS-embedded Lua strings.** They stay (until 2.0 if ever)
  for backward compat. TK-1102 ADDS the source files + manifest; doesn't
  remove the inlined strings.
- **Wire v2.** Stays implicit-v1 until a real breaking change demands
  v2; the dual-version negotiation mechanism is in place but not exercised
  at 1.0.0.

---

## 6  Interstitial small polish (between major releases)

Between bigger-bet releases there are smaller items worth shipping as
0.8.x / 0.9.x / 0.10.x point releases. None block a bigger bet but each is
worth doing:

| Item | Where | When |
|---|---|---|
| Bench-gate `continue-on-error: true` → `false` once <10% noise confirmed | `.github/workflows/ci.yml` | 0.8.4 (post enough green CI runs) |
| Live-wire `leaseSizer` / `predictiveLeaseSizer` into `twoTier` | `src/twotier/index.ts` | 0.8.4 or 0.9.x |
| Re-measure coverage (the 95.2% figure in SCOREBOARD is from 0.8.0) | `npm run test:cov` + SCOREBOARD | 0.8.4 |
| `PostgresCoordinator` for federation (alternative to RedisCoordinator) | `src/federation/postgres-coordinator.ts` | 0.9.x follow-up |
| Distributed adaptive concurrency (federation-backed; DR-10 follow-up) | `src/admission/` | 0.10.x follow-up |
| Federated WFE (weighted fair escrow across regions) | `src/federation/wfe.ts` | 0.10.x |
| Joint-LP policy in `unifiedAdmission` (DR-11 follow-up, if TK-1007 yields positive) | `src/admission/joint-lp.ts` | 0.10.x conditional |
| Multi-process regional escrow (federation deepening) | `src/federation/regional-escrow.ts` | 0.9.x |

These are tracked as single "polish" tasks each (TK-13xx-series), spawned
when their parent release lands and demand is confirmed.

---

## 7  Tasks

The full task list lives in the task system (see `TaskList`). Status as of
0.8.3 ship:

| ID | Label | Maps to | State |
|---|---|---|---|
| meta | **TK-823** Federation — shipped 0.8.3 | bet #77 | ✅ completed |
| meta | **TK-825** Unified admission — ship 0.9.0 | bet #79 | pending → in_progress on TK-1001 start |
| meta | **TK-824** Polyglot — ship 1.0.0 | bet #78 | pending; soft-ordered after TK-825 |
| meta | **TK-1200** HotNets paper — submit by Jul 16 | parallel | pending; runs in parallel with TK-1xxx work |
| sub | **TK-901**..**TK-912** | federation sub-tasks | ✅ all completed |
| sub | **TK-1001**..**TK-1009** | unified admission sub-tasks | pending; linear `blockedBy` chain |
| sub | **TK-1101**..**TK-1111** | polyglot sub-tasks | pending; TK-1101 blocked by TK-1009 (0.9.0 release); rest linear |

**Sub-task chains (each implies the prior is complete):**

Unified admission (#79):
```
TK-1001 → TK-1002 → TK-1003 → TK-1004 → TK-1005 → TK-1006 → TK-1007 → TK-1008 → TK-1009 (release 0.9.0)
```

Polyglot (#78):
```
TK-1009 → TK-1101 → TK-1102 → TK-1103 → TK-1104 → TK-1105 → TK-1106 → TK-1107 → TK-1108 → TK-1109 → TK-1110 → TK-1111 (release 1.0.0)
```

The chains are linear because each step assumes the prior step's
interfaces / proofs / stores exist; trying to parallelize would produce
merge churn on the same interface files. The single cross-bet dependency
(TK-1101 blocked by TK-1009) enforces "freeze the wire protocol only after
the unified-admission fused script has settled."

---

## 8  Decision records (revisitable)

| ID | Decision | Date | Status |
|---|---|---|---|
| DR-01 | Federation architecture = option D (federated escrow with window-coupling at the regional boundary). | 2026-05-28 | Locked unless a CRDT proof emerges that strictly dominates |
| DR-02 | Global coordinator = `GlobalCoordinator` interface; MVP impl = single global Redis (SPOF documented). Postgres / Raft are future impls. | 2026-05-28 | Locked for 0.8.3 |
| DR-03 | Wire protocol stays implicit at v1 through 0.8.3 / 0.9.0 / 0.10.0; #78 freezes v1 explicitly at 1.0.0. | 2026-05-28 | Locked |
| DR-04 | Unified-admission backend = sequential (default) + Redis-Lua fused (opt-in). | 2026-05-28 | Locked unless a benchmark shows fused is universally cheaper |
| DR-05 | Polyglot ports = separate repos, vendored Lua + sha256 checksum verify in CI. | 2026-05-28 | Locked for 1.0.0 |
| DR-06 | HotNets paper runs as a parallel single-developer track, not a serial dependency on the bets. | 2026-05-28 | Locked unless the paper hits a research-blocker that the bets can resolve |
| DR-07 | Federation (#77) ships as **0.8.3 patch** not 0.9.0 minor. Rationale: the surface is purely additive (new `throttlekit/federation` subpath; no change to existing 0.8.x API). A patch is the most accurate semver signal — consumers can upgrade without migration. 0.9.0 is freed for the next user-facing breaking change. *Why changed: weighed at release-prep time; the additive nature didn't warrant a minor bump.* | 2026-05-28 | Locked (shipped) |
| DR-08 | `unifiedAdmission(...)` returns `UnifiedAdmitter` (with `.admit() → { decision, release }`), NOT `Limiter`. Rationale: concurrency has lease semantics (acquire-release) that don't fit Limiter's stateless `.check() → Decision` shape. Wrapping it would either force premature lease release or hide a global lease registry (action-at-a-distance). Caller wires `release()` to its request lifecycle hook (e.g. `res.on("finish", release)`). | 2026-05-28 | Locked unless an alternative API emerges that preserves Limiter-compat without hiding state |
| DR-09 | The existing `adaptiveConcurrency()` primitive (gradient2 default + AIMD opt-in, `src/concurrency/adaptive.ts`) is the substrate for the concurrency axis of unified admission. NO new concurrency primitive is added in 0.9.0; the work is *fusion*, not invention. | 2026-05-28 | Locked — both algorithms are shipped + tested as of 0.8.x |
| DR-10 | Distributed adaptive concurrency = NOT in 0.9.0. The recursive-twoTier insight (each region's concurrency state = leased counter against global) is a 0.10.x follow-up. 0.9.0 ships in-process concurrency only; documented as a known gap. | 2026-05-28 | Locked unless an LLM-gateway customer asks for distributed-concurrency-now |
| DR-11 | Joint-LP policy = research-only in 0.9.0 (TK-1007 produces `THEORY.md` + regret curves). Runtime implementation waits for 0.10.x conditional on a positive empirical result. Marginal-AND (the algebra-based default) is the 0.9.0 deliverable regardless. | 2026-05-28 | Locked — empirical result drives the next step |
| DR-12 | Polyglot Lua distribution = vendor + sha256 verify (NOT a separate `@throttlekit/lua` package, NOT runtime CDN fetch). Each language repo embeds the Lua scripts; CI cross-verifies the manifest. | 2026-05-28 | Locked for 1.0.0 |
| DR-13 | Polyglot ports = separate repos (`throttlekit-go`, `throttlekit-rs`), NOT subdirs of this monorepo. Matches gRPC / protobuf / Stripe pattern; per-language CI matrices stay clean; cross-repo drift mitigated by DR-12 + cross-language conformance CI (TK-1108). | 2026-05-28 | Locked for 1.0.0 |

When implementation reveals a decision needs to change, edit the row in place
and add a one-line "Why changed" under it — do not silently rewrite.

---

## 9  How to start (the next session)

Federation (#77) is shipped. The next bet is **#79 unified admission**.

1. Read this file first.
2. `TaskList` → claim **TK-1001** (unified admission design doc + algebra
   spec).
3. Write `research/bigger-bets/unified/DESIGN.md` — full design, expands §4
   here with:
   - Lit synthesis: Netflix concurrency-limits (gradient2 / AIMD); Envoy
     adaptive concurrency filter; Google SRE chapter 21 (adaptive
     throttling); Little's Law as the queuing-theory grounding; recent
     academic work on joint admission control (search HotCloud / HotNets /
     NSDI 2022–2026 for "joint admission" / "multi-resource rate
     limiting").
   - The algebra spec for `combineDecisions` (the 4 laws + their
     property-test plan).
   - The architecture (sequential + Lua-fused; `UnifiedAdmitter` interface;
     `Lease ↔ Decision` shim).
   - The research question setup (toy-model bivariate workload, three
     policies, regret curves).
4. No code yet for TK-1001 — design doc only. The commit is `docs(research):
   unified admission design doc + algebra spec`. Pass-`check`: nothing
   breaks because no code changes.
5. Mark TK-1001 complete; pick TK-1002 (`combineDecisions` + algebraic-laws
   property test).
6. Iterate down the unified chain: TK-1002 → TK-1003 → ... → TK-1009
   (release 0.9.0).
7. After TK-1009 lands, switch to **TK-1101** (wire-protocol freeze, the
   first polyglot step) — the polyglot chain unblocks naturally because
   TK-1101 is `blockedBy: TK-1009`.

**Standing rules (re-stated for the implementer):**
- Every commit passes `npm run check`.
- No `Co-Authored-By` trailers.
- Wiki commits accumulate locally on `tk-wiki master`; pushed only at
  release tag time.
- npm publish requires explicit user authorization (push of `vX.Y.Z` tag
  triggers OIDC publish — irreversible).
- When something doesn't go as planned, *say so* — update §8 decision
  records rather than diverging silently.
- When a sub-task spawns a new follow-up (e.g. TK-1007 yields a positive
  joint-LP result and TK-13xx polish needs creating), add the task and
  link it from §6.

**Parallel-track reminder:** TK-1200 (HotNets paper) runs in parallel
with TK-100x. Don't let the bets crowd out the paper assembly — the
2026-07-16 deadline is hard.
