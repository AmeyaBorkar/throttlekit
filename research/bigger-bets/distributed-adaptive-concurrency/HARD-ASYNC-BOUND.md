# A HARD async `Σ inflight ≤ L_global` bound (acknowledged handoff)

**Status:** ✅ **BUILT + machine-verified** (TK-1330, D-DAC-19). Opt-in
(`acknowledgedHandoff`, default off). Model-checked with TLC and a Java-free BFS
twin; implemented in both coordinators (Test + Redis) with dual-path conformance.
This doc records the scoping, the **corrected** reserve rule (the rule first
proposed below in §2 was *refuted* by model-checking — see §4), and the result.

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
