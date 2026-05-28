# Multi-process regional escrow — design (TK-1305 / 0.8.5)

> Status: design lock for TK-1305. Implementation lands in TK-1306.
> Target release: 0.8.5 (federation completion patch — closes the
> `regional-only` outage-mode gap documented in the 0.8.3 CHANGELOG
> caveats).

This document specifies a Redis-backed multi-process regional escrow for
the federation engine, alongside the `regional-only` outage mode that the
existing `FederatedStore` API has accepted at construction since 0.8.3 but
collapsed to `fail-closed` because the implementation was missing. Both
land together — they are the same primitive at two levels of detail.

---

## 1  What's broken today (the gaps)

From the 0.8.3 codebase:

| Surface | Today's behavior | The gap |
|---|---|---|
| `federate({ regional, ... })` accepts a `regional: Store` | "UNUSED at this commit (TK-904); reserved for TK-906" (src/federation/window-coupled.ts §66-71) — the federation engine ignores the parameter | Multi-process atomicity within a region. Today, two processes in `us-east` each hold their own in-process escrow; the bound on TOTAL US-East admissions per window is `2 × batch` instead of `batch` |
| `onCoordinatorOutage: "regional-only"` | "lands fully in TK-906 along with the regional Store; at this commit it falls back to `fail-closed`" (src/federation/window-coupled.ts §74-76, §225-227) | The availability-over-precision mode operators opted into doesn't actually exist — they get `fail-closed` behavior unbeknownst to them |

Both are the **same** gap: the regional Redis layer that should sit
between the federation engine (process-local) and the global coordinator
(cross-region). Adding it closes both at once.

---

## 2  Recap: the federation stack today

```
                       ┌──────────────────────────┐
                       │ GlobalCoordinator (L3)   │  ← Redis/Postgres single
                       │ - lease(key, tokens, e)  │
                       │ - reconcile(...)         │
                       └──────────────────────────┘
                                  ▲
                                  │ cross-region RTT (1-150 ms)
              ┌───────────────────┼────────────────────┐
              │ federation engine (per-process)        │
              │ - in-process Entry per key             │
              │ - balance, windowStart, windowExpiresAt│
              │ - leases batch tokens at a time        │
              │ - decrements on admit; reconciles      │
              │   leftover at window boundary          │
              └────────────────────────────────────────┘
                                  ▲
                                  │ in-process call
                       ┌──────────────────────────┐
                       │ caller (rateLimit etc.)  │
                       └──────────────────────────┘
```

**The 0.8.3 commitment**: Δ = 0 per global window, K-INDEPENDENT.

**Where multi-process is missing**: if you run M processes in the same
region, each has its own `Entry` per key. They each lease `batch` tokens
from the coordinator. Total regional in-flight escrow: `M × batch`.
Within the GLOBAL window the federation bound STILL holds (Δ = 0) —
because the coordinator counted each region's lease. But within a
*region* the regional bound is `M × batch` instead of `batch`. For
operators who care about regional sub-bounds (rare but real for some
billing / quota stories), this is a leak.

---

## 3  What 0.8.5 ships

```
                       ┌──────────────────────────┐
                       │ GlobalCoordinator (L3)   │
                       └──────────────────────────┘
                                  ▲
                                  │ cross-region RTT
              ┌───────────────────┴────────────────────┐
              │ regional escrow (regional Redis L2)   │  ← NEW in 0.8.5
              │ - HASH per (key, region)               │
              │ - { balance, expires_at, window_start} │
              │ - atomic Lua lease/release             │
              │ - PEXPIRE drops at window boundary     │
              └────────────────────────────────────────┘
                                  ▲
                                  │ same-region RTT (~ms)
              ┌───────────────────┴────────────────────┐
              │ federation engine (per-process)        │
              │ - in-process L1 CACHE only             │
              │ - calls regional escrow on shortage    │
              │ - same lease/reconcile shape           │
              └────────────────────────────────────────┘
```

Two consequences:
1. **Multi-process atomicity**: M processes in the same region share the
   regional Redis L2; total in-flight regional escrow is `batch`, not
   `M × batch`.
2. **`regional-only` outage mode works**: when the coordinator is
   unreachable, the engine continues to serve from regional Redis L2
   until the regional budget is depleted. Δ degrades from federation
   bound (Δ = 0) to *regional bound* (≤ `regional_budget`) — the
   documented availability-over-precision opt-in.

---

## 4  Schema (regional Redis HASH per key)

Mirror `RedisCoordinator`'s pattern, one layer down:

```
key:     <prefix>:<region>:<federation-key>
type:    HASH
fields:
  balance         : remaining regional escrow for the active window
  expires_at      : when the active window ends (epoch-ms)
  window_start    : the active window's start (epoch-ms) — for reconcile idempotency
  source_lease    : the most recent windowStart the regional lease was refilled from coordinator
PEXPIRE: set to expires_at - now on every touch (auto-cleanup at window roll)
```

**Why include `region` in the key?** Two regions sharing the same regional
Redis (rare but possible — e.g. `us-east-1` and `us-east-2` both pointing
at a us-east Redis cluster) need separate escrows. Defaults to the
`region` argument to `federate(...)`.

**Why `source_lease`?** Tracks "which coordinator-side window did this
regional escrow come from?" Needed for the regional-only-recovery
reconcile: when the coordinator returns, the engine reconciles regional
leftover against the *original* source windowStart, not the current.

---

## 5  Lua scripts (atomic regional ops)

Three scripts, all mirror the `RedisCoordinator` pattern. Server-time
anchoring via `redis.call('TIME')` (same as `RedisCoordinator`).

### 5.1 `REGIONAL_LEASE` — acquire regional escrow

```lua
-- KEYS[1] = regional escrow key
-- ARGV[1] = now (epoch-ms; 0 → use TIME)
-- ARGV[2] = tokens requested
-- ARGV[3] = windowMs
-- ARGV[4] = source_lease windowStart (from coordinator)
-- ARGV[5] = perRegionBudget (the batch the coordinator granted us)
-- Returns: granted (0..tokens)

local windowStart = floor(now / windowMs) * windowMs
local expiresAt = windowStart + windowMs

local h = HMGET KEYS[1] balance expires_at source_lease
-- ... if expired window OR fresh: initialize to perRegionBudget tagged with source_lease
-- ... compute granted = MIN(tokens, balance); decrement; PEXPIRE; return granted
```

### 5.2 `REGIONAL_RELEASE` — return unused regional escrow at window boundary

```lua
-- KEYS[1] = regional escrow key
-- ARGV[1] = now
-- ARGV[2] = leftover
-- ARGV[3] = windowStart (the window being closed)
-- ARGV[4] = windowMs
-- Returns: amount actually released to upstream coordinator (0 if window already rolled)

-- Idempotent: if window has rolled OR source_lease != windowStart, no-op.
-- Otherwise: zero out balance; expire HASH; return balance value.
```

The "released" amount is then handed to `coordinator.reconcile(...)` by
the engine — preserving the existing reconcile semantics.

### 5.3 `REGIONAL_REFILL` — refill regional from coordinator grant

```lua
-- KEYS[1] = regional escrow key
-- ARGV[1] = now
-- ARGV[2] = granted (from coordinator.lease)
-- ARGV[3] = source_lease windowStart
-- ARGV[4] = windowMs
-- Returns: 1 if refilled, 0 if window mismatch

-- Sets balance := granted, source_lease := windowStart, expires_at := windowStart + windowMs.
-- PEXPIRE to (expires_at - now). Atomic.
```

---

## 6  Engine integration (how the federation engine changes)

The existing `createFederationEngine` (src/federation/window-coupled.ts)
holds `Map<key, Entry>` of in-process state. The change:

**Before (0.8.4)**:
```ts
async function check(key: string, cost: number) {
  let entry = state.get(key);
  if (entry === undefined || windowRolled(entry)) {
    entry = await openWindow(key);   // calls coordinator.lease(...)
  }
  if (entry.balance >= cost) {
    entry.balance -= cost;
    return ALLOW;
  }
  // shortage: try to refill from coordinator
  const granted = await refill(key, batch);
  if (entry.balance >= cost) { ... }
  return DENY;
}
```

**After (0.8.5)** — when `regional` is provided:
```ts
async function check(key: string, cost: number) {
  let entry = state.get(key);
  if (entry === undefined || windowRolled(entry)) {
    entry = await openWindow(key);   // calls coordinator.lease, then REGIONAL_REFILL
  }
  // Try in-process L1 cache first (fast path; no Redis trip).
  if (entry.balance >= cost) {
    entry.balance -= cost;
    return ALLOW;
  }
  // L1 shortage: leases from regional L2 (typically one ~ms RTT to local Redis).
  const grantedL2 = await REGIONAL_LEASE(key, batch);
  if (grantedL2 > 0) {
    entry.balance += grantedL2;
    if (entry.balance >= cost) { entry.balance -= cost; return ALLOW; }
  }
  // L2 shortage too: regional escrow exhausted in this window → DENY.
  return DENY;
}
```

When `regional` is **NOT** provided, the engine falls back to the existing
in-process-only behavior (backward compatible). Detection:
`regional` defined ⇒ multi-process mode; undefined ⇒ legacy single-process
mode.

The window-coupling rule applies at BOTH layers:
- Regional Redis L2 HASH auto-expires at `expires_at` (PEXPIRE)
- In-process L1 entry's `balance` becomes invalid at the same boundary
  (the existing check)
- Both reconcile to the upstream layer when their window rolls

---

## 7  `regional-only` outage mode (the second deliverable)

When `onCoordinatorOutage: "regional-only"` is set AND `regional` is
provided, the engine swaps strategies on a coordinator failure:

```ts
async function refill(key, batch) {
  try {
    const granted = await coordinator.lease(key, batch, expiresAt);
    await REGIONAL_REFILL(key, granted, sourceWindowStart);
    return granted;
  } catch (err) {  // StoreUnavailableError
    if (onCoordinatorOutage === "regional-only") {
      // Don't refill from coordinator. Continue against regional Redis L2's
      // remaining balance. If L2 is also empty, deny (the bound degrades to
      // the regional budget, NOT zero).
      coordinatorHealthy = false;
      scheduleHealthRecheck();
      return 0;  // signal: no new grant, but don't propagate the error
    }
    throw err;   // fail-closed: bubble up; engine returns DENY
  }
}
```

**The trade-off** (documented):
- `fail-closed` (default): on coordinator outage, regional escrow empties
  → engine denies until coordinator returns. Δ = 0 preserved.
- `regional-only`: on coordinator outage, regional escrow continues
  serving until it depletes; new requests admitted up to the *regional
  budget* (the `batch` last refilled). Δ ≤ regional budget per
  surviving window. Once coordinator returns, normal lease/reconcile
  resumes.

**Recovery story**: when the coordinator returns (`isHealthy()` periodic
poll), the engine resumes calling `coordinator.lease(...)`. The regional
Redis state is preserved across the outage; the next refill cycle is
identical to the steady-state path. If the engine missed a window
boundary during the outage, the regional Redis HASH PEXPIRE'd and the
next refill initializes a fresh window from the (recovered) coordinator
— so the federation bound is RE-ENFORCED from that point. The outage
window is a soft-bound period; before and after it the hard bound holds.

### 7.1 What `regional-only` does NOT promise

- It does NOT promise the federation bound during the outage. The bound
  degrades to the regional budget. This is the entire reason it's
  opt-in.
- It does NOT promise the coordinator-Redis bound on a partial-write
  recovery (split-brain across cross-region links). For that, the
  coordinator's primary failover (Sentinel / Patroni) is the right
  layer.
- It does NOT auto-detect that the coordinator is healthy again — the
  engine periodically calls `coordinator.isHealthy()` (every 5s by
  default; configurable via `coordinatorHealthCheckMs`). When healthy,
  the engine resumes coordinator-lease.

---

## 8  Public API

**DR-20 (TK-1306 implementation revision)**: The original design (§8 below)
spec'd `regional?: Store` as the wiring point — but the `Store` interface
(`apply(transform)` + `reset(key)`) doesn't accept the multi-arg atomic Lua
scripts the L2 layer needs (LEASE/REFILL/RELEASE), and routing through the
generic `Transform` would couple `Store`'s contract to federation semantics.
We introduce a first-class **`RegionalEscrow`** interface instead, mirroring
`GlobalCoordinator` one layer down. The existing `regional?: Store` field
on `FederatedStoreOptions` stays accepted (still used for `regional.reset()`
plumbing); the new `regionalEscrow?: RegionalEscrow` field is what the engine
actually consults. Purely additive — no breaking changes.

**DR-21 (TK-1306 algorithmic revision)**: `REFILL` is **additive** within a
window (`balance += granted` when `source_lease == sourceWindowStart`),
not "first-wins". Rationale: multiple processes can each call
`coord.lease()` concurrently at window-open; first-wins would discard the
losers' grants (capacity leak), additive accumulates them in L2 where any
process can lease them. Federation bound (Δ = 0) is preserved by the L3
coordinator's `perKeyBudget` cap — total grants per window per key ≤
`perKeyBudget` regardless of how many processes contributed. The original
design's "regional bound ≤ batch per window" claim narrows to "regional
bound ≤ perKeyBudget per window per region" — same as the federation bound,
which is still the load-bearing guarantee for the regional-only outage mode.

### 8.1 The `RegionalEscrow` interface (TK-1306 actual)

```ts
export interface RegionalEscrow {
  /** Consume from L2 balance. Returns granted (0..tokens). */
  lease(key: string, tokens: number): Promise<number>;
  /** Add an L3 grant to L2 balance; additive within window; idempotent on stale grants. */
  refill(key: string, granted: number, sourceWindowStart: number): Promise<boolean>;
  /** Capture-and-zero the balance at window roll; idempotent per (key, sourceWindowStart). */
  release(key: string, sourceWindowStart: number): Promise<number>;
  isHealthy?(): Promise<boolean>;
}
```

Implementations shipping in 0.8.5:
- `RedisRegionalEscrow` — Lua-backed; mirrors `RedisCoordinator` pattern
- `TestRegionalEscrow` — deterministic in-memory; mirrors `TestCoordinator`

### 8.2 The wiring at `federate(...)` / `FederatedStore`

```ts
interface FederateOptions<S> {
  strategy: Strategy<S>;
  coordinator: GlobalCoordinator;
  region: Region;
  batch?: number;
  /**
   * Regional escrow (L2) for multi-process per-region atomicity and
   * regional-only outage mode. When provided, the engine routes leases
   * through L2 before reaching the coordinator (L3). When undefined,
   * the engine uses in-process escrow only (legacy 0.8.4 behavior).
   */
  regionalEscrow?: RegionalEscrow;
  /**
   * (Soft-deprecated as of 0.8.5; the `regionalEscrow` field is what the
   * engine actually consults. This field stays accepted but is no-op for
   * the engine — kept for backward compat with the 0.8.3+ FederatedStore
   * API which used it for `reset()` plumbing.)
   */
  regional?: Store;
  onCoordinatorOutage?: CoordinatorOutageMode;
  /**
   * How often to re-check `coordinator.isHealthy()` while in
   * `regional-only` mode after a coordinator outage. Default 5000 (5 s).
   */
  coordinatorHealthCheckMs?: number;
  clock?: Clock;
  prefix?: string;
}
```

### 8.3 Original draft (superseded by §8.1 + §8.2)

```ts
// Original draft — superseded. Kept for audit trail.
interface FederateOptions<S> {
  // ...
  regional?: Store;  // ← was the planned wiring; replaced by `regionalEscrow`
  // ...
}
```

---

## 9  Test plan (TK-1306)

Six layers, all running against the existing `tk-redis-test` on port
`6380` per `memory/local-test-redis.md`:

1. **Multi-process atomicity** (`test/federation/regional-escrow.test.ts`).
   - Two `federate(...)` engines in the same region share a regional Redis.
   - Combined admissions stay within `batch` per window.
   - Property test: M ∈ {2, 4, 8} processes, 100 timelines each.

2. **Regional escrow lease/release atomicity**.
   - Direct Lua script invocation (REGIONAL_LEASE, REGIONAL_RELEASE).
   - Verifies window-roll detection, idempotency on windowStart.

3. **`regional-only` happy path** (`test/federation/regional-only.test.ts`).
   - Force coordinator down (mock or disconnected client).
   - Verify regional Redis continues serving until budget depleted.
   - Verify Δ ≤ regional budget per window (the documented degradation).
   - Verify recovery: coordinator returns → next refill cycle resumes.

4. **`regional-only` window-boundary recovery**.
   - Coordinator dies during window N.
   - Window N+1 starts while coordinator is still down (regional Redis
     HASH PEXPIRE'd).
   - Coordinator returns mid-N+1.
   - Verify the engine reinitializes the regional escrow from the fresh
     coordinator grant; Δ = 0 bound holds from that point forward.

5. **Backward compat (no regional store)**.
   - `federate({ ... })` without `regional` falls back to existing
     in-process behavior; all existing tests (TK-901..TK-912) pass
     unchanged.

6. **Property-based dual-path** (existing test/federation/property.test.ts).
   - Extend the existing K=2,3,4 timelines with M ∈ {1, 2, 4} processes
     per region. The bound `total_admitted_per_global_window ≤ Limit`
     holds for all (K, M) combinations.

Gated on `THROTTLEKIT_TEST_REDIS` (already required for the existing
federation tests).

---

## 10  Failure modes (vs 0.8.4 baseline)

| Failure shape | 0.8.4 behavior | 0.8.5 behavior |
|---|---|---|
| Coordinator unreachable, `fail-closed` (default) | Engine denies once in-process escrow empty | UNCHANGED — engine denies once in-process AND regional escrow both empty (slightly more headroom in practice but same logical guarantee: Δ ≤ regional budget at outage onset, which depletes to 0) |
| Coordinator unreachable, `regional-only` | Falls back to `fail-closed` (documented broken-by-design) | **FIXED** — engine continues against regional Redis L2 until L2 depletes; Δ ≤ regional budget per window during outage |
| Regional Redis unreachable, coordinator healthy | n/a (regional was unused) | Engine falls back to in-process-only mode for the duration of the regional outage. Δ degrades from `batch` to `M × batch` per region (the existing 0.8.4 behavior) |
| Both regional Redis AND coordinator unreachable | Engine denies (in-process escrow then empty) | Engine denies (in-process escrow then empty, then regional empty too) |
| Multi-process within a region | M independent processes each lease `batch` from coordinator; total regional escrow `M × batch` | **FIXED** — processes share regional Redis L2; total regional escrow `batch` per region |

---

## 11  Out of scope (for 0.8.5)

- **Federated WFE** (Pillar 4 escrow-layer fair-share across tenants).
  That's TK-1309..TK-1313 (0.9.1). Composes naturally with this — the
  regional escrow becomes the layer at which WFE applies.
- **Distributed adaptive concurrency** (TK-1314..TK-1318). Also composes
  with this (regional escrow as the concurrency-counting layer).
- **Per-process L1 sizing adaptation**. The existing `batch` is static;
  GALE Pillar 2 (`leaseSizer`) applies unchanged. Live-wiring is a
  separate polish task per PLAN.md §6.6.

---

## 12  Definition of done (TK-1306)

- `src/federation/window-coupled.ts` engine USES the `regional: Store`
  when provided (currently ignored); regional Redis L2 between
  in-process L1 and coordinator L3.
- Three Lua scripts (REGIONAL_LEASE / REGIONAL_RELEASE / REGIONAL_REFILL)
  in the engine, atomic via EVALSHA (mirroring `RedisCoordinator`).
- `onCoordinatorOutage: "regional-only"` actually works — engine
  continues serving from regional Redis L2 during coordinator outage,
  resumes normal operation on coordinator recovery.
- `test/federation/regional-escrow.test.ts` covers multi-process
  atomicity (≥ 100 timelines × M ∈ {2,4,8} processes); gated on
  `THROTTLEKIT_TEST_REDIS`.
- `test/federation/regional-only.test.ts` covers the regional-only
  outage flow + recovery; gated on `THROTTLEKIT_TEST_REDIS`.
- Backward compat: `federate(...)` without `regional` behaves identically
  to 0.8.4. All existing federation tests pass unchanged.
- `npm run check` green at 870+ tests (12 new regional tests + 12
  existing PostgresCoordinator + 793 baseline = 817 pass, plus gated
  counts).

---

## 13  References

- `src/federation/window-coupled.ts` — the engine; §66-71 + §74-76 +
  §225-227 are the locations that flag the gaps closed here.
- `src/federation/redis-coordinator.ts` — the Lua-script pattern to
  mirror at the regional layer.
- `research/postgres-coordinator/DESIGN.md` — the 0.8.4 design that
  preceded this; same shape (atomicity + outage-mode wiring).
- `research/bigger-bets/federation/DESIGN.md` §3.1 (the recursive twoTier
  insight: regional Redis as L2 between in-process L1 and global L3).
- `spec/GaleFederatedLeasing.tla` — the formal model; the bound
  (Δ = 0 K-INDEPENDENT) is preserved end-to-end; this design adds
  precision at the regional sub-bound (`batch` per region instead of
  `M × batch`).
