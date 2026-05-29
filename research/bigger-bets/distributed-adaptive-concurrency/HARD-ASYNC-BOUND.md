# A HARD async `Σ inflight ≤ L_global` bound (acknowledged handoff)

**Status:** ✅ **BUILT + machine-verified** (TK-1330, D-DAC-19). Opt-in
(`acknowledgedHandoff`, default off). Model-checked with TLC and a Java-free BFS
twin; implemented in both coordinators (Test + Redis) with dual-path conformance.
This doc records the scoping, the **corrected** reserve rule (the rule first
proposed below in §2 was *refuted* by model-checking — see §4), and the result.

> **Completed end to end (TK-1331 / TK-1332).** §1–§6 close the bound for *live,
> cooperating* nodes at a ramp-latency cost. **§7 (eager handoff, D-DAC-20)** removes
> that cost — the bound stays hard, the ramp drops to the physical floor. **§8
> (self-fencing, D-DAC-21)** closes the one remaining residual — a crashed/partitioned
> node's in-flight — under the standard bounded-clock-skew assumption, and states the
> FLP/CAP frontier honestly. Together: a hard `Σ inflight ≤ L_global` with near-floor
> ramp for live nodes and a closed partition case, no asterisks beyond a stated,
> universal timing assumption.

**Context.** 0.10.0 shipped the **occupancy cap** (D-DAC-18): the coordinator
reserves each peer's `max(share, inflight)`, and the guard applies grants
monotonically. This **eliminates the synchronous / protocol-level rebalance
overshoot** but does **not** make `Σ inflight ≤ L_global` a hard *instantaneous*
invariant of the async system — a bounded (~1.5×), self-draining residual remains.
Acknowledged handoff (this doc) lifts the async case to a **hard** bound.

## 1. The residual (why 0.10.0 is not enough)

Adversarial review (3-skeptic workflow) found, and a deterministic test pins, a
**1.5× overshoot under fail-closed / constant `L_global` / both nodes coordinator-
live** (`distributed-invariant.test.ts` → "async reply-lag residual"). The
synchronous spec collapses two lags to zero that are independently live:

1. **Committed-vs-applied share lag.** The guard admits against its **cached
   (applied)** share. When the coordinator lowers a node's **committed** share
   (freeing budget for a joiner) but that reply is still in flight, the node keeps
   admitting against the stale-high applied share.
2. **Reporting lag.** The occupancy cap reserves a peer's **last-reported**
   `inflight`; a node that re-acquires after reporting low is under-reserved.

The residual is **bounded (~1.5–2×) and self-draining** — the same eventual-
consistency property as the rest of the library; `GlobalCap` (`Σ committed share ≤
L`) stays hard throughout.

## 2. The fix: acknowledged handoff — the **validated** rule

> **Correction.** This section originally proposed `reserve_j = max(committed_j,
> reported_applied_share_j, reported_inflight_j)`. Model-checking **REFUTED** that
> rule (it is the BFS twin's `committed-snapshot` rule; it overshoots to exactly
> 1.5×L — see §4). The validated rule replaces the `committed/reported_applied`
> share term with the **max un-acknowledged grant** (true per-grant seq-ack):

```
reserve_j = max( maxUnackedGrant_j , reported_inflight_j )
```

- **`maxUnackedGrant_j`** — the largest share VALUE the coordinator has issued to
  `j` that `j` has **not confirmed superseding**. The coordinator reserves on what
  **it itself issued** (lag-free knowledge), NOT on a laggy peer report — so a
  grant a peer may still apply but has not yet acked is reserved even before the
  peer reports it. This closes the reporting-lag hole at its root. It cannot be
  collapsed to `max(committed, reported_applied)`: an intermediate grant **spike**
  (issue 4, then 6, then 3; peer acks the 4) has un-acked-suffix max 6 that neither
  `committed=3` nor `reported_applied=4` sees.
- **`reported_inflight_j`** — defends **non-revocable in-flight that drains below a
  lowered+acked share** (the occupancy outlives the grant that authorized it; that
  grant may already be pruned from the un-acked set). NOT subsumed by the grant
  term — both are independently necessary (§4 minimality).

**Wire (additive, DR-14).** Each `ConcurrencyReport` carries the node's heartbeat
`seq` and the grant **generation** (`appliedGen`) its guard is enforcing, sampled
**atomically** with `inflight`. Each `ConcurrencyGrant` carries a `gen` the
coordinator bumps **only when the granted value changes**.

**Implementation (O(1) per peer).** The coordinator tracks `committedGen`
(value-change generation), `maxSeq` (freshness gate against reordered heartbeats),
and `unackedHigh` (the reserve floor = running max grant since the peer last caught
up, **reset** when `appliedGen ≥ committedGen`). Because gen bumps only on a value
change, a stable value lets the peer's `appliedGen` reach `committedGen` and the
floor resets — no per-heartbeat ratchet. A peer that never echoes `appliedGen`
(old guard) never resets → the **safe, over-reserving** direction.

Effect: a joiner is granted freed budget **only after the incumbent confirms
(via its echoed `appliedGen`) that it lowered its applied share AND its in-flight
has drained** — the overshoot becomes a **ramp delay** (≈1–2 heartbeats), never a
violation.

## 3. Cost / tradeoff (why opt-in)

- **Ramp latency.** A node gaining share waits for incumbents' lowered grants to
  *land* AND be *reported* before it ramps — the price of a hard bound under
  periodic heartbeats. Worse for long-RTT grants / long heartbeat periods.
- **Wire + state.** `ConcurrencyReport` gains `seq`/`appliedGen`; `ConcurrencyGrant`
  gains `gen`; the Redis field widens 4→7 ints (additive; legacy 4-int values parse
  as 0). Per-peer coordinator state stays O(N) (three extra scalars).
- **Default off.** Workloads tolerating brief 1.5× bursts keep D-DAC-18 (fastest
  ramp). Workloads needing a hard ceiling pay the ramp latency via
  `acknowledgedHandoff: true`. All nodes/coordinators on a key MUST agree (like
  `aggregate`); enable only once every guard echoes `appliedGen`.

## 4. The open subtlety — RESOLVED by model-checking (do not ship on the hand-argument)

This section warned that `max(committed, reported_applied)` "needs the model to
confirm — or per-grant seq-ack is required." The model **confirmed seq-ack is
required**, and found a *second*, independent failure mode. The BFS twin
(`distributed-async-leasing-model.test.ts`) proves **minimality + sufficiency**:

- `committed-snapshot` = `max(committed, reported_applied, reported_inflight)`
  (the originally-proposed §2 rule) — **REFUTED**, peaks at exactly 1.5×L (a
  late-landing un-acked high grant the report-based terms never see).
- `grant-suffix-only` = `maxUnackedGrant` alone — **REFUTED**, the non-revocable
  in-flight drains below a lowered+acked share (uncovered occupancy).
- `acknowledged-handoff` = `max(maxUnackedGrant, reported_inflight)` — **HARD +
  TIGHT** (Σ inflight ≤ L on every reachable state, and reaches L) for nodes∈{2,3},
  L∈{4,6}, K∈{2,3,4} (K-stable ⇒ hazard saturates at 2 outstanding grants).

A further required constraint surfaced (a torn-report negative test pins it): the
`(appliedSeq/appliedGen, inflight)` report MUST be a single atomic snapshot, and
the coordinator must advance its ack-floor and reported-inflight transactionally —
a torn report (fresh gen + stale inflight) reopens the overshoot. JS's
single-threaded guard read gives this for free.

## 5. Verification (the acceptance gate — PASSED)

1. **TLA⁺ `spec/GaleHeartbeatHandoff.tla`** models the async gap explicitly
   (`hist`/`appliedIdx` for committed-vs-applied + out-of-order monotonic delivery,
   lagging `ackIdx`/`repInflight`, atomic `Report`, the `max(maxUnacked, repInflight)`
   reserve). **TLC 2.19 (OpenJDK 17): TypeOK + GlobalCap + InflightCap hold on all
   250,624 reachable states (L=4, K=3, depth 37, no error); InflightCapTight is
   violated (reaches L) ⇒ tight.** (Also re-ran TLC on the 0.10.0
   `GaleHeartbeatLeasing` spec: 76 distinct states = the BFS twin's pinned 76 —
   TLC parity, previously pending a Java env, now confirmed.)
2. **BFS twin** (TK-1330a) — CI oracle (no Java in CI); minimality + sufficiency +
   torn-report negative test; pinned distinct=12387 for the 2-node/L=4/K=2 config.
3. **Property test** REACHES the committed-vs-applied interleaving: the
   deterministic 1.5× reviewer counterexample FLIPS from overshoot to
   `Σ inflight ≤ L_global` under handoff (real guard + coordinator), with the joiner
   held until the incumbent acks, then ramping (a delay, not a deadlock).
4. **Dual-path** Test ≡ Redis: 26 conformance cases against live Redis (the
   spike/hold-until-acked/inflight-union/stale-seq logic; `gen` compared).

## 6. Relationship to 0.10.0

Strictly additive and opt-in. D-DAC-18 (occupancy cap + monotonic application) stays
the **default** — acknowledged handoff *builds on* it (still reserves occupancy via
the `reported_inflight` term; adds the un-acked-grant confirmation). `GlobalCap` is
unchanged and remains hard. The honest 0.10.0 contract (synchronous-hard + bounded
async residual) is the floor; this lifts the async case to **hard** at a latency cost.

## 7. Removing the latency cost — eager (event-driven) handoff (D-DAC-20, TK-1331)

The §3 cost (ramp latency, ~1–2 heartbeats) is **not fundamental** — it is an artifact
of *batching the budget transfer onto the periodic heartbeat tick*. This is the
Doorman / Kubernetes-APF poll shape; credit-based flow control (InfiniBand FCP, HTTP/2
`WINDOW_UPDATE`) and watch-based semaphores (ZooKeeper/Chubby/etcd) escape it by moving
the transfer onto the **release event**. We do the same, **guard-side only** (opt-in
`eagerHandoff: true`): the guard fires an OFF-CYCLE heartbeat the instant local state
shows the allocation is stale:

- **PULL** — the node is capped *below its fair share* (`share < ⌊lGlobal/nodes⌋`,
  computed from the already-returned `lGlobal`/`nodes` — **no new wire field**). It has
  demand it can't satisfy and budget is coming, so it re-beats to claim it. (Probing
  only *below fair* — not merely "blocked by share" — is what the model proved
  necessary: a node *at* its fair share is always blocked-by-share, so the naive signal
  loops forever at steady state.)
- **PUSH** — an incumbent's in-flight drains to ≤ its (lowered) share with capacity it
  has not yet reported. It re-beats so peers can claim the freed budget now.
- **ACK** — the node applied a grant whose generation changed (a lowered share). Under
  acknowledged handoff the coordinator reserves the node's un-acked-high grant until it
  confirms; the node re-beats promptly to confirm. (The model showed this is the
  load-bearing trigger: without it, an incumbent that lowered but isn't draining sits on
  its un-acked grant until its next *periodic* beat, starving the joiner.)

Off-cycle beats are **debounced** to ≥ `minHeartbeatMs` apart, coalesced through ONE
pending timer — so steady state adds **zero** beats; the burst is transient, during a
rebalance only.

**Why it is safe for free.** Eager beats add no new action — an off-cycle beat is just a
`Report`/`Reallocate` at a different *time*. The §4–§5 async model (BFS twin + TLC)
quantifies over **every** interleaving of those actions and proves `Σ inflight ≤ L` on
every reachable state. So any eager execution is a path the model already covers — the
hard bound is preserved with no new proof obligation. What changes is *liveness*.

**Verification (the liveness win).** A phase-swept sim of the REAL guard + coordinator
(`distributed-eager-handoff.test.ts`) sweeps the joiner's arrival across a heartbeat
period and measures ramp-to-fair:

- periodic-only ramp is a **flat ~2× heartbeat** (one beat for the incumbent to report
  the drain, one for the joiner to pick up);
- eager removes the **entire second beat**: mean ≈ ½ heartbeat + drain, **floor ≈ drain
  + one round-trip** (≪ a heartbeat);
- `Σ inflight ≤ L` at **every** phase, eager or not (the safety regression guard).

**The irreducible floor (stated honestly).** When the fleet is *saturated*, a new
admission must wait for an in-flight op to complete somewhere — that is Little's Law, the
definition of the cap, not a tunable. Eager handoff drives the *signaling* term to its
minimum but cannot remove that physical wait. The one residual *protocol* term is the
pull-model **"incumbent discovers it should lower on its next beat"** ([drain+RTT,
heartbeat], avg ½ heartbeat) — shrinkable via `heartbeatMs` (cheap, since eager fires
only during transients). A coordinator→incumbent **push** (Redis pub/sub) would remove
even that; documented as future, **not** claimed here.

**The pitch-perfect config** is therefore `{ acknowledgedHandoff: true, eagerHandoff:
true }`: a hard `Σ inflight ≤ L_global` bound **and** a near-floor ramp — the two
properties the 0.10.1 toggle forced you to choose between, now both.

## 8. Closing the partition residual — self-fencing (D-DAC-21, TK-1332)

The last residual (D-DAC-14): a crashed or network-partitioned node keeps serving its
already-accepted in-flight, and in 0.10.x kept *admitting* against its last-known share
until a heartbeat **threw** — but a partition **hangs** rather than throwing, so the
node over-admitted for the whole partition while the coordinator reassigned its budget
(`Σ inflight > L_global`, bounded by the budget but persistent — the unreachable node
never learns). 0.10.x documented this as liveness-only / effectively unfixable. **It is
fixable** — under a clearly-stated, standard assumption.

**Self-fencing (default ON under `fail-closed`).** The node enforces its lease on its
**own clock**: it stops admitting (`effectiveLimit → 0`) at `lastSuccessfulBeatExpiresAt
− fenceSafetyMargin`, strictly *before* the coordinator's reclaim. This is family-2 lease
self-expiry — Chubby's jeopardy/grace, Kubernetes' `leaseDuration > renewDeadline`.
Crucially it triggers on **elapsed silence**, not on a beat *failing* — which is exactly
what a partition produces (a hang), and exactly what 0.10.x's throw-driven fail-closed
missed. An `onFenced` hook lets the app **abort** in-flight (e.g. `AbortController`),
draining the occupancy so the overshoot is closed end to end; non-cancellable in-flight
instead needs the margin to cover its max request duration. A healthy node (beats keep
landing) **never** fences; `stats().fenced` exposes the state.

**The assumption, made explicit (the load-bearing one): node↔coordinator clock skew ≤
`fenceSafetyMargin`.** A timed-model gate (`distributed-self-fence-model.test.ts`)
derives the exact requirement and refutes a smaller margin:

- with abort: `fenceSafetyMargin ≥ maxSkew` ⇒ zero overshoot for every skew ≤ maxSkew;
  a margin *below* maxSkew is **refuted** (overshoot reachable) — pinning the minimum;
- without abort: `fenceSafetyMargin ≥ maxSkew + maxReq` (the un-aborted in-flight must
  drain before reclaim) ⇒ zero overshoot; `= maxSkew` is **refuted**.

Default margin `(leaseTtlMs − heartbeatMs)/2`, so one slow beat never fences a healthy
node. Default OFF under `local-only` (which deliberately serves through an outage). The
real-guard suite (`distributed-self-fence.test.ts`) proves the headline end to end: A
self-fences + aborts *before* the coordinator reclaims ⇒ B takes over with `Σ inflight ≤
L` (vs the documented overshoot with `selfFence: false`).

### Why not fence tokens — and the honest impossibility frontier

Fence tokens (Kleppmann) are the *clock-free* alternative for the partition problem, and
the natural question is why we don't ship them. **They fence a *discrete* resource** —
the backend rejects any request carrying a token below the highest it has seen, ordering
successive holders of one lock. This budget is a **fungible, counting** resource (`L`
interchangeable slots across `N` holders); a partitioned node's budget is reassigned
*fungibly* to peers, with no discrete chain-of-custody for a token to order. To bound a
*count* with fencing you need a **count-aware admission point at the backend** (a
distributed semaphore keyed on lease validity) — which is a different architecture
(resource-side enforcement, duplicating the gateway limiter), and which the library
cannot provide because it does not control the backend. Self-fencing is the **gateway-side
fit**, which is what this library is.

The frontier is therefore precise, and it is a **theorem, not a tradeoff we chose**: with
**neither** a timing assumption (self-fencing) **nor** backend cooperation (resource-side
fencing) — pure asynchrony, a dumb backend, an unreachable node — bounding `Σ inflight ≤
L_global` across a partition is **provably impossible** (FLP: a slow node and a dead node
are indistinguishable; Two Generals: you cannot get an acknowledgement across a partition;
CAP: under a partition you trade C or A). You cannot revoke work from a node you can
neither reach nor detect. "No tradeoff" means giving every *satisfiable* deployment a path
— self-fencing for the (universal) bounded-clock case, resource-side admission for those
who can cooperate at the backend — and stating the impossible case as the mathematics it
is.
