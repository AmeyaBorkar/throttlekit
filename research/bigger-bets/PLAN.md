# Bigger bets — roadmap & ROI plan

> Status: planned 2026-05-28; implementation begins next session.
> Maintainer of this doc: whoever picks up the next task in [Tasks](#tasks).
> Edit guideline: this is a *living* roadmap — when a design decision is
> revisited (e.g. an experiment invalidates an assumption), update the
> "Decision records" section in place rather than dropping a new doc.

This file is the single source of truth for ordering, cross-cutting decisions,
and per-bet design notes for the three deferred research/production "bigger
bets" tracked in `MEMORY.md` and the task system. It survives session compaction
and is the doc the implementer reads first.

---

## 0  Why this doc exists

The 0.8.x line is feature-complete relative to `THROTTLEKIT.md` and the GALE /
TALE shipping map (`memory/throttlekit-research-direction.md`). The three
remaining bets are large enough that each warrants its own minor release; the
order in which they ship matters because (a) one of them is the systems gating
item for the archival GALE / TALE papers, and (b) the third effectively
*freezes* a wire protocol that the first two evolve, so it should land last.

This doc fixes ordering, locks the architecturally load-bearing decisions, and
enumerates the bisectable commits each release decomposes into.

---

## 1  ROI ordering & rationale

| Order | Bet | Target release | Why this position |
|---|---|---|---|
| 1 | **#77 Cross-cluster federation** (L2-replica reconciliation) | **0.9.0** | Unblocks the archival GALE / TALE papers (the publishability memo flags the multi-region eval as "the only true systems blocker"); ships a real production feature in the same motion. Highest dual-payoff. |
| 2 | **#79 Unified admission** (rate-limit + adaptiveConcurrency + tokenBudget fusion) | **0.10.0** | Highest-leverage user-facing primitive for LLM gateways — they want one decision, not three. Carries a genuine open theory question (does the joint optimum beat the marginal product?); a positive answer is a follow-up paper. |
| 3 | **#78 Versioned Lua wire protocol + Go/Rust ports** | **1.0.0** | Pure adoption work; weakly coupled to the research story. Doing it last lets #77 and #79 evolve the wire protocol freely; locking it down then is the natural `1.0` moment. |

**Order rationale.** #77 is the only bet that pays both axes — the paper
*needs* this eval and operators *need* multi-region. #79 is the next-highest
because LLM-gateway operators ask for it loudly and it carries a research
follow-up. #78 is real value but it's adoption-only, and freezing a wire
protocol while #77/#79 may still add Lua scripts would be premature.

**What would invalidate the order:**
- If an LLM-vendor customer asks for Go/Rust *now*, #78 jumps to #1.
- If a HotNets reviewer requests a real cluster eval before notification, #77
  becomes time-critical against the paper deadline.
- If #79 turns out to have a clean *negative* result (joint = marginal), it
  loses its research payoff and demotes to a feature-only bet.

## 1a  Parallel track: the HotNets '26 paper

**Submission Jul 16, 2026 AoE — ~7 weeks from this plan.** Status:
prose-complete (`research/hotnets2026/DRAFT.md`, ~270 lines, §1–§8 + reproducible
Fig 2). What's left is *assembly*, not research:

1. LaTeX'ify the prose (the body is already double-blind-clean)
2. Set up the anonymized mirror (`anonymous.4open.science`)
3. Tighten to ≤6 pp 10 pt
4. Confirm the '26 format rules when the CFP posts

Effort: ~5 focused days. This **runs in parallel** with bet #1; the bets are
the deep work and the paper is the assembly. Do not let the bets crowd out the
paper — the deadline is hard.

A separate task (TK-1200) tracks the paper. Treat it as a parallel
single-developer track, not a serial dependency.

---

## 2  Cross-cutting decisions (apply to every bet)

These are the standing rules — they're not bet-specific.

| Decision | Choice | Why |
|---|---|---|
| **Commit granularity** | Every commit must pass `npm run check` (lint + tsc + vitest) | Bisectability — `git bisect` must give a useful answer |
| **Co-author trailers** | Never | Project rule (`memory/no-coauthor-commits.md`) |
| **Wiki coupling** | Wiki commits accumulate locally on `tk-wiki` master, **pushed only at release tag time** | Public docs must not lead npm; user has confirmed this rule twice now |
| **Release authorization** | Explicit user OK before `git push origin vX.Y.Z` | npm publish is irreversible |
| **Proof-first** | New formal-bounded primitives (federation, fused admission) ship with the TLA⁺ / BFS proof *before* the production code | GALE pillars were built this way; it caught the EOQ-cost-model bug |
| **Dual-path conformance** | Every Lua-backed primitive must have a JS↔Lua dual-path test (seeded grid *and* shrinkable property fuzz) | `test/conformance/{conformance,lua-property}.test.ts` are the templates |
| **Eval reproducibility** | Every measured number that lands in a paper / SCOREBOARD must be regeneratable by a script committed under `research/<bet>/` | Already established by `research/hotnets2026/fig2.ts` |
| **Wire-protocol versioning** | `tk:v1:*` is the current implicit version; #78 freezes it. Any wire change before #78 is a *minor* compatible add (new script name); breaking changes wait until v2 / a major release | Avoids a wire churn before the polyglot freeze |
| **Zero runtime deps** | Stays. New peers continue to be optional. | Project value |

---

## 3  Bet #77 — Cross-cluster federation

> **Target release: 0.9.0.** Estimated effort: 3–4 weeks of focused work.

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
| **TK-912** `chore(release): prepare 0.9.0` | Version bump, CHANGELOG, README/SCOREBOARD touch-ups | Full release prep |

### 3.6 Definition of done (the 0.9.0 release gate)

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
- CHANGELOG `[0.9.0]` entry; release authorized + published

### 3.7 What I'm explicitly not doing in 0.9.0

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

> **Target release: 0.10.0.** Estimated effort: 4–6 weeks.

### 4.1 The problem

A real API request must clear *three* orthogonal admissions: **rate** (req /
period), **concurrency** (parallel in-flight), and **cost** (tokens / budget).
Today these are independent primitives composed by middleware stacking — three
round trips, three Decisions, no shared reasoning. **No single decision
answers "what would happen if I admitted this request right now?"**

### 4.2 The architecture (two layers)

#### Layer A — Decision algebra (pure functions)

A canonical `combineDecisions(d1: Decision, d2: Decision): Decision` with
documented + property-tested semantics:

- `allowed = d1.allowed && d2.allowed` (the AND axiom)
- `limit = min(d1.limit, d2.limit)` (the binding-budget axiom)
- `remaining = min(d1.remaining, d2.remaining)` (similar)
- `resetAt = max(d1.resetAt, d2.resetAt)` (the latest-resolution axiom)
- `retryAfterMs = max(d1.retryAfterMs, d2.retryAfterMs)` (the dominant-wait axiom)

Algebraic laws to prove:
- **Identity**: `combine(d, ALLOW_FULL) = d` for an `ALLOW_FULL` neutral element
- **Associativity**: `combine(combine(a,b),c) = combine(a,combine(b,c))`
- **Idempotency**: `combine(d, d) = d`
- **Commutativity**: `combine(a,b) = combine(b,a)`

These let `combineDecisions` extend to N inputs via reduce and let a Lua
fusion implementation re-order its checks without changing the result.

#### Layer B — `unifiedAdmission(...)` primitive

```ts
unifiedAdmission({
  rate?:           Limiter,              // a rateLimit(...)
  concurrency?:    AdaptiveConcurrency,  // existing primitive
  tokenBudget?:    TokenBudget,          // existing TALE L1
  // ... future axes plug in here
}): Limiter;
```

Two backend modes:
- **Sequential (default).** Each axis runs in turn; first deny short-circuits.
  Works with any store mix.
- **Fused (Redis only).** One Lua script co-locates all three states; one
  EVALSHA per check. Same correctness as sequential (proven via the algebra),
  better latency.

### 4.3 The research question

**Is the joint admission optimum strictly better than the AND of marginal
optima?** When the three axes are correlated (cost correlates with
concurrency-time-product; rate correlates with concurrency), there's a
plausible *joint* policy that admits requests an AND-of-marginals policy
would deny — without violating any individual axis bound.

If yes, that's a follow-up paper. If no (the algebra is "tight"), it's still
a high-leverage feature with clean math; the negative result is itself
publishable as "you cannot do better than marginal."

Toy model + simulation in `research/bigger-bets/unified/`:
- 2-axis (rate + cost) first; if there's a gap, lift to 3-axis
- Compare: marginal-AND policy vs. joint-LP policy vs. clairvoyant oracle
- The figure of merit: regret of marginal-AND against the joint optimum

### 4.4 Subtasks

| Task | Commit shape |
|---|---|
| **TK-1001** `docs(research): unified admission design doc + algebra spec` |
| **TK-1002** `feat(core): combineDecisions + property-test the four algebraic laws` |
| **TK-1003** `feat(admission): unifiedAdmission sequential composition` |
| **TK-1004** `feat(admission): Lua fusion for the Redis path (single EVALSHA)` |
| **TK-1005** `test(admission): dual-path conformance for fused vs sequential` |
| **TK-1006** `feat(observability): unified-decision OTel attributes` |
| **TK-1007** `research(unified): joint vs marginal optimum — sim + analysis` |
| **TK-1008** `docs: wiki Unified-Admission page + example + FAILURE-MODES update` |
| **TK-1009** `chore(release): prepare 0.10.0` |

### 4.5 Definition of done (the 0.10.0 release gate)

- `unifiedAdmission(...)` shipped in `src/admission`; root export
- `combineDecisions` proven against the 4 algebraic laws (property tests at
  numRuns ≥ 200)
- Sequential ≡ fused dual-path: bit-identical Decision streams across
  generated timelines
- `research/bigger-bets/unified/THEORY.md` with the joint-vs-marginal
  finding (positive or negative)
- Wiki + example + CHANGELOG + authorized release

### 4.6 What I'm explicitly not doing in 0.10.0

- **Federated unified admission** — composes naturally (#77 + #79 are
  orthogonal), but eval comes in a 0.10.x point release if there's demand
- **Dynamic axis discovery** — `unifiedAdmission` takes a fixed shape; users
  who want to add new axes (e.g. memory budget) write a small adapter

---

## 5  Bet #78 — Versioned Lua wire protocol + Go / Rust ports

> **Target release: 1.0.0.** Estimated effort: 5–7 weeks.

### 5.1 The problem

The atomic Lua decisions exist only as JS-embedded strings; a Go or Rust
service in the same fleet cannot share the budget without round-tripping
through a JS sidecar. Polyglot adoption is blocked.

### 5.2 What ships

1. **`docs/WIRE-PROTOCOL.md`** — the frozen v1 spec: script naming
   (`tk:v1:<strategy>`), ARGV layout per strategy, Decision tuple encoding
   `[allowed, limit, remaining, resetAt, retryAfterMs]`, state encoding,
   key-prefix rules.
2. **Version negotiation in the JS client.** Each strategy declares
   `wireVersion: 1`; the store records it on first EVALSHA; a mismatch
   throws `ThrottleKitError`. The path to v2 is "introduce `tk:v2:<strategy>`
   alongside, keep v1 working until clients migrate."
3. **`throttlekit-go`** in a separate repo (`github.com/AmeyaBorkar/throttlekit-go`).
4. **`throttlekit-rs`** in a separate repo (`github.com/AmeyaBorkar/throttlekit-rs`).
5. **Cross-language conformance CI** — docker-compose; one Redis; the three
   clients hammer the same key against a seeded timeline; assert bit-identical
   Decisions.

### 5.3 The Lua-script distribution question (decision)

Three options for how the ports get their Lua:

| Option | Mechanics | Verdict |
|---|---|---|
| Vendor (copy-paste + checksum verify) | Each port embeds its own copy; CI verifies sha256 match | **Selected for MVP** — simplest; CI catches drift |
| Separate `@throttlekit/lua` npm/Go/Rust package | Single source, all ports vendor | Future — needs versioning policy + 3-language packaging |
| Network-fetch from CDN | Ports download Lua on init | Rejected — runtime dependency, opaque failures |

### 5.4 Subtasks

| Task | Commit shape |
|---|---|
| **TK-1101** `docs(wire): WIRE-PROTOCOL.md v1 spec` |
| **TK-1102** `feat(redis): wireVersion negotiation + clear-error on mismatch` |
| **TK-1103** `chore: throttlekit-go repo init + Limiter/Decision types` |
| **TK-1104** `feat(go): GCRA + RedisStore + dual-path conformance vs JS` |
| **TK-1105** `feat(go): tokenBucket + fixedWindow + slidingWindow + slidingWindowLog + quota` |
| **TK-1106** `chore: throttlekit-rs repo init` |
| **TK-1107** `feat(rs): all 6 strategies + dual-path conformance vs JS` |
| **TK-1108** `ci: cross-language conformance harness (docker-compose; JS/Go/Rust against one Redis)` |
| **TK-1109** `release: throttlekit-go v0.1.0 + throttlekit-rs v0.1.0` |
| **TK-1110** `docs: wiki Polyglot page + README polyglot section` |
| **TK-1111** `chore(release): prepare 1.0.0` |

### 5.5 Definition of done (the 1.0.0 release gate)

- `docs/WIRE-PROTOCOL.md` v1 frozen
- `throttlekit-go v0.1.0` published; `go get github.com/AmeyaBorkar/throttlekit-go`
- `throttlekit-rs v0.1.0` on crates.io
- Cross-language conformance CI green: JS / Go / Rust agree on Decision
  streams across all 6 strategies × 100 generated timelines
- README + wiki polyglot pages; CHANGELOG entry; user-authorized 1.0.0 release

---

## 6  Interstitial small polish (between major releases)

Between bigger-bet releases there are smaller items worth shipping as
0.8.x / 0.9.x / 0.10.x point releases. None block a bigger bet but each is
worth doing:

| Item | Where | When |
|---|---|---|
| Bench-gate `continue-on-error: true` → `false` | `.github/workflows/ci.yml` | 0.8.3, once enough CI runs confirm <10% noise on `ubuntu-latest` |
| Live-wire `leaseSizer` / `predictiveLeaseSizer` into `twoTier` | `src/twotier/index.ts` | 0.8.3 or 0.9.x |
| Re-measure coverage (the 95.2% figure in SCOREBOARD is from 0.8.0) | `npm run test:cov` + SCOREBOARD | 0.8.3 |
| `PostgresCoordinator` for federation | `src/federation/` | 0.9.x |
| Federated WFE (weighted fair escrow across regions) | `src/federation/wfe.ts` | 0.9.x |

These are tracked as a single "polish" task each (TK-1300-series), spawned
when their parent release lands.

---

## 7  Tasks

The full task list lives in the task system (see `TaskList`). The pre-existing
meta-tasks (TK-823 / TK-824 / TK-825 from `MEMORY.md`) are this plan's three
bets; the sub-task IDs introduced here (TK-9xx for federation, TK-10xx for
unified, TK-11xx for polyglot, TK-12xx for the HotNets paper) are new and
created upfront for bet #1 only — sub-tasks for #2 and #3 spawn at the start
of their respective meta-tasks (the design step), because the granular
decomposition there depends on the design-doc decisions and pre-committing
too far would create churn.

| ID | Label | Maps to | State |
|---|---|---|---|
| (meta) | **TK-823** Federation — ship 0.9.0 | bet #77 | in_progress when this plan lands |
| (meta) | **TK-825** Unified admission — ship 0.10.0 | bet #79 | pending; soft-ordered after TK-823 |
| (meta) | **TK-824** Polyglot — ship 1.0.0 | bet #78 | pending; soft-ordered after TK-825 |
| (meta) | **TK-1200** HotNets paper — assemble + submit by Jul 16 | parallel | pending; runs in parallel with TK-823 |
| sub | **TK-901**–**TK-912** | federation sub-tasks | created with explicit `blockedBy` chain |

Sub-task chain for federation (each implies the prior is complete):
TK-901 → TK-902 → TK-903 → TK-904 → TK-905 → TK-906 → TK-907 → TK-908 →
TK-909 → TK-910 → TK-911 → TK-912 (release 0.9.0). The chain is linear because
each step assumes the prior step's interfaces / proof / store exist; trying
to parallelize would produce merge churn on the same interface files.

---

## 8  Decision records (revisitable)

| ID | Decision | Date | Status |
|---|---|---|---|
| DR-01 | Federation architecture = option D (federated escrow with window-coupling at the regional boundary). | 2026-05-28 | Locked unless a CRDT proof emerges that strictly dominates |
| DR-02 | Global coordinator = `GlobalCoordinator` interface; MVP impl = single global Redis (SPOF documented). Postgres / Raft are future impls. | 2026-05-28 | Locked for 0.9.0 |
| DR-03 | Wire protocol stays implicit at v1 through 0.9.0 and 0.10.0; #78 freezes v1 explicitly at 1.0.0. | 2026-05-28 | Locked |
| DR-04 | Unified-admission backend = sequential (default) + Redis-Lua fused (opt-in). | 2026-05-28 | Locked unless a benchmark shows fused is universally cheaper |
| DR-05 | Polyglot ports = separate repos, vendored Lua + sha256 checksum verify in CI. | 2026-05-28 | Locked for 1.0.0 |
| DR-06 | HotNets paper runs as a parallel single-developer track, not a serial dependency on the bets. | 2026-05-28 | Locked unless the paper hits a research-blocker that the bets can resolve |

When implementation reveals a decision needs to change, edit the row in place
and add a one-line "Why changed" under it — do not silently rewrite.

---

## 9  How to start (the next session)

1. Read this file first.
2. `TaskList` → claim **TK-901** (federation design doc + TLA⁺ extension).
3. Write `research/bigger-bets/federation/DESIGN.md` (full design, expands §3
   here with the proofs).
4. Adapt `spec/GaleWindowCoupledLeasing.tla` → `spec/GaleFederatedLeasing.tla`
   (the relabeling described in §3.2).
5. Run TLC against small state counts (the `test/gale/leasing-variants.test.ts`
   pattern); commit the counts.
6. Mark TK-901 complete; pick TK-902.

**Standing rules (re-stated for the implementer):**
- Every commit passes `npm run check`.
- No `Co-Authored-By` trailers.
- Wiki commits accumulate locally; pushed only at release tag.
- npm publish requires explicit user authorization.
- When something doesn't go as planned, *say so* — update this file's
  decision records rather than diverging silently.
