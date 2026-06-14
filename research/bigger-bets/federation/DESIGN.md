# Cross-cluster federation — design

> Status: TK-901 (design + proof). Implementation begins TK-902.
> Read `research/bigger-bets/PLAN.md` §3 first — this expands it.
> Edit guideline: when implementation invalidates an assumption, edit the
> Decision summary at the bottom in place and add a one-line "Why changed".

## 0  Why this doc exists

`PLAN.md` §3 fixes the architecture choice (option D: federated escrow with
window-coupling). This doc carries the proof, the locked interface signatures,
the worked example, and the TLC-checked counts. It is the gate the implementer
walks past before writing a single line of production code (`TK-902`+).

It exists because we built GALE proof-first and the EOQ-cost-model bug was
caught at exactly this step on Pillar 2. Federation is bigger; the cost of
finding a bound bug *after* shipping a `FederatedStore` is catastrophic.

---

## 1  Problem statement

ThrottleKit's `twoTier(leased)` (`src/twotier/index.ts`) holds a per-process
L1 of credits in memory and round-trips to one shared L2 store on lease
exhaustion. The proven per-window overshoot is

```
admitted ≤ Limit + N · (Batch − 1)        (DistributedLeasing.tla)
```

with `N` the number of leasing nodes. When window-coupled (credits expire on
the L2 window boundary) the bound collapses to

```
admitted ≤ Limit                          (GaleWindowCoupledLeasing.tla)
```

independent of `N`.

**Both proofs assume a single L2 store.** In production, regions cohabit:
us-east + eu-west + ap-south talking to the same Redis is a 80–150 ms RTT
per check. Operators fall back to one of two compromises:

| Mitigation | Behavior | Why it's bad |
|---|---|---|
| Static partition: each region gets `Limit/K` | `Δ = 0` by construction | No pooling — under skew, `Limit/K` binds locally while the global budget is largely unused. Throughput collapses. |
| Per-region independent counters | Pools regionally | `Δ` unbounded across regions; admitted scales linearly with `K`. |

**Open problem.** No published or deployed limiter has both pooling *and* a
tight, fleet-size-independent overshoot bound across regions. This is the
systems blocker for the archival GALE paper.

---

## 2  The lift — `windowCoupled` to `federated`

The contribution is a **federated escrow with global window-coupling**: each
region holds a leased sub-budget (its *escrow*) from a global coordinator;
the escrow expires at the global window boundary; uncommitted escrow
forfeits, then re-leases for the next window.

The mathematical content of this scheme is exactly `GaleWindowCoupledLeasing`
under a relabeling of variables. The lift is structural:

### 2.1 The relabeling

| `GaleWindowCoupledLeasing` (in-process leasing) | `GaleFederatedLeasing` (this design) |
|---|---|
| `Nodes` — set of leasing nodes in one process group | `Regions` — set of regional clusters |
| `credits[n]` — node `n`'s unconsumed leased tokens | `escrow[r]` — region `r`'s unconsumed leased sub-budget |
| `l2` — remaining L2 store budget this window | `globalBudget` — remaining global-coordinator budget this window |
| `Limit` — per-window L2 budget | `Limit` — per-window **global** budget |
| `Batch` — per-node lease size | `Batch` — per-region escrow allocation |
| `admitted` — admissions in one L2 window | `admitted` — admissions **across all regions** in one global window |

`spec/GaleFederatedLeasing.tla` is literally `spec/GaleWindowCoupledLeasing.tla`
with these names substituted (and updated comments). The actions match:

| Spec action | Federated meaning |
|---|---|
| `Serve(r)` | A region's regional L2 admits a request out of its local escrow. No cross-region RTT. |
| `Lease(r)` | A region leases one whole `Batch` from the global coordinator (one cross-region RTT) — amortized over `Batch` admissions. |
| `Roll` | Global window rolls over: `globalBudget` resets; **regional escrow expires across all regions** (the window-coupling rule). |

### 2.2 The recursive twoTier insight

The body of one region is *itself* a `twoTier(leased)` (regional L1 in
memory, regional L2 in Redis), which `GaleWindowCoupledLeasing.tla` already
proves at depth. The outer layer (region ↔ global coordinator) is what this
design adds. **A `FederatedStore` is just a `twoTier` where the L2 is the
global coordinator and each "node" is a region.** The proofs compose
because the layers are independent (the inner proof's invariants are
preserved at the granularity of regional escrow, which is exactly the
"credits" the outer proof reasons about).

Concretely the request path is:

```
client → regional-L1 (memory)           [Serve-inner, no I/O]
       → regional-L2 (regional Redis)   [Lease-inner: regional escrow draws here]
       → global coordinator (global L3) [Lease-outer: cross-region RTT]
```

The two layers' window-coupling rules align — the regional L2 window IS the
global window for that key — so on `Roll`, *both* layers' escrow forfeits
together. There is no second-order leak.

### 2.3 What the lift proves

For `K = |Regions|` regions, with one coordination event per region per
global window, and federated window-coupling:

```
admitted_per_window ≤ Limit                              (federation bound)
```

— Δ = 0 across regions, independent of `K`. The static-partition baseline
gets the same bound but only under symmetric load; this scheme pools the
global budget freely.

The proof is *literally* `GaleWindowCoupledLeasing.Overshoot` after the
relabeling, which TLC checks against finite state and the BFS twin
re-checks in CI without Java (TK-905).

---

## 3  Architecture

### 3.1 `GlobalCoordinator` — the locked interface

The cross-region escrow mechanism is *not* committed to one backend. It sits
behind an abstract interface that ships in `src/federation/coordinator.ts`:

```ts
/**
 * Cross-region lease coordinator — the "L3" of the federated stack.
 *
 * One coordinator instance is shared across all regions for a given key
 * prefix. Implementations include `RedisCoordinator` (default, single
 * global Redis; documented SPOF) and `PostgresCoordinator` (0.9.x);
 * Raft-via-etcd is a future option for HA-without-SPOF.
 *
 * The coordinator MUST be window-coupled: leases expire at `expiresAt`
 * (the window boundary for the strategy at `key`). The default Redis
 * implementation enforces this via PEXPIRE on the lease record; alternate
 * implementations must respect the same lifetime contract for the federation
 * bound to hold.
 */
export interface GlobalCoordinator {
  /**
   * Lease `tokens` units of budget for one window from the global key `key`.
   * Returns the granted amount (0 ≤ granted ≤ tokens) — the lease may be
   * partial under contention (other regions raced the global budget down
   * before this request landed).
   *
   * `expiresAt` is the window boundary in epoch-ms. The grant is invalid
   * after that instant — implementations MUST enforce expiry (the
   * window-coupling commitment is the federation bound's load-bearing
   * assumption).
   *
   * Calls MAY throw `StoreUnavailableError` on coordinator unavailability;
   * the caller (FederatedStore) handles this by failing closed in the
   * region (see §5).
   */
  lease(key: string, tokens: number, expiresAt: number): Promise<number>;

  /**
   * Reconcile `leftover` un-served escrow back to the global budget at
   * the global window's start. Idempotent on `windowStart` — duplicate
   * calls within the same window MUST be no-ops (so retries through a
   * partition converge to the correct global state).
   *
   * `leftover` is non-negative. Reconciliation is best-effort: a failure
   * here cannot violate the federation bound (it can only LOSE capacity
   * that the federation could have admitted next window). Implementations
   * MAY silently drop on persistent failure.
   */
  reconcile(key: string, leftover: number, windowStart: number): Promise<void>;

  /**
   * Optional liveness probe. Returns `true` when the coordinator is
   * reachable and serving leases. Used by FederatedStore's failure-mode
   * detector to switch a region into fail-closed when the coordinator is
   * unreachable across a global window boundary.
   *
   * Defaults to `() => Promise.resolve(true)` if not implemented.
   */
  isHealthy?(): Promise<boolean>;
}
```

**Lock decisions** (DR-02 in `PLAN.md`):
- The interface is *abstract*; no `Redis` types leak into the signature.
- `lease()` returns a `number`, not a `Decision` — partial grants are
  legitimate and the federation logic in `FederatedStore` handles the
  arithmetic (does not surface as a "denied" Decision).
- `reconcile()` is idempotent on `windowStart` — this is the recovery
  primitive after a partition; without idempotence the bound can leak.
- `isHealthy()` is optional with a safe default (assume healthy until a
  `lease()` fails) — implementations that can cheaply probe (Redis PING)
  should override.

### 3.2 `FederatedStore` — the composition

`FederatedStore` is a `Store` (the existing ThrottleKit primitive) that
composes one *regional* `Store` (the local Redis L2 for one region) with a
`GlobalCoordinator` (the L3). It is the outer layer of the recursive
twoTier:

```ts
export interface FederatedStoreOptions {
  /** The region's local Store (typically a regional RedisStore). */
  regional: Store;
  /** The cross-region lease coordinator. */
  coordinator: GlobalCoordinator;
  /** This region's identity (used in coordinator key prefixes + telemetry). */
  region: string;
  /**
   * The escrow size each region leases per global window. Larger batch =
   * fewer cross-region RTTs at the cost of `(Batch - 1) * (K - 1)` worst-
   * case capacity unused during a window (under uneven load). Default: 16.
   *
   * NB: with federated window-coupling, even this transient unused
   * capacity does NOT contribute to overshoot (Δ = 0). It is purely a
   * utilization concern. The leaseSizer/predictiveLeaseSizer (Pillar 2 of
   * GALE) sizes this adaptively.
   */
  batch?: number;
  /** Optional adaptive sizer. Defaults to the static `batch` above. */
  sizer?: LeaseSizer;
  /**
   * What to do when `coordinator.lease()` throws. "fail-closed" (default,
   * matches the existing twoTier behavior) denies in-region until the
   * coordinator returns; "regional-only" drops to regional limits
   * (loses Δ guarantee — for soft-traffic operators who prefer
   * availability).
   */
  onCoordinatorOutage?: "fail-closed" | "regional-only";
}
```

The check path is:

```
1. Try the regional store (Serve(r) — fast path; no global coordinator hit).
   → If it admits: return its Decision verbatim.
2. Otherwise the regional store is exhausted (or its escrow is at zero).
   2a. Compute the window's expiresAt (from the strategy at `key`).
   2b. Call coordinator.lease(key, batch, expiresAt).
       - On a positive grant: write `grant` budget into the regional store
         (via Store.apply with a "credit" transform — see TK-902 design),
         then retry step 1.
       - On grant = 0: return `denied` with the regional store's Decision
         (preserving the strategy's `retryAfterMs`).
       - On throw: per `onCoordinatorOutage`, either fail-closed (return
         denied; surface StoreUnavailableError to telemetry) or fall
         through to regional-only (return regional Decision; emit metric).
3. At the window boundary (driven by an idle timer keyed on `expiresAt`):
   compute the regional store's residual budget, call
   coordinator.reconcile(key, leftover, windowStart). Idempotent.
```

**Key correctness commitment.** Step 1 cannot succeed past the global
window boundary because the regional store's lease records are
PEXPIRE-bounded to `expiresAt`. Once the boundary passes, Lease must
re-run — which is the federated window-coupling action `Roll` in the
formal model. **This binds the formal `Roll` to a physical mechanism
(PEXPIRE on regional-store keys); the bound only holds when this mechanism
holds.**

---

## 4  Formal model & TLC-checked counts

`spec/GaleFederatedLeasing.tla` is the formal model. It is a literal
relabeling of `spec/GaleWindowCoupledLeasing.tla` — see Section 2.1 for
the variable mapping. The committed `.cfg` runs at
`Regions = {us_east, eu_west, ap_south}, Limit = 6, Batch = 3`.

### 4.1 BFS-twin state counts

The Java-free BFS twin (the GALE pattern, see
`test/gale/leasing-variants.test.ts`) re-runs the same transition system
in TypeScript. Below is the output of
`npx tsx research/bigger-bets/federation/tla-counts.ts`
(re-running it reproduces these numbers byte-for-byte):

| Config | Variant | Distinct states | Max admitted | Bound | Tight? |
|---|---|---:|---:|---:|:---:|
| K=2, Limit=4, Batch=2 | baseline (carryover) | 31 | 6 | 6 | ✓ |
| K=2, Limit=4, Batch=2 | federated (window-coupled) | 8 | 4 | 4 | ✓ |
| K=3, Limit=6, Batch=3 | baseline (carryover) | 441 | 12 | 12 | ✓ |
| K=3, Limit=6, Batch=3 | federated (window-coupled) | 27 | 6 | 6 | ✓ |
| K=5, Limit=10, Batch=2 | baseline (carryover) | 992 | 15 | 15 | ✓ |
| K=5, Limit=10, Batch=2 | federated (window-coupled) | 112 | 10 | 10 | ✓ |

**Harness validation** (anchor row): K=2 baseline = 31 states matches the
committed TLC output in `spec/README.md` §1; K=3 baseline = 441 states
matches `spec/README.md` §3. These numbers came out of TLC 2.19 on JDK 17.
This validates that the BFS faithfully reproduces TLC's state exploration,
which lets us treat the BFS twin as a CI-runnable proxy for TLC at the
state-count granularity the small configs allow.

**Federation rows** (the contribution): every federated config attains its
bound (max admitted = Limit, tight ✓), with K-independent bound (Limit, not
`Limit + K(Batch-1)`). The distinct-state counts shrink dramatically vs
baseline because `Roll` collapses the escrow vector to a single
all-zeros state instead of preserving the carryover vector.

### 4.2 Bound comparison at scale

| Variant | Per-window overshoot bound | K=10 | K=100 |
|---|---|---:|---:|
| baseline (carryover) | `L + K·(B−1)` | `L + 10(B−1)` | `L + 100(B−1)` |
| static partition | `L` | `L` | `L` |
| **federated window-coupled** | **`L`** | **`L`** | **`L`** |

The static partition matches the federation bound but loses pooling under
skew (utilization analyzed in §6). The federated window-coupled scheme
delivers both Δ = 0 *and* free pooling — the contribution.

### 4.3 What the model deliberately omits

- **Coordinator latency.** Modeled as instantaneous; in reality the
  `Lease(r)` action takes 80–150 ms cross-region. This is a *liveness/
  utilization* concern, not a safety concern — it cannot violate
  `Overshoot`. The eval (TK-910) measures real latency.
- **Coordinator failure mid-window.** Modeled as a no-op `Lease(r)`
  (region keeps serving regional escrow until it runs out). The
  fail-closed semantics are covered in §5 and tested in TK-907.
- **Reconciliation.** The model forfeits leftover escrow at `Roll`, and the
  implementation now matches it exactly: `reconcile()` is **window-coupled** —
  it credits leftover back ONLY into the still-active window (a boundary/skew
  race where `windowStart == currentWindowStart`), and FORFEITS leftover whose
  window has already rolled. An earlier implementation credited a rolled
  window's leftover into the *next* window; that does **not** preserve the
  bound. Crediting a later, already-draining window *adds* capacity to it, so
  cumulative admissions in that window can reach `Limit + leftover` — exactly
  the K-dependent `L + K·(B−1)` overshoot federation exists to eliminate (§4.2).
  The forfeit is the price of `Δ = 0`; the lost utilization is bounded and
  analyzed in §6. (Coordinators: `RedisCoordinator`/`PostgresCoordinator`
  guard on the server clock; `TestCoordinator` models it when `windowMs` is set.)

### 4.4 RedisCoordinator (TK-906) — the production-ready impl

The default `GlobalCoordinator` impl ships in `src/federation/redis-coordinator.ts`.

**Layout — one Redis HASH per coordinator key** (`<prefix>:<key>`):

```
budget           : remaining global budget for the active window
expiresAt        : when the active window ends (epoch-ms)
rec_<windowStart>: idempotency marker per reconciled windowStart
```

**Lua scripts** (one EVALSHA per RPC; with NOSCRIPT-fallback to EVAL):

- `LEASE_LUA` — atomically initialize-or-roll-or-grant. On a fresh window
  the HASH is wiped via DEL (clearing stale `rec_*` markers) and budget
  reinitialized to `perKeyBudget`. PEXPIRE matches the window boundary.
- `RECONCILE_LUA` — credits leftover into the CURRENT window's budget
  (capped at `perKeyBudget`). The `rec_<windowStart>` field enforces
  per-windowStart idempotency, so retries across a partition converge.
  Initializes a fresh window if needed, covering the engine-side race
  between fire-and-forget reconcile and the post-roll lease (the two
  arrive in Redis in unspecified order).

**SPOF caveat.** A single global Redis is a single point of failure for
the federation's safety bound. When the Redis is unreachable, every
region's `lease()` throws → fail-closed (default) → no new admissions
across the entire federation until the Redis returns. The mitigations:

- **Sentinel / Cluster.** Operators layer Redis Sentinel under the
  coordinator's client for HA. The Lua scripts work unchanged.
- **PostgresCoordinator** (0.9.x). Translates the same Lua to
  LISTEN/NOTIFY + atomic UPDATE WHERE. Same interface; Postgres's
  HA story (synchronous replication, automatic failover) replaces
  Sentinel.
- **Raft-via-etcd** (1.0.x). The HA-without-SPOF option. More complex;
  the same `GlobalCoordinator` interface fits.

For 0.8.3, the SPOF is documented; users in regulated environments
should opt for Sentinel or `PostgresCoordinator` (when it lands).

**`windowMs` at construction.** RedisCoordinator takes `windowMs` as a
required option — the Lua scripts derive the active window's
`expiresAt` from `now` (`floor(now/windowMs)·windowMs + windowMs`) so
reconcile can correctly initialize a fresh window without the caller
having to pass it through the `GlobalCoordinator.reconcile` signature.
The caller MUST pass the same `windowMs` to the coordinator as to the
strategy it federates; a mismatch silently breaks federation.

---

## 5  Failure semantics

### 5.1 Region partitioned from the global coordinator

Region's view: `coordinator.lease()` throws. Behavior per
`onCoordinatorOutage`:

| Mode | Behavior |
|---|---|
| `fail-closed` (default) | Region serves whatever regional escrow it already holds; once exhausted, denies until the partition heals. **`Δ` stays at zero across regions.** Matches existing `twoTier` semantics on L2 outage. |
| `regional-only` | Region falls back to the regional Limit. **`Δ` is bounded by the regional Limit, not the federation Limit.** Operators choose this for soft-traffic (e.g. analytics events) where availability beats precision. |

The default is `fail-closed` because the federation bound is the user's
load-bearing assumption — silently weakening it on outage is the worst
failure mode. `regional-only` is opt-in with a clear telemetry marker
(`throttlekit_federation_mode{state="regional-only-fallback"}`).

### 5.2 Coordinator crash, recovered before next window boundary

The `lease()` calls during the outage throw → regions fail-closed (default)
or fall back (regional-only). On recovery, the next `lease()` succeeds
normally. **No state recovery is needed in the regions** — the regional
escrow records are PEXPIRE-bounded and will roll over on schedule.

### 5.3 Coordinator unavailable across a window boundary

This is the corner case where the formal model's `Roll` happens but no
region can acquire fresh escrow. Behavior:

- All regions' escrow expires (PEXPIRE on the regional store).
- All regions return `denied` for new traffic (regional store empty +
  coordinator unreachable).
- When the coordinator returns, normal operation resumes; regions
  re-lease.

This is the worst possible federation outage and the bound still holds —
admissions during the outage are zero, which trivially satisfies
`admitted ≤ Limit`. The cost is full unavailability for traffic that
needs federated rate-limiting until recovery.

### 5.4 Coordinator returns a partial grant

Common during contention: K regions all hit Lease simultaneously, the
global budget has only `M < K·Batch` left, `lease()` returns the actual
granted amount. `FederatedStore` writes the granted amount to the regional
store and retries — the request the lease was for sees the freshly-written
escrow on retry, but if the grant was 0 it correctly returns `denied`.

Property to prove (TK-908): under any sequence of partial grants, the sum
of admitted across regions never exceeds `Limit`. This is the
multi-region analog of GCRA dual-path conformance and falls out of the
formal model directly.

### 5.5 Two regions racing the same `reconcile`

If region A's reconcile lands at coordinator while region B is
mid-`lease()` for the next window: the reconcile increments the global
budget; B's lease draws from it. **The window boundary anchored on
`windowStart` provides the serialization point**: A's reconcile is for
`windowStart_n`, B's lease is for `windowStart_{n+1}`. They cannot
interfere within a window. This is enforced by the `reconcile()`
idempotency-on-`windowStart` contract.

---

## 6  Utilization analysis (the cost of federation)

The safety bound is K-independent. The *cost* is a transient utilization
dip around the window boundary, plus the worst-case `(Batch-1)·(K-1)`
sub-budget left unused under uneven load.

### 6.1 Boundary dip

Around each global window boundary:
1. Regional escrow expires (PEXPIRE fires).
2. Next in-region request triggers `Lease(r)` (one cross-region RTT).
3. Until the lease returns, the region denies.

For a region serving `Q` req/s with a global window of `W` seconds and a
cross-region RTT of `R` seconds, the per-window utilization is

```
U = (W − R) / W
```

For W=60s, R=0.1s → U = 99.83%. The dip is bounded and amortizes — the
leaseSizer / predictiveLeaseSizer pillars target exactly this cost.

### 6.2 Uneven-load capacity

Under uneven regional load (e.g. K=3, one region taking 90% of traffic),
the static-partition policy under-serves the hot region (it binds at
Limit/3 while regions 2 and 3 sit at <10% utilization). The federation
scheme allows the hot region to lease the global budget freely; pooling
is restored.

**Quantitatively**: if region `r` requests `q_r` req/s and the global
budget is `L` req/s, federation admits `min(Σq_r, L)`; static partition
admits `Σ min(q_r, L/K)`. The gap can be arbitrary (limited by L/K under
extreme skew).

Worst-case carryover under federation: `(Batch − 1) · (K − 1)` regional
escrow units sit unused if only one region's traffic clears. With Batch=16,
K=10, that's 135 units of un-served capacity per window across the
federation — bounded and small relative to `Limit` for typical
deployments.

### 6.3 Cross-region RTT amortization

For a region with steady `Q` req/s, one `Lease(r)` per `Batch` admissions
amortizes the cross-region RTT over `Batch` requests. At Batch=16, Q=1000
req/s, R=100 ms:

- Lease frequency: 1000/16 ≈ 62.5 leases/sec
- Per-request RTT amortization: 100/16 = 6.25 ms (vs 100ms unbatched)
- Memory: 16 escrow units × K regions = bounded constant

This is the same amortization argument as in-process twoTier; federation
just lifts the constant.

---

## 7  Worked example: 3 regions, 1000 req/s budget

Setup:
- `Limit = 1000` req/s, window = 1s, `Batch = 16`
- Regions: us-east, eu-west, ap-south
- Loads: us-east 700 req/s, eu-west 200 req/s, ap-south 100 req/s
- Cross-region RTT to coordinator: 100 ms

Single window:

```
T=0.000  Roll: globalBudget = 1000; all escrow = 0; admitted = 0
T=0.001  us-east: Lease(us_east, 16) → granted 16
                  → regional store now has 16; admit one request → 15 left
                  → globalBudget = 984
T=0.005  us-east: Serve(us_east) (4 more requests from escrow) → 11 left
T=0.024  us-east: Serve(us_east) (all 11 served) → 0 left
                  → Lease(us_east, 16) → granted 16
                  → globalBudget = 968
... (44 Lease cycles for us-east over the second; 44 × 16 = 704 admissions; 
     actually serves 700 req/s with one cycle to spare; spends 4400 ms × RTT 
     amortized; 1 RTT per 16 reqs = ~6.25 ms/req amortized waste)
T=0.050  eu-west: Lease(eu_west, 16) → granted 16 → admit eu-west traffic
...      (12 Lease cycles for eu-west over the second; 12 × 16 = 192 admissions, 
          plus 8 escrow remaining at boundary)
T=0.500  ap-south: Lease(ap_south, 16) → granted 16 → admit ap-south traffic
...      (6 Lease cycles for ap-south; 6 × 16 = 96 admissions; 4 escrow remaining)

T=1.000  Roll: globalBudget = 1000; ALL escrow → 0 (forfeit)
                  → us-east: 0 left (all served), eu-west: 8 forfeit, 
                    ap-south: 4 forfeit
                  → 12 units of escrow forfeit total
                  → admitted_total = 700 + 192 + 96 = 988 (< Limit = 1000 ✓)
```

Under static partition (`L/K = 333` each):
- us-east admits min(700, 333) = 333 (drops 367 req/s!)
- eu-west admits min(200, 333) = 200
- ap-south admits min(100, 333) = 100
- total admitted: 633 — well below the 988 the federation admits

The federation pools the under-utilized eu-west/ap-south budget into
us-east, recovering the throughput the static partition leaves on the
table — without losing the Δ = 0 bound.

---

## 8  What's NOT in this design (deferred to follow-ups)

| Item | Why deferred |
|---|---|
| CRDT / gossip coordinator | Option C in PLAN.md. Worth a research follow-up; staleness-Δ tradeoff is its own paper. 0.9.x at earliest. |
| `PostgresCoordinator` | Straightforward translation of `RedisCoordinator` (LISTEN/NOTIFY for the lease record). 0.9.x. |
| Federated WFE (weighted fair federation) | Composes `weightedFairShare` with this scheme; orthogonal to the Δ proof. 0.9.x. |
| Coordinator HA (Raft / Sentinel) | Operators layer Sentinel under `RedisCoordinator` themselves. Out of library scope. |
| Federated `unifiedAdmission` (#79 ⨯ #77) | Composes after 0.10.0 — same coordinator handles `rate`, `concurrency`, `tokenBudget` budgets together. |

---

## 9  Decision lock summary

These crystallize PLAN.md DR-01 / DR-02 with this design's specifics. Edit
in place when implementation reveals a need to change.

| ID | Decision | Status |
|---|---|---|
| **D-901-1** | Spec = literal relabeling of `GaleWindowCoupledLeasing` (Section 2.1). The published proof transfers via the recursive twoTier insight (Section 2.2). | Locked |
| **D-901-2** | `GlobalCoordinator` is an abstract interface (Section 3.1); MVP impl = `RedisCoordinator` (TK-906). | Locked |
| **D-901-3** | `lease(key, tokens, expiresAt)` returns the granted amount (partial grants allowed). Window-coupling enforced by `expiresAt` discipline at the coordinator. | Locked |
| **D-901-4** | `reconcile(key, leftover, windowStart)` is idempotent on `windowStart`. Required for partition recovery (Section 5.5). | Locked |
| **D-901-5** | `FederatedStore.onCoordinatorOutage` default = `fail-closed` (safety > availability). `regional-only` is opt-in, weakens Δ to per-region. | Locked |
| **D-901-6** | Batch size sourced from `LeaseSizer` (the GALE Pillar 2 sizer applies unchanged). Default static `batch=16`. | Locked |
| **D-901-7** | Reconciliation is best-effort: a reconcile failure cannot violate the bound; at worst it loses one window's leftover capacity. | Locked |

---

## 10  Implementation roadmap (TK-902 onwards)

This design is the gate for `TK-902` to begin. The chain:

1. **TK-902** — `feat(federation): GlobalCoordinator interface + FederatedStore skeleton` (interfaces only; throws `NotImplementedError` on `check()`).
2. **TK-903** — `feat(federation): static-partition implementation + dual-path tests` (the baseline; never used in production but provides the test floor).
3. **TK-904** — `feat(federation): window-coupled federated leasing` (the actual implementation of this design).
4. **TK-905** — `test(federation): TLA⁺ BFS twin in test/gale/federated/` (CI-runnable twin of `spec/GaleFederatedLeasing.tla`).
5. **TK-906** — `feat(federation): RedisCoordinator default implementation`.
6. **TK-907**–**TK-911** — failure modes, dual-path property tests, eval, docs.
7. **TK-912** — release 0.8.3 (versioned as a patch since the surface is purely additive; see PLAN.md DR-07).

The chain is linear because each step assumes the prior step's contracts.
Trying to parallelize would merge-churn on the same interface files (the
GALE pattern). The full ROI plan in `research/bigger-bets/PLAN.md` §3.5.

---

## 11  How to verify this design

- **Re-run the counts:** `npx tsx research/bigger-bets/federation/tla-counts.ts`
  reproduces the §4.1 table byte-for-byte.
- **Re-run the BFS twin** (existing): `npm test -- leasing-variants` confirms
  the harness validation anchor (31, 441) against TLC.
- **Re-run TLC (optional):** download `tla2tools.jar`, point it at
  `spec/GaleFederatedLeasing.tla` with the committed `.cfg`. Expected:
  *"Model checking completed. No error has been found"*; 27 distinct states
  at depth ≤ 6 (mirroring the BFS K=3,L=6,B=3 federated row).
- **Tightness witness (optional):** enable `OvershootTight` in the `.cfg`,
  re-run TLC. Expected: violation trace ending at `admitted = Limit = 6`.
