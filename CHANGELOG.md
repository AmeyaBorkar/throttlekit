# Changelog

All notable changes to ThrottleKit are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Online (sample-then-price) dual refinement for the joint-LP policy — opt-in
  `jointLp.adaptive = { sampleWindow }` (TK-1401, D-JLP-8/13/14).** Requires the
  `jointLp.workload` form. Default and static joint-LP are byte-for-byte unchanged. The bid
  filter prices the first `sampleWindow` requests with the construction prior while observing
  the live `(cost, value)` mixture, then re-solves the fluid LP from what it actually saw and
  adopts the learned bid prices **only if they strictly beat the prior on the observed
  sample** (replayed under the window-scaled budget), else keeps the prior — then freezes.
  This **self-validating** rule is the load-bearing idea: a correct prior is kept (noise can't
  dislodge it), while a *catastrophically misspecified* prior — one whose duals reject
  everything — is escaped (gate-measured rescue from **100% → ~20–30%** regret), and the naïve
  "freeze-always" variant, which hurts a correct prior (**9.9–21.1%** vs static's **0.7–1.2%**),
  is rejected. **Honest scope:** the guarantee is non-inferiority *on the observed sample*, not
  full-horizon — under autocorrelated arrivals an adopted dual can be slightly worse over the
  full stream (the ρ=+1 foil's cousin; bounded, +~0.8pp measured, and regression-guarded). With
  a `concurrency` axis the window counts the concurrency-passed population.
- **3-axis joint-LP — a CONCURRENCY shadow price on top of rate + cost (TK-1405, D-JLP-15/16).**
  Opt-in; default and 2-axis joint-LP are byte-for-byte unchanged. Via **Little's law** an
  occupancy cap `L` over a window `T` is a third fluid budget `K = L·T` (concurrency-seconds)
  consumed per admit by the request's **hold time**, so the bid test becomes
  `value ≥ p_R + p_C·cost + p_K·hold`. This lets the filter reject a **hold-time hog** — a request
  cheap-and-valuable per token but slow to release its slot — that 2-axis is structurally blind to:
  the gate measures regret **53% → 2% (ε≈51pp)** when concurrency binds and the hog is
  indistinguishable from good traffic on (rate, cost). Enable via `jointLp.workload` with a
  `concBudget` + per-type `hold` (the solver runs a 3-budget dual), or `jointLp.duals.conc`, plus a
  per-request `hold` on `admit`/`admitSync`. **No harm** when concurrency is ample (`p_K=0`).
  **Honest limits:** like all bid-price controls it cannot ration a *marginal* hog (it strictly
  helps only against a strictly-dominated one); a missing / non-finite / negative per-request
  `hold` is fail-open (treated as 0 — never a wrongful reject). Not combinable with `jointLp.adaptive`
  yet.

## [0.11.2] — 2026-05-30

**Two opt-in concurrency upgrades + a stability charter — all additive; `0.11.1` users upgrade
with zero behavior change.**

### Added

- **Postgres concurrency coordinator — `PostgresConcurrencyCoordinator` (TK-1402).** A drop-in
  `ConcurrencyCoordinator` backed by a single Postgres primary — the event-release sibling of
  the federation `PostgresCoordinator`. It runs the SAME heartbeat compute as the in-memory
  reference inside one `pg_advisory_xact_lock` transaction (the shared pure `heartbeat-core`),
  so it is structurally conformant — dual-path tested `Test ≡ Postgres` across aggregate ×
  allocation × acknowledged-handoff. Store parity with `RedisConcurrencyCoordinator` for fleets
  already running Postgres; exported from the root entry.
- **`allocation: "demand-proportional"` on the distributed concurrency coordinators
  (TK-1403, D-DAC-22).** Opt-in — default stays `"equal-split"`, byte-for-byte unchanged.
  Under skewed load, equal-split strands an idle node's `≈ L/N` share where a busy peer
  needs it; demand-proportional lets a *satisfied* node (`inflight < share`) drain to a
  1-slot probe and re-grants the released budget to *hungry* nodes (`inflight ≥ share`) —
  **+25–50pp utilization under skew** (gate-measured), **0 regression** when load is
  balanced. It is a **TARGET-only** change: the occupancy cap is untouched, so `GlobalCap`
  (`Σ share ≤ L_global`) and the synchronous `InflightCap` (`Σ inflight ≤ L_global`) hold
  for the new target exactly as for equal-split — re-verified **exhaustively** in the BFS
  twin and **bit-identically** across the `TestConcurrencyCoordinator` ↔
  `RedisConcurrencyCoordinator` dual path. Every node keeps a `≥ 1` probe slot, so it is
  starvation-free when `L_global ≥ N`. All nodes/coordinators on a key must agree (like
  `aggregate`).
- **STABILITY.md** — a published stability + versioning charter: what is stable today (the core
  algorithms, stores, adapters, federation) vs the opt-in experimental frontier, and what `1.0`
  will commit to. Now shipped in the package and linked from the README.

### Changed

- Internal: the coordinator heartbeat compute is now a shared pure `heartbeat-core` used by both
  the Test and Postgres coordinators (one source of truth; no behavior change), additionally
  hardened to never self-evict a node on its own heartbeat (a latent crash on a past-`expiresAt`
  report).

## [0.11.1] — 2026-05-29

**Joint-LP admission policy — an opt-in bid-price filter for cost-bound gateways.**
`unifiedAdmission`'s default ("marginal-AND") admits when each axis independently has
room; when the **cost** axis binds and request types differ in value-per-token, that
greedily spends budget on whatever arrives first, starving higher-value requests. The new
`policy: "joint-lp"` adds a revenue-management bid-price filter on top — admit iff
`value ≥ p_R + p_C·cost`, with shadow prices solved from the workload's fluid LP. THEORY.md
(TK-1007) measured the mean revenue gap it closes at **ε = 25.33%** across the realistic
arrival-correlation sweep. **Patch** versioned: purely additive opt-in (`policy` defaults
to `"marginal"`, byte-for-byte unchanged) plus two correctness fixes.

### Added

- **`policy: "joint-lp"` on `unifiedAdmission` (TK-1320..1323).** Opt-in. Supply the bid
  prices directly (`jointLp: { duals }`) or a workload model the library solves once at
  construction (`jointLp: { workload }`). Per-call `value` (default 1) drives the
  bid-price test; the result gains `policyDenied: true` when the filter (not an axis)
  bound. **Strictly more selective** than marginal-AND (D-JLP-5) — it only ever *removes*
  admits, so it cannot break any existing limit/safety property — and runs identically
  over both the sequential and `lua-fused` backends (D-JLP-6, dual-path verified). The
  default `"marginal"` path is unchanged (D-JLP-2, property-tested).
- **`solveFluidLp(...)` — a zero-dep two-budget fluid-LP solver** (new export, with
  `WorkloadType` / `FluidLpInput` / `FluidLpSolution`). Returns the bid prices (LP duals),
  the optimal admit plan, and the objective. Hand-written vertex enumeration generalized to
  N request types; correctness pinned by a **KKT optimality certificate** over random
  instances (primal + dual feasibility + complementary slackness, which jointly prove LP
  optimality without an external solver) plus the THEORY.md canonical fixture.
- **`examples/joint-lp-admission.ts`** — an LLM gateway whose cost budget is steered to
  high-value completions; the bid-price filter ~doubles revenue vs marginal-AND on the
  adversarial arrival order.

**Honest caveat (do not bury — D-JLP-9):** under highly autocorrelated, near-*absorbing*
workloads the static fluid-LP duals can **under-perform** marginal-AND (the textbook
fluid-LP failure under non-stationarity; Talluri–van Ryzin 1998). At ρ = +1 in the sweep,
joint-LP's regret is *worse* — a foil the empirical-regret gate regression-guards so it is
never silently "fixed". Default stays marginal-AND; enable joint-LP when the cost axis
binds and request types differ in value-density. See
`research/bigger-bets/joint-lp-admission/DESIGN.md` §7.

### Fixed

- **`unifiedAdmission` (sequential backend) no longer leaks a concurrency slot when a
  rate/cost limiter throws.** If a Redis-backed rate/cost `check()` rejected (e.g. a store
  outage) after the concurrency slot was acquired, the held slot was never released — the
  `lua-fused` path already guarded this, the sequential path did not (a latent gap since
  0.9.0 / TK-1004). Both `admit` and `admitSync` now release the held slot before
  propagating the error. Surfaced by the 0.11.1 adversarial review.
- **A closed `DistributedConcurrencyGuard` now rejects new acquisitions.** After `close()`,
  `acquire()` previously kept admitting against the last-known share until the lease TTL
  elapsed; it now denies immediately (the node has left the coordinator). Flagged by the
  0.11.0 adversarial review as a candidate cleanup.

## [0.11.0] — 2026-05-29

**The complete instantaneous hard bound, end to end — eager handoff (D-DAC-20) +
self-fencing (D-DAC-21).** 0.10.0 (occupancy cap) + 0.10.1 (acknowledged handoff) made
`Σ inflight ≤ L_global` a hard bound for *live, cooperating* nodes — but at two costs
this release removes: the handoff's **ramp-latency tradeoff** (~2 heartbeats), and the
**partition overshoot** a crashed/silent node caused (the residual 0.10.x documented as
liveness-only / "not fixable"). **Minor** versioned: additive options + a new
`stats().fenced` field, plus one safe behavior refinement (self-fencing defaults ON under
`fail-closed`, closing a documented overshoot — healthy nodes are unaffected).

### Added

- **Eager (event-driven) handoff — hard bound at NEAR-FLOOR ramp (D-DAC-20, TK-1331).**
  Opt-in `eagerHandoff: true` on `distributedAdaptiveConcurrency`. Acknowledged handoff
  (0.10.1) makes the bound hard but costs ~2 heartbeats of ramp latency because the
  budget transfer is *batched onto the periodic tick*. Eager handoff fires OFF-CYCLE
  beats the instant local state shows the allocation is stale — **PULL** (capped below
  fair share, from already-returned `lGlobal`/`nodes` — no wire change), **PUSH** (drained
  below the lowered share), **ACK** (applied a generation-changing grant) — collapsing the
  ramp toward the physical floor (drain + one round-trip) with **ZERO loosening of the
  bound**. Guard-side only, so it is safe by the existing exhaustive async model (an
  off-cycle beat is just a `Report`/`Reallocate` at a different time). Debounced to
  `minHeartbeatMs`, so steady state adds zero beats. Pairs with `acknowledgedHandoff` for
  the "pitch-perfect" config `{ acknowledgedHandoff: true, eagerHandoff: true }`. Requires
  a scheduler with `setTimer` (the default has it). Verified: phase-swept real-guard sim
  (eager mean ramp ≪ periodic's flat 2×heartbeat; `Σ inflight ≤ L` at every phase),
  trigger/steady-state/compat unit tests, Redis dual-path.
- **Self-fencing — closes the partition / lease-expiry in-flight overshoot (D-DAC-21,
  TK-1332).** A crashed or partitioned node cannot heartbeat, but in 0.10.x kept admitting
  against its last-known share until a beat *threw* — and a partition HANGS, so the node
  over-admitted for the whole partition while the coordinator reassigned its budget
  (`Σ inflight > L_global`). Self-fencing enforces the lease on the node's OWN clock: it
  stops admitting at `lastSuccessfulBeatExpiresAt − fenceSafetyMargin`, strictly BEFORE the
  coordinator's reclaim. New options: `selfFence` (default `true` under `fail-closed`,
  `false` under `local-only`), `fenceSafetyMargin` (default `(leaseTtlMs − heartbeatMs)/2`;
  MUST be ≥ your max node↔coordinator clock skew), `onFenced` (a hook to abort in-flight,
  e.g. `AbortController`, draining the occupancy so the overshoot is closed end to end).
  `stats()` gains `fenced: boolean`. A healthy node never fences. **Assumption (explicit):
  bounded clock skew** — the standard lease assumption (Chubby jeopardy/grace, K8s
  `leaseDuration > renewDeadline`); FLP + Two Generals + CAP make some assumption
  unavoidable. Verified by a timed-model gate (derives the exact margin, refutes a smaller
  one) + a real-guard suite incl. the headline no-overshoot-on-takeover integration.

### Changed

- **`distributedAdaptiveConcurrency` under `fail-closed` now self-fences by default**
  (D-DAC-21). A healthy node is unaffected (it never reaches its fence deadline); the
  change closes the documented partition overshoot. It adds **one clock read per
  `acquire()`** while on (the time-based fence check — negligible for a network-bound
  concurrency gate, and guarded by a single-clock-read test). A node whose heartbeats are
  slow-but-successful (round-trip > the margin) will now shed where 0.10.x served — that
  is `fail-closed`'s contract (never overshoot). Set `selfFence: false` for the 0.10.x
  throw-only behavior, or use `local-only` (which never self-fences); `local-only` is
  otherwise unchanged.
- `HeartbeatScheduler` gains an optional `setTimer(fn, delayMs)` (one-shot timer) used by
  eager handoff. Existing schedulers keep working for the periodic-only default; a custom
  scheduler must add `setTimer` only if it enables `eagerHandoff`.

## [0.10.1] — 2026-05-29

**Acknowledged handoff — an opt-in HARD async `Σ inflight ≤ L_global` bound
(TK-1330).** A follow-up to 0.10.0's distributed adaptive concurrency: it closes the
bounded (~1.5×), self-draining `Σ inflight` residual that 0.10.0 honestly documented
(grant-reply + reporting lag) — turning it into a hard *instantaneous* invariant
under an opt-in coordinator flag, machine-checked by a new TLA⁺ spec (TLC) + a
Java-free BFS twin. **Patch** versioned because the surface is purely additive and
the default behavior is byte-identical to 0.10.0.

### Added

- **Acknowledged handoff for `distributedAdaptiveConcurrency` — an opt-in HARD
  async `Σ inflight ≤ L_global` bound (D-DAC-19, TK-1330).** 0.10.0's occupancy cap
  (D-DAC-18) eliminates the *synchronous* rebalance overshoot but leaves a bounded
  (~1.5×), self-draining residual under async grant-reply + reporting lag. Setting
  `acknowledgedHandoff: true` on `TestConcurrencyCoordinator` /
  `RedisConcurrencyCoordinator` makes `Σ inflight ≤ L_global` a **hard instantaneous**
  invariant: the coordinator reserves each peer `max(maxUnackedGrant, reported_inflight)`
  — the largest share it issued that the peer has not confirmed superseding (the guard
  echoes the grant **generation** it enforces, atomically with its in-flight) — so a
  joiner is granted freed budget only once the incumbent confirms it lowered its applied
  share AND drained. The overshoot becomes a **ramp delay** (≈1–2 heartbeats), not a
  violation. **Default is off** (the D-DAC-18 occupancy cap — fastest ramp); enable it
  for workloads that need a hard ceiling and tolerate the ramp latency. All
  nodes/coordinators on a key must agree; enable only once every guard is upgraded (a
  guard that doesn't echo the generation makes the coordinator over-reserve — safe).
  Verified by `spec/GaleHeartbeatHandoff.tla` (TLC: hard + tight on 250,624 states), a
  Java-free BFS twin (rule minimality + sufficiency + a torn-report negative test), the
  1.5× property counterexample flipping to `≤ L_global`, and Test ≡ Redis dual-path.
  Purely additive — `ConcurrencyReport` gains optional `seq`/`appliedGen`,
  `ConcurrencyGrant` gains optional `gen`; existing behavior is unchanged when off.

## [0.10.0] — 2026-05-29

**Distributed adaptive concurrency.** `adaptiveConcurrency()` infers a
concurrency ceiling **per process** from locally observed RTT. The moment
N processes front a *shared* backend (one inference cluster, one database
pool, one upstream API), N independent adaptive limiters each infer a
ceiling for the *whole* backend and collectively admit up to `Σ Lᵢ` — N×
the backend's true capacity. The adaptive limiter that was supposed to
*prevent* overload now *causes* it under fan-out. This release closes that
gap with `distributedAdaptiveConcurrency()`: a drop-in `ConcurrencyGuard`
that keeps the fleet's total in-flight count under one cooperatively-
inferred global ceiling. **Minor** versioned because the surface is purely
additive — no API or behavioral change to `federate`, `unifiedAdmission`, or
any existing adapter. (`adaptiveConcurrency`'s internals were rewritten for
performance this release — identical API and behavior; see *Performance* below.)

### Added

- **`distributedAdaptiveConcurrency(...)` in `src/concurrency/distributed.ts`
  (TK-1315)** — the new primitive (D-DAC-1). A dedicated `ConcurrencyGuard`,
  **not** a `federate()` extension: concurrency needs the event-release
  `acquire() → Lease` contract the 0.9.2 adapters accept, not federation's
  windowed-rate `Limiter`. The guard delegates `acquire`/`release` to a
  private in-process `adaptiveConcurrency` and only *tightens the gate* by
  the coordinator-supplied `share`; the effective ceiling is
  `min(share, local.limit)` (D-DAC-5/D-DAC-6), so RTT timing, the windowed
  no-load minimum, Gradient2/AIMD adaptation, and release idempotency are
  all inherited for free, with sub-heartbeat local reaction to an RTT spike.
  `acquire()` stays **synchronous** (D-DAC-4); only `heartbeat()` / `close()`
  are async. `nodeId` is **required, no default** (collisions corrupt the
  aggregate — D-DAC-15). One coordination round-trip per heartbeat, not per
  request (D-DAC-3).

- **`ConcurrencyCoordinator` interface + `ConcurrencyReport` /
  `ConcurrencyGrant` types in `src/concurrency/coordinator.ts` (TK-1315)** —
  the event-release sibling of federation's `GlobalCoordinator`. Owns the
  shared `L_global` and parcels it into per-node shares; the lease is renewed
  by heartbeat (liveness) and reclaimed by TTL (D-DAC-2). `leaseTtlMs`
  defaults to `2·heartbeatMs` so one slow heartbeat does not drop a node and a
  crashed node is reclaimed within the TTL (D-DAC-7).

- **`TestConcurrencyCoordinator` + `RedisConcurrencyCoordinator` (TK-1315)** —
  in-memory deterministic (no timers, no I/O; expiry against an injected
  clock) and a single atomic Lua heartbeat-aggregate-split, respectively.
  Postgres is **deferred** to a follow-up patch, mirroring federation's
  0.8.3 (Redis) → 0.8.4 (Postgres) rollout (D-DAC-16).

- **Occupancy-capped equal-split allocation (D-DAC-9 / D-DAC-17 / D-DAC-18)** — each
  grant is the equal-split target (`base = ⌊L/N⌋` plus one to the lowest-ranked `rem`
  by deterministic lexicographic `nodeId`, no RNG) **capped at the budget no other
  live node is holding**: `share = max(0, min(target, L_global − Σ_other max(share,
  inflight)))`. The `share` term makes **`GlobalCap`: `Σ share ≤ L_global`** a hard
  invariant under *any* staggered-heartbeat interleaving — a node that joins computes
  `min(target, L_global − L_global) = 0` and stays at 0 until incumbents re-split down
  (the cap subsumes any one-shot "provisional join", which is *insufficient* — it
  fails if the joiner re-heartbeats first). The `inflight` term (D-DAC-18, reserving
  each peer's `max(share, inflight)`) plus **monotonic grant application** (drop a
  reordered, stale grant) **eliminate the synchronous / protocol-level rebalance
  overshoot** in `Σ inflight` — `InflightCap : Σ inflight ≤ L_global` holds on every
  reachable state of the **synchronous** model (TLA⁺ + BFS twin). The fleet converges
  to the exact split within ≈ N heartbeats; idle-node skew is the documented
  utilization limitation (never a safety bug). **`Σ inflight ≤ L_global` is NOT a hard
  *instantaneous* invariant of the async system**: a bounded (~1.5–2×), self-draining
  residual remains from grant-reply + reporting lag (a guard admits against its cached
  grant; the cap reserves a peer's last-reported in-flight), clamped by `min(share,
  local.limit)` (D-DAC-14). A hard async bound would need acknowledged handoff
  (deferred).

- **Median / min aggregation, never sum (D-DAC-10)** —
  `aggregate({lLocal}) → L_global` is `"median"` (**default**, the lower
  median — robust to a single cold-starting node) or `"min"` (the
  conservative extreme). All nodes estimate the **same** quantity (the shared
  backend's capacity), so aggregation is robust *central estimation* of one
  number; **summing rebuilds the `N·C` overshoot bug** of fan-out and is
  never used. The policy lives on the coordinator, not the guard, so a
  mixed-fleet misconfiguration is impossible (D-DAC-8).

- **Fail-closed by default (D-DAC-11)** — on a coordinator outage,
  `onCoordinatorOutage: "fail-closed"` (default — safety > availability,
  matching federation) sets `share → 0` and the node sheds everything until
  the coordinator returns; `"local-only"` falls back to pure in-process
  adaptive concurrency (`share → local.limit`), staying up at the cost of the
  fleet possibly overshooting the backend. Cold start schedules the first
  heartbeat on the **next tick** (D-DAC-12); the budget cap (D-DAC-17) holds
  `Σ share ≤ L_global` across membership growth — a joining node is granted 0
  until incumbents re-split down, with no separate provisional-join bookkeeping.

- **`spec/GaleHeartbeatLeasing.tla` + `.cfg` (TK-1314)** — the safety spec, a
  relabeling of `GaleFederatedLeasing` from clock-release (window) escrow to
  event-release (heartbeat) shares (`windowMs → heartbeat_T`, `globalBudget → L`).
  Models the **staggered, budget-capped** protocol: an `active` set, a
  `Reallocate(n)` action that caps each grant at the budget left by the other
  active nodes, plus `Join`/`Leave`. The committed safety invariants are
  **`GlobalCap`: `Σ active share ≤ L`** (which a stateless equal-split would violate
  under a staggered join) and **`InflightCap`: `Σ active inflight ≤ L`**, both
  intentionally tight (`GlobalCapTight` / `InflightCapTight` are violated — `L` is the
  least upper bound). The proof fixes `L` *within* a heartbeat (D-DAC-13). **Scope:**
  the spec is **synchronous** (no committed-vs-applied distinction), so `GlobalCap`
  lifts to a hard invariant of the system but `InflightCap` is the synchronous-protocol
  guarantee only — the async system keeps a bounded, self-draining `Σ inflight`
  residual from grant-reply + reporting lag (D-DAC-14 / the spec's SCOPE note); a hard
  async bound would need acknowledged handoff (deferred).

- **`research/bigger-bets/distributed-adaptive-concurrency/DESIGN.md`
  (TK-1314)** — design lock; 18 decision records D-DAC-1..D-DAC-18. Lit
  synthesis citing Netflix `concurrency-limits` (Gradient2), Google SRE
  adaptive throttling, Chubby/ZooKeeper lease-based semaphores, and TCP
  congestion control as distributed resource sharing.

### Tested

- **BFS twin** at `test/concurrency/distributed-leasing-model.test.ts`
  (TK-1316) — the `GaleHeartbeatLeasing` **synchronous** transition system in TS (the
  `active` set, the occupancy-capped `Reallocate`, `Join`/`Leave`); exhaustively
  enumerates all reachable states for `Nodes={n1,n2}, L=4`, asserts `TypeOK` +
  **`GlobalCap` + `InflightCap`** on every state, pins the distinct-state count
  (`76`), witnesses the `GlobalCapTight` / `InflightCapTight` violations (both tight at
  `L`), and asserts at least one transition is a `Join` (membership growth observably
  covered). Both caps are guarantees of the **synchronous** model the twin enumerates;
  the async-system `Σ inflight` residual is the property suite's job (below). TLC
  parity is pending a Java env.

- **Property test** at `test/concurrency/distributed-invariant.test.ts`
  (TK-1316, fast-check) — random fleets (2-6 nodes), random `lLocal` reports,
  random `acquire`/`release`/`heartbeat` interleavings with simulated
  out-of-order grant landing. In a constant-`lGlobal` regime it asserts
  **`GlobalCap`** — `Σ` of coordinator-committed shares `≤ lGlobal` (read via
  `peek()`) at every step, the exact over-commitment the budget cap fixes; a
  shrink-biased sub-scenario provably enters the in-flight drain transient (a
  coverage assertion fails if it never does). `Σ inflight ≤ lGlobal` is **not**
  asserted as a hard invariant of the async system; instead a deterministic scenario
  pins the reviewer-found async reply-lag residual (a parked share-reduction lets
  `Σ inflight` reach ~1.5× transiently, then only drain — bounded ≤ 2×, never a
  runaway), so nobody re-introduces a false hard end-to-end claim (D-DAC-14 / D-DAC-18).

- **Dual-path conformance** at
  `test/concurrency/coordinator-conformance.test.ts` (TK-1316, Redis-gated on
  `THROTTLEKIT_TEST_REDIS`, port 6380) — an identical report sequence through
  `TestConcurrencyCoordinator` and `RedisConcurrencyCoordinator` yields
  identical `{share, lGlobal, nodes}` for every node, plus unit coverage at
  `test/concurrency/distributed.test.ts`.

### Forward-compat

- Because `DistributedConcurrencyGuard extends ConcurrencyGuard`, the value
  drops straight into `expressAdaptiveConcurrency({ guard })` and every
  sibling 0.9.2 adapter unchanged — the forward-compat hook the middleware
  family promised (D-M-12) realized.

### Performance

- **`adaptiveConcurrency` acquire/release ~3× faster (TK-1316).** Its hot path
  was rewritten from a fresh per-acquire `release` closure — which kept the
  rolling-min deque + gradient math in V8's *unoptimized* tier (each one-shot
  closure never tiers up) — to a class holding state in fields, with a `release`
  method **bound once per lease**: a single optimized body that is still safe to
  call detached (as the lease-shim, `unifiedAdmission`, and the adapters do).
  **Identical API and behavior** (all 1027 tests unchanged). On the project
  bench, acquire+release drops ~895 → ~297 ns/op (the pure logic ~14× faster;
  the end-to-end gain is larger on hosts where `Date.now()` is cheap), still
  ~0 alloc; `distributedAdaptiveConcurrency` inherits it (~1026 → ~290 ns/op).
  Now covered by `bench/run.ts` ("Concurrency — acquire + release").

## [0.9.2] — 2026-05-29

**Middleware integration for `unifiedAdmission` + `adaptiveConcurrency`.**
Both primitives expose a `release()` lifecycle callback that the user
previously had to wire to their framework's request lifecycle by hand.
Miss any one of the hooks (`finish`, `close`, error path on Node;
stream end, cancel, error on Web) and concurrency slots leak silently
until the adaptive limit collapses to zero and the server stops admitting.

This release adds **22 new exports** across **11 frameworks** that wire the
lifecycle correctly inside the library: the user passes a prebuilt
`UnifiedAdmitter` or `ConcurrencyGuard` to the adapter and the adapter
owns the release. **Patch** versioned because the surface is purely
additive — no changes to the existing `rateLimit` adapters or the
underlying primitives.

### Added

- **Node-server adapters (TK-1325)** — express, fastify, koa, nest. Each
  exports `<framework>UnifiedAdmission(options)` and
  `<framework>AdaptiveConcurrency(options)` (nest ships
  `*Middleware` variants for `MiddlewareConsumer.apply`). All wire
  `res.on("finish")` + `res.on("close")` with the **first-fire-wins**
  pattern: `close` before `finish` ⇒ `dropped: true` (client hangup or
  handler throw without error middleware), `finish` first ⇒
  `dropped: false` (normal completion). The second event is a no-op via
  idempotent release. Optional `dropOn5xx: boolean` for treating 5xx
  responses as overload signals (default `false` — a returned 5xx is
  application policy).

- **Web-platform adapters (TK-1326)** — hono, fetch, next, remix,
  sveltekit, elysia, trpc. Two patterns:
  - **Try/finally wrap** (hono, trpc, elysia): `await next()` (or the
    user-supplied body) inside `try/catch/finally`; release fires with
    `dropped = thrown` (plus the `dropOn5xx` rule for normal returns).
  - **Response stream-wrap** (fetch, next, remix, sveltekit): the
    returned `Response.body` ReadableStream is wrapped so release fires
    on natural drain (`done`), stream error, or consumer cancellation.
    Null body responses release synchronously.

- **`src/adapters/lifecycle.ts`** — shared `wireResponseLifecycle` +
  `unifiedHeadersFor` helpers for the node-server adapters.

- **`src/adapters/lifecycle-web.ts`** — shared
  `wrapResponseStreamLifecycle` + `unifiedHeadersWeb` +
  `defaultDenyResponse` / `defaultUnavailableResponse` helpers for the
  web-platform adapters.

- **`research/bigger-bets/middleware-integration/DESIGN.md`
  (TK-1324)** — design lock; 14 decision records D-M-1..D-M-14. Lit
  synthesis citing the Netflix concurrency-limits Servlet filter, Node
  `http.ServerResponse` state machine, and AWS Lambda invocation
  lifecycle. Per-framework hook table for every adapter family.

### Tested

- **48 new tests** across `test/adapters/{express,fastify,koa,nest,web}-{unified,middleware}.test.ts`
  + `test/adapters/release-invariant.test.ts`. Coverage matrix: admit +
  finish-release, close-before-finish (dropped), deny short-circuit
  with no slot held, idempotent double-fire, onLimited observability
  hook, dropOn5xx with 5xx status, null-body release, handler-throw,
  consumer-cancel.

- **Property test** at numRuns 50-200: exactly-once-release invariant
  across fuzzed `[finish, close]` event orderings for the node-server
  helper, fuzzed body outcomes (`drain | cancel | null-body`) for the
  web-platform helper, plus integration paths through
  `expressUnifiedAdmission` and `withUnifiedAdmission` confirming the
  adaptive concurrency limit never collapses to zero across 50 random
  workloads of 10 concurrent requests each.

### Forward-compat

- The adapters accept any `ConcurrencyGuard`, not just the in-process
  implementation (D-M-12). When 0.10.0 lands distributed adaptive
  concurrency, the same adapter wiring picks up the new guard
  transparently.

## [0.9.1] — 2026-05-29

**Pillar 4 — Weighted Fair Escrow.** A weighted, work-conserving
fair-allocation limiter that splits one shared per-window budget across
tenants in proportion to weight, with idle tenants' surplus reclaimed by
backlogged ones — neither stranded nor first-come. The production
graduation of GALE's Pillar 4 research module (`research/gale/PILLAR4-
fairness.md`, 4-theorem proof machine-checked at 20 000 random trials).
**Patch** versioned because the surface is purely additive — one new
top-level primitive (`weightedFairEscrow`) sitting next to the existing
fairness siblings (`fairShare`, `weightedFairShare`, `weightedMaxMin`),
zero changes to existing APIs.

### Added

- **`weightedFairEscrow(...)` in `src/twotier/` (TK-1310)** — the new
  fairness primitive. Returns a `WeightedFairEscrowLimiter` with a
  `.check(tenant, cost) → Decision` signature; does NOT widen the
  existing `Limiter` interface (DR-P4-3). Supports both L1-only
  (single-process) and L2-backed (multi-process) modes via an optional
  `l2: Store` parameter.

  Algorithm: per check, compute the dynamic guaranteed share
  `gᵢ = ⌊wᵢ·L/W⌋` for the current active set; admit within guarantee
  unconditionally; beyond guarantee, borrow from the pessimistic
  surplus `max(0, (L − Σ used) − Σⱼ≠ᵢ max(0, gⱼ − usedⱼ))` with the
  per-call borrow capped at the call's own `cost` (DRR semantics —
  matches Shreedhar-Varghese SIGCOMM'95). O(N) per check; N = active
  tenants this window.

- **L2 multi-process backing** — when `l2: Store` is configured, each
  process atomically leases `quantum` credits at a time from a shared
  `fixedWindow({ limit: L, windowMs })` counter on the store. Re-uses
  the existing fixedWindow Lua (zero new wire surface, per DR-P4-5);
  the shared store's atomicity is what bounds global `Σ used ≤ L`
  across processes. The per-process T4 bound picks up a `quantum`-
  scaled DRR slack across processes (`Σₚ Q⁽ᵖ⁾ · (1/wᵢ + 1/wⱼ)`).

- **`weightedFairEscrowLimiter.stats()`** — read-only window snapshot
  including `windowStart`, `limit`, `effectiveLimit` (the lazy-leased
  total in L2 mode), `pool`, `totalUsed`, and per-tenant `{tenant,
  weight, used}`. Useful for metrics / dashboards.

- **`examples/weighted-fair-escrow.ts`** — LLM-gateway-multi-tenant
  scenario: enterprise:pro:free at 4:2:1 weights against a 30 000 TPM
  budget. Demonstrates the work-conservation effect — free-tier
  flooders are metered at their guaranteed share, leaving headroom for
  enterprise:alpha's later large completion.

- **Wiki: `Pillar-4-Weighted-Fair-Escrow.md`** (pushed at the v0.9.1
  release tag) — covers the 3-primitive fairness landscape, the
  streaming algorithm, T1-T4 guarantees + the T5 (FairRide-conceded)
  vertex, L2 multi-process backing, failure modes, composition, and
  roadmap (federated WFE → 0.10.x).

### Changed

- **`guaranteedShare(weights, limit)` and `weightedFairShare`** —
  switched from `floor((w/W)*L)` to `floor((w*L)/W)` to fix a
  floating-point precision bug in edge cases like `(6/11)*99 =
  53.999...` flooring to 53 instead of 54. The integer-first form is
  exact up to `MAX_SAFE_INTEGER`. Pre-existing bug in 0.9.0; all
  existing tests used friendly ratios that floor correctly, so this
  is a silent precision improvement with no observable behaviour
  change at common configurations.

- **`docs/FAILURE-MODES.md`** — added a `weightedFairEscrow` outage
  matrix section (L1-only vs L2-backed: tenant explosion, process
  restart, L2 unreachability, paused tenant, T5 over-declaration,
  async-vs-sync semantics, weight drift, lease denial).

### Verified

- 38 new WFE tests pass (22 happy-path + 8 L2 + 8 property tests
  including L1 ≡ L2 dual-path conformance on MemoryStore + Redis-gated
  DB 7 at 50 timelines).
- T1 safety, T2 sharing-incentive, T3 work-conservation property tests
  at `numRuns: 200`; T4 bounded unfairness at the
  `q·(1/wᵢ + 1/wⱼ)` DRR bound. The pure batch algebra
  (`weightedMaxMin`) is independently proven at 20 000 random trials
  (`test/gale/fair-escrow.test.ts`, unchanged).
- Composition with `combineDecisions`: WFE's Decision shape composes
  via the 0.9.0 algebra unchanged.
- Bench gate green at the 0.9.0 baseline (no `src/algorithms/*` or
  `src/core/limiter.ts` or `src/stores/memory.ts` changes between
  0.9.0 and 0.9.1; only `src/twotier/weighted-fair-escrow.ts` is new).

### Design records (added)

- DR-P4-1 through DR-P4-14 in `research/bigger-bets/pillar4-wfe/
  DESIGN.md`. Most load-bearing:
  - DR-P4-1 — API shape = top-level primitive in `src/twotier/`
  - DR-P4-3 — does NOT widen `Limiter` (new interface)
  - DR-P4-5 — L2 backing reuses existing `Store.apply` lease shape
    (no new Lua)
  - DR-P4-10 — NOT strategy-proof (FairRide conceded vertex)
  - DR-P4-13 — first commit ships L1-only, second commit adds L2

DR-P4-2 amended ("Why changed") — the L1-layer DRR quantum was dropped
because the streaming algorithm matches exact integer guarantees per
check; the quantum concept re-emerges only at the L2 layer (lease size).

## [0.9.0] — 2026-05-29

**Unified admission — one Decision across rate, concurrency, and cost.**
The 0.9.0 deliverable: `unifiedAdmission(...)` composes the three
orthogonal admission axes a real API request must clear into ONE
`Decision`, with a four-law pure algebra (`combineDecisions`) and both
sequential (any backend) and Lua-fused (Redis-only opt-in) execution.
The LLM-gateway shape: rate (req/min) + concurrency (in-flight) +
cost (tokens) is the production target. Versioned as a **minor** bump
because it introduces a NEW admission primitive — the algebra,
`UnifiedAdmitter`, the Lua-fused atomic script, and the
`tk.binding_axis` OTel attribute are all new public surfaces (all
additive — no breaking changes to 0.8.5). Test count **913 → 996**
(+83 new tests across `combine.test.ts`, `lease-shim.test.ts`,
`unified.test.ts`, `unified-fused.test.ts`, `fused-conformance.test.ts`,
`metrics-contract.test.ts`).

### Added

- **`combineDecisions(a, b): Decision` + `ALLOW_FULL`** (`src/core/combine.ts`
  — TK-1002). The pure field-by-field algebra at the heart of unified
  admission: AND on `allowed`, MIN on `limit`/`remaining`, MAX on
  `resetAt`/`retryAfterMs`. Four algebraic laws proven via fast-check
  at `numRuns ≥ 500`: **identity** (combine with `ALLOW_FULL` = no-op),
  **associativity** (N inputs reduce flat), **commutativity** (order
  doesn't change the result), **idempotency** (retried sub-checks are
  safe). `ALLOW_FULL` uses `Number.MAX_SAFE_INTEGER` for `limit` /
  `remaining` (not `+Infinity`) to preserve the project-wide JS-Lua
  bit-identity guarantee. Re-exported from the root + `throttlekit/core`.

- **`leaseAsAdmission(guard, opts?)`** (`src/admission/lease-shim.ts`
  — TK-1003). Bridges `ConcurrencyGuard.acquire() → Lease` into a
  Decision-shaped admission so the concurrency axis composes with
  rate / cost axes via `combineDecisions`. The release is kept
  separate from the Decision (returned in the same object) so the
  caller can wire it to the request lifecycle — that's the mechanical
  reason `unifiedAdmission` returns `{ decision, release }` and NOT
  `Limiter` (D-U4 / DR-08 — concurrency's lease semantics don't fit
  `Limiter`'s stateless `.check() → Decision` shape). On rejection,
  `retryAfterMs` is a Little's-Law-honest hint (`max(1,
  round(lastRtt || 1))`) since the slot frees by *event*, not by clock.

- **`unifiedAdmission({ rate?, concurrency?, cost?, backend?, fused?,
  clock? }): UnifiedAdmitter`** (`src/admission/unified.ts` — TK-1004
  / TK-1005). The composition primitive. Two backend modes:
  - **`backend: "sequential"`** (default): each axis runs in turn
    (concurrency → rate → cost — in-process fastest fail first); first
    deny short-circuits and releases any transiently-held slot.
    Works with any backend mix.
  - **`backend: "lua-fused"`** (opt-in, requires `fused` option group
    with explicit `client` + per-axis strategy params): one Redis
    `EVALSHA` of `tk:v1:fused-rc:check` evaluates rate + cost
    atomically. 0.9.0 ships GCRA + tokenBucket fusion (the LLM-gateway
    combination); other strategy pairs throw at construction with a
    clear error and land as 0.9.x patches per demand.

  `UnifiedAdmitter` exposes both `admit() → Promise<UnifiedAdmission>`
  (universal) and `admitSync() → UnifiedAdmission` (sync; throws if any
  axis lacks `checkSync` or if `backend: "lua-fused"`), mirroring the
  project's existing `Limiter.check` / `Limiter.checkSync` pattern.
  `lastDecisions()` returns a frozen per-axis snapshot for OTel /
  metrics consumption.

- **`FusedDispatcher` + `FUSED_GCRA_TOKEN_BUCKET_LUA`**
  (`src/admission/fused-lua.ts` — TK-1005). The standalone fused-script
  dispatcher (mirroring `RedisCoordinator`'s `EVALSHA → EVAL on NOSCRIPT`
  pattern). Public so power users can dispatch the fused script
  directly outside `unifiedAdmission`. The script returns a 13-element
  integer tuple `[combined.allowed, combined.limit, combined.remaining,
  combined.resetAt, combined.retryAfterMs, rate.allowed, rate.remaining,
  rate.resetAt, rate.retryAfterMs, cost.allowed, cost.remaining,
  cost.resetAt, cost.retryAfterMs]`. Semantic match to sequential mode:
  each axis writes its own state per its own admit decision,
  independent of the other axis's outcome (preserves the byte-identity
  claim across the two backends).

- **`bindingAxisOf(lastDecisions)`** and
  **`recordUnifiedAdmissionOnSpan(span, decision, lastDecisions,
  extra?)`** (`src/observability/otel.ts` — TK-1008). Identify the
  binding axis of a denied unified-admission decision (`"concurrency"`
  | `"rate"` | `"cost"`, omitted from admitted decisions) and record
  it onto an OTel span via the new
  `SPAN_ATTRIBUTES.bindingAxis = "throttlekit.binding_axis"` key.
  Convention: deterministic priority is concurrency → rate → cost
  (matches sequential's evaluation order), so the attribute is
  consistent across backends. Closes the #1 missing OTel signal for
  LLM gateways (which axis blocked me?).

### Tested

- **Algebra laws property test** (`test/core/combine.test.ts`, +16):
  identity (right + left), associativity, commutativity, idempotency
  via fast-check at `numRuns: 500` per law; N-ary reduction consistency
  (foldLeft = foldRight); explicit field-by-field semantic cases;
  `ALLOW_FULL` shape pin.

- **Lease-shim shape + lifecycle**
  (`test/admission/lease-shim.test.ts`, +13): accepted-lease Decision
  shape, rejected-lease shape with `retryAfterMs = lastRtt` heuristic,
  release pass-through, `dropped: true` AIMD-limit-contraction,
  double-release idempotency, integer bit-identity on all numeric
  fields, composition with `combineDecisions`.

- **Sequential composition** (`test/admission/unified.test.ts`, +26):
  construction validation (empty axes, invalid backend, missing
  `fused` group), every axis subset (single / pair / triple),
  short-circuit + binding-axis identification, release lifecycle,
  `admitSync` error propagation, key / cost forwarding.

- **Lua-fused mode** (`test/admission/unified-fused.test.ts`, +14
  gated): `FusedDispatcher` construction validation, dispatch happy
  path (rate-deny, cost-deny, 13-tuple shape, integer bit-identity),
  `unifiedAdmission` integration (concurrency-deny short-circuit
  without consulting Redis, `admitSync` throws, Redis-error releases
  slot), atomicity (20 parallel admits at capacity 10 admit ≤ 10).

- **Dual-path conformance** (`test/admission/fused-conformance.test.ts`,
  +4 gated): byte-identical Decision streams across 100 fast-check
  timelines per (rate-binding / cost-binding / both-binding)
  configuration (300 timelines total, ~9000 Redis ops per run). Pins
  both per-axis and combined Decisions agree field-by-field. Sequential
  uses `useServerTime: false` + ManualClock; fused uses `dispatchAt`
  with the same explicit `now`.

- **`bindingAxisOf` + `recordUnifiedAdmissionOnSpan`**
  (`test/observability/metrics-contract.test.ts`, +10): single-axis /
  multi-axis priority / all-allow / all-undefined cases for
  `bindingAxisOf`; attribute-set / attribute-omit / extras-merge cases
  for `recordUnifiedAdmissionOnSpan`; updated `SPAN_ATTRIBUTES`
  contract pin.

### Research

- **`research/bigger-bets/unified/DESIGN.md`** — the design lock (TK-1001).
  Lit synthesis citing Netflix concurrency-limits gradient2, Envoy
  adaptive concurrency, Google SRE Ch.21, Little's Law,
  Devanur-Hayes 2009 (Adwords primal-dual, 1−1/e), Talluri-van Ryzin
  1998 (network revenue management bid prices), Buchbinder-Jain-Naor
  2007 (multi-resource online matching), TALE work for the cost axis.
  15 decision records (D-U1..D-U15).

- **`research/bigger-bets/unified/THEORY.md` + `sim.ts`** — the
  empirical joint-vs-marginal regret analysis (TK-1007). Markov-
  correlated workload, fluid-LP closed form, three policies
  (marginal-AND, joint-LP, clairvoyant-via-fluid-upper-bound), ρ
  sweep in {−1, −0.5, 0, +0.5, +1} × 20 seeds. **Mean ε = 25.33%**
  (well above DR-19's 5% threshold). **Verdict: SHIP** the joint-LP
  runtime as `policy: "joint-lp"` in 0.10.1. Honest documentation of
  the ρ = +1 negative result (well-known fluid-LP failure under
  non-stationarity); production workloads sit in moderate-ρ regimes
  where joint-LP wins consistently.

### Docs

- `docs/FAILURE-MODES.md` — new "`unifiedAdmission` — outage shapes"
  section: per-backend failure-mode matrix (sequential vs lua-fused),
  observability conventions, pointers to DESIGN.md / THEORY.md.

- `examples/unified.ts` — runnable LLM-gateway-style demo (concurrency
  binding, binding-axis observability, release lifecycle). Async /
  Express shape documented as a commented recipe.

- Wiki: new **`Unified-Admission`** page (algebra + two backends +
  observability + lifecycle + joint-LP roadmap + recipes). Updates to
  `Home` and `_Sidebar` navigation.

### Removed / breaking

_None._ The release is purely additive: every 0.8.5 surface remains
available with bit-identical behavior. The new `unifiedAdmission(...)`
sits alongside `rateLimit(...)`, `adaptiveConcurrency(...)`,
`tokenBudget(...)` — opt in by calling it.

### Out of scope (deferred)

- **`policy: "joint-lp"` runtime** — gated by DR-19 to 0.10.1 (the
  conditional ship is now GREEN per TK-1007's ε = 25.33% finding);
  TK-1319 design will lock the API.
- **Distributed adaptive concurrency** (DR-10) — 0.10.0 follow-up.
- **`Decision.bindingAxis` field** — breaking change to the Decision
  shape; use the `tk.binding_axis` OTel attribute + `lastDecisions()`
  introspection instead. Revisit at 1.0.
- **Online primal-dual** (Devanur-Hayes update rule for
  non-stationary workloads) — 0.10.2 candidate.

## [0.8.5] — 2026-05-28

**Multi-process regional escrow + regional-only outage mode.** Closes the
two TK-906-era gaps documented in the 0.8.3 release notes: (1) M
processes in the same region can now share a regional escrow atomically,
so in-flight per-region escrow is bounded by what the global coordinator
has actually granted instead of `M × batch`; (2) `onCoordinatorOutage:
"regional-only"` is now actually wired — the engine keeps serving from
the regional L2 balance during a coordinator outage and re-probes via
`coordinator.isHealthy()`. Versioned as a patch because the surface is
purely additive: new types on the existing `throttlekit/federation`
subpath; the existing `federate(...)` flow is bit-identical to 0.8.4
when no `regionalEscrow` is configured. Test count **857 → 913** (28 +
10 + 10 always-on TK-1306 tests + 13 gated Redis tests across four new
test files; pre-existing 793 pass count carried forward to **836**).

### Added

- **`RegionalEscrow` interface** (`src/federation/types.ts` — TK-1306).
  The L2 layer between the per-process engine L1 cache and the cross-
  region L3 `GlobalCoordinator`. Three atomic ops mirroring
  `GlobalCoordinator` one layer down:
  - `lease(key, tokens)` → 0..tokens granted from the L2 balance
  - `refill(key, granted, sourceWindowStart)` → additive within a
    window; drops grants for already-expired windows
  - `release(key, sourceWindowStart)` → captures-and-zeroes; idempotent
    per `(key, sourceWindowStart)` so multi-process release races have
    one winner
  - optional `isHealthy()` → liveness probe

- **`RedisRegionalEscrow`** (`src/federation/redis-regional-escrow.ts` —
  TK-1306). Production-ready implementation; same atomic-Lua pattern as
  `RedisCoordinator` (LUA_NOW preamble, `EVALSHA + EVAL` NOSCRIPT
  fallback, PEXPIRE-anchored window-coupling, `StoreUnavailableError`
  wrapping). Three Lua scripts (REGIONAL_LEASE / REGIONAL_REFILL /
  REGIONAL_RELEASE). Schema: one HASH per `(region, key)` with
  `balance`, `expires_at`, `source_lease` fields.

- **`TestRegionalEscrow`** (`src/federation/test-regional-escrow.ts` —
  TK-1306). Deterministic in-memory mirror with `ManualClock` injection
  for tests + examples; mirrors `TestCoordinator` one layer down.

- **`FederateOptions.regionalEscrow?: RegionalEscrow`** (and
  `FederatedStoreOptions.regionalEscrow`). When provided, the federation
  engine routes leases through the L2 layer between in-process L1 and
  the coordinator (L3). When undefined, the engine uses in-process
  escrow only (legacy 0.8.4 behavior; **backward compatible**).

- **`FederateOptions.coordinatorHealthCheckMs?: number`** (default
  5000 ms). The cadence at which the engine re-probes
  `coordinator.isHealthy()` while in `regional-only` outage mode. The
  probe is **clock-driven** (lazy, on `check()`) — deterministic tests
  with `ManualClock` advance the clock past the interval to trigger
  recovery. No background timers; nothing to close.

- **`regional-only` outage mode** (TK-1306) now actually works. When
  `onCoordinatorOutage: "regional-only"` AND a `regionalEscrow` is
  configured, on a coordinator outage the engine marks the coordinator
  unhealthy and short-circuits subsequent requests at a gate — they
  serve from the L2 fast path (if balance) or deny (if not), without
  paying per-request `coord.lease` latency hits. On
  `coordinator.isHealthy()` returning true after the probe interval,
  the engine flips back to healthy and resumes normal lease + reconcile.
  Without a `regionalEscrow`, this mode silently degrades to
  `fail-closed` (documented).

- **Multi-process atomicity tests** (TK-1306). 56 new tests across four
  files:
  - `test/federation/regional-escrow.test.ts` (28 always-on) —
    `TestRegionalEscrow` contract: lease/refill/release semantics,
    window-coupling, multi-process accumulation, release-race,
    partition behavior, malformed inputs.
  - `test/federation/regional-escrow-engine.test.ts` (10 always-on) —
    M=2/4/8 engines sharing one L2 admit ≤ perKeyBudget per window;
    L2-as-cache; backward compat without `regionalEscrow`; L2 outage
    fallback.
  - `test/federation/regional-only.test.ts` (10 always-on) — the
    regional-only outage gate; L2-seeded outage serves; recovery via
    probe; window-boundary recovery; health-probe cadence; degenerate
    fallbacks (no regionalEscrow, no isHealthy).
  - `test/federation/redis-regional-escrow.test.ts` (13 gated on
    `THROTTLEKIT_TEST_REDIS`) — atomic-Lua parity against a real
    regional Redis; M=8 concurrent lease atomicity; release-race-winner;
    region key isolation.

- **`examples/federation-regional-escrow.ts`** (TK-1307). M=4 federation
  engines in `us-east` sharing one `RedisRegionalEscrow` + one
  `RedisCoordinator` (two databases on the same Redis for the L2/L3
  split). Demonstrates that total admissions stay at `perKeyBudget` even
  though `M × batch` would leak overshoot without an L2. The
  `regional-only` outage mode is wired in the example.

- **`docs/FAILURE-MODES.md`** federation section refreshed (TK-1307):
  three new rows in the outage table (multi-process atomicity, regional
  L2 outage, regional-only outage mode); the "Optional softer mode"
  paragraph updated to reflect that regional-only is now shipped.

- **Wiki: new "Multi-process regional escrow (0.8.5)" section** in the
  `Federation` page (TK-1307), with the `RedisRegionalEscrow` +
  `RedisCoordinator` quick-start and `regional-only` outage mode wiring.

### Design notes

Two implementation revisions are recorded in
`research/regional-escrow/DESIGN.md`:

- **DR-20**: introduce first-class `RegionalEscrow` interface instead of
  routing through `Store.apply()`. `Store`'s generic `Transform` doesn't
  accept the multi-arg Lua scripts L2 needs; coupling `Store`'s contract
  to federation semantics would be a code smell. The interface mirrors
  `GlobalCoordinator` one layer down (clean separation).

- **DR-21**: REFILL is additive within a window (not first-wins).
  Multiple processes' concurrent coord-grants accumulate in L2;
  federation bound (Δ = 0) is preserved by L3's `perKeyBudget` cap.
  First-wins would leak capacity at window-open contention.

## [0.8.4] — 2026-05-28

**Federation completion: PostgresCoordinator.** A drop-in `GlobalCoordinator`
implementation backed by a single Postgres primary, alongside the existing
`RedisCoordinator`. Same window-coupling guarantee (Δ = 0, K-INDEPENDENT
bound), same `federate(...)` surface — pick whichever store your ops team
already runs. Versioned as a patch because the surface is purely additive:
a new class on the existing `throttlekit/federation` subpath; no existing
API changes. Test count **845 → 857** (12 new gated Postgres conformance
tests; same 793 pass count under default `npm run check`).

### Added

- **`PostgresCoordinator`** (`src/federation/postgres-coordinator.ts` — TK-1301..TK-1304).
  Implements `GlobalCoordinator` against a single Postgres primary; drop-in
  replacement for `RedisCoordinator`. Schema (one `tk_fed_state` table)
  created lazily on first call — no migration tool needed. Atomicity via
  single-transaction `INSERT ON CONFLICT DO UPDATE` + `SELECT FOR UPDATE` +
  `UPDATE` (window roll handled in-place by CASE on `expires_at`).
  Idempotency markers as `BIGINT[]` mirror Redis's `rec_<windowStart>`
  HASH fields. Server-time anchoring via `clock_timestamp()` (Postgres
  analog to Redis `TIME` — node clock skew is irrelevant for the bound).
  Background GC sweep via JS `setInterval` (configurable; default 60s
  sweep, 24h retention; opt-out via `gcIntervalMs: 0`).

  Latency / throughput trade-off vs Redis: ~1-3 ms per lease vs ~0.5-1 ms;
  5K-20K leases/sec vs 100K+. HA story: synchronous replication +
  automated failover (Patroni / pg_auto_failover) vs Sentinel / Cluster.

- **`PostgresCoordinator` conformance tests** (TK-1302). 12 cases mirroring
  `RedisCoordinator` 1:1 — lease/reconcile semantics, idempotency,
  per-key budget overrides, constructor validation, window-roll behavior,
  identifier safety on `tableName`. Gated on `THROTTLEKIT_TEST_POSTGRES`
  (e.g. `postgres://user:pass@localhost:5433/db`).

- **`examples/federation-postgres.ts`** (TK-1303). Parallel to
  `examples/federation.ts`: 3-region skewed workload demonstrating Δ = 0
  + recovery vs static-partition, with the only change being
  `PostgresCoordinator` in place of `RedisCoordinator`. Same admit
  counts expected; the bound is identical across backends.

- **`docs/FAILURE-MODES.md`** federation section refreshed (TK-1303):
  new Postgres-primary-failover row in the outage table; new
  "Choosing a coordinator backend" subsection comparing
  latency / throughput / HA / durability axes.

- **Wiki: new `PostgresCoordinator` quick start** in the
  `Federation` page, plus the coordinator-backends table updated to
  show Postgres as Shipped 0.8.4.

### Design references

- `research/postgres-coordinator/DESIGN.md` — full design lock for
  TK-1301; schema, atomicity model, server-time anchoring,
  garbage-collection strategy, failure-mode parity with Redis.

## [0.8.3] — 2026-05-28

**The federation patch.** Ships `federate(...)` — cross-cluster rate limiting with a
formally-verified, K-INDEPENDENT overshoot bound — and the production-grade
`RedisCoordinator` that backs it. Versioned as a patch within the 0.8 line (rather than
the originally-planned 0.9.0 minor bump) because the new surface is purely additive:
the existing 0.8.x API is unchanged, `throttlekit/federation` is a NEW subpath, and
no consumer code needs to migrate to upgrade. Test count **769 → 845** (793 pass + 52
skipped without `THROTTLEKIT_TEST_REDIS`/`PG`; all pass with the gated suites enabled).

### Added

- **Cross-cluster federation** (`throttlekit/federation` — TK-901 .. TK-912). `federate({
  strategy, coordinator, region, batch })` returns a regular `Limiter` that pools one
  global budget across K regions; per-window overshoot **`admitted ≤ Limit`,
  independent of region count K**. The contribution vs the existing in-process
  `twoTier(leased, windowCoupled)` is *cross-cluster*: when your processes span
  multiple Redis clusters (one per region), this gives the same proven bound at the
  inter-cluster layer with one cross-region round trip per `batch` requests.

  Components:
  - `federate(...)` — top-level Limiter factory (parallel to `rateLimit` / `twoTier`).
  - `FederatedStore` — the Store-shape composition for users layering `twoTier` on top
    (recursive twoTier composition).
  - `GlobalCoordinator` — abstract interface; ships with `TestCoordinator` (in-memory
    for tests) and `RedisCoordinator` (production default; single global Redis,
    documented SPOF). `PostgresCoordinator` and Raft-via-etcd are 0.9.x / 1.0.x
    follow-ups.
  - Window-coupling rule: regional escrow expires at the global window boundary, with
    idempotent reconcile on `windowStart` (the partition-recovery contract).
  - Fail-closed default (`onCoordinatorOutage: "fail-closed"`); `regional-only` opt-in
    for soft-traffic operators (TK-906 scope).
  - New subpath export: `import { federate, RedisCoordinator } from "throttlekit/federation"`.

- **Formal model: `spec/GaleFederatedLeasing.tla`** (TK-901). A literal relabeling of
  `spec/GaleWindowCoupledLeasing.tla` (`Nodes → Regions`, `credits → escrow`,
  `l2 → globalBudget`); the math lifts directly via the recursive twoTier insight.
  TLC-checked at small state counts (8 / 27 / 112 distinct states for K=2/3/5);
  CI-runnable BFS twin in `test/gale/federated/leasing-variants.test.ts` (TK-905)
  reproduces TLC's anchor counts byte-for-byte (31 baseline / 441 baseline) and pins
  the new federated counts.

- **`staticPartition()` baseline** (TK-903). The simplest correct federation scheme —
  split the global budget evenly across K regions, no coordination, no pooling. Used
  as the comparison baseline in `research/bigger-bets/federation/baselines.md`;
  measured U_capacity collapses from 1.0 (uniform) to 1/K (max skew). The federation
  scheme recovers full utilization under skew (see eval below).

- **3-region cluster eval** (`research/bigger-bets/federation/eval/` — TK-909, TK-910).
  Reproducible docker-compose layout + replay harness. End-to-end run captures:
  - Δ = 0 on every measured configuration (skew 0..1, RTT 1ms..100ms)
  - U_capacity ≥ 0.957 across the skew sweep; **U = 1.000 at max skew**, where the
    static-partition baseline drops to 0.333 (federation **recovers +0.667** of
    utilization)
  - Coordinator round trips amortize exactly at `1/batch` (38 trips for 600 admissions
    at batch=16); latency is irrelevant to utilization (p99 grows linearly with RTT
    but the throughput claim doesn't move).

- **Property-based dual-path federation conformance** (TK-908). Fast-check generates
  adversarial `(regionIdx, cost)` timelines and drives them through BOTH
  `TestCoordinator` and `RedisCoordinator`, asserting the admit-decision streams
  agree byte-for-byte across K ∈ {2, 3, 4} × L ∈ {12, 30}. Gated on
  `THROTTLEKIT_TEST_REDIS`.

- **Cross-region failure-mode tests** (TK-907). Deterministic tests for the three
  documented failure modes (region partitioned, coordinator crash + recovery,
  coordinator out across a window boundary). Δ = 0 holds across every outage shape;
  the federation fails *closed* under every partition.

- **Failure-modes documentation** (`docs/FAILURE-MODES.md`). New section detailing the
  four federation outage shapes with the recovery behavior and Δ bound for each. The
  optional `regional-only` mode for availability-over-precision is documented.

- **Wiki: new `Federation` page** + cross-links from `Home`, `Distributed-and-Provable`,
  and the sidebar. Full design + proofs + eval at
  `research/bigger-bets/federation/{DESIGN.md, RESULTS.md, baselines.md}`.

- **`examples/federation.ts`** — a runnable 3-region federation example against the
  TK-909 docker-compose; demonstrates `Δ = 0` and prints the recovery vs static
  partition.

- **`NotImplementedError`** — new error subclass of `ThrottleKitError` for placeholder
  code paths during incremental rollouts; exported from the root.

### Caveats + scope

- **`RedisCoordinator` SPOF.** A single global Redis IS a single point of failure for
  the federation's safety bound. Mitigations: Sentinel/Cluster under the Redis
  client (the Lua scripts work unchanged); `PostgresCoordinator` (0.9.x follow-up);
  Raft-via-etcd (1.0.x). Documented in `research/bigger-bets/federation/DESIGN.md` §4.4
  and the Federation wiki page.
- **In-process regional escrow.** At this commit federation holds per-process escrow
  in memory. Multi-process per-region (regional Redis backing the escrow) is a
  0.9.x follow-up; layer `twoTier(leased)` on top of `federate(...)` for an
  in-process L1 cache today.
- **Windowed strategies only.** `federate(...)` requires `strategy.windowMs` defined
  (`fixedWindow`, `slidingWindow`, `quota` with fixed cadence). Pure-rate strategies
  (`gcra`, `tokenBucket`) need the window for the window-coupling rule and aren't
  supported at this commit.
- **`regional-only` outage mode** is accepted on construction but currently collapses
  to `fail-closed`; the regional-Store fallback lands with the multi-process regional
  escrow in TK-906+.

### Changed

- `FederatedStoreOptions` now requires `strategy` and accepts `clock` — small refinement
  vs the TK-902 skeleton surface, with no real-world impact (no production users; the
  skeleton was published as part of 0.8.3).

## [0.8.2] — 2026-05-28

A small, focused follow-up release that lands the two non-blocking small bets the 0.8.1 CHANGELOG
flagged as deferred, plus the stale-number sweep that audit missed. Test count **747 → 769**
(768 pass + 1 skip with the gated Redis/Postgres suites enabled).

### Added

- **Property-based fuzzing of the Lua dual-path** (TK-826) — a new `test/conformance/lua-property.test.ts`
  uses fast-check to generate shrinkable `(start, [{deltaMs, cost}])` timelines and drives each of
  the 6 Lua-backed strategies (`gcra`, `tokenBucket`, `fixedWindow`, `slidingWindow`,
  `slidingWindowLog`, `quota`) through both the JS executor and the atomic Redis Lua executor,
  asserting bit-identical Decision streams. On any divergence fast-check shrinks to a minimal
  counterexample and prints it alongside the Redis key — a 1-line repro instead of a 900-step
  seeded log. **Complements (not replaces) the existing seeded grid:** the grid pins 18 specific
  cases × 40×25 deterministic timelines plus the post-timeline non-consuming peek; the property
  pass explores a much larger input space with shrinkable arbitraries focused on the consuming
  `check` path. Gated on `THROTTLEKIT_TEST_REDIS`.
- **`bench:gate` regression gate + CI integration** (TK-827) — a small in-process micro-benchmark
  (`bench/gate.ts`, three sync single-state strategies, best-of-N=10, ITERS=2M) that compares
  current ns/op to a committed `bench/baseline.json` and exits non-zero on any row that regresses
  beyond `BENCH_REGRESSION_THRESHOLD` (default 1.10). Two new scripts: `npm run bench:gate`
  (compare) and `npm run bench:baseline` (write a fresh baseline; commit alongside the change that
  intentionally moves the numbers). A new informational `bench-gate` job in CI surfaces the
  per-row delta table on every PR — initially with `continue-on-error: true` while we calibrate
  the threshold against shared-runner noise. Pure-function tests for the comparator + table
  formatter are in `test/bench/gate.test.ts`.

### Changed

- **Stale `~320 ns/op` figures swept** (TK-829, 0.8.1 audit follow-up) — the 0.8.1 audit moved the
  canonical `checkSync` figure to 186 ns/op in SCOREBOARD + the README Performance section, but
  three current-state claims still read `~320 ns/op`: the README hero, the README "Why ThrottleKit"
  bullet, and the package.json description (npm metadata). All three corrected. CHANGELOG.md's
  "up from the 320 ns/op the pre-audit numbers reported" line and JOURNEY.md's 2026-05-26 entry
  are chronological history and stay unchanged.

### Notes for operators

- The bench gate's `continue-on-error: true` is deliberate while we collect runner-variance data.
  Once we've confirmed <10% noise on `ubuntu-latest`, the flag will be removed and the gate becomes
  a hard fail. Locally `BENCH_REGRESSION_THRESHOLD=1.25 npm run bench:gate` widens the band; commit
  a refreshed `bench/baseline.json` whenever a perf change is intentional.
- Wall-clock-vs-simulated-clock note for the new property test: the strategies' Lua sets
  `PEXPIRE = resetAt - now` (a memory micro-optimization), which means a `ManualClock`-driven test
  that awaits a peek after the timeline can lose to wall-clock elapse while simulated time stays
  put. That race is purely a test artifact (in production wall clock IS the limiter clock, so an
  expired key after `resetAt` is indistinguishable from a fresh window — the correct outcome), so
  the property test deliberately scopes itself to per-step `check` equality and leaves peek/readState
  bit-identity to the seeded grid where the timing is bounded.

## [0.8.1] — 2026-05-28

A docs-and-DX release that lands the introspection / observability / config / CLI surface 0.8.0
left for follow-up — every public name added here is pinned by a test or conformance case so it
behaves as a contract, not a happy-path. Test count **609 → 747** (746 pass + 1 skip with the
gated Redis/Postgres suites enabled).

### Added

- **`quota()` billing-period strategy** (root export) — a budget that resets on a *real* calendar
  boundary, distinct from a sliding rate limit. Cadences: `calendar-month` / `-week` / `-day` (fixed
  UTC offset, leap-correct), `fixed` (anchor-aligned), and `rolling` (delegates to the proven
  `slidingWindow`). The calendar math is a dependency-free Hinnant civil-date helper **mirrored
  byte-for-byte in the atomic Redis Lua form** — proven bit-identical by 7 new dual-path conformance
  cases.
- **Non-consuming introspection: `Limiter.peek()` / `.peekSync()` / `.forecast()` /
  `.forecastSync()`** — the current `Decision` and a `{ spendableNow, nextReplenishAt, fullAt }`
  capacity projection, neither of which spends a unit. Implemented for every built-in strategy. On a
  Lua store the read uses each strategy's new read-only `readState` Lua (`GET` / `HMGET` / `HGETALL`
  / `ZRANGE`), never the consuming check script. The post-timeline-peek conformance check proves
  decode is bit-identical to the JS state for all six strategies.
- **NestJS `@RateLimit({ limit, period })` decorator** (`throttlekit/nest`) — the ergonomic
  per-route form, joining the existing `nestRateLimit` guard. Pair with one `createRateLimitGuard(...)`
  registered via `APP_GUARD`. Dependency-free — reads the ambient `reflect-metadata` NestJS already
  loads via `globalThis.Reflect`, never importing `@nestjs/common`.
- **Cloudflare `KVStore`** (`throttlekit/cloudflare`) — explicitly **best-effort**: Workers KV is
  eventually consistent with no atomic CAS, so it can over-admit under load and is intentionally not
  run through the atomic conformance suite. Carries loud caveats; use Durable Objects or D1 for an
  exact bound.
- **`tapDecisions(limiter, onDecision)`** (root export) — the lowest-level observability primitive: a
  dependency-free callback fired once per completed check with `{ key, cost, decision, strategy,
  durationMs, kind }`. A throwing tap can never break the limiter. `withAnalytics` and
  `instrumentLimiter` are higher-level consumers of the same idea.
- **Stable OpenTelemetry contract** (`throttlekit/otel`) — `METRIC_NAMES` and `SPAN_ATTRIBUTES` are
  exported `as const` and pinned by a contract test; renames now require a deliberate major bump,
  protecting downstream dashboards/alerts. Adds `recordDecisionOnSpan(span, decision, strategy,
  extra?)` for trace-level rate-limit visibility (search by `throttlekit.allowed=false`,
  dependency-free via a structural `SpanLike`).
- **`.throttlekit.yaml` rate-limit-as-code** — new `throttlekit/config` entry. `loadConfig(text,
  { store? })` returns ready-to-use named limiters; declare strategies and policies as data, inject
  the live `Store` at load time. Includes a small **zero-dep** YAML-subset parser (block maps,
  scalars, inline `{}`, `#` comments) so the loader preserves the project's zero-runtime-deps
  guarantee. JSON config auto-detected.
- **`throttlekit` CLI** (new `bin`) — `throttlekit benchmark` (in-process micro-bench across the
  three single-state strategies), `throttlekit doctor` (Node version + optional-peer detection +
  validates a local `.throttlekit.yaml`/`.json`), `throttlekit replay <log.jsonl>` (re-runs a
  JSON-lines decision log through a configured limiter and reports admit/deny + top denied keys).
  All commands take a pluggable `Output` so they're unit-tested without touching `process.stdout`.
- **`docs/FAILURE-MODES.md`** — a per-store outage/recovery matrix (Memory, Redis, Postgres,
  DynamoDB, D1, Deno KV, Durable Object) × twoTier modes; every cell cross-checked against the store
  code. Linked from the README and the wiki Operations page.
- **`docs/METRICS.md`** — the stable OTel metrics & span-attributes reference, including the
  Prometheus `.` → `_` mapping and the stability policy.
- **`grafana/throttlekit-dashboard.json`** — an importable Prometheus dashboard (check rate by
  outcome, deny rate, remaining-headroom and store-latency percentiles, adaptive-concurrency
  gauges), built on `METRIC_NAMES` with `$datasource` and `$strategy` template variables.

### Changed

- **Refreshed reproducible benchmark numbers** in `SCOREBOARD.md` and the README Performance
  section — `checkSync` (GCRA) now **186 ns/op (5.37M ops/s)** post-audit, up from the 320 ns/op
  the pre-audit numbers reported. Methodology, exact machine spec, dates, the Docker-on-Windows
  network caveat, and every place ThrottleKit *loses* are spelled out.
- **Migration guides** (wiki Migrating page) expanded to full mapping tables for
  `express-rate-limit`, `rate-limiter-flexible`, and the new `@upstash/ratelimit`, plus a peek/quota
  recipes addendum.
- **Wrapper introspection forwarding (regression fix).** Adding `peek`/`forecast`/`close` to
  `Limiter` in this release would have silently dropped them through the existing `withAnalytics`
  and `instrumentLimiter` wrappers; a new shared `forwardIntrospection()` helper threads them
  through all three wrappers (including the new `tapDecisions`), guarded by a test.
- **`parseDuration`** (`"30s"` / `"1m"` / `"1h"` / `"1d"` / ms) lifted to `src/core/duration.ts` —
  shared by the NestJS decorator and the config loader.

### Notes

- Workers KV is now offered as `KVStore` only as an **explicitly best-effort** option (not run
  through the conformance suite). The exact stores on Cloudflare are still Durable Objects and D1.
- The OpenTelemetry layer (`throttlekit/otel`) stays type-only on `@opentelemetry/api`; the new
  `recordDecisionOnSpan` is dependency-free via a structural `SpanLike`.
- Two non-blocking small-bet tasks are deferred to 0.8.2: continuous-bench CI regression gate, and
  property-based fuzzing of the Lua dual-path. The three GALE/TALE-adjacent research bigger bets
  remain research-track.

## [0.8.0] — 2026-05-28

Full-reach release: four new exact backends, seven new framework/transport bindings, a fleet-shared
token budget, a transport-agnostic enforcement core, and a security/robustness/performance hardening
pass from a multi-agent code audit. Every new store passes the shared conformance suite (including a
200-way concurrent read-modify-write); test count **490 → 609**.

### Added

- **Cloudflare stores** (`throttlekit/cloudflare`): **`DurableObjectStore`** runs the limiter's pure
  transform inside `blockConcurrencyWhile`, so the read-modify-write is atomic with **no retry loop**;
  **`D1Store`** backs edge SQLite with optimistic concurrency (a version compare-and-set) plus
  in-process per-key coalescing and a `sweep()` for Cron Triggers. (Workers KV is intentionally *not*
  offered — it can't honor the atomic `Store` contract.)
- **`DynamoStore`** (`throttlekit/dynamodb`) — DynamoDB via a conditional-write CAS on a `version`
  attribute, with `expires_at` in epoch seconds so native TTL reclaims items. Zero-dep structural
  client whose inputs mirror the AWS SDK v3 commands.
- **`DenoKvStore`** (`throttlekit/deno`) — Deno KV via its native atomic `versionstamp` CAS and native
  `expireIn` TTL; lazy expiry on the injected clock keeps decisions deterministic.
- **`distributedTokenBudget`** — the fleet-shared, `Store`-backed sibling of `tokenBudget`: the same
  stop-at-boundary debit run as an atomic RMW, so one budget `L` holds across every gateway with a
  per-token overshoot of **0 independent of fleet size** (the `B=1` GALE window-coupled instantiation).
  Carries a Lua form for single-round-trip Redis.
- **`createEnforcer`** — a transport-agnostic enforcement core (root export): turns a key into a
  verdict + standards headers with the fail policy folded in, for any transport.
- **Framework & transport adapters** — **NestJS** (`/nest`, a `CanActivate` guard), **AWS Lambda /
  API Gateway** (`/lambda`, REST v1 + HTTP v2), **gRPC** (`/grpc`, unary interceptor →
  `RESOURCE_EXHAUSTED`), **tRPC** (`/trpc`, ctx-keyed middleware), **SvelteKit** (`/sveltekit`, a
  `handle` hook), **Remix** (`/remix`, a loader/action guard that throws a `Response`), and **Elysia**
  (`/elysia`, an `onBeforeHandle` hook). All dependency-free via structural/Web-standard types.

### Changed

- **Performance (hot path):** `slidingWindow` is now backed by a fixed ring buffer (no per-check object
  rebuild); `slidingWindowLog` denies allocation-free; `checkSync` reads the clock once and reuses one
  transform with no per-call closure; `MemoryStore` folds expiry into the entry and mutates timing-wheel
  entries in place; `twoTier` collapses its per-key state into one record. (audit TK-P01..P07)
- **Security:** edge adapters no longer trust `x-forwarded-for` unless a proxy chain is configured, and
  `cf-connecting-ip` trust is opt-out via `trustClientIpHeader` (audit TK-S01); structured rate-limit
  header values are sanitized against CRLF/control-character injection (audit TK-S03).
- **Robustness:** `leakyBucket.schedule()` chunks sleeps past `setTimeout`'s 32-bit ceiling (audit
  TK-R05); `Limiter.close()` releases owned timers and the `twoTier` idle timer (audit TK-R02);
  `twoTier` coalesces in-flight on-demand leases (audit TK-R01); Lua `PEXPIRE` is clamped `≥ 1` (audit
  TK-R03); `sketchRateLimit` requires an integer cost (audit TK-R04); the per-window fairness maps are
  documented as bounded by distinct tenants (audit TK-R07).
- Validation/cleanup: shared `requireCost`/`clamp`/`prefixer` helpers across the core (audit TK-Q01..Q06).

### Breaking

- **Custom `Strategy` authors only:** `Strategy.check` now returns its decision under **`result`**
  (was `decision`), unifying `StrategyOutcome<S>` as a type alias of `ApplyOutcome<S, Decision>` so the
  limiter passes a strategy's output to the store with no per-check re-wrap (audit TK-P01). **Built-in
  strategies and all public APIs are unaffected** — only code that implemented a custom `Strategy` and
  read `outcome.decision` must rename it to `outcome.result`.

### Notes

- Two audit trade-offs were evaluated and **deliberately declined** as net-negative: forcing the
  synchronous in-process meters' `reset()` to return `Promise<void>` (TK-Q07 — sync state deserves a
  sync API; the store-backed `distributedTokenBudget` is correctly async), and renaming the
  `throttlekit/otel` entry (TK-Q08 — the export-map convention is already uniform and a rename would
  only break importers).

## [0.7.0] — 2026-05-27

The learned/predictive layers of both research tracks ship as first-class primitives. Each is a
faithful port of its proven research kernel and is **cross-checked byte-identically** against that
kernel over many seeds, so the shipped code inherits the kernel's guarantees and any future drift
turns CI red. No existing behaviour changes — these are additive.

### Added

- **`learnedReservation`** (+ **`criticalFractile`**) — online learned token *reservation* (the
  shipped **TALE Layer 2**). The streaming `tokenBudget` meter bounds overshoot for any reservation,
  but admission still needs a reservation committed *before* a request's cost is known; this learns it
  with projected online gradient descent on the asymmetric newsvendor / pinball loss, descending onto
  the critical-fractile quantile `τ = overrunCost/(holdCost+overrunCost)` with **`O(√T)` regret**
  versus the best fixed reservation. Safety stays the meter's job — the learner only governs the
  false-reject ⇆ abort trade-off. Pure, deterministic, no clock.
- **`predictiveReservation`** — learning-augmented reservation (the shipped **TALE Layer 3**): blend a
  per-request output-length *prediction* against `learnedReservation` via a Hedge meta-learner.
  Accurate predictions drive cost to the clairvoyant optimum (**consistency**); adversarial ones fall
  back to the no-regret quantile (**robustness**); and safety is untouched — the prediction is just a
  number the meter caps, so no prediction can breach the budget (predictions-with-safety on the cost
  axis).
- **`leaseSizer`** (+ **`eoqOptimum`**) — adaptive lease sizing for `twoTier` leased mode (the shipped
  **GALE Pillar 2**): an online learner for the L2 lease `batch` that minimises the EOQ
  coordination-vs-stranding cost via AdaGrad in log-space, with **`O(√T)` regret** versus the best
  fixed batch. Standalone for now (feed `size()` into `lease.batch`); safety stays Pillar 1's — under
  `lease.windowCoupled` the overshoot is exactly `Limit` *independent of the batch*, so adaptive
  sizing can never loosen the proven bound.
- **`predictiveLeaseSizer`** — learning-augmented lease sizing (the shipped **GALE Pillar 3**): the
  prediction-augmented sibling of `leaseSizer`, with the same consistency / robustness / unconditional
  safety triad via Hedge over {follow-prediction, robust learner}.

### Documentation

- README, SCOREBOARD, and the GitHub Wiki updated: the GALE Pillars 2/3 and TALE Layers 2/3 are now
  marked **shipped** (`leaseSizer` / `predictiveLeaseSizer`, `learnedReservation` /
  `predictiveReservation`), not just researched. Test count 460 → 490.

## [0.6.1] — 2026-05-27

### Documentation

- README updated to record the now-**proved** dynamic `≤C`-message trilemma bound
  `Δ + N·U ≥ (N−1)(L − C·B)` (tight at unit batch `B=1`), completing the trilemma's coordination axis
  alongside the static-partition interpolation.

### Research

- The dynamic `≤C`-message trilemma bound is proven (single-hot-node adversary) and machine-checked
  (`test/gale/dynamic-coordination.ts` — exhaustive solver + 6 gated checks), with the closed form for
  *batched* leasing (`B>1, C≥2`, an online-stranding lower bound) left as the one open piece. Gated
  under `research/`/`test/`; **no change to the published package code** — this is a docs release.

## [0.6.0] — 2026-05-27

### Added

- **`tokenBudget`** — a streaming token-budget meter for *post-hoc* costs (the LLM-gateway problem:
  a completion's output-token cost is known only as it streams). Debit the actual tokens as they are
  produced; a debit is admitted iff budget remains *before* it, so worst-case overshoot is bounded by
  the debit granularity — **exactly 0 per token**, `≤ g−1` at chunk size `g` — **independent of the
  per-request cap (`max_tokens`)** and of how many streams meter concurrently (only the single
  crossing debit can exceed the budget). This dominates the two production corners at once: it has
  reserve-`max_tokens`'s safety (no overshoot per token) at admit-then-count's utilization (`~1`),
  with no dependence on the cap. The shipped piece of the **TALE** research track's Layer 1
  (`research/cost-uncertainty/`); its overshoot is cross-checked byte-for-byte against the research
  streaming kernel over 200 randomized property runs. Same epoch-aligned window, `Decision` contract,
  and injected `Clock` as the other `admission` primitives; lives beside `fairShare` /
  `weightedFairShare`.

### Fixed

- The exported `version` constant was stale at `0.3.0`; synced to the package version.

### Documentation

- README **rebranded** around provability ("rate limiting you can prove") and trimmed from ~220 to
  ~110 lines — leading with the machine-checked, fleet-size-independent overshoot bound, with the full
  guides remaining in the GitHub Wiki. npm description refreshed to match; added an `llm` keyword.

### Research

- Research tracks advanced (gated under `research/`, **not** part of the published package): the
  `0<C<N` trilemma partial-coordination interpolation (`research/gale/TRILEMMA.md`), the L2/L3
  regret/consistency analysis with explicit constants (`research/cost-uncertainty/REGRET-ANALYSIS.md`),
  and a discrete-event distributed simulator confirming the Pillar-1 overshoot bound holds for N→512
  under lease latency and partitions (`research/gale/DISTRIBUTED-SIM-EVAL.md`).

## [0.5.1] — 2026-05-26

### Documentation

- README rewritten leaner (~600 → ~220 lines), leading with the differentiators — the
  formally-verified, fleet-size-independent overshoot bound; one transform across every backend,
  proven bit-identical; the synchronous API; and the GALE/TALE research tracks. The per-feature
  walkthroughs moved to a new GitHub **Wiki** (Getting Started, Strategies, Frameworks & the Edge,
  Distributed & Provable, Advanced Limiting, Overload/Fairness/DDoS, Operations, Performance,
  Migrating, Research). Corrected the stale test count in the README (389 → 430).
- Package description refreshed to match the README — leads with the proven, fleet-size-independent
  overshoot bound and the single-transform in-memory/Redis/Postgres story.

## [0.5.0] — 2026-05-26

### Added

- **Weighted Fair Escrow** (`weightedMaxMin`, `weightedFairShare`, `guaranteedShare`) — weighted
  fairness for a contended budget, the weighted siblings of `fairShare`. `weightedMaxMin(demands,
  weights, limit)` is the exact integer **weighted max-min fair allocation**: work-conserving (sums to
  `min(Σ demand, limit)` — an idle tenant's share flows to the backlogged ones) and weight-honoring
  (every backlogged tenant reaches a common weighted service level and gets at least its guaranteed
  floor `⌊w_i/W·limit⌋`); equal weights reduce to ordinary max-min. Computed as continuous
  water-filling (`O(n log n)`) plus a bounded integer drip of the `< n`-credit remainder, so it stays
  fast for large limits. Its four properties (safety / weighted-floor / work-conservation / bounded
  unfairness) are machine-checked on random instances. `weightedFairShare({limit, windowMs, weightOf})`
  is the online streaming limiter — `fairShare` with per-tenant caps proportional to weight, same
  honest online caveats. This is the shipped piece of the GALE research track's Pillar 4
  (`research/gale/PILLAR4-fairness.md`); use `weightedMaxMin` to split, e.g., a `twoTier` node's leased
  batch among its local tenants.

### Changed

- CI/release workflows bumped to `actions/checkout@v5` + `actions/setup-node@v5` (Node 24 runtime;
  Node 20 actions are being retired from GitHub-hosted runners).

## [0.4.1] — 2026-05-26

_Supersedes 0.4.0, which was tagged but never published — a GitHub Actions outage blocked its release._

### Added

- **Window-coupled leasing** (`lease.windowCoupled`, opt-in on `twoTier` `leased` mode) — expires a
  node's leased credits when the shared L2 window that granted them rolls over, instead of carrying
  them into the next window. This makes worst-case global overshoot exactly **`Limit`**, *independent
  of the number of nodes*, versus the carryover bound `Limit + N·(Batch−1)`. Default off (existing
  behaviour preserved). Machine-checked (TLA⁺ spec + exhaustive checker). It is the shipped piece of
  the GALE research track (`research/gale/`); see SCOREBOARD “Research track”.

### Documentation

- README rewritten to lead with the provable distributed-leasing story (the window-coupled overshoot
  bound + the GALE research track) and trimmed ~13%.

## [0.3.0] — 2026-05-26

### Added

- **PostgreSQL store** (`throttlekit/postgres`): a fully distributed backend for teams already running
  Postgres — no Redis required. `PostgresStore` runs the **same pure JS transform** as the in-memory
  store (no Postgres-specific algorithm to keep in sync) inside a transaction serialized per key by a
  transaction-scoped advisory lock (`pg_advisory_xact_lock` — which, unlike `SELECT … FOR UPDATE`,
  also serializes first-touch keys). Concurrent checks are atomic (**N simultaneous checks at limit K
  admit exactly K**, proven against a live server) and decisions are bit-identical to the in-memory
  and Redis paths (state stored as JSON text, round-tripping the exact IEEE-754 double). State expiry
  is clock-driven with lazy reads + a background sweep; safe because every built-in strategy is
  idempotent w.r.t. stale state. Pass a `pg.Pool` directly — no adapter. `pg` is an optional peer.
- **Batch checks** — `limiter.checkMany(keys, cost?)` and `limiter.checkManySync(keys, cost?)` check
  many independent keys in one call, each evaluated at a **single consistent timestamp** and returned
  in input order. On a synchronous store the checks run in an ordered loop with no per-key promise
  overhead; on an async store (e.g. Redis) they fire concurrently — a single round trip on clients
  that pipeline same-tick commands (node-redis, or `ioredis` with `enableAutoPipelining`). Decisions
  are identical to per-key `check`. Available on every limiter, including `twoTier` and the
  `withAnalytics` / OpenTelemetry wrappers (batch checks are counted/instrumented too).
- **Mergeable sketch** (`mergeableSketch`, `sketchSnapshotFromBytes`) — a Count-Min Sketch for
  **cluster-wide** heavy-hitter detection in fixed memory. Each node sketches its own traffic and
  ships a compact snapshot (`snapshot()` / `toBytes()`); because CMS counters are linear, merging
  them (`merge()`) is **exact** — counter-for-counter identical to one sketch over the union of all
  streams — so a low-and-slow distributed attacker invisible per node is caught cluster-wide. Never
  underestimates. Honestly scoped as eventually-consistent *detection* / best-effort shedding, not a
  strongly-consistent global limit (use Redis/Postgres or `twoTier` for that).

### Documentation

- **Multi-region guidance.** Documented that a global limit across regions is `twoTier` leased mode
  with the regions as leasing nodes and one shared L2 — region-local latency, with the
  formally-verified bound capping worldwide overshoot at `Limit + regions × (batch − 1)` (no separate
  multi-region engine to trust). New `examples/multi-region.ts` demonstrates it (~50 requests served
  per cross-region hop in the default scenario).

## [0.2.0] — 2026-05-26

### Added

- **`sketchRateLimit`** — a Count-Min Sketch limiter that caps an **unbounded key universe in fixed
  memory** (~7.4 KB at the defaults, independent of key count) for huge-cardinality / DDoS shedding.
  Provably **never over-admits** (check-before-add over a never-underestimating sketch); its only
  error is bounded early denial (`ε·N` w.p. `≥ 1−δ`). Pure JS, sync + async.
- **`withAnalytics`** — zero-config, dependency-free traffic insight: wrap any limiter to get
  allow/deny counts and bounded-memory **top-K heavy hitters** (Space-Saving), queryable in-process
  via `analytics()` without an OpenTelemetry backend.
- **Admission control** (`adaptiveThrottle`, `fairShare`): Google-SRE client-side adaptive
  load-shedding (sheds locally based on the backend's accept rate, with priority), and an online
  equal-share fairness splitter so one tenant can't starve a shared global budget.
- **Redis client adapters** (`throttlekit/redis`): `fromNodeRedis`, `fromUpstash`, and `fromIoredis`.
  `RedisStore` now works with the official **node-redis** client and the **Upstash REST** client
  (Cloudflare Workers, Vercel, Deno, Bun — anywhere TCP isn't allowed), not just `ioredis`. Every
  built-in strategy's atomic Lua runs identically across all three; the node-redis path is proven
  bit-identical to the JS path against a live server. (Upstash REST is Lua-only — no `WATCH`/`MULTI`.)
- **Framework adapters** on a shared core, each its own subpath: `throttlekit/hono` (`honoRateLimit`),
  `throttlekit/next` (`nextRateLimit`, dependency-free), `throttlekit/fastify` (`fastifyRateLimit`),
  and `throttlekit/koa` (`koaRateLimit`). Hono/Fastify/Koa are optional peers.
- A **comparative benchmark** (`npm run bench:compare`) measuring ThrottleKit against
  `rate-limiter-flexible` and `express-rate-limit` on one fair harness (memory + Redis tiers).
- **Formal verification** of the leased two-tier overshoot bound: a TLA+ spec
  (`spec/DistributedLeasing.tla`) model-checked with TLC, plus a Java-free exhaustive checker that
  reproduces it in CI. Proves `admitted_per_window ≤ Limit + N·(Batch−1)` (tight; implies the
  documented `≤ L×batch`). See `docs/FORMAL-MODEL.md`.

### Changed

- **Faster async `check()`** on synchronous stores (e.g. `MemoryStore`): it now runs the transition
  inline and hands back a resolved promise, skipping the async store frame and the per-call
  transform closure. Measured ~2.7× faster (596.9k → ~1.64M ops/s in memory, single hot key);
  `checkSync` remains allocation-free at ~3.2M ops/s. The async path is unchanged for genuinely
  async stores (Redis). No observable behavior change.
- **Leaner package:** the published tarball no longer ships sourcemaps (~2.0 MB → ~600 KB unpacked,
  72 → 52 files). Compiled code and `.d.ts` types are unchanged.

## [0.1.0] — 2026-05-26

Initial release — a pluggable, framework-agnostic rate-limiting toolkit for Node and the web.

### Algorithms

- **GCRA** (`gcra`, default) — single-timestamp pacing with a configurable burst.
- **Token bucket** (`tokenBucket`) — explicit token count, lazy refill.
- **Fixed window** (`fixedWindow`) — cheapest coarse cap (documented 2× boundary).
- **Sliding window counter** (`slidingWindow`) — sub-bucketed, near-exact, bounded O(buckets) memory.
- **Sliding window log** (`slidingWindowLog`) — exact "N in the trailing window".
- **Leaky bucket** (`leakyBucket`) — a traffic `Shaper` that delays rather than rejects
  (`reserve` / `reserveSync` / `schedule`, with `QueueFullError`).
- **Adaptive concurrency** (`adaptiveConcurrency`) — Netflix-style Gradient2 + AIMD backpressure.

Every pass/deny strategy ships a pure JS transition **and** an atomic Redis Lua form, proven
bit-identical by a dual-path conformance suite.

### Engine & stores

- `rateLimit` limiter with `check` / `checkSync` / `reset`, injectable clock, and key prefixing.
- One storage primitive — `Store.apply(key, transform)`.
- `MemoryStore` — lock-free synchronous RMW, hierarchical timing-wheel expiry, CLOCK
  (second-chance) approximate-LRU eviction.
- `RedisStore` (`throttlekit/redis`) — single `EVALSHA` round trip (with `EVAL`/`NOSCRIPT`
  fallback), optimistic-concurrency fallback for custom strategies, server-clock time source.
- `twoTier` — L1/L2 engine with `strict`, `cached-deny`, and `leased` modes (bounded `L × batch`
  overshoot, low-water async refill).
- `multiRateLimit` with `all` / `any` — multi-dimensional limits in a single fused Lua round trip,
  with no partial-consume.

### Adapters, headers & security

- Express middleware (`throttlekit/express`) and Web `fetch`/edge wrapper (`throttlekit/fetch`),
  with `fail` open/closed, `onLimited`/`onError` hooks, and custom 429 handlers.
- `buildRateLimitHeaders` — IETF draft triple, RFC 9651 structured `RateLimit`/`RateLimit-Policy`,
  legacy `X-RateLimit-*`, and `Retry-After`.
- `clientIp` — proxy-correct client IP with explicit trusted-proxy policy (default-deny `XFF`, hop
  count, or CIDR allowlist) and IPv6 `/64` aggregation; `hashKey` / `hmacKeyer` for PII-safe keys.

### Observability & testing

- Optional OpenTelemetry instrumentation (`throttlekit/otel`): `instrumentLimiter` /
  `instrumentGuard`.
- Framework-agnostic store conformance kit (`throttlekit/testkit`): `runStoreConformance`.
- Deterministic `ManualClock`; benchmark harness (`npm run bench`).

### Tooling

- TypeScript-first, strict; dual ESM + CJS builds with types across six subpaths.
- Tested with Vitest (unit, boundary, property via fast-check, dual-path conformance, and
  exactly-K concurrency/atomicity on memory and Redis); CI on Node 20/22/24 with a Redis service.

[Unreleased]: https://github.com/AmeyaBorkar/throttlekit/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/AmeyaBorkar/throttlekit/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/AmeyaBorkar/throttlekit/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/AmeyaBorkar/throttlekit/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/AmeyaBorkar/throttlekit/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/AmeyaBorkar/throttlekit/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/AmeyaBorkar/throttlekit/compare/v0.3.0...v0.4.1
[0.3.0]: https://github.com/AmeyaBorkar/throttlekit/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/AmeyaBorkar/throttlekit/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/AmeyaBorkar/throttlekit/releases/tag/v0.1.0
