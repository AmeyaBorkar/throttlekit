# 04 · Two-tier engine & leasing (GALE)

> The distributed engine: how a fleet enforces one global limit without paying a network round trip per
> request — and how the over-admission is held to a hard, *fleet-size-independent* bound. Internally this
> is **GALE** (*Globally-Accounted Learned Escrow*) — provable distributed leasing. Source: `src/twotier/`, `spec/`, `docs/FORMAL-MODEL.md`.

## Purpose

A purely distributed limiter pays one round trip to the shared store on *every* request — the wrong cost
exactly when traffic (and attacks) spike. The two-tier engine fronts the distributed tier (L2) with a
local tier (L1) and lets you choose the consistency/throughput trade per limiter. Its headline mode —
*leased* — collapses steady-state network cost to roughly **one round trip per `batch` requests** while
keeping a provable bound on how far global admissions can exceed the limit. With window-coupling, that
bound becomes **exactly the limit, independent of the number of nodes**.

```
request ─► L1 (in-process, sync)
              │  decisive locally?  ──► return (0 network)
              │  needs authority?   ──► L2 (Redis, atomic Lua) ──► update L1
              ▼
           Decision
```

## The three modes

`twoTier({ strategy, l2, mode, lease? })` returns a `Limiter` (`src/twotier/index.ts:163`):

- **`strict`** — every check consults L2 directly. Exact, 1 RTT/request, no local state. The safe default
  for hard quotas and billing.
- **`cached-deny`** — allowed traffic still hits L2 (so allows stay globally exact), but **denials are
  cached locally** for their `retryAfterMs`. Once a key is over the limit, further requests are rejected
  from L1 with no round trip, so an abusive client flooding a blocked key can't translate that flood into
  L2 load. This is the "protect the protector" mode — a natural default for public endpoints.
- **`leased`** — each node atomically leases a `batch` of credits from L2 and serves them from a local
  counter. The core of GALE.

## The lease lifecycle (leased mode)

All per-key L1 state is one `LeaseEntry` record (`src/twotier/index.ts:133`). The check loop
(`src/twotier/index.ts:343`):

1. **Serve locally** — `if (credits ≥ cost) { credits -= cost; return allow }`. A local hit, no network.
2. **Lease on shortage** — when `credits < cost`, atomically lease `max(leaseSize, cost)` from L2; on
   success, add the grant to local credits and retry.
3. **Coalesce concurrent misses** — the in-flight lease promise is stored on the entry; concurrent misses
   on the same key `await` it instead of issuing their own lease. This guarantees a node never holds more
   than `batch` outstanding — the assumption the overshoot bound rests on — and stops a cold hot-key from
   stampeding L2.
4. **Surface global exhaustion** — when L2 is globally out of budget and nothing remains locally, the
   node returns L2's denial.

`lowWater > 0` (opt-in) fires a fire-and-forget refill once local credits drop to the threshold, so
requests never block on the network — at the cost of a looser bound. `returnIdleAfterMs` drops keys whose
local credits have sat idle, returning that capacity to L2 for other nodes; its timer is owned by the
limiter and released on `close()`.

## The overshoot bound, and why window-coupling makes it fleet-size-independent

The baseline leased mode (credits carry across window boundaries) has a **tight** bound, machine-checked
in `spec/DistributedLeasing.tla` and `docs/FORMAL-MODEL.md`:

```
admitted_per_window ≤ Limit + N · (Batch − 1)        // N = number of nodes
```

The carryover is the *sole* source of overshoot: L2 resets to `Limit` each window, but each node may still
hold up to `Batch − 1` unconsumed local credits from the prior window's last lease. Across `N` nodes that
is up to `N·(Batch − 1)` extra admissions riding on a fresh full `Limit`. (The library's documented
`≤ L × batch` is the safe headline; the proof sharpens it by `N`.)

**Window-coupling** is the one-line refinement that removes it. When the L2 window that granted a key's
credits rolls (`now ≥ lastDecision.resetAt`), the local credits **expire** instead of carrying over
(`src/twotier/index.ts:358`). Because cross-window carryover was the *only* overshoot source, the per-
window bound collapses to:

```
admitted_per_window ≤ Limit          for ANY number of nodes N
```

This is the load-bearing result: the bound stops depending on `N` because there is no longer any per-node
leftover to sum across nodes. It is proven in `spec/GaleWindowCoupledLeasing.tla` (`MaxAdmitted == Limit`)
and reproduced by an exhaustive BFS twin that runs in CI. The cost is one re-lease per busy node just
after each boundary — a bounded near-boundary *utilization* dip (a liveness, not a safety, concern), which
is exactly what adaptive lease sizing minimizes.

## EOQ lease sizing — trading round trips against stranded budget

Once window-coupling makes safety independent of the batch size, the batch governs only **efficiency**:
coordination cost (L2 round trips) versus stranding (leased-but-unused credits that expire at the
boundary). For a node serving demand `D` per window, that is the classic Economic Order Quantity trade
(`src/twotier/sizing.ts:11`):

```
f_D(b) = orderCost · D / b   +   strandPenalty · b / 2
       =  (coordination)      +   (stranding)
```

minimized at `b* = √(2 · orderCost · D / strandPenalty)`. Because `D` is unknown, skewed across nodes, and
non-stationary, no fixed `b` is right, so `leaseSizer` (`src/twotier/sizing.ts:98`) learns it **online**
with AdaGrad in log-space (it optimizes `x = ln b`, since the optimum spans orders of magnitude). It
attains `O(√T)` regret against the best fixed batch in hindsight and tracks a drifting optimum; the engine
runs one learner per key, feeding it each window's served demand and reading back the next batch size.
`predictiveLeaseSizer` adds a prediction-augmented sibling: two experts ("follow the predicted demand" and
the robust `leaseSizer`) arbitrated by a Hedge meta-learner, so accurate predictions approach the
clairvoyant optimum while bad ones fall back to the no-regret bound.

*Why AdaGrad here (vs OGD on the cost axis, [05](05-cost-axis-token-budget.md)):* the EOQ gradient is
unbounded and smooth, which is exactly where AdaGrad's per-coordinate adaptivity earns its keep; the cost
axis's pinball gradient is bounded and constant-magnitude, where vanilla OGD is regret-optimal. Same
family, the tool calibrated to the gradient's shape.

**Safety is decoupled from the learner.** Window-coupling caps per-window admissions at `Limit` for *any*
batch sequence the learner emits, so adaptive sizing can only trade coordination against stranding — it
can never loosen the cap (`src/twotier/index.ts:84`).

## The trilemma — why coordination is unavoidable

GALE is framed by a one-line lower bound (`test/gale/trilemma.test.ts`). Any **zero-coordination**
protocol (each node pre-authorizes a local budget and admits against it) has worst-case overshoot `Δ` and
under-utilization `U` satisfying:

```
Δ + N · U ≥ (N − 1) · L          (tight at the uniform allocation)
```

Both corners are ruinous: an exact protocol (`Δ = 0`) starves a hot node to `1/N` of the budget
(`U ≥ L(N−1)/N`); a work-conserving one (`U = 0`) forces every node to hold the full `L`, so
`Δ ≥ (N−1)L`. **You cannot have both at zero coordination.** This is *why* leasing spends a little
coordination: window-coupled leasing reaches the `Δ = 0, U ≈ 0` corner the trilemma proves is unreachable
for free, paying only the coordination the bound says is unavoidable. Two interpolations are also proven
and machine-checked (static-partition and dynamic-leasing variants).

## Weighted-fair escrow — who gets the next credit

When the budget is contended, `weightedFairEscrow` (`src/twotier/weighted-fair-escrow.ts`) splits one
budget `L` across tenants in **weighted-max-min-fair** proportion, work-conserving (an idle tenant's
surplus is reclaimed by backlogged ones). The `decide` logic is hierarchical: a hard global cap first
(never over-admit regardless of fairness), then "within your guaranteed share," then a borrow phase where
a tenant over its guarantee can take surplus other tenants haven't claimed — capped at the call's own
`cost` (Deficit Round Robin quantum semantics), which bounds the unfairness so one call can't grab all the
slack. In multi-process mode the effective budget is grown lazily by leasing quanta from a shared
`fixedWindow` counter, whose atomicity bounds the global total at `L`.

`federatedWeightedFairEscrow` (covered in [08](08-federation.md)) composes two levels of this to make each
tenant's *global* total match the flat global weighted-max-min ideal across regions.

*Honesty note:* WFE is **not strategy-proof** — per FairRide (Pu et al., NSDI'16), no shared primitive can
be sharing-incentive, work-conserving, *and* strategy-proof at once. WFE takes the first two; window-
coupling bounds a misreporter's gain to a single window.

## Design decisions & rationale

- **`leased` is opt-in, not the default.** It trades exactness for network amortization; `strict` (exact)
  is the safe default and leasing is the tunable lever for hot keys where RTT-per-request dominates.
- **Window-coupling is the keystone.** Expiring credits at the boundary removes the only overshoot term
  that summed across nodes, converting a `Limit + N·(Batch−1)` bound into exactly `Limit`.
- **EOQ + an online learner**, because the coordination-vs-stranding trade is a textbook order-cost-vs-
  holding-cost problem and the demand that parameterizes it is unknown, skewed, and drifting.
- **Safety structurally decoupled from learning** — the escrow store holds the hard per-window cap, so no
  learner or predictor can breach it; the regret results govern only efficiency.

## Caveats

- Leased mode admits a *bounded* overshoot, not zero — unless `windowCoupled`, where it is exactly `Limit`
  (and even then a bounded near-boundary utilization dip remains). `lowWater > 0` trades a looser bound for
  hidden lease latency.
- `cached-deny` consistency and single-process WFE fairness are per-process; set `maxKeys` on public
  surfaces so the L1 maps can't grow unbounded.
- On an L2 error the lease path leaves credits as-is and the next check leases synchronously; a denied
  lease surfaces L2's denial (fail-closed).
- Only strategies with a discrete window boundary participate in window-coupling; pure-rate GCRA/token-
  bucket lease without it.

## What proves it

- `spec/DistributedLeasing.tla` — the baseline tight bound `Limit + N·(Batch−1)` (TLC-checked; tightness
  via an intentionally-false invariant).
- `spec/GaleWindowCoupledLeasing.tla` — the one-line refinement proving `admitted ≤ Limit` independent of N.
- `test/gale/leasing-variants.test.ts` — the Java-free BFS twin: reproduces the spec's reachable-state
  counts (harness validation), then proves windowCoupled `maxAdmitted == L` for every N ∈ {1,2,4,8}.
- `test/gale/trilemma.test.ts` — exhaustively verifies `Δ + N·U ≥ (N−1)L` and tightness for N ∈ {2,3,4}.
- `test/gale/lease-sizer.test.ts` — `eoqOptimum`, sublinear regret, beats best-fixed under drift, and
  **Pillar 1 ⊕ 2 safety** (admitted ≤ limit for *any* learned sizes).
- `test/gale/predictive-sizer.test.ts` — Hedge consistency/robustness/unconditional safety.
- `test/gale/fair-escrow.test.ts` — water-filling correctness + four fairness theorems machine-checked on
  20,000 random instances.

## Source map

`src/twotier/index.ts` (the engine + three modes) · `sizing.ts` (`leaseSizer`, `predictiveLeaseSizer`) ·
`weighted-fair-escrow.ts` · `federated-weighted-fair-escrow.ts` ([08](08-federation.md)) ·
`spec/DistributedLeasing.tla`, `spec/GaleWindowCoupledLeasing.tla` · `docs/FORMAL-MODEL.md`.
