# 06 · Concurrency

> Capping *in-flight* requests at an inferred ceiling rather than a hand-tuned constant — and making that
> ceiling correct across a fleet sharing one backend. Source: `src/concurrency/`, `spec/GaleHeartbeat*.tla`.

## Purpose

Rate limiting answers "is this client asking too often?"; concurrency control answers "is the service
about to fall over?". A static concurrency cap assumes you know the safe number in advance, but under real
load — cold caches, a slow dependency, a noisy neighbor — it changes minute to minute. ThrottleKit infers
it. The single-process limiter grows the ceiling while latency stays low and contracts under load
(TCP-congestion-control style); the distributed coordinator makes N processes fronting one shared backend
respect a single, cooperatively-inferred global ceiling — closing the gap where N independent limiters
would each infer a ceiling for the *whole* backend and collectively admit `N×` capacity.

## Single-process inference (`adaptiveConcurrency`)

`acquire()` returns a `Lease { ok, release }`; rejections reuse one frozen no-op lease (no allocation, no
slot). The control loop measures the latency **gradient** (`src/concurrency/adaptive.ts:351`):

```
gradient = clamp((tolerance · rttNoload) / rtt, 0.5, 1.0)     // 1.0 ⇒ no queueing; < 1.0 ⇒ queue forming
```

`rttNoload` is a *windowed* rolling minimum over the last `rttWindow` samples via a monotonic deque (O(1)
amortized), so the baseline can drift *up* after a deploy rather than being pinned to an all-time minimum.
The gradient2 update law:

```
queueSize = √estimate
newLimit  = estimate · gradient + queueSize
estimate  = EMA(estimate, newLimit), clamped to [minLimit, maxLimit]
```

The `√estimate` headroom yields fast growth at small limits and stability at large ones — the familiar
congestion-control sawtooth that continuously probes for capacity. A guard prevents growing while
under-utilized (a sample taken well below the ceiling carries no "could go higher" information). An opt-in
AIMD law (multiplicative decrease, additive increase) and an opt-in Envoy-style **minRTT recalibration**
(periodically clamp the ceiling so queues drain and the no-load baseline can be re-measured cleanly) round
it out. There is no background timer — every adjustment happens on the lease-settle path.

## The distributed protocol (`distributedAdaptiveConcurrency`)

Two mechanisms compose. A *private* `adaptiveConcurrency` owns capacity estimation (RTT, the local limit
`L_local`, in-flight count, release idempotency). A `ConcurrencyCoordinator` folds every live node's
`L_local` into a global `L_global` and splits it into per-node `share`s. The effective ceiling is:

```
min(share, L_local)
```

Both terms are ≤ `L_local`, so whenever the outer gate admits, the inner `local.acquire()` is guaranteed
to succeed.

**The heartbeat cycle** (`src/concurrency/distributed.ts:455`). Each node stamps a strictly-increasing
sequence number, samples `(L_local, inflight, appliedGen, expiresAt)` *synchronously before the await* (JS
single-threading gives a torn-free snapshot — load-bearing for handoff), and calls
`coordinator.heartbeat(report)`. The coordinator's compute (`src/concurrency/heartbeat-core.ts`, the single
source shared by the Test and Postgres coordinators; the Redis Lua is a transcription held to it by the
dual-path test): upsert self, evict nodes whose lease expired (self always survives), aggregate the live
locals with `min` or lower-`median` (**never sum** — sum would re-introduce the `N×` fan-out), compute a
target split, then **cap** it.

### The occupancy cap (the safety core)

The cap reserves, for every *other* node, `max(its granted share, its actual in-flight)`:

```
share = max(0, min(target, L_global − Σ_other max(rec.share, rec.inflight)))
```

Reserving the larger of a peer's granted share and its actual occupancy makes `Σ share ≤ L_global` a hard
invariant **and** `Σ inflight ≤ L_global` a *synchronous* one — a node joining the fleet cannot be granted
budget an incumbent is still occupying. This is the decision that keeps a stateless `⌊L/N⌋` split from
over-admitting the instant a node joins (when the incumbent still holds its larger pre-join share).

### Acknowledged handoff (the hard async bound, opt-in)

The occupancy cap makes `Σ inflight ≤ L` synchronous, but a guard still admits against its *cached* grant
while a reduction is in flight, leaving a bounded (~1.5×) self-draining residual. Acknowledged handoff
closes that hole: the cap reserves `max(unackedHigh, inflight)`, where `unackedHigh` is the highest grant
the coordinator has *issued but not yet seen acknowledged*. Reserving on what the coordinator itself issued
(lag-free) rather than on a laggy peer report is what defends a late-landing grant; once the peer echoes an
`appliedGen ≥ committedGen`, the reserve drops back to the acknowledged share. This makes
`Σ inflight ≤ L_global` a **hard instantaneous bound** under grant-reply and reporting lag — at the cost of
ramp latency. **Eager/event-driven heartbeats** (opt-in) collapse that ramp toward its physical floor
(drain + one RTT) by firing one debounced off-cycle beat on three triggers (a node capped below fair
share, in-flight drained below a lowered share, or a generation-changing grant applied) — without loosening
any bound, since an off-cycle beat is just a report at a different time.

### Self-fencing (partition safety, opt-in)

A partition usually *hangs* rather than throws, so a partitioned node could keep admitting against its
last-known share while the coordinator reassigned its budget. Self-fencing enforces the lease on the
node's **own** clock: once `now ≥ leaseExpiresAt − fenceSafetyMargin`, the node fences itself (effective
ceiling 0) and fires `onFenced` once so the app can abort non-cancellable work — stopping *strictly before*
the coordinator's reclaim.

## Design decisions & rationale

- **The occupancy cap `max(share, inflight)`** is the safety core: it holds `Σ share ≤ L_global` under
  *every* interleaving and makes `Σ inflight ≤ L_global` synchronous for free.
- **Acknowledged handoff reserves on `maxUnacked`, not on peer reports**, because the coordinator's own
  issued-but-unacked grant is the exact term a laggy report misses; the two reserve terms (unacked-high and
  reported-inflight) are each individually necessary and their union is sufficient.
- **Fence tokens were rejected for this.** A monotonic fence token fences *one* exclusive resource; a
  concurrency budget is a *fungible count* of interchangeable slots — there is no single token to bump.
  Without either a timing assumption or backend fence tokens, bounding `Σ inflight` across a partition is
  provably impossible (FLP / CAP), and tokens don't fit the shape regardless — so self-fencing under a
  stated bounded-clock-drift assumption is the chosen mechanism.
- **Aggregate ∈ {min, median}, never sum** — and it lives on the coordinator so every node on a key agrees;
  summing would re-create the very `N×` over-admission the coordinator exists to prevent.
- **Demand-proportional allocation (opt-in)** gives idle budget to hungry nodes (with a floor of 1 slot so
  every node can still reveal demand), adding utilization under skew with *zero* effect on safety — the cap
  enforces both bounds for any target.
- **`nodeId` is required** (a collision corrupts the aggregate), and **`leaseTtlMs` defaults to
  `2 × heartbeatMs`** so one slow beat can't drop a healthy node.

## Caveats

- A lone process's adaptive limiter is just an inference; under fan-out, N copies over-admit unless wired
  through a coordinator.
- Without acknowledged handoff, the occupancy cap leaves a bounded ~1.5× `Σ inflight` overshoot during a
  rebalance (self-draining).
- Self-fencing's `fenceSafetyMargin` **must** exceed the maximum clock offset + drift over one
  `leaseTtlMs` (and, for non-cancellable in-flight work, the max request duration); the dangerous direction
  is the coordinator's clock running ahead of the node's.
- The per-beat `(seq/appliedGen, inflight)` snapshot must be atomic — a fresh-generation + stale-inflight
  report would refute the bound (the spec pins this as a negative test).
- The default coordinator backends (single Redis / single Postgres primary) are a SPOF; during failover
  guards fall to `onCoordinatorOutage`.

## What proves it

- `spec/GaleHeartbeatHandoff.tla` — proves `GlobalCap` (Σ committed ≤ L) and `InflightCap` (Σ inflight ≤ L)
  on **all 250,624 reachable states**; an intentionally-violated tight invariant shows L is the *least*
  upper bound; the minimality of each reserve term and the torn-report negative are pinned.
- `test/concurrency/distributed-async-leasing-model.test.ts` — a CI BFS twin that refutes the weaker
  reserve rules and proves their union is a hard bound.
- `test/concurrency/distributed-invariant.test.ts` — property tests over random fleets with out-of-order
  grant delivery.
- `test/concurrency/distributed-self-fence-model.test.ts` — derives the exact safety margin and refutes a
  too-small one.
- `test/concurrency/coordinator-conformance.test.ts` — dual-path `Test ≡ Redis` step-for-step.
- `test/concurrency/distributed-eager-handoff.test.ts`, `distributed-demand-proportional.test.ts`,
  `adaptive.test.ts`, `adaptive-recalibration.test.ts`, `postgres-concurrency-coordinator.test.ts`.

## Source map

`src/concurrency/adaptive.ts` · `distributed.ts` · `coordinator.ts` · `heartbeat-core.ts` ·
`redis-concurrency-coordinator.ts` · `postgres-concurrency-coordinator.ts` ·
`test-concurrency-coordinator.ts` · `spec/GaleHeartbeatHandoff.tla`, `spec/GaleHeartbeatLeasing.tla`.
