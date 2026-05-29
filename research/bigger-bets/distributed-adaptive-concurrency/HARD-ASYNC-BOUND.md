# Scoping: a HARD async `Σ inflight ≤ L_global` bound (acknowledged handoff)

**Status:** scoping only (TK-1330). Not designed-locked, not built. Target: a 0.10.x
opt-in if the latency tradeoff is judged worth it.

**Context.** 0.10.0 shipped the **occupancy cap** (D-DAC-18): the coordinator reserves
each peer's `max(share, inflight)`, and the guard applies grants monotonically. This
**eliminates the synchronous / protocol-level rebalance overshoot** — proven
exhaustively in `GaleHeartbeatLeasing.tla` + the BFS twin (`InflightCap` on all 76
reachable states) and witnessed in the common low-latency case (1.5×→1.0×). It does
**not** make `Σ inflight ≤ L_global` a hard *instantaneous* invariant of the async
system. This doc scopes what would.

## 1. The residual (why 0.10.0 is not enough)

Adversarial review (3-skeptic workflow) found, and a deterministic test now pins, a
**1.5× overshoot under fail-closed / constant `L_global` / both nodes coordinator-live**
(`test/concurrency/distributed-invariant.test.ts` → "async reply-lag residual"). The
synchronous spec collapses two lags to zero that are independently live in the real
system:

1. **Committed-vs-applied share lag.** The guard admits against its **cached (applied)**
   share — the last grant that *landed*. When the coordinator lowers a node's
   **committed** share (freeing budget for a joiner) but that reply is still in flight,
   the node keeps admitting against the stale-high applied share.
2. **Reporting lag.** The occupancy cap reserves a peer's **last-reported** `inflight`.
   A node that re-acquires *after* reporting low is under-reserved by its peers.

Reproduced trace (L=6): A solo→share 6→fills, drains to 2, re-HBs (reports inflight 2);
B joins→0; A re-HBs → coordinator **commits A=3** but the reply is *parked* (A still
*applies* 6); B re-HBs → granted 3 against A's committed-3 + reported-2; A re-acquires
against its stale applied 6. `Σ inflight = 6 + 3 = 9 > L = 6`.

The residual is **bounded (~1.5–2×) and self-draining** — the same eventual-consistency
property as the rest of the distributed library (federation, regional escrow). It is a
*transient*, not a runaway; `GlobalCap` (`Σ committed share ≤ L`) stays hard throughout.

## 2. The fix: acknowledged handoff

A hard instantaneous bound is achievable without per-request coordination (which would
defeat D-DAC-3, one round-trip per heartbeat) by making **share expansion lag confirmed
relinquishment**:

- **Wire change.** `ConcurrencyReport` carries the node's **currently-applied share**
  (the value its gate enforces) — or, equivalently, the **grant sequence number** it has
  applied (the coordinator stamps each grant with a seq; the node echoes the highest it
  has applied).
- **Cap change.** The coordinator reserves, per peer `j`:
  ```
  reserve_j = max(committed_share_j, reported_applied_share_j, reported_inflight_j)
  ```
  - `committed_share_j` closes the **grow** direction (a peer that just had its share
    *raised* and is using it, before it has re-reported — the coordinator knows what it
    granted).
  - `reported_applied_share_j` closes the **shrink** direction (the confirmed hole: a peer
    still gating on a stale-high grant the coordinator already lowered).
  - `reported_inflight_j` is subsumed (`inflight ≤ applied`) but kept defensively.

Effect: a joiner is granted freed budget **only after the incumbent has confirmed
(via its report) that it lowered its applied share** — i.e. the budget is re-granted from
*confirmed-relinquished* capacity, not *predicted-to-be-relinquished*. The overshoot
becomes a **ramp delay** (≈1–2 extra heartbeats for the joiner), never an overshoot.

This is the classic safe-lease-handoff discipline (never reuse a lease until you've
*observed* it released), applied to the share itself — a natural fit with the GALE
escrow-leasing model.

## 3. Cost / tradeoff (the product call)

- **Ramp latency.** A node gaining share waits for incumbents' lowering grants to *land*
  AND be *reported* before it ramps — the fundamental price of a hard bound under
  periodic heartbeats. Worse for long-RTT grants / long heartbeat periods.
- **Wire-protocol change.** `ConcurrencyReport` gains a field (applied-share or seq). A
  versioned, additive change — but a wire change nonetheless (coordinate with DR-14).
- **Coordinator state.** Per-peer applied-share/seq tracking (already O(N) state, so no
  asymptotic change).
- **Likely an opt-in policy**, not the default: workloads that tolerate brief 1.5×
  bursts and want fastest ramp keep D-DAC-18; workloads needing a hard ceiling pay the
  ramp latency.

## 4. Open subtlety (must be model-checked, not hand-waved)

`reported_applied_share_j` itself lags *actual* applied (between a node applying a grant
and its next heartbeat). The claim that `max(committed, reported_applied)` closes **both**
directions rests on: grow is covered by `committed` (coordinator-known), shrink by
`reported_applied`. But a careful interleaving where applied *increased* yet the report is
stale-low, with committed also stale, needs the model to confirm — or per-grant seq-ack
(strictly stronger) is required. **Do not ship on the hand-argument.**

## 5. Verification plan (the acceptance gate)

1. **Extend `GaleHeartbeatLeasing.tla`** to model the async gap explicitly: split `share`
   into `committed[n]` (coordinator) and `applied[n]` (guard), add a `Deliver(n)` action
   (applied ← a not-yet-delivered committed value, out of order) and a `Report(n)` action
   (coordinator's view of n ← n's current applied/inflight, lagging). Add the
   `max(committed, applied, inflight)` reserve in `Reallocate`. Then `InflightCap` over
   *applied*-driven inflight must hold on every reachable state. **This is the gate** —
   if TLC/twin find a counterexample, the wire field isn't enough and seq-ack is needed.
2. **BFS twin** reproduces the new (larger) state space; pin the count.
3. **Property test** must *reach* the committed-vs-applied interleaving (the current
   harness passed the false bound by coverage luck). Drive parked + reordered replies as
   a first-class op; the deterministic "async reply-lag residual" test flips from
   *documents overshoot* to *asserts ≤ L*.
4. **Dual-path** Test ≡ Redis for the new report field + reserve rule.

## 6. Relationship to the shipped 0.10.0

Strictly additive and opt-in. D-DAC-18 (occupancy cap + monotonic application) stays —
acknowledged handoff *builds on* it (it still reserves occupancy; it adds the
applied-share confirmation). `GlobalCap` is unchanged and remains hard. The honest 0.10.0
contract (synchronous-hard + bounded async residual) is the floor; this lifts the async
case to hard at a latency cost.
