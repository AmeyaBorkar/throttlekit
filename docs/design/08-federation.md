# 08 · Federation

> One global per-window budget shared across regions/clusters, with total admissions ≤ the limit
> *regardless of region count* — while pooling capacity under skew. Source: `src/federation/`,
> `src/twotier/federated-weighted-fair-escrow.ts`, `spec/GaleFederatedLeasing.tla`.

## Purpose

When K regional clusters must jointly honor one global limit `L`, statically slicing `L/K` strands
capacity: a hot region binds at its slice while idle regions sit on unused budget. Federation pools the
budget instead — a hot region borrows idle regions' capacity — while keeping total admissions ≤ `L` with
overshoot **Δ = 0 independent of K**. It is GALE's window-coupled leasing lifted one level: nodes become
regions, local credits become regional escrow, and the L2 store becomes a cross-region coordinator.

## The coordinator abstraction

`GlobalCoordinator` (the "L3") has three methods (`src/federation/types.ts:45`):

- `lease(key, tokens, expiresAt) → granted ∈ [0, tokens]` — a **partial** grant is legitimate (other
  regions raced the budget down).
- `reconcile(key, leftover, windowStart)` — **idempotent on `windowStart`**, so a retry through a partition
  converges and can only ever lose *next-window* capacity, never violate the bound.
- `isHealthy?()` — optional, for outage detection.

The load-bearing contract: the coordinator **must be window-coupled** — leases expire at the window
boundary (enforced via `PEXPIRE` on the Redis path). That expiry is the entire basis of the Δ = 0 proof.

## Window-coupled federated leasing (the contribution)

Per-key escrow state carries a `balance`, the window bounds, an in-flight `pending` lease, and the
last-reconciled window (`src/federation/window-coupled.ts:124`). The mechanism:

- **Window-coupling (the Δ = 0 lever).** When the prior window expires, the engine captures
  `leftover = balance`, resets `balance = 0`, drops the in-flight lease (it would credit the wrong window),
  and reconciles the leftover back to L3 *once* per boundary. Credits **expire at the boundary** — they do
  not carry over, which is provably the sole source of overshoot, so the bound collapses to `admitted ≤
  Limit` independent of K.
- **The check loop.** While `balance < cost`: try L2 (regional escrow) first if configured, else lease
  `max(batch, cost)` from L3 — with at most one outstanding lease per region per key (the safety
  coalescing). After every await, re-resolve the entry (the window may have rolled or `reset()` may have
  run). Admit ⇒ `balance -= cost`.
- **Regional escrow (L2).** Sits between the per-process in-process L1 and the cross-region L3, so multiple
  processes in a region share one atomic regional store and in-flight per-region escrow is bounded by the
  per-key budget instead of `processes × batch`. Three ops: `lease` (consume), `refill` (additive within a
  window, dropping stale-window grants — window-coupling), `release` (capture-and-zero at the boundary,
  idempotent so the first releaser wins).

## Static partition (the baseline foil)

`staticPartition` splits `L` evenly across regions (remainder to the earliest regions so `Σ slice = L`
exactly). Δ = 0 trivially (each slice is independent), but it loses pooling under skew. It is kept
deliberately as the foil the window-coupled scheme must *beat on utilization* — lopsided allocation doesn't
matter because the real scheme pools anyway.

## Federated weighted-fair escrow

`federatedWeightedFairEscrow` + `regionFairPool` compose **two levels** of weighted-fair escrow so each
tenant's *global* total (summed across regions) equals the flat global weighted-max-min ideal
(`src/twotier/federated-weighted-fair-escrow.ts`):

1. **Cross-region WFE** — a weighted-fair *reservation* layer whose "tenants" are regions; region `r`'s
   weight is its dynamic active aggregate tenant weight `W_r = Σ w_{t,r}`. It reserves each region at least
   its guarantee and lets a region grow into the others' idle surplus.
2. **In-region WFE** — the per-tenant fair split over the region's pool-granted budget.
3. **Demand-proportional weight split** — a tenant active in several regions splits its global weight
   `w_{t,r} = w_t · d_{t,r}/d_t`, so a tenant active in k regions isn't k×-counted.

The insight: hierarchical max-min ≠ flat max-min *unless* an internal node is weighted by the **sum of its
children's weights** (the Parekh–Gallager GPS-decomposition condition). Setting region weight = Σ of its
tenants' weights is exactly that condition, collapsing the two-level hierarchy to a single global water-fill
— exact in the fluid limit, within a two-level DRR residual under discrete granting. A plain shared counter
*cannot reserve*, which is the root of the cross-region isolation gap a weighted-fair reservation layer fills.

## Outage modes

- **`fail-closed`** (default) — serve whatever escrow the region already holds, then deny until the
  coordinator returns. Δ = 0 preserved.
- **`regional-only`** (requires an L2) — keep serving from the regional balance until depleted; mark the
  coordinator unhealthy on a `lease()` throw and re-probe `isHealthy()` lazily (clock-driven, no background
  timer). Δ degrades to the regional sub-bound during the outage; without an L2 it silently degrades to
  fail-closed.

## Design decisions & rationale

- **A coordinator interface, not a concrete store** — one coordinator serves all regions for a key prefix,
  and Redis / Postgres / a future Raft-via-etcd implement the same window-coupled lease/reconcile contract
  without the federation engine changing.
- **Window-coupling is the load-bearing safety commitment** — the Δ = 0 proof depends entirely on leases
  expiring at the boundary with no carryover; the relabeled spec shows carryover is the sole overshoot
  source.
- **Reconcile is idempotent on `windowStart`** — fire-and-forget through partitions; without the per-window
  marker a retried reconcile would double-credit the next window. A reconcile *failure* can only lose
  next-window capacity, never violate the bound.
- **At most one outstanding lease per region per key** — concurrent shortages await one lease rather than
  racing parallel L3 leases.
- **The WFE∘WFE composition theorem** — naive pooling (per-region WFE over a plain shared counter) gives
  in-region fairness but cross-region FCFS, starving a heavily-weighted late-arriving region; a plain
  counter can't *reserve*, so the cross-region weighted-fair reservation layer is exactly what cross-region
  weights require.
- **`batch` is a utilization knob, not a safety one** — a larger batch means fewer cross-region round trips
  at the cost of worst-case unused escrow, which under window-coupling does *not* contribute to overshoot.

## Caveats

- **No sync path** — federation always crosses a region boundary (intrinsically async, 80–150 ms RTT);
  `checkSync` throws.
- **SPOF** — the default Redis coordinator is a single global Redis; mitigate with synchronous replication
  + failover.
- **Multi-process leftover loss** — with multiple processes per region, only the L2-release winner recovers
  leftover; others lose their L1 leftover (a *utilization* cost; Δ = 0 preserved either way).
- **Only windowed strategies federate** — window-coupling needs a discrete boundary, so `fixedWindow` /
  `slidingWindow` / `quota` federate; gcra/tokenBucket throw at construction.
- **Federated WFE is not strategy-proof** (inherited from WFE / FairRide); window-coupling bounds the gain
  to one window. The shipped `regionFairPool` is in-process (one arbiter); distributing it is a documented
  store-backed path.
- A bounded near-boundary utilization dip remains (a busy region re-leases after each boundary), which
  adaptive lease sizing minimizes.

## What proves it

- `spec/GaleWindowCoupledLeasing.tla` — `admitted ≤ Limit` for any N (credits expire at the boundary).
- `spec/GaleFederatedLeasing.tla` — a literal relabeling (Nodes→Regions, credits→escrow, l2→globalBudget)
  lifting the same bound to K regions: `admitted ≤ Limit` independent of K.
- `test/gale/federated/leasing-variants.test.ts` — the CI BFS twin, reproducing the spec's distinct-state
  counts byte-for-byte (harness validation) then proving the bound.
- `test/federation/window-coupled.test.ts` — Δ = 0 independent of K.
- `test/federation/property.test.ts` — dual-path `TestCoordinator ≡ RedisCoordinator` over adversarial
  timelines (Redis-gated).
- `test/federation/failure-modes.test.ts` — the three outage shapes all hold Δ = 0; federation fails closed.
- `test/federation/federated-skew.test.ts` — recovers the utilization static partition strands (vs the
  `static-skew.test.ts` foil).
- `test/federation/{static-partition,regional-escrow,redis-regional-escrow,regional-only,redis-coordinator,
  postgres-coordinator}.test.ts`.

## Source map

`src/federation/types.ts` (the coordinator/escrow contracts) · `window-coupled.ts` (the engine) ·
`static-partition.ts` (the baseline) · `redis-coordinator.ts`, `postgres-coordinator.ts` ·
`redis-regional-escrow.ts`, `test-regional-escrow.ts`, `test-coordinator.ts` ·
`src/twotier/federated-weighted-fair-escrow.ts` · `spec/GaleFederatedLeasing.tla`.
