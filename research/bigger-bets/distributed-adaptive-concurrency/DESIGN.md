# Distributed adaptive concurrency — DESIGN (0.10.0)

> Status: **design lock** (TK-1314). Implementation is TK-1315..TK-1318.
> This doc is prescriptive: every signature, algorithm, invariant, test, and
> commit shape below is fixed. Implementers follow it literally — open
> questions are confined to §14.
>
> Decision records: **D-DAC-1 .. D-DAC-17** in §13.

---

## 0. Why this doc exists

`adaptiveConcurrency()` (pre-0.8.x) infers a concurrency ceiling **per
process** from locally observed RTT. The moment N processes front a *shared*
backend (one inference cluster, one database pool, one upstream API), N
independent adaptive limiters each infer a ceiling for the *whole* backend and
collectively admit up to `Σ Lᵢ` — N× the backend's true capacity. The adaptive
limiter that was supposed to *prevent* overload now *causes* it under fan-out.

0.10.0 closes that gap with `distributedAdaptiveConcurrency()`: a drop-in
`ConcurrencyGuard` (so every 0.9.2 adapter — `expressAdaptiveConcurrency`,
`fastifyAdaptiveConcurrency`, … — picks it up unchanged, per D-M-12) that keeps
the fleet's total in-flight count under one cooperatively-inferred global
ceiling.

The release is **minor** (`0.9.2 → 0.10.0`): purely additive surface, no change
to `adaptiveConcurrency`, `federate`, `unifiedAdmission`, or any existing
adapter.

---

## 1. Problem statement

### 1.1 The fan-out overshoot

Single backend of true capacity `C` (time-varying, unknown). `N` gateway nodes,
each running its own `adaptiveConcurrency`. Each node observes RTT that reflects
the **total** load on the shared backend (the backend is slow for *everyone* at
once), so each independently infers `Lᵢ ≈ C`. Each then admits up to `Lᵢ`
concurrent requests ⇒ the backend sees `Σ Lᵢ ≈ N·C`. Overshoot factor N. As the
backend buckles, every node's RTT climbs together, every node backs off
together, and the fleet oscillates in lockstep (synchronized AIMD collapse).

### 1.2 What we need

The coordinator must **never commit more concurrency than the global budget**.
That is the hard safety invariant, stated over the shares the coordinator has
actually granted (the *committed* budget), holding for **any** interleaving of
staggered per-node heartbeats while `L_global` is constant:

```
GlobalCap :  Σ_{n live} share[n]  ≤  L_global          (HARD invariant)
```

where `L_global` tracks the backend's true capacity `C` and is **inferred from
the fleet's aggregate RTT signal**, not configured by hand. The gate must:

- keep `acquire()` **synchronous** (the `ConcurrencyGuard` contract; a
  concurrency gate must never block on the network — shedding is the right move
  when you are out of slots, per D-DAC-4);
- degrade safely when the coordinator is unreachable (D-DAC-11);
- reclaim a dead node's share automatically (D-DAC-7);
- impose **one** coordination round-trip per heartbeat, not per request
  (D-DAC-3);
- hold `GlobalCap` across **membership growth** — a node joining must not let
  the committed budget exceed `L_global`, even with `L_global` held constant
  (D-DAC-17; see §6).

> **`GlobalCap` is the invariant; `Σ inflight ≤ L_global` is NOT.** The thing the
> coordinator can guarantee unconditionally is that the *granted shares* never
> sum above `L_global` — because every grant is **capped** at the budget not
> already committed to other live nodes (§6, D-DAC-17). `GlobalCap` therefore
> holds after every heartbeat under any staggering, and it is the property the
> earlier (stateless equal-split) bug violated.
>
> The instantaneous `Σ_n inflight[n] ≤ L_global` is a **bounded drain-lag**
> consequence, **not** a hard invariant, and the doc does not claim it. In-flight
> requests are non-revocable: during a rebalance (a peer joins and ramps while an
> over-provisioned node drains, or `L_global` shrinks under a node) `Σ inflight`
> can transiently exceed `L_global`, draining monotonically back. That convergence
> is the **liveness** property of §9.3 / D-DAC-14, further clamped in practice by
> the guard's `min(share, local.limit)` gate (D-DAC-6). Treating it as safety
> would be dishonest — you cannot un-admit a running request.
>
> **The bound is two-sided in `nodeId` membership.** Shrink-drain (a node
> *leaving* or `L_global` *dropping*) and a node *joining* are duals, and the
> **budget cap** (§6, D-DAC-17) handles both with one mechanism. Without the cap,
> stateless equal-split is unsafe: because each node fetches its share
> independently, at a different time, from a different live-set snapshot, a naive
> coordinator would grant a fresh joiner a positive share *before* the incumbents
> re-split down on their next heartbeat, so for up to one heartbeat
> `Σ granted shares > L_global` with `L_global` never having decreased (worst case
> `(N−1)/N · L_global` overshoot — e.g. 1 incumbent at share 6 + 1 joiner at
> share 3 ⇒ Σ = 9 > L_global = 6, a 1.5× overshoot). §0/§1.1 promise "keeps the
> fleet total under one global ceiling"; a steady-state over-*commit* on every
> scale-up event would break exactly that promise. §6 (D-DAC-17) closes it by
> **capping** each grant at `L_global − Σ(other live shares)`: a joining node
> computes `min(target, L_global − L_global) = 0` until incumbents re-heartbeat
> down, so `GlobalCap` is preserved at every step. The cap is robust even if the
> joiner heartbeats *twice* before any incumbent re-splits — its second grant is
> still capped at the unallocated remainder — which is exactly the case a one-shot
> "provisional join" rule (share 0 for one heartbeat only) failed to cover.

### 1.3 Non-goals (0.10.0)

- Demand-proportional allocation under skew (v1 is equal-split; see §6, §14.1).
- A Postgres concurrency coordinator (Test + Redis ship; Postgres is §14.2).
- Distributing the *rate* or *cost* axes (those are federation's job, 0.8.3+).
- Online `L_global` smoothing beyond the per-node `adaptiveConcurrency` EMA.

---

## 2. Literature synthesis

- **Netflix `concurrency-limits`** (Gradient2, the substrate of our
  `adaptiveConcurrency`): per-node TCP-congestion-style limit inference from
  RTT. Explicitly *per-node*; the project's own docs note the fan-out problem
  but leave fleet coordination to the operator. We close exactly that.
- **Google SRE, "Handling Overload" / adaptive throttling**: client-side
  rejection probability from a local accept/throttle ratio — *uncoordinated*,
  tolerates fleet overshoot by design. We provide the coordinated alternative.
- **Lease-based distributed semaphores** (Chubby/ZooKeeper-style): a slot is a
  lease with a TTL; the holder renews; a crashed holder's lease expires and the
  slot returns. This is the **event-release** dual of federation's
  **clock-release** window escrow — the heart of D-DAC-1.
- **TCP congestion control as distributed resource sharing**: many flows share
  one bottleneck; each adapts from local RTT; fairness emerges from a shared
  signal. Our `aggregate` step makes that sharing explicit instead of emergent.
- **`research/bigger-bets/federation/DESIGN.md`** (0.8.3, GALE): window-coupled
  leasing with the K-independent `Δ = 0` bound. We reuse its proof skeleton by
  relabeling `windowMs → heartbeat_T` (§9).

---

## 3. The DR-18 reduction, made precise

PLAN.md §6.7 (DR-18): *"a concurrent slot is a leased token released by **event**
(request completion), not by **clock**."* That makes distributed adaptive
concurrency a **composition** of two already-shipped ideas. We make the
composition precise by splitting it into two orthogonal mechanisms:

> **Mechanism 1 — Capacity estimation.** *"How big is the shared backend right
> now?"* Each node reports its locally-inferred `L_local` (straight from a
> private `adaptiveConcurrency` fed by that node's RTTs). The coordinator folds
> all live reports into `L_global = aggregate({L_local})`. **This is new** —
> federation's `Limit` is a static config; here the budget is itself estimated.

> **Mechanism 2 — Capacity allocation.** *"Which node may admit a request?"*
> `L_global` is divided into per-node **shares**; a node admits while its local
> in-flight count is below its share. **This is federation**, relabeled: the
> share is the escrow, the heartbeat boundary is the window `Roll`. The hard
> invariant `GlobalCap : Σ shares ≤ L_global` holds *across membership changes*
> because each grant is **budget-capped** (§6 / D-DAC-17): a heartbeating node is
> never granted more than `L_global − Σ(other live shares)`, the budget not
> already committed to its peers. A node joining therefore computes
> `min(target, L_global − L_global) = 0` until the incumbents re-heartbeat down,
> so the committed sum never momentarily exceeds `L_global` while incumbents are
> still re-splitting. The cap holds the bound even if the joiner heartbeats
> repeatedly before any incumbent re-splits — each grant is re-capped at the
> current remainder. (`GlobalCap` ⇒ `Σ inflight ≤ L_global` only at the steady
> state where in-flight has fully ramped to the granted shares; the transient
> drain-lag is liveness, §9.3.)

The two run at different tempos:

```
 fast loop  (synchronous, in-process, per request)
   acquire()/release()  ──gate on──▶  min(share, L_local)
                                          ▲          │ RTT feeds
   the ConcurrencyGuard contract lives here          ▼
 slow loop  (async, background, every heartbeat_T)
   report L_local + inflight ──▶ coordinator ──▶ aggregate ──▶ cap(equal-split) ──▶ new share
```

The safety proof (§9) is **only about Mechanism 2's `GlobalCap` with `L_global`
held constant within a heartbeat epoch**. Mechanism 1 re-aggregates `L_global` at
heartbeat boundaries — exactly as the window budget resets at each window
boundary in federation. The `windowMs → heartbeat_T` relabeling is therefore
literal: **the heartbeat epoch is the federation window** (D-DAC-2).

---

## 4. Architecture

### 4.1 A dedicated primitive (D-DAC-1)

`distributedAdaptiveConcurrency()` is a **new primitive** in
`src/concurrency/distributed.ts`. It does **not** extend `federate()` (which PLAN
§6.7 floated) because:

1. `federate()` returns a `Limiter` (windowed-rate `check() → Decision`).
   Concurrency needs the `ConcurrencyGuard` (`acquire() → Lease`, event-release)
   contract — the exact seam the 0.9.2 adapters accept (D-M-12). Forcing
   event-release through a `Limiter` would either break the adapter contract or
   leak a windowed API onto an instantaneous concept.
2. The coordinator semantics differ (heartbeat/aggregate vs window/reconcile);
   reusing `GlobalCoordinator` would overload `lease()` with a second meaning.
3. `federate()`'s proven invariants stay untouched.

So we add a sibling, not an overload. (See D-DAC-1 for the recorded trade-off.)

### 4.2 The guard is a thin wrapper around a private `adaptiveConcurrency` (D-DAC-5)

The single most important implementation decision: **the distributed guard
delegates acquire/release to a private in-process `adaptiveConcurrency`
instance**, and only *tightens the gate* by the coordinator-supplied `share`.

```
distributedAdaptiveConcurrency
   ├── local: ConcurrencyGuard = adaptiveConcurrency(options.local)   // owns RTT, L_local, inflight
   ├── share, lGlobal, nodes  ← refreshed by the background heartbeat
   └── acquire(): gate on min(share, local.limit); on pass, return local.acquire()
```

Why this is correct and trivial:

- The effective ceiling is `min(share, local.limit)`. Both terms are `≤
  local.limit`, so whenever the outer gate admits, `local.inflight <
  local.limit` holds and `local.acquire()` is **guaranteed** to return `ok:
  true`. (Proof: outer gate passes ⇒ `local.inflight < min(share, local.limit)
  ≤ local.limit`.)
- RTT timing, the windowed no-load minimum, Gradient2/AIMD adaptation, and
  **release idempotency** are all inherited from `local` for free — zero new
  estimator code, zero new idempotency logic.
- `min(share, …)` only ever *lowers* the ceiling below `share`, so it can never
  violate `inflight ≤ share`. It also gives **fast local reaction**: if this
  node's RTT spikes, `local.limit` drops within one request and the node sheds
  immediately, without waiting for the next heartbeat (D-DAC-6).

The guard's *only* new state is `share` / `lGlobal` / `nodes` (last heartbeat)
and the timer handle.

---

## 5. API surface (locked)

### 5.1 The coordinator interface — `src/concurrency/coordinator.ts` (NEW)

```ts
/** One node's heartbeat report to the {@link ConcurrencyCoordinator}. */
export interface ConcurrencyReport {
  /** Logical shared-backend key. Nodes sharing a backend MUST use the same key. */
  key: string;
  /** Unique-per-process node identity. */
  nodeId: string;
  /** This node's locally-inferred ceiling (its private adaptiveConcurrency `limit`). */
  lLocal: number;
  /** This node's current in-flight count (the demand signal; reserved for future
   *  demand-proportional allocation — equal-split ignores it in 0.10.0). */
  inflight: number;
  /** Lease expiry, epoch-ms. The coordinator MUST treat any node with
   *  `expiresAt < now` as departed and reclaim its share. */
  expiresAt: number;
}

/** The coordinator's grant back to one node for the next heartbeat window. */
export interface ConcurrencyGrant {
  /** This node's allocated ceiling. `acquire()` admits while `inflight < share`.
   *  The grant is the equal-split target CAPPED at the budget not currently
   *  committed to other live nodes: `max(0, min(target, lGlobal − Σ other live
   *  shares))` (§6 / D-DAC-17). A node that is new to the fleet naturally
   *  receives `share = 0` — the incumbents still hold the whole budget, so the
   *  cap leaves nothing — and earns its `≈ lGlobal/N` share once they re-heartbeat
   *  down. The cap, not any join-phase bookkeeping, is what keeps `Σ share ≤
   *  lGlobal` (`GlobalCap`) under any heartbeat interleaving. */
  share: number;
  /** Current fleet-wide inferred limit (telemetry). Aggregated over ALL live
   *  nodes' `lLocal` per the coordinator's `aggregate` policy (§7). */
  lGlobal: number;
  /** Count of live nodes the coordinator aggregated/split over (telemetry /
   *  equal-split transparency). */
  nodes: number;
}

/**
 * Owns the shared `L_global` and parcels it into per-node shares. The
 * event-release sibling of {@link GlobalCoordinator} (federation): same
 * "central authority leases sub-budgets to N participants" shape, but the
 * lease is renewed by heartbeat (liveness) and reclaimed by TTL, not reset by
 * a wall-clock window. See DESIGN §3 + §9.
 */
export interface ConcurrencyCoordinator {
  /**
   * Heartbeat + report + (re)lease in one round-trip. The coordinator:
   *   1. upserts this node's {lLocal, inflight, expiresAt}, carrying forward its
   *      currently-stored `share` (0 if first-seen);
   *   2. evicts every node whose `expiresAt < now` (its share leaves the live
   *      sum, reclaiming its budget);
   *   3. recomputes `L_global = aggregate(all live nodes' lLocal)` (§7);
   *   4. computes this node's equal-split `target` over the live set (§6);
   *   5. CAPS the grant: `share = max(0, min(target, L_global − Σ(other live
   *      shares)))`, then stores it as this node's share so peers' subsequent
   *      heartbeats see it committed.
   * The cap keeps `GlobalCap : Σ stored shares ≤ L_global` invariant across ANY
   * staggered interleaving when `L_global` is constant (§6 / D-DAC-17), because
   * `share + Σ(other live shares) ≤ L_global` by construction. A new node gets
   * `share = 0` naturally — incumbents still hold the whole budget, so the cap
   * leaves nothing — and ramps to its fair share as incumbents re-heartbeat down.
   * There is NO new/established/provisional bookkeeping: the cap alone is the
   * mechanism. Idempotent per `nodeId` within a heartbeat. MAY reject with
   * `StoreUnavailableError` on unreachability.
   */
  heartbeat(report: ConcurrencyReport): Promise<ConcurrencyGrant>;
  /** Voluntary departure: drop `nodeId` and reclaim its share now (don't wait for TTL).
   *  Best-effort, idempotent. */
  leave(args: { key: string; nodeId: string }): Promise<void>;
  /** Optional liveness probe; defaults to always-healthy. */
  isHealthy?(): Promise<boolean>;
}
```

> **D-DAC-8 — aggregation policy lives on the coordinator, not the guard.**
> `aggregate ∈ {"min","median"}` is a *fleet-wide* decision (every node must use
> one consistent rule), so it is a coordinator-construction option. Guards only
> *report* raw `lLocal`. This makes a misconfigured-mixed-fleet impossible.

### 5.2 The primitive — `src/concurrency/distributed.ts` (NEW)

```ts
import { adaptiveConcurrency, type AdaptiveConcurrencyOptions,
         type ConcurrencyGuard, type Lease } from "./adaptive";
import type { ConcurrencyCoordinator } from "./coordinator";
import { systemClock } from "../core/clock";
import type { Clock } from "../core/types";

/** Injectable repeating timer (so tests drive heartbeats deterministically). */
export interface HeartbeatScheduler {
  schedule(fn: () => void, everyMs: number): { cancel(): void };
}

export interface DistributedAdaptiveConcurrencyOptions {
  /** The cross-node coordinator that owns `L_global`. */
  coordinator: ConcurrencyCoordinator;
  /** Unique-per-process identity. REQUIRED (no default — collisions corrupt the aggregate). */
  nodeId: string;
  /** Shared-backend key. Nodes fronting the same backend MUST match. Default "". */
  key?: string;
  /** Forwarded verbatim to the private `adaptiveConcurrency`. Default {}. */
  local?: AdaptiveConcurrencyOptions;
  /** Heartbeat / lease-renewal period in ms — the `heartbeat_T`. Default 1000. */
  heartbeatMs?: number;
  /** Lease TTL handed to the coordinator (`expiresAt = now + leaseTtlMs`).
   *  MUST exceed `heartbeatMs` so a single slow heartbeat doesn't drop the node.
   *  Default `2 * heartbeatMs`. */
  leaseTtlMs?: number;
  /** Behavior when `coordinator.heartbeat()` throws. Default "fail-closed". */
  onCoordinatorOutage?: "fail-closed" | "local-only";
  /** Injectable clock. Default systemClock. */
  clock?: Clock;
  /** Injectable scheduler. Default a setInterval-based timer (unref'd). */
  scheduler?: HeartbeatScheduler;
}

/** A {@link ConcurrencyGuard} plus distributed lifecycle. */
export interface DistributedConcurrencyGuard extends ConcurrencyGuard {
  /** Force a heartbeat now (report L_local, refresh share). Resolves when the
   *  round-trip lands. Normally driven by the internal timer; exposed for tests
   *  and graceful pre-shutdown sync. Never throws (outage → outage policy). */
  heartbeat(): Promise<void>;
  /** Stop the timer and `leave()` the fleet. Idempotent. */
  close(): Promise<void>;
  /** Distributed stats snapshot (extends the base `stats()`). */
  stats(): {
    limit: number; inflight: number; rttNoload: number; lastRtt: number;
    share: number; lGlobal: number; nodes: number;
  };
}

export function distributedAdaptiveConcurrency(
  options: DistributedAdaptiveConcurrencyOptions,
): DistributedConcurrencyGuard;
```

> Note `acquire()` stays **synchronous** (inherited from the base
> `ConcurrencyGuard`). `heartbeat()` / `close()` are the only async members.
> Because `DistributedConcurrencyGuard extends ConcurrencyGuard`, the value
> returned drops straight into `expressAdaptiveConcurrency({ guard })` and every
> sibling adapter — **this is the 0.9.2 forward-compat hook (D-M-12) realized**.

### 5.3 Concrete coordinators

- **`TestConcurrencyCoordinator`** — `src/concurrency/test-concurrency-coordinator.ts`
  (NEW). In-memory, deterministic, **no timers, no I/O** (expiry compared
  against an injected `clock`). Mirrors `TestCoordinator` (federation). Used by
  examples, the BFS twin, and the dual-path conformance test. Construction:
  `new TestConcurrencyCoordinator({ aggregate?: "min" | "median"; clock?: Clock })`
  (default `"median"`, `systemClock`). Extra test helpers:
  `setHealthy(b)`, `peek(key) → { lGlobal, nodes, shares: Record<nodeId, number> }`.

- **`RedisConcurrencyCoordinator`** — `src/concurrency/redis-concurrency-coordinator.ts`
  (NEW). One Lua script does heartbeat-aggregate-split atomically (§10). Mirrors
  `RedisCoordinator`'s client-shape + error mapping. Construction:
  `new RedisConcurrencyCoordinator({ client, aggregate?, prefix? })`.

- **Postgres** — **deferred** to a follow-up patch (§14.2), exactly as the
  federation `PostgresCoordinator` (0.8.4) followed the Redis one (0.8.3).

### 5.4 Exports

Root `src/index.ts`: `distributedAdaptiveConcurrency`, `TestConcurrencyCoordinator`,
and the `ConcurrencyCoordinator` / `ConcurrencyReport` / `ConcurrencyGrant` /
`DistributedAdaptiveConcurrencyOptions` / `DistributedConcurrencyGuard` /
`HeartbeatScheduler` types.

**`RedisConcurrencyCoordinator` MUST be reachable through a documented import
path.** Resolve by **reachability, not by literal grep** — the federation
precedent ships `RedisCoordinator` via the `throttlekit/federation` *subpath*
entry (`tsup.config.ts: federation: "src/federation/index.ts"`, mapped to the
`"./federation"` block in `package.json` `exports`), **not** via root
`src/index.ts` (so an old note to "grep `RedisCoordinator` in `src/index.ts`" is
stale — it isn't there). Do **not** rely on `src/concurrency/index.ts` as the
export site: it is an orphaned barrel (not a tsup entry, mapped to no
`package.json` subpath, not re-exported by root `src/index.ts`), so a coordinator
exported only from there ships in no bundle and is unreachable by consumers.

Pick **one** of these (option 2 is the recommended, lowest-risk choice):

- **(1) Mirror the federation subpath (closest structural analog).** Add
  `concurrency: "src/concurrency/index.ts"` to `tsup.config.ts` `entries` and a
  matching `"./concurrency"` block to `package.json` `exports` (alongside
  `"./federation"`), then export `RedisConcurrencyCoordinator` +
  `RedisConcurrencyCoordinatorOptions` from `src/concurrency/index.ts`. This makes
  `throttlekit/concurrency` a real, bundled subpath.
- **(2, recommended) Re-export from root `src/index.ts`.** Add
  `RedisConcurrencyCoordinator` (and its `RedisConcurrencyCoordinatorOptions`
  type) to root `src/index.ts`, alongside the other distributed-concurrency
  exports (`distributedAdaptiveConcurrency`, `TestConcurrencyCoordinator`, the
  `ConcurrencyCoordinator` family). This makes the class + options type reachable
  via the **main** entry the rest of the 0.10.0 surface already uses, with no new
  tsup entry or `package.json` subpath to maintain. (Note: unlike the federation
  `RedisCoordinator`, this coordinator carries no extra runtime dependency beyond
  the injected `client`, so co-locating it on the root entry adds no new dep to
  the main bundle.)

Whichever is chosen, a consumer MUST be able to
`import { RedisConcurrencyCoordinator } from "throttlekit"` (option 2) or
`from "throttlekit/concurrency"` (option 1) — verify with an import in the
dual-path conformance test (§11.4), not by inspecting the barrel.

---

## 6. The allocation algorithm — budget-capped equal split (D-DAC-9, D-DAC-17)

The coordinator stores, per `(key, nodeId)`, `{lLocal, inflight, expiresAt,
share}` — the node's last report **plus the share it currently holds**. The
stored `share` is what makes the cap possible: a heartbeating node can see the
budget already committed to its peers and never grant itself more than the
remainder. Given the live node set (after eviction) and `L = L_global`:

```
// 1. upsert self {lLocal, inflight, expiresAt}, carrying forward its stored
//    share (0 if new / first-seen).
// 2. evict every node with expiresAt < now (its share leaves the live sum).
// 3. liveIds = all live nodeIds; L = aggregate(live lLocal)              // §7
// 4. equal-split TARGET for self:
N      = |liveIds|
base   = floor(L / N)
rem    = L - base * N                       // in 0 .. N-1
ids    = sort(liveIds ascending)            // lexicographic; total order ⇒ deterministic
rank   = index of self in ids               // 0-based
target = base + (rank < rem ? 1 : 0)
// 5. CAP at the budget not committed to OTHER live nodes:
others = Σ stored share of every live node EXCEPT self
share  = max(0, min(target, L - others))    // THE CAP — D-DAC-17
// 6. store self.share = share; return { share, lGlobal: L, nodes: N }
```

**`GlobalCap`-correctness (the safety invariant).** After step 6 the committed
sum is `share + others = min(target, L − others) + others ≤ (L − others) +
others = L`, so `GlobalCap : Σ_{live} stored share ≤ L_global` holds after
**every** heartbeat, for **any** interleaving of staggered heartbeats, while
`L_global` is constant. This is the hard safety property (§1.2); it does NOT
depend on the exact `target` — only on the cap. The equal-split `target` is the
value the fleet *converges* to as nodes re-heartbeat: once every node has
heartbeated against the same `(L_global, live-set)`, `Σ share = base·N + rem =
L_global` exactly and no node's share exceeds `base + 1`. ∎

> **The cap subsumes "provisional join" — and is strictly stronger.** A node new
> to the fleet computes `others = Σ(incumbent shares)`. When the incumbents still
> hold the whole budget (`others = L_global`), the cap gives `min(target,
> L_global − L_global) = 0`: the newcomer admits nothing until the incumbents
> re-heartbeat down and free budget. So a fresh node *naturally* gets share 0 —
> no `isNew`/`established`/`firstSeen` marker, no special join branch. Crucially,
> the cap is robust where a one-shot "provisional join" (share 0 for exactly one
> heartbeat, then a full equal-split) was **not**: if the joiner heartbeats a
> *second* time before any incumbent re-splits, the one-shot rule would hand it a
> full `⌊L/N⌋`, pushing `Σ share` back above `L_global`; the cap re-evaluates
> `min(target, L − others)` on **every** heartbeat, so the second grant is still
> capped at the (still-zero) remainder. The cap is therefore the mechanism, and
> the one-shot provisional rule is abandoned (it was never implemented).
>
> **Eviction and departure** are handled by the same arithmetic: an evicted or
> departed node's stored share leaves the live sum, so `others` drops and the
> survivors' next grants grow toward the freed budget — no clawback, no special
> case. Shrink-drain (a survivor's share must still cover its existing in-flight)
> is the §9.3 liveness direction, clamped by `min(share, local.limit)` (D-DAC-6).

**Aggregation uses ALL live nodes** (§7), including a just-arrived node's
`lLocal`. The cap, not aggregate-set surgery, is what bounds the committed sum,
so there is no "established set" to exclude joiners from — a deliberate
simplification over the abandoned provisional-join design.

**Properties:** deterministic (sorted-nodeId tiebreak — no RNG), `O(N log N)`,
needs no carry-over or clawback (the cap is exact, not approximate), and maps
directly onto the TLA⁺ `Reallocate` action's `Min2(Target, L − others)` cap over
the active set (§9). **Known limitation:** an idle node still holds `≈ L/N`, so
under skew the busy nodes are capped below what the idle nodes are wasting.
Documented as a FAILURE-MODES row (§12) and a future refinement (§14.1).
Budget-capped equal-split is the *conservative* choice: it never over-commits,
and "leaves capacity on the table under skew" is a utilization bug, not a safety
bug.

---

## 7. The aggregation algorithm (D-DAC-10)

`aggregate({lLocal over live nodes}) → L_global`:

- `"median"` (**default**): ascending-sort the `lLocal` values; take the element
  at index `floor((N-1)/2)` (the **lower median** — integer, deterministic, no
  averaging). Robust to a single mis-calibrated/cold-starting node.
- `"min"`: `Math.min(...)`. The conservative extreme — the most-stressed node's
  view caps the fleet. Choose when strict overload-avoidance beats utilization.

> **Why not `sum`?** Summing per-node `lLocal` *is the bug in §1.1* — it
> reconstructs the `N·C` overshoot. All nodes estimate the **same** quantity
> (the shared backend's capacity), so aggregation is robust *central estimation*
> of one number, never addition. This is the single most important conceptual
> guard-rail in the design; it gets its own DR (D-DAC-10) and a wiki callout.

**Modeling assumption (documented honestly):** a node sees only its *share* of
traffic, so its `lLocal` is a biased estimate of `C`. The bias is acceptable
because (a) the RTT *gradient* (degradation) is a shared signal — when the
backend slows, every node's `lLocal` falls together — and (b) `median`/`min`
track the fleet's consensus view of that gradient. We do **not** claim `L_global
= C`; we claim `L_global` tracks `C`'s health and the safety bound
`GlobalCap : Σ stored shares ≤ L_global` holds exactly regardless of estimation
quality (it is maintained by the budget cap, §6, for *whatever* `L_global` the
aggregate produces). Estimation quality is a utilization concern; `GlobalCap` is
the safety guarantee. (The instantaneous `Σ inflight ≤ L_global` is the bounded
drain-lag liveness consequence of §9.3, not the hard bound.)

---

## 8. Heartbeat lifecycle

### 8.1 Timeline

```
construct ─▶ share = (fail-closed ? 0 : local.limit);  schedule first heartbeat on next tick,
            then every heartbeatMs.
each tick ─▶ report = { key, nodeId, lLocal: local.limit, inflight: local.inflight,
                        expiresAt: clock.now() + leaseTtlMs }
            try   grant = await coordinator.heartbeat(report)
                  → share = grant.share; lGlobal = grant.lGlobal; nodes = grant.nodes; healthy = true
            catch → onCoordinatorOutage handling (§8.2); healthy = false
close()  ─▶ scheduler.cancel(); await coordinator.leave({key,nodeId})  (best-effort, idempotent)
```

**Cold start (D-DAC-12):** before the first grant lands, `share = 0` under
`fail-closed` (the node admits nothing for ~one RTT) or `share = local.limit`
under `local-only`. The first heartbeat is scheduled on the **next tick**, not
after a full `heartbeatMs`, to minimize the stall. Callers who must gate startup
can `await guard.heartbeat()` once after construction (documented in the wiki).

> **The budget cap (D-DAC-17) interacts with cold start.** When a node joins a
> fleet whose incumbents already hold the whole budget, its first grant is
> `share = max(0, min(target, L_global − Σ incumbent shares)) = 0` even on
> success — the cap (§6) leaves it nothing until the incumbents re-heartbeat
> down. So a joining node admits nothing for its first heartbeat window
> regardless of outage mode under `fail-closed`; under `local-only`,
> `min(share, local.limit) = min(0, …) = 0` still holds until incumbents free
> budget. The node ramps to its `≈ L_global/N` share over the next heartbeat or
> two (as many incumbents re-heartbeat against the new live-set cardinality),
> adding ≈ one `heartbeatMs` of join latency. A node that must serve traffic from
> the instant it boots should over-provision the fleet or accept the ramp; the
> alternative (admitting before incumbents re-split) is the unsafe over-commit
> the cap exists to prevent. (The very first node under a key is the founding
> member: with no incumbents, `others = 0` and the cap gives it the full
> `L_global` immediately — no artificial one-heartbeat stall beyond the
> cold-start `share = 0` above.)

### 8.2 Coordinator-outage modes (D-DAC-11)

- **`"fail-closed"`** (default — safety > availability, matching federation's
  default): on a throw, set `share = 0`. The node sheds everything until the
  coordinator returns. Never overshoots; trades availability.
- **`"local-only"`**: on a throw, set `share = local.limit`. The node falls back
  to *pure in-process adaptive concurrency* — each node self-limits, the fleet
  may collectively overshoot the backend (the §1.1 regime), but stays up. The
  honest degraded mode; choose when availability > strict bound.

`leaseTtlMs` default `2·heartbeatMs` means one missed heartbeat (slow round-trip)
does **not** drop the node from the fleet — only two consecutive misses do
(D-DAC-7). A node that crashes is reclaimed within `leaseTtlMs`.

---

## 9. Safety theorem + TLA⁺ (`spec/GaleHeartbeatLeasing.tla`)

### 9.1 The theorem

> **`GlobalCap` (the hard safety property).** With `L_global` constant over a
> heartbeat epoch, for **every** interleaving of staggered per-node
> `Reallocate`/`Join`/`Leave` heartbeats,
>
> ```
> GlobalCap :  Σ_{n live} share[n]  ≤  L_global
> ```
>
> The coordinator never *commits* more concurrency than the global budget,
> regardless of heartbeat order, joins, or departures.

This is exactly what the budget cap (§6 / D-DAC-17) buys: every `Reallocate(n)`
sets `share[n] = min(target, L_global − Σ_{others} share)`, so the committed sum
after the step is `share[n] + Σ_others ≤ L_global`. `Join(n)` enters at share 0
(no double-count) and `Leave(n)` zeroes the departing share (budget reclaimed),
so neither can break the bound either. `GlobalCap` is the relabeled
`GaleFederatedLeasing` budget invariant, with `Limit ← L_global` and the lease
(escrow) being the committed `share[n]`. The `windowMs → heartbeat_T` relabeling
(D-DAC-2): the federation **window** (budget resets) becomes the **heartbeat
epoch** (`L_global` constant), and the per-window escrow-leasing becomes the
per-node staggered `Reallocate` with the cap.

> **`Σ inflight ≤ L_global` is NOT a safety invariant.** In-flight is
> non-revocable, so during a rebalance (a peer joins and ramps while an
> over-provisioned node drains) `Σ inflight` can transiently exceed `L_global`,
> draining monotonically back. That is the **liveness** property of §9.3 /
> D-DAC-14 — modeled but deliberately *omitted* from the invariant list (it
> appears in the spec as the documentation-only `SteadyOvershoot`, never checked).
> The crisp per-node gate `inflight[n] ≤ share[n]` is enforced by `Acquire`'s
> guard, and the headline safety claim is `GlobalCap` over committed shares.

### 9.2 Honest scope (D-DAC-13)

The proof fixes `L_global` **constant** for the heartbeat epoch (the spec's
`CONSTANT L`). Across epochs `L_global` re-aggregates at heartbeat boundaries
(Mechanism 1, §3); each epoch is independently bounded by its own `L_global`.
This is the same per-window framing the shipped federation spec uses; we inherit
its honesty. The cap argument is what makes the bound hold *within* the epoch for
any staggered ordering — the contribution over the relabeled federation skeleton.

**Membership is not fixed.** The spec carries an explicit `active` subset of
`Nodes` with `Join`/`Leave` actions: the fleet starts as any nonempty founding
set and grows or shrinks. `GlobalCap` is quantified over `active`, and the
**budget cap** in `Reallocate` (`Min2(Target, L − others)`) is what holds the
committed sum `≤ L` across every staggered join — a joining node, once active but
before it has reallocated, holds share 0; once it reallocates while incumbents
still hold the whole budget, the cap grants it `min(target, L − L) = 0`, so the
membership-growth over-commit (§1.2 callout) cannot occur. The cap is robust even
if the joiner `Reallocate`s repeatedly before an incumbent re-splits (each grant
re-caps at the current remainder) — the gap a one-shot provisional rule left
open. (Departure / eviction is the §9.3 shrink-drain direction for *in-flight*,
argued as liveness; the *committed-share* bound is safety, encoded here.)

### 9.3 The one place concurrency differs from rate — shrink-drain (D-DAC-14)

At a rate-window roll, `admitted` resets to 0 (new window). At a concurrency
heartbeat, **`inflight` does NOT reset** — in-flight requests persist; you cannot
retroactively un-admit a running request. So when a node's `share` drops below
its current `inflight` (`L_global` shrank, or a peer joined and the node's
`Reallocate` re-capped it down), that node carries "debt": it admits **nothing
new** (its `Acquire` guard `inflight < share` is closed) and drains as requests
complete. `Σ inflight` is non-increasing under debt and converges back to
`≤ L_global`.

This is **identical** to how single-node `adaptiveConcurrency` behaves when
`estimate` drops: `acquire()` starts rejecting, but existing leases run to
completion. It is a **liveness/convergence** property, not a safety violation,
and is therefore argued informally here rather than encoded as a safety
invariant. In the spec it appears only as the documentation-only
`SteadyOvershoot` (`Sum(inflight, active) ≤ L`), deliberately **omitted** from
the checked invariant list — `Acquire` may push `inflight[n]` up to the *current*
`share[n]`, and because shares rebalance while in-flight persists,
`Σ inflight` can momentarily exceed `L` before draining. The crisp per-node fact
`inflight[n] ≤ share[n]` is held at every state by `Acquire`'s guard; the
committed-share safety property is `GlobalCap`.

> **Shrink-drain (a node leaving / `L_global` dropping) and join (a node
> arriving) are duals — the budget cap handles both.** Shrink-drain
> over-allocates a *survivor* relative to its falling share and drains its
> in-flight down — `Σ inflight` non-increasing, liveness. A join would
> *over-commit the fleet as a whole* (Σ stored shares momentarily `> L_global`)
> if the joiner were granted a positive share before incumbents re-split, which
> is a genuine **safety** breach — and it is prevented structurally by the
> **budget cap** in `Reallocate` (§6 / D-DAC-17): the joiner's grant is
> `min(target, L − others)`, which is 0 until incumbents free budget. The cap is
> the one mechanism for both directions; `GlobalCap` is the invariant it
> maintains, and `Join`/`Leave` are the membership actions in the model (§9.4).

### 9.4 The module (`spec/GaleHeartbeatLeasing.tla`, embedded verbatim)

```tla
-------------------------- MODULE GaleHeartbeatLeasing --------------------------
(***************************************************************************)
(* GALE research spec: distributed ADAPTIVE CONCURRENCY as event-release    *)
(* leasing. The event-release sibling of MODULE GaleFederatedLeasing         *)
(* (clock/window escrow), relabeled windowMs -> heartbeat_T:                 *)
(*                                                                         *)
(*   GaleFederatedLeasing            GaleHeartbeatLeasing                    *)
(*   --------------------            --------------------                    *)
(*   windowMs   (clock reset)        heartbeat_T  (per-node heartbeat)       *)
(*   globalBudget = Limit            L            (constant this epoch)      *)
(*   escrow[r]   (leased, decays)    share[n]     (granted, event-released)  *)
(*   admitted    (cumulative/window) inflight[n]  (instantaneous, persists)  *)
(*                                                                         *)
(* WHY THIS MODEL IS STAGGERED (and the earlier atomic-Roll model was        *)
(* unsound). Each node heartbeats INDEPENDENTLY, at its own time, against     *)
(* whatever fleet snapshot the coordinator holds then. A stateless           *)
(* equal-split (share = floor(L/N) computed per node) VIOLATES the global     *)
(* budget under this staggering: a node that joins computes its small share   *)
(* while an incumbent still holds its larger pre-join share, so Sum(share)    *)
(* transiently exceeds L with L CONSTANT (no shrink). The earlier spec hid    *)
(* this by re-splitting all shares atomically in one Roll. This module        *)
(* models the real staggered protocol: one node reallocates at a time, and    *)
(* the grant is CAPPED at the budget not committed to other live nodes        *)
(* (DESIGN section 6 / 10 / D-DAC-17). Under that cap GlobalCap holds for     *)
(* ANY interleaving.                                                          *)
(*                                                                         *)
(* WHAT IS PROVED (constant L): GlobalCap == Sum(share over active) <= L.     *)
(* The coordinator never COMMITS more than the global budget, regardless of   *)
(* heartbeat order, joins, or departures. This is the achievable, hard        *)
(* safety property -- and the one the bug violated.                          *)
(*                                                                         *)
(* WHAT IS NOT AN INVARIANT (deliberately): Sum(inflight) <= L. In-flight     *)
(* requests cannot be revoked, so when shares rebalance (a peer joins and     *)
(* ramps while an over-provisioned node drains) Sum(inflight) can             *)
(* transiently exceed L, draining monotonically back. This is a liveness/     *)
(* convergence property (DESIGN section 9.3 / D-DAC-14), identical to how     *)
(* single-process adaptiveConcurrency keeps serving in-flight after its       *)
(* estimate drops, and is further clamped in practice by min(share,           *)
(* local.limit) (D-DAC-6). It is therefore NOT in the invariant list.        *)
(*                                                                         *)
(* TLC needs Java; the committed Java-free twin is                           *)
(* test/concurrency/distributed-leasing-model.test.ts (TK-1316), which        *)
(* reproduces TLC's distinct-state count and asserts the same invariants.     *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Nodes,   \* set of node identities, e.g. {n1, n2}
    L        \* the constant global concurrency budget for this heartbeat epoch

VARIABLES
    active,    \* subset of Nodes currently in the fleet (heartbeating)
    share,     \* share[n]: node n's currently-granted ceiling (0 when inactive)
    inflight   \* inflight[n]: node n's current in-flight count

vars == << active, share, inflight >>

Min2(a, b) == IF a < b THEN a ELSE b
Ceil(a, b) == (a + b - 1) \div b

RECURSIVE SumOver(_, _)
SumOver(f, S) == IF S = {} THEN 0
                 ELSE LET x == CHOOSE y \in S : TRUE
                      IN f[x] + SumOver(f, S \ {x})

\* An upper bound on any single node's fair share this epoch. The real
\* coordinator uses the tighter base/remainder equal-split; Ceil(L,|active|) is a
\* safe over-approximation -- the SAFETY bound depends only on the CAP below, not
\* on the exact target.
Target == Ceil(L, Cardinality(active))

ASSUME HeartbeatAssumptions ==
    /\ Nodes # {}
    /\ L \in Nat

TypeOK ==
    /\ active \subseteq Nodes
    /\ active # {}
    /\ share \in [Nodes -> 0..L]
    /\ inflight \in [Nodes -> 0..L]

Init ==
    /\ active \in { s \in SUBSET Nodes : s # {} }   \* any nonempty starting fleet
    /\ share = [n \in Nodes |-> 0]                  \* cold start: nobody holds budget yet
    /\ inflight = [n \in Nodes |-> 0]

\* Reallocate(n): node n heartbeats and is (re)granted a share. The grant is
\* CAPPED at the budget not currently committed to OTHER active nodes, so the
\* committed sum can never exceed L regardless of the order nodes heartbeat in.
\* This is the federation lease, event-coupled (D-DAC-17).
Reallocate(n) ==
    /\ n \in active
    /\ LET others == SumOver(share, active \ {n})
       IN share' = [share EXCEPT ![n] = Min2(Target, L - others)]
    /\ UNCHANGED << active, inflight >>

\* Join(n): a new node enters holding NO budget (share 0) until it reallocates,
\* so an incumbent's outstanding share is never double-counted.
Join(n) ==
    /\ n \notin active
    /\ active' = active \cup {n}
    /\ share' = [share EXCEPT ![n] = 0]
    /\ UNCHANGED inflight

\* Leave(n): a node departs (voluntary close or lease-expiry); its share leaves
\* the live sum (budget reclaimed) and its in-flight is gone.
Leave(n) ==
    /\ n \in active
    /\ Cardinality(active) > 1
    /\ active' = active \ {n}
    /\ share' = [share EXCEPT ![n] = 0]
    /\ inflight' = [inflight EXCEPT ![n] = 0]

\* Acquire(n): admit one request -- only while below the node's granted share.
Acquire(n) ==
    /\ n \in active
    /\ inflight[n] < share[n]
    /\ inflight' = [inflight EXCEPT ![n] = @ + 1]
    /\ UNCHANGED << active, share >>

\* Release(n): a request on node n completes (event-release).
Release(n) ==
    /\ inflight[n] > 0
    /\ inflight' = [inflight EXCEPT ![n] = @ - 1]
    /\ UNCHANGED << active, share >>

Next ==
    \E n \in Nodes :
        \/ Reallocate(n) \/ Join(n) \/ Leave(n) \/ Acquire(n) \/ Release(n)

Spec == Init /\ [][Next]_vars

(***************************************************************************)
(* Invariants.                                                              *)
(***************************************************************************)

\* THE safety property: the coordinator never commits more than the global
\* budget. Maintained by the CAP in Reallocate (each grant <= L - others) and by
\* Join granting 0. A stateless equal-split (no cap) VIOLATES this under
\* staggered heartbeats -- that was the bug. Independent of |Nodes|.
GlobalCap == SumOver(share, active) <= L

\* Tightness witness for GlobalCap (intentionally FALSE: TLC must exhibit a
\* reachable state with Sum(share) = L, so L is the LEAST upper bound -- the
\* distributed allocation loses no steady-state capacity). Swap into the .cfg to
\* capture the trace; not in the committed invariant list.
GlobalCapTight == SumOver(share, active) <= L - 1

\* Documentation-only (NOT an invariant; deliberately omitted from the .cfg):
\* in-flight can transiently exceed L during a rebalance because in-flight is
\* non-revocable. Convergence to <= L is the liveness property of DESIGN 9.3.
SteadyOvershoot == SumOver(inflight, active) <= L
=================================================================================
```

> **What the model proves and what it does not.** The checked safety property is
> `GlobalCap : SumOver(share, active) ≤ L` — the coordinator never *commits* more
> than the global budget, for **any** interleaving of staggered `Reallocate`
> heartbeats, joins, and departures, with `L` constant. It is maintained by the
> **cap** in `Reallocate` (`Min2(Target, L − others)`) and by `Join` entering at
> share 0. `Target` is a safe over-approximation (`Ceil(L, |active|)`) of the
> real coordinator's tighter base/remainder split — the bound depends only on the
> cap, not the exact target. `GlobalCapTight` is the intentionally-false
> tightness witness (TLC exhibits a reachable `Sum(share) = L`, so `L` is the
> least upper bound — distribution loses no steady-state capacity). And
> `SteadyOvershoot : SumOver(inflight, active) ≤ L` is **documentation-only**,
> deliberately omitted from the `.cfg` invariant list because in-flight is
> non-revocable and can transiently exceed `L` during a rebalance (§9.3). The
> twin (§11.2) is the authority; the spec is the readable witness.

### 9.5 The `.cfg` (`spec/GaleHeartbeatLeasing.cfg`, embedded verbatim)

```
\* TLC config for MODULE GaleHeartbeatLeasing.
\* Two nodes; constant global budget L = 4 (one heartbeat epoch). Joins/leaves
\* over the {n1,n2} set + staggered Reallocate exercise the cap.
CONSTANTS
    Nodes = {n1, n2}
    L = 4

INIT Init
NEXT Next

INVARIANTS
    TypeOK
    GlobalCap

\* To capture the GlobalCap tightness counterexample (Sum(share) reaches L), swap in:
\* INVARIANTS TypeOK GlobalCapTight
```

`L` is a **constant** of the model (a single heartbeat epoch), not a set of
budgets: the safety claim is `GlobalCap` *under constant `L`* (§9.1), and the
staggered `Reallocate`/`Join`/`Leave` actions exercise the cap across membership
changes within that epoch.

### 9.6 TLC counts (filled at TK-1316)

Run `java -cp tla2tools.jar tlc2.TLC -workers auto -config
spec/GaleHeartbeatLeasing.cfg spec/GaleHeartbeatLeasing.tla` and record here:
`<NNN states generated, MMM distinct, depth D>`. The reachable space spans the
nonempty starting fleets in `Init` plus the staggered `Reallocate`/`Join`/`Leave`
interleavings. The BFS twin (`test/concurrency/distributed-leasing-model.test.ts`)
MUST reproduce `MMM` distinct states and assert that **`GlobalCap` and `TypeOK`
hold on all of them**, that **`GlobalCapTight` is violated** (tightness — some
reachable state has `Sum(share) = L`), and that the **`Join` (membership-growth)
action is actually reachable/exercised** — i.e. at least one enumerated state
transition adds a node to `active` — so the staggered-join path that the bug hit
is observably covered, not vacuously absent. (`SteadyOvershoot` is the
documentation-only in-flight note — NOT asserted as an invariant, §9.3.) Pin
`MMM` as a literal in the test, as TK-905 did for the federation twin.

---

## 10. Coordinator wire semantics

### 10.1 `TestConcurrencyCoordinator` (reference algorithm — implement literally)

State: `Map<key, Map<nodeId, { lLocal, inflight, expiresAt, share }>>`. The extra
field versus the report is `share` — **the share this node currently holds** (the
value its last grant returned). Storing it is what makes the budget cap (§6 /
D-DAC-17) possible: each heartbeat sees the budget already committed to peers and
caps the grant at the remainder. There is **no** `isNew`/`established`/`firstSeen`
flag — the cap alone bounds the committed sum, so a brand-new node naturally gets
share 0 (incumbents still hold the budget) without any join-phase branch.

```
heartbeat(report):
  now = clock.now()
  perKey = state.get(report.key) ?? new Map(); state.set(report.key, perKey)

  // 1. upsert self, carrying forward any share we already granted it (0 if new).
  prior = perKey.get(report.nodeId)
  perKey.set(report.nodeId, { lLocal: report.lLocal, inflight: report.inflight,
                              expiresAt: report.expiresAt, share: prior?.share ?? 0 })

  // 2. evict expired (expiresAt < now). Self always survives (it just renewed);
  //    an evicted node's share leaves the live sum, reclaiming its budget.
  for (id, rec) of perKey:  if (rec.expiresAt < now) perKey.delete(id)

  // 3. aggregate ALL live nodes' lLocal (§7). Self is always live.
  liveIds = [...perKey.keys()]
  lGlobal = aggregate(liveIds.map(id => perKey.get(id).lLocal))

  // 4. equal-split TARGET for self: base + 1 for the first `rem` by sorted id.
  N = liveIds.length; base = floor(lGlobal / N); rem = lGlobal - base*N
  sorted = [...liveIds].sort()                                                     // lexicographic
  rank = sorted.indexOf(report.nodeId)
  target = base + (rank < rem ? 1 : 0)

  // 5. CAP the grant at the budget not committed to OTHER live nodes, so
  //    Σ share ≤ lGlobal under any heartbeat interleaving (D-DAC-17).
  others = Σ over liveIds (id != self) of perKey.get(id).share
  share = max(0, min(target, lGlobal - others))

  // 6. record the grant so subsequent heartbeats by other nodes see it committed.
  perKey.get(report.nodeId).share = share
  return { share, lGlobal, nodes: N }

leave({key,nodeId}): state.get(key)?.delete(nodeId)
isHealthy(): healthy   // toggled by setHealthy() for tests; when false, heartbeat() throws StoreUnavailableError
```

> **`peek(key)` returns the STORED shares, not a fresh stateless re-split.** It
> filters to live records and reports each node's `rec.share` plus
> `lGlobal = aggregate(live lLocal)` and the live count. Because every stored
> share was capped at the budget remaining at the time it was granted,
> `Σ stored shares ≤ lGlobal` (`GlobalCap`) holds whenever `lGlobal` has been
> stable — and that is exactly the consistent budget the property test (§11.3)
> asserts the global bound against. A node that lease-expired and later returns
> is upserted with its carried-forward share gone (a fresh record with share
> seeded 0 if no prior live record), so it re-earns budget through the cap on its
> next heartbeats — no unbounded "seen" ledger, no special re-join path.

### 10.2 `RedisConcurrencyCoordinator` (HASH + one Lua script)

- Key: `<prefix>conc:<key>` → a Redis HASH, one field per node:
  `field = nodeId`, `value = "<lLocal> <inflight> <expiresAt> <share>"`
  (space-joined ints — the trailing `share` is the **stored grant**, the Redis
  analog of the Test coordinator's `NodeRecord.share`, and is what makes the cap
  possible).
- `HEARTBEAT_LUA` (EVALSHA), args `(key, nodeId, lLocal, inflight, expiresAt, now, aggregate)`:
  1. **Carry forward the prior share:** `HGET key nodeId`; parse its 4th field as
     `priorShare` (`0` if no prior field). (Must be read before step 2 overwrites
     it.)
  2. `HSET key nodeId "<lLocal> <inflight> <expiresAt> <priorShare>"` — upsert
     self, seeding the stored share with its carried-forward value.
  3. `HGETALL key`; parse; `HDEL` every field with `expiresAt < now` (an evicted
     node's stored share thus leaves the live sum, reclaiming its budget).
  4. Build the live set = all surviving nodeIds. Compute `lGlobal` per `aggregate`
     over **all live** `lLocal` (`min` = min; `median` = `table.sort` then index
     `floor((n-1)/2)`, 1-based: `t[math.floor((n-1)/2)+1]`). `N = #live`.
  5. Equal-split TARGET for self: `table.sort` the live ids; `base =
     floor(lGlobal/N)`, `rem = lGlobal - base*N`; `rank` = 0-based index of
     `nodeId`; `target = base + (rank < rem and 1 or 0)`.
  6. **CAP (D-DAC-17):** `others = Σ over live ids (id ~= nodeId) of that id's
     stored share`; `share = max(0, min(target, lGlobal - others))`.
  7. Persist the grant: `HSET key nodeId "<lLocal> <inflight> <expiresAt>
     <share>"` (rewrite self's field with the just-computed share so peers' later
     heartbeats see it committed).
  8. `PEXPIRE key <2*leaseTtlMs-ish GC ttl>`; return `{ share, lGlobal, N }`.
- `leave`: `HDEL key nodeId`.
- Error mapping: reuse `RedisCoordinator`'s `StoreUnavailableError` wrapping
  (implementer: copy the try/catch shape from `redis-coordinator.ts`).

> Median/sort in Lua is `O(N log N)` over the (small) node set — fine. All
> arithmetic is integer. The whole script is atomic — no read-modify-write race
> — which is what makes the cap exact: the `HGETALL`/aggregate/cap/`HSET`
> sequence sees one consistent HASH snapshot, so the `others` sum the cap
> subtracts is precisely the budget committed to peers at this instant. The
> per-node staggering happens only ACROSS heartbeats, and the cap bounds the
> committed sum (`Σ stored shares ≤ lGlobal`) regardless — a node arriving while
> incumbents still hold the whole budget computes `min(target, lGlobal - lGlobal)
> = 0` and ramps as incumbents re-heartbeat down, with no `isNew` flag and no
> separate join path. `RedisConcurrencyCoordinator` and `TestConcurrencyCoordinator`
> must therefore return identical `{share, lGlobal, nodes}` for any report
> sequence (§11.4 dual-path conformance).

---

## 11. Test substrate (TK-1316)

1. **Unit — `test/concurrency/distributed.test.ts`** (drive heartbeats with a
   fake `HeartbeatScheduler` + injected `clock`, `TestConcurrencyCoordinator`):
   - 2 nodes, `L_global` via `min`/`median` over reported `lLocal`; assert
     `share = ⌊L/N⌋ (+1 by rank)` and `Σ share = L`.
   - gate is `min(share, local.limit)`: shrink `share` → node sheds; spike RTT →
     `local.limit` drops → node sheds even with a large `share` (D-DAC-6).
   - cold start: `acquire()` rejects before first heartbeat under `fail-closed`;
     admits up to `local.limit` under `local-only`.
   - outage: `setHealthy(false)` → `fail-closed` drives `share→0`; `local-only`
     drives `share→local.limit`; recovery on `setHealthy(true)`.
   - `close()`: cancels timer, calls `leave()`, is idempotent; `acquire()` after
     close behaves per cold-start (no timer).
   - release idempotency inherited from the base guard (double-release no-op).
2. **BFS twin — `test/concurrency/distributed-leasing-model.test.ts`**: the
   `GaleHeartbeatLeasing` transition system in TS (the `active` subset plus the
   `Reallocate`/`Join`/`Leave`/`Acquire`/`Release` actions); enumerate all
   reachable states for `Nodes={n1,n2}, L=4`; assert distinct-state count equals
   the pinned TLC `MMM`; assert **`GlobalCap` and `TypeOK`** on every state;
   assert **`GlobalCapTight` is violated** (tightness); and assert at least one
   transition is a `Join` (membership growth is reachable, §9.6).
   (`SteadyOvershoot` is the documentation-only in-flight note — NOT asserted.)
3. **Property — `test/concurrency/distributed-invariant.test.ts`** (fast-check,
   numRuns 100-200): random fleets (2-6 nodes), random `lLocal` reports, random
   `acquire`/`release`/`heartbeat` interleavings with **simulated cross-node
   latency** (heartbeats land out of order). The headline assertion is the hard
   safety invariant `GlobalCap : Σ peek(KEY).shares ≤ peek(KEY).lGlobal` at every
   step (the coordinator never over-commits, §1.2/§9.1). The shrink-drain side is
   asserted **per node** (the reachable quantity), NOT as any global `Σ inflight`
   bound: a node's `inflight[n] > share[n]` can only be *draining* debt — new
   admits respect the `inflight < share` gate, so only pre-existing in-flight may
   exceed a freshly-capped/shrunk `share`, and it must then be **non-increasing
   while in debt** (§9.3/D-DAC-14), never a hard bound. (A global `Σ inflight >
   Σ share` debt branch was found unreachable in this harness and removed — see
   (b) below.) Mirror the federation property test in
   `test/...federation...latency` for structure.

   The test MUST honor these three additional requirements so the headline claim
   is actually exercised (not self-fulfilling):

   - **(a) Assert against the CONSISTENT budget, not the per-guard cached
     shares.** The reference budget for the global bound is the coordinator's
     consistent `peek(KEY).lGlobal` (a single `(L_global, live-set)` snapshot,
     §6), against which `Σ peek(KEY).shares ≤ peek(KEY).lGlobal` (`GlobalCap`)
     holds by the cap. Do NOT assert against `Σ over guards of stats().share`:
     each guard caches its last grant locally, and under simulated latency those
     caches lag the coordinator's committed shares, so the per-guard sum can
     momentarily diverge from `lGlobal` during a join even though the
     coordinator's stored shares satisfy `GlobalCap` (§1.2). `peek().lGlobal`
     (and `peek().shares`) must be an *asserted* reference, not merely a comment.
     (The per-guard `Σ stats().share` MAY be kept as an additional, weaker
     cross-check, but the headline assertion is against `peek()`.)
   - **(b) Exercise the shrink-drain / debt transient — and prove it fires.**
     Random timelines as generated by `buildFleet` (all guards instantiated and
     heartbeating from step 0, local-only cold start) **never** enter debt at the
     committed config: the **per-node** `inflight > share` branch fired 0 times
     across all seeds, so the regime asserted a property whose precondition never
     held (it was VACUOUS — finding #3). The required fix is **both** of:
     - **Bias the generator so per-node debt is provably reached.** Add a
       `shrinkBiasedScenarioArb` whose limits put node 0 strictly highest and
       node 1 strictly lowest, and PREFIX every timeline with a deterministic
       shrink transient (node 0 heartbeats solo ⇒ `share = lGlobal = l0`; fills it
       to `inflight = l0`; the lower-`lLocal` node 1 joins ⇒ `min`/lower-`median`
       drops `lGlobal` to `l1 < l0`; node 0 re-heartbeats ⇒ its grant is capped
       `< l0` ⇒ `inflight > share` ⇒ debt). Run regime B over the *union* of the
       random `varyingScenarioArb` and `shrinkBiasedScenarioArb` (broad coverage +
       guaranteed transient). Assert the per-node `inflight` is **non-increasing
       while in debt** and converges back to `≤ share`.
     - **A coverage guard that FAILS the suite if the debt branch never fires.**
       Increment a counter inside the `if (inflight > share)` body and assert it
       `> 0` in an `afterAll`, so a future regression that silently stops reaching
       debt is caught. The "shrink-drain-aware" part of the invariant must be
       *observably executed*, per §9.3 / D-DAC-14.

     **Do NOT assert a GLOBAL `Σ inflight > Σ guard.share` debt branch.** It is
     **unreachable** in this local-only cold-start harness — empirically 0 fires
     even at 20× budget (`numRuns = 3000`, `maxOps = 200`) — because a single
     node's per-node debt is always absorbed in the SUM by the slack of its
     co-shrunk peers (when `lGlobal` drops, every live node's share drops together,
     so the peers carry near-zero in-flight and near-zero slack, and the fleet
     total never exceeds the fleet share-sum). Asserting it would be a second
     vacuous branch (the same defect finding #3 raised), so it is **removed as dead
     code**; the per-node branch above is the real, reachable §9.3 guard. (The
     deterministic third-describe scenario independently constructs and asserts the
     same per-node solo-ramp → join → cap → monotone-drain transient end to end.)
   - **(c) Exercise the membership-GROWTH (budget-cap) transient.** Include a
     deterministic sub-scenario where a node joins a non-empty fleet with
     `L_global` held constant (e.g. node A alone holding share = `lGlobal`, then B
     joins). Assert that immediately after B's first heartbeat `Σ peek().shares ≤
     peek().lGlobal` (`GlobalCap`) STILL holds — B's grant is capped at
     `min(target, lGlobal − A.share) = 0` because A still holds the whole budget,
     which prevents the §1.2 1.5× over-commit — and that B earns a positive share
     only **after A re-heartbeats down** (freeing budget so B's cap admits its
     `≈ lGlobal/N` share). Also assert the stronger cap-specific case: B
     heartbeating a *second* time before A re-splits is STILL capped at 0 (the gap
     a one-shot provisional rule left open). This is the direct regression test
     for the membership-growth bound gap (§6 / D-DAC-17); a stateless equal-split
     (no cap) fails it with `Σ shares > lGlobal` and `L_global` never decreased.
4. **Dual-path conformance — `test/concurrency/coordinator-conformance.test.ts`**
   (Redis-gated; skipped without `THROTTLEKIT_TEST_REDIS`, port **6380** per
   project rule): identical report sequence through `TestConcurrencyCoordinator`
   and `RedisConcurrencyCoordinator` yields **identical** `{share, lGlobal,
   nodes}` for every node. This is the federation dual-path pattern (TK-903/908).

---

## 12. Failure modes (rows to add to `docs/FAILURE-MODES.md`, TK-1317)

| Condition | `fail-closed` (default) | `local-only` | Recovery |
|---|---|---|---|
| Coordinator unreachable | `share→0`, node sheds all (503) | `share→local.limit`, per-node self-limit; fleet may overshoot backend | Next successful heartbeat restores share |
| Node crashes holding share | Its lease TTL (`2·heartbeatMs`) expires → coordinator reclaims; survivors' shares grow next heartbeat | same | Automatic within `leaseTtlMs` |
| `L_global` shrinks (backend degraded) | Over-allocated nodes admit nothing new; in-flight drains; `Σ inflight → L_global` | same | Convergence within max request duration (§9.3) |
| Node JOINS (membership growth, `L_global` constant) | Joiner's grant is capped at the unallocated budget `lGlobal − Σ incumbent shares`, so it gets `share = 0` while incumbents still hold the whole budget (budget cap, §6/D-DAC-17); incumbents re-split DOWN on their own next heartbeats; `GlobalCap : Σ stored shares ≤ L_global` preserved — no transient over-commit | same | Joiner earns its `≈ L/N` share as incumbents re-heartbeat down (one or two heartbeats); ≈ one `heartbeatMs` join latency |
| Stale share (between heartbeats) | Node may admit up to a now-too-large share for ≤ `heartbeatMs`; bounded by `min(share, local.limit)` fast-shrink | same | Smaller `heartbeatMs` trades coordinator load for reaction speed |
| `nodeId` collision (operator error) | Two processes overwrite one HASH field → undercount → **under**-admission (safe direction) | same | Operational: enforce unique `nodeId` (doc warning) |
| Clock skew between node and coordinator | Redis uses node-supplied `expiresAt` vs coordinator `now`; large skew → premature evict (safe) or late evict (bounded by skew) | same | Keep nodes NTP-synced; doc note |

---

## 13. Decision records

- **D-DAC-1 — Dedicated `distributedAdaptiveConcurrency()` primitive, NOT a
  `federate()` extension.** `federate()`→`Limiter` (windowed rate); concurrency
  needs the `ConcurrencyGuard` event-release contract the 0.9.2 adapters accept.
  Refines PLAN §6.7's "extend federate" toward the cleaner seam. (User-approved,
  2026-05-29.) See §4.1.
- **D-DAC-2 — The heartbeat boundary IS the federation `Roll`.** `windowMs →
  heartbeat_T` is literal: lease renewal by liveness replaces budget reset by
  clock. See §3, §9.
- **D-DAC-3 — One coordination round-trip per heartbeat, not per request.** The
  share is delegated authority the node spends locally. Per-request coordination
  would reintroduce network latency into `acquire()`.
- **D-DAC-4 — `acquire()` stays synchronous; out-of-slots ⇒ shed, never await.**
  A concurrency gate that blocks on the network defeats its purpose.
- **D-DAC-5 — The guard delegates to a private `adaptiveConcurrency`; it only
  tightens the gate by `share`.** Inherits RTT/estimator/idempotency for free;
  the proof that the outer gate ⇒ inner `acquire()` succeeds is in §4.2.
- **D-DAC-6 — Effective ceiling is `min(share, local.limit)`.** Provably ≤
  `share` (safe) AND gives sub-heartbeat local reaction to RTT spikes. (Replaces
  an earlier `localFastShrink` flag — folded in unconditionally; one fewer
  option for users and implementers.)
- **D-DAC-7 — `leaseTtlMs` default `2·heartbeatMs`.** One slow heartbeat doesn't
  drop a node; a crash is reclaimed within the TTL.
- **D-DAC-8 — Aggregation policy lives on the coordinator, not the guard.**
  Fleet-wide consistency by construction. See §5.1.
- **D-DAC-9 — Budget-capped equal-split allocation in v1.** The grant is the
  equal-split target `⌊L_global/N⌋ (+1 by rank)` **capped** at the budget not
  committed to other live nodes (`max(0, min(target, L_global − Σ other live
  shares))`, the D-DAC-17 cap). At steady state `Σ share = L_global` exactly;
  under staggered heartbeats the cap holds `Σ share ≤ L_global` (`GlobalCap`)
  invariantly. Deterministic, no clawback. Skew under-utilization is a documented
  limitation (§6, §14.1). (User-approved, 2026-05-29.)
- **D-DAC-10 — Aggregate with `median` (default) or `min`; NEVER `sum`.**
  Summing rebuilds the `N·C` overshoot bug. Nodes estimate one shared quantity.
  See §7.
- **D-DAC-11 — Outage modes `fail-closed` (default) / `local-only`.** Mirrors
  federation's `onCoordinatorOutage`. Safety-default; availability opt-in.
- **D-DAC-12 — Cold-start: first heartbeat on next tick; `share=0` (fail-closed)
  or `local.limit` (local-only) until it lands.** Minimizes the startup stall;
  `await guard.heartbeat()` available to gate startup.
- **D-DAC-13 — The safety proof fixes `L_global` constant within a heartbeat
  epoch.** Each epoch independently bounded by `GlobalCap` — the federation
  per-window framing. The cap (D-DAC-17) is what makes the bound hold for any
  staggered ordering within the epoch.
- **D-DAC-14 — In-flight drain-lag is liveness, not safety.** `GlobalCap`
  (`Σ stored shares ≤ L_global`) is the hard invariant; the instantaneous
  `Σ inflight ≤ L_global` is **not**. In-flight is non-revocable, so during a
  rebalance (a peer joins and ramps while an over-provisioned node drains, or
  `L_global` shrinks under a node) `Σ inflight` can transiently exceed `L_global`,
  draining monotonically back as requests complete (the node admits nothing new —
  its `inflight < share` gate is closed). Identical to single-node
  `adaptiveConcurrency` after its estimate drops, and further clamped by
  `min(share, local.limit)` (D-DAC-6). Modeled as the documentation-only
  `SteadyOvershoot`, deliberately omitted from the spec's invariant list (§9.3).
- **D-DAC-15 — `nodeId` is required, no default.** Collisions corrupt the
  aggregate (toward under-admission — safe — but wrong); fail loud if absent.
- **D-DAC-16 — Ship Test + Redis coordinators; defer Postgres.** Mirrors
  federation's 0.8.3 (Redis) → 0.8.4 (Postgres) rollout. See §14.2.
- **D-DAC-17 — Budget cap: every grant is capped at the budget not committed to
  other live nodes (`max(0, min(target, L_global − Σ other live shares))`).**
  Closes a genuine SAFETY gap (not a docs gap): a stateless equal-split (`⌊L/N⌋`
  computed per node) over-commits under staggered heartbeats — because each node
  fetches its share independently, at a different time, from a different live-set
  snapshot, a joiner takes a positive share *before* incumbents re-split down, so
  `Σ granted shares > L_global` (up to `(N−1)/N · L_global`, a 1.5× steady-state
  overshoot on a 1→2 scale-up) with `L_global` never having decreased — directly
  contradicting the §0/§1.1 "one global ceiling" promise. The coordinator stores
  each node's currently-granted `share` and caps every new grant at the
  remainder; the committed sum `share + Σ others ≤ L_global` by construction, so
  `GlobalCap : Σ stored shares ≤ L_global` holds after every heartbeat for ANY
  interleaving with `L_global` constant. A brand-new node naturally gets share 0
  (incumbents hold the whole budget ⇒ `min(target, L_global − L_global) = 0`) and
  ramps as they re-heartbeat down — **no `isNew`/`established`/`provisional`
  bookkeeping**; the cap alone is the mechanism. It SUBSUMES and supersedes the
  abandoned "provisional join" rule (share 0 for exactly one heartbeat), which was
  insufficient: if the joiner heartbeated a second time before an incumbent
  re-split, the one-shot rule handed it a full `⌊L/N⌋` and `Σ share` exceeded
  `L_global` again; the cap re-evaluates the remainder on every heartbeat, so the
  second grant is still capped. (Provisional join was never implemented in code.)
  The dual of the drain-lag liveness note (D-DAC-14): a node *leaving* drains its
  in-flight down; a node *arriving* must not transiently over-*commit* (encoded as
  safety via the cap in `Reallocate` + the `GlobalCap` invariant, §9.4).
  Implemented in both coordinators (§10.1, §10.2), modeled in the TLA⁺ (§9.4), and
  regression-tested in the property suite (§11.3(c)). See §6.

1. **Demand-proportional allocation.** Replace equal-split with a leasing scheme
   that gives busy nodes more and idle nodes less, while preserving
   `Σ share ≤ L_global` via federation-style on-demand grants + clawback. The
   `inflight` field is already carried in `ConcurrencyReport` for exactly this.
   Candidate: 0.10.2.
2. **`PostgresConcurrencyCoordinator`.** Same `INSERT … ON CONFLICT` +
   per-window-marker shape as `PostgresCoordinator`, with a `tk_conc_state`
   table keyed by `(key, nodeId)` and a single-statement aggregate-split. Follow-up patch.
3. **Online `L_global` smoothing at the coordinator** (e.g. an EMA over
   successive aggregates) to damp cross-heartbeat oscillation beyond the
   per-node EMA. Research, not committed.
4. **Multi-backend keys in one guard** (a node fronting several backends). Today:
   one guard per `key`. Probably stays that way (composition over configuration).

---

## 15. References

- Netflix `concurrency-limits` (Gradient2) — `docs/DESIGN-NOTES.md` ("Adaptive
  concurrency (Gradient2 + AIMD)") for the verified math + citations.
- Google SRE, *Site Reliability Engineering*, ch. "Handling Overload" (adaptive
  throttling; the uncoordinated baseline).
- Burrows, *The Chubby lock service* (OSDI '06) — lease + TTL + liveness renewal.
- `research/bigger-bets/federation/DESIGN.md` (GALE, 0.8.3) — the window-coupled
  leasing proof we relabel.
- `spec/GaleFederatedLeasing.tla` — the source module for the §9.4 relabeling.

---

## Appendix A — Task breakdown & PARALLEL DISPATCH DAG (for the coding phase)

Linear-by-issue (TK-1314 ⊳ … ⊳ TK-1318), but **within** the release the
implementation parallelizes once the interface barrier (A0) lands. The coding
phase should run the fan-out below.

```
PHASE A0 (BARRIER — must land first; everything imports these types):
  A0  src/concurrency/coordinator.ts        ConcurrencyReport / ConcurrencyGrant /
                                            ConcurrencyCoordinator   (§5.1)
      + this DESIGN.md + spec/GaleHeartbeatLeasing.tla|.cfg          (TK-1314 commit)

PHASE A1 (FAN-OUT — all import A0, mutually independent):
  A1a src/concurrency/distributed.ts                 distributedAdaptiveConcurrency (§5.2, §4.2, §8)
  A1b src/concurrency/test-concurrency-coordinator.ts TestConcurrencyCoordinator  (§10.1)
  A1c src/concurrency/redis-concurrency-coordinator.ts RedisConcurrencyCoordinator (§10.2)
  A1d spec/GaleHeartbeatLeasing.tla + .cfg created, TLC run, counts recorded (§9.6)

PHASE A2 (DEPENDS A1):
  A2a src/index.ts exports                           (needs A1a/A1b/A1c)   (§5.4)
  A2b test/concurrency/distributed.test.ts           (needs A1a+A1b)       (§11.1)
  A2c test/concurrency/distributed-leasing-model.test.ts (needs A1d counts)(§11.2)
  A2d test/concurrency/distributed-invariant.test.ts (needs A1a+A1b)       (§11.3)
  A2e test/concurrency/coordinator-conformance.test.ts (needs A1b+A1c, Redis-gated) (§11.4)
  A2f examples/distributed-concurrency.ts            (needs A1a+A1b)

PHASE A3 (release prep — TK-1317 docs + TK-1318 ship; serial, last):
  A3a docs/FAILURE-MODES.md rows (§12); wiki Distributed-Adaptive-Concurrency.md +
      _Sidebar.md (accumulate locally on tk-wiki, push at tag time)
  A3b package.json + src/index.ts version 0.9.2→0.10.0; src/cli/index.ts; CHANGELOG
      [0.10.0]; SCOREBOARD test count refresh
  A3c npm run check; commit chain; (await user authorization before tag/publish)
```

Commit shapes (no Co-Authored-By; each commit passes `npm run check`):

| TK | Commit |
|---|---|
| TK-1314 | `docs(research): distributed adaptive concurrency design + GaleHeartbeatLeasing TLA⁺ + TLC counts (TK-1314)` |
| TK-1315 | `feat(concurrency): distributedAdaptiveConcurrency primitive + ConcurrencyCoordinator (Test+Redis) (TK-1315)` |
| TK-1316 | `test(concurrency): heartbeat-leasing BFS twin + property invariant + dual-path conformance (TK-1316)` |
| TK-1317 | `docs(concurrency): wiki Distributed-Adaptive-Concurrency + example + FAILURE-MODES rows (TK-1317)` |
| TK-1318 | `chore(release): prepare 0.10.0 (distributed adaptive concurrency) (TK-1318)` |
