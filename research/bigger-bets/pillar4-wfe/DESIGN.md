# Pillar 4 escrow-layer WFE — design (TK-1309 / 0.9.1)

> Status: design lock for TK-1309. Implementation begins TK-1310.
> Target release: **0.9.1** — the first patch after the federation+unified
> pair (0.8.5 / 0.9.0). Read `research/bigger-bets/PLAN.md` §6.5 and
> `research/gale/PILLAR4-fairness.md` first — this expands the former and
> productizes the latter. No code is written here; the gate this doc
> opens is **TK-1310 — `weightedFairEscrow()` implementation + tests**.

This document specifies how the existing weighted max-min fair allocation
(`weightedMaxMin`, already shipped in `src/admission/index.ts`) graduates
to the escrow / leasing layer as a production primitive
`weightedFairEscrow(...)` under `src/twotier/`. The research artifact in
`test/gale/fair-escrow.{ts,test.ts}` — four theorems (T1 safety, T2
sharing-incentive, T3 work-conservation, T4 bounded unfairness),
machine-checked at 20 000 random trials — is the proof carrier. This
doc locks the API shape, the lease integration, the multi-process
backing, the composition rules, and the test gate.

---

## 0  Why this doc exists

The graduation gap is **narrower than a new primitive but wider than a
rename**. Two pieces already ship in 0.9.0:

| Piece | Where | What it does |
|---|---|---|
| `weightedMaxMin(d, w, L)` | `src/admission/index.ts:456-483` | Exact integer batch weighted max-min — pure function |
| `weightedFairShare({ limit, windowMs, weightOf, clock })` | `src/admission/index.ts:538-622` | Streaming, single-process *equal-share approximation* at the admission-decision level |

`weightedFairShare` is explicit about its limitation (lines 524-536): it
is **online weighted equal-share approximation, NOT exact work-conserving
weighted max-min** — surplus is first-come, not redistributed by weight,
because it never sees all tenants' demands at once. The pure
`weightedMaxMin` is the exact split *if you have all demands*; the
streaming limiter never gets that view.

The missing piece, the one TK-1310 ships, is the **escrow-layer
composition that bridges the exact batch split to a Store-backed budget**.
Concretely: when a leased budget `L` is contended across `N` tenants,
all `N` should reach a common weighted service level `aᵢ/wᵢ`, with the
surplus from idle tenants actually flowing to the backlogged ones in
proportion to weight — and that should hold across processes when the
budget lives in Redis/Postgres, not just within one node.

The cost of getting this wrong is the same FCFS-starvation that
`PILLAR4-fairness.md` calls out: under multi-tenant overload, a
low-priority tenant's flood drains the leased pool before the weighted
floor `gᵢ = ⌊wᵢ/W · L⌋` of a high-priority tenant is honored. That is
not a hypothetical; it is the Workload C contrast already measured in
`test/gale/fair-escrow.test.ts` (lines 155-198): static fair is fair but
strands the idle high-priority share (mean util 0.876); weight-blind
leasing reclaims the surplus but starves the priority tenant (share
violation > 0.20); only WFE is good on both axes.

This doc exists because the productization step has **three load-bearing
design choices** that have to be locked before implementation, each with
real downside risk:

1. **Where to insert WFE in the existing primitive graph** (decorator
   above `twoTier`, fairness inside the leased loop, or a new top-level
   primitive). §4.
2. **How `Decision.limit` is reported per tenant** without breaking the
   `combineDecisions` algebra that the 0.9.0 release just locked. §5.
3. **The multi-process backing**: re-use the federation `RegionalEscrow`
   Lua, write new fair-share Lua, or stay single-process at 0.9.1. §6.

A wrong decision on any of these is *not* an additive fix afterwards —
it would either break composition with `unifiedAdmission`
(`combineDecisions` is already public API as of 0.9.0) or force a wire
change to the regional-escrow Redis layout shipped in 0.8.5. Both are
hard reversals.

---

## 1  Problem statement

### 1.1 The escrow-layer fairness gap

`twoTier(leased)` (`src/twotier/index.ts:174-302`) is the production
escrow primitive: each node leases a batch of credits from L2 and serves
them locally, with the steady-state network cost converging to ~1 round
trip per `batch` requests. The lease loop's signature is
`check(key, cost) → Decision` — note the *single key*. The
existing implementation has **no tenant arithmetic**:

```ts
// src/twotier/index.ts:249-302 — the leased check loop
const check = async (key: string, cost = 1): Promise<Decision> => {
  // … local credits served FIFO, lease loop on shortage …
  const leaseAmount = Math.max(batch, cost);
  lease = l2.apply(fk, decisionTransform(strategy, clock.now(), leaseAmount))
    .then(/* … */);
};
```

When `N` tenants share one `twoTier` key (the common case for an LLM
gateway sharing one `tk:gateway:default` key across customers), the
local credit pool is consumed in arrival order, and the L2 lease is
issued by the unlucky tenant whose check happened to find the pool
empty. **There is no weighted ceiling, no surplus reclamation, and no
visibility into per-tenant share.** Under the Workload C contrast that
is documented misbehavior.

Three operator workarounds today, none of which are good:

- **Run `weightedFairShare` *above* `twoTier`** — but `weightedFairShare`
  is the equal-share approximation; surplus is FCFS, not weight-fair, so
  on idle tenants the high-weight tenant gets less than `wᵢ/W` of the
  released capacity.
- **Use `fairShare` with manually-tuned per-tenant `twoTier` keys** —
  this works but defeats the *pooling* point of `twoTier`: each tenant
  has its own leased batch and its own L2 round trip, no surplus sharing,
  the operational complexity goes up `N`-fold.
- **Pre-allocate static slices `gᵢ = wᵢ/W · L`** — the Workload-C
  baseline, drops to 0.876 mean util on the high-weight tenant's idle
  windows.

The gap is: `twoTier`'s **work-conservation** + `weightedFairShare`'s
**weight honoring** + a **hard Δ = 0 bound** that composes with Pillar 1.
WFE is exactly that union — *but only as a research artifact*. TK-1310
ships it.

### 1.2 The unifiedAdmission composition gap (the 0.9.0 surface)

`unifiedAdmission(...)` (0.9.0, `src/admission/unified.ts`) composes
rate ⊕ concurrency ⊕ cost into one `Decision` via `combineDecisions`.
Under multi-tenant overload, the *cost* axis is currently first-come:
whichever tenant's request hits the cost meter first gets the remaining
budget. The same fairness bug `twoTier(leased)` has, the LLM gateway
inherits when the cost meter is shared.

This means WFE's graduation isn't just escrow-layer — it has to compose
with `unifiedAdmission`'s `Decision`-shaped contract. A WFE primitive
that returns `Decision` (not a custom shape) drops into
`unifiedAdmission({ cost: weightedFairEscrow({...}) })` for free. This
constrains the API shape (§5).

### 1.3 The multi-process surface (the 0.8.5 surface)

`RedisRegionalEscrow` (0.8.5, `src/federation/redis-regional-escrow.ts`)
manages a per-region L2 escrow as a single integer balance with
window-coupled TTL. A leased credit pool that is *both* federated AND
weight-fair across tenants is what an LLM gateway running on multi-region
infrastructure ultimately needs — but doing both at 0.9.1 (a) doubles
the Lua surface, (b) requires new BFS-twin tests for `(region, tenant)`
state, (c) blocks Pillar 4 on a federation-fairness composition theorem
that doesn't yet exist in `research/gale/`.

0.9.1 ships **single-pool WFE** (one L2 store, no federation). Federated
WFE is a clean follow-up (§12, DR-P4-7) once the federation+adaptive
composition (0.10.0) and the joint-LP work (0.10.1) are done — by which
point the `(region, tenant)` math is well-rehearsed.

---

## 2  Lit synthesis

The fairness literature is dense; this section pins exactly what is being
ported and what stays in research-only land.

### 2.1 Weighted max-min as the fairness ideal

[**Bertsekas & Gallager, *Data Networks*, §6.5.2**][bertsekas-gallager]
defines max-min fair allocation as the unique allocation that
*lexicographically maximizes the sorted vector of allocations* subject
to feasibility. Weighted max-min generalizes by replacing `aᵢ` with
`aᵢ / wᵢ` — the "common service level" is normalized service. The
[Parekh-Gallager][gps] generalized processor sharing (GPS) result
(ToN'93) shows that under GPS, every backlogged session reaches the same
normalized service level instantaneously; weighted max-min is the
discrete-time analog.

This is **the target allocation** WFE realizes. `waterfill()` in
`src/admission/index.ts:406-439` computes it in continuous form (`O(n
log n)`); the integer version `weightedMaxMin()` (lines 456-483) rounds
to integer credits with a bounded `< n`-credit drip.

### 2.2 Deficit Round Robin — quantum-bounded fairness

[**Shreedhar & Varghese**][drr] (DRR, SIGCOMM'95) gave the first
weighted fair scheduler with **O(1) per-packet** work, by associating a
*deficit counter* with each backlogged flow and rotating through them in
fixed-size quantum units. Their key result (Theorem 1):

```text
|Sent_i(t) − Sent_j(t) · wᵢ/wⱼ|  ≤  Quantum_i + Quantum_j  · (independent of t)
```

The relative fairness bound is `Q · (1/wᵢ + 1/wⱼ)` after dividing
through. This is **independent of window length and demand magnitude** —
the bound holds forever. This is T4 in `PILLAR4-fairness.md`.

The DRR insight maps directly: in WFE, the **lease size** `bᵢ` plays the
role of the per-flow quantum, and the **L2 leased budget** plays the
role of the link's instantaneous capacity. The bound transfers verbatim,
with the lease size as the tunable knob — larger leases mean fewer round
trips and *looser* fairness; smaller leases mean tighter fairness and
more coordination. **This is the Pillar 1 trilemma's coordination axis,
exposed on the fairness side.**

### 2.3 Core-Stateless Fair Queueing — fairness without per-flow state

[**Stoica, Shenker & Zhang**][csfq] (CSFQ, SIGCOMM'98) showed that
*approximate* fair queueing is achievable in an O(1)-state core, by
edge-labeling each packet with its arrival rate and core-comparing
against a single fair-share threshold. The lesson for WFE: **you do not
need per-tenant queues in the shared store**. WFE's L2 state is exactly
one integer (the remaining budget) plus the per-key lease record
`twoTier` already keeps. Per-tenant state lives in L1 (in-process), not
L2 (shared). This makes the Lua surface trivial — the existing
`RedisRegionalEscrow.lease` Lua needs zero changes — and rules out a
hierarchical-controller pattern (`Pisces`, §2.5).

### 2.4 Fair queueing with per-flow weight — Weighted Fair Queueing

[**Demers, Keshav & Shenker**][wfq] (WFQ, SIGCOMM'89) is the original
weighted generalization. The mechanism (virtual-time-tagged round-robin)
is irrelevant to WFE (we don't round-robin packets; we round-robin
*credits via leases*), but the **isolation guarantee** is what matters:
a flow with weight `wᵢ` is guaranteed throughput `wᵢ/W · C` no matter
what other flows do — formally, `aᵢ ≥ min(dᵢ, gᵢ)` where
`gᵢ = ⌊wᵢ/W · L⌋`. That is T2 (sharing-incentive) in
`PILLAR4-fairness.md`, with the proof retained inline.

### 2.5 What we *don't* do — central controllers, multi-resource, strategy-proofness

- **Pisces** (Shue, Freedman & Shaikh, OSDI'12) — fairness-under-skew
  with a central controller, multi-tenant key-value store. We avoid the
  central controller. The L3 coordinator in our federation is for
  cross-region pooling, not per-tenant arbitration; tenant arithmetic
  stays at the L1 (in-process) level, with the L2 budget the only
  shared state. This matches the CSFQ design principle (§2.3) and keeps
  the WFE primitive composable with the *existing* federation
  coordinator without a wire change.
- **DRF** (Ghodsi et al., NSDI'11) — multi-resource fairness, the right
  frame when tenants compete for `(CPU, RAM, disk)` simultaneously. WFE
  is single-resource (one leased budget, one weight per tenant);
  multi-resource fairness is the joint-LP work on the 0.10.1 track
  (DR-19), not Pillar 4. *(Note: WFE composing with `unifiedAdmission`
  gives a kind of multi-axis fairness — but the AXES are
  rate/concurrency/cost, not tenants × resources. Each axis stays
  single-resource for WFE purposes.)*
- **FairRide** (Pu et al., NSDI'16) — strategy-proof + Pareto-efficient
  + sharing-incentive is **impossible** for shared caches (the SIP
  impossibility, Theorem 1). WFE picks
  **sharing-incentive + work-conserving** (Pareto-efficient up to
  quantum); it is **NOT strategy-proof**. T5 in
  `PILLAR4-fairness.md` records this honestly: a tenant can over-declare
  demand to claim surplus. Window-coupling bounds the gain (inflated
  credits expire), but we claim no strategy-proofness. Documented
  prominently in `Decision.limit` semantics (§5) and the API docstring.

### 2.6 What's already cited in PILLAR4-fairness.md — re-pinned

The research doc already cites Shreedhar-Varghese, Demers-Keshav-Shenker,
Parekh-Gallager, Stoica-Shenker-Zhang, Shue-Freedman-Shaikh,
Ghodsi-et-al, Pu-et-al. This doc preserves those anchors and adds
**[Bertsekas-Gallager][bertsekas-gallager]** (the canonical max-min
definition) and **[Little's Law][little]** (referenced for the lease-vs-RTT
quantum tradeoff in §4).

---

## 3  What 0.9.0 already ships (the inventory)

Before locking the API, an honest reckoning of what's already public:

| Symbol | Where | Shape | Limitation |
|---|---|---|---|
| `weightedMaxMin(d, w, L) → number[]` | `src/admission/index.ts:456-483` | Pure, integer, exact weighted max-min | Batch only — needs all demands at once |
| `guaranteedShare(w, L) → number[]` | `src/admission/index.ts:398-403` | Pure, `gᵢ = ⌊wᵢ/W·L⌋` | None (it's a primitive) |
| `weightedFairShare({...})` | `src/admission/index.ts:538-622` | Streaming, single-process, **equal-share approximation** | Surplus is FCFS; not work-conserving under skew (documented at lines 524-536) |
| `fairShare({...})` | `src/admission/index.ts:288-373` | Streaming equal-share (unweighted) | Same |
| `twoTier(leased)` | `src/twotier/index.ts:174-302` | Escrow-leasing primitive, single-key | No tenant arithmetic — single key, FCFS within node |
| `RedisRegionalEscrow` | `src/federation/redis-regional-escrow.ts` | Multi-process L2 escrow (single integer balance per key) | One budget per region, no per-tenant share |

The graduation TK-1310 ships is **the weighted-max-min algebra running
against an L2 Store-backed budget, with per-tenant ceilings reclaimed
lazily on contention** — neither of those independently is missing, but
their composition is. The naming reflects this: it's *Weighted Fair
**Escrow***, not "weighted fair Limiter" — the unit of accounting is
the leased escrow credit, not the admission count, even though the
visible API is `check(tenant, cost) → Decision` (preserving
`unifiedAdmission` composition; §1.2).

---

## 4  Where to insert WFE — the architectural choice

Three candidate insertion points, with the failure modes that ruled out
the rejected ones. **DR-P4-1 records the choice; this is the most
load-bearing decision in this doc.**

### Option A — Decorator above `twoTier` (rejected)

Wrap an existing `Limiter` with a WFE pre-check; the WFE pre-check
returns deny if the tenant has spent its weighted share, otherwise the
inner limiter runs as usual.

```ts
// REJECTED API shape
const inner = twoTier({ strategy: tokenBucket({...}), l2: redis, mode: "leased", lease: { batch: 100 } });
const fair = weightedFairDecorator({ inner, weightOf: t => weights[t] ?? 1 });
await fair.check("tenant-A", "shared-key", 5);  // tenant + key + cost
```

**Why rejected:**

1. **The pre-check has no visibility into the L2 budget.** The decorator
   sees only `Limiter.check()` results, which are already-committed
   admit/deny decisions. To enforce a weighted ceiling, the decorator
   must maintain its own *parallel* accounting of per-tenant
   consumption — but it never sees the leased pool size, only the inner
   limiter's after-the-fact `Decision`. So the weighted ceiling is at
   best an equal-share approximation of the visible admit rate, which
   is what `weightedFairShare` already is. **The decorator
   reinvents `weightedFairShare`, not WFE.** Failure mode confirmed.
2. **The shape collision.** `Limiter.check(key, cost)` has two
   parameters; the WFE check needs `tenant` distinct from `key`. The
   decorator either (a) overloads `key` to mean "tenant" (breaking
   `twoTier`'s key-namespace semantics) or (b) introduces a new
   `check(tenant, key, cost)` signature that doesn't match `Limiter`
   (breaking the decorator pattern itself).

### Option B — Fairness *inside* `twoTier`'s leased loop (rejected for 0.9.1)

Extend `twoTier(leased)` to accept a `tenants` config and split the
leased `batch` across local tenants via `weightedMaxMin` at lease time.

```ts
// REJECTED API shape for 0.9.1
const limiter = twoTier({
  strategy: tokenBucket({...}),
  l2: redis,
  mode: "leased",
  lease: { batch: 100 },
  fairness: {                                       // ← new
    weightOf: (tenant) => weights[tenant] ?? 1,
    quantum: 10,                                     // ≤ batch
  },
});
await limiter.check("shared-key", 5, "tenant-A");   // ← new third param
```

**Why rejected for 0.9.1 (but reconsidered for 0.10.x):**

1. **Widens `Limiter.check` signature** — `check(key, cost, tenant?)`
   is a breaking change to the `Limiter` interface that 0.9.0's
   `combineDecisions` algebra depends on. We just locked
   `combineDecisions(a: Decision, b: Decision)` and built
   `unifiedAdmission` on top of it; widening `Limiter.check` to take a
   tenant is a wire-protocol change at the type level (DR-14 forbids
   wire changes without authorization).
2. **Bloats the leased-loop hot path.** The current leased loop is one
   of the most-exercised paths in the library (every `check()` in a
   leased `twoTier`). Threading per-tenant ceilings, surplus
   reclamation, and weighted credit accounting through that loop
   significantly raises the bar for property tests
   (`twoTier` already has 200+ tests). The performance gate at
   `bench/baseline.json` is 200ns/op; tenant-aware lease accounting
   could easily double that.
3. **Confuses the namespaces.** `twoTier`'s `key` is *the limited
   resource* (e.g. `"api/v1/completions"`); tenant is *the actor*. Forcing
   the leased loop to handle both makes the mental model "this limiter
   limits both keys and tenants" — confusing, and a wrong abstraction
   for the cases where the user really does want a tenant-blind shared
   leased budget.
4. **Composition with `unifiedAdmission` is awkward**. The
   `unifiedAdmission` API hands `cost` to each axis via `admit({ cost })`
   — there's no `admit({ cost, tenant })` overload, and adding one
   forces a `combineDecisions` widening.

Option B *is* the right shape for a future hot-path-fused
weighted-leased primitive (the way `tk:v1:fused-rc:check` fused rate +
cost in 0.9.0); it's deferred to **0.10.x**, conditional on a demonstrated
performance win, and called out in §12 (DR-P4-9).

### Option C — Top-level `weightedFairEscrow(...)` primitive (selected)

A self-contained primitive that owns its own L1 ceiling state plus an
optional L2 Store-backed budget, and exposes
`.check(tenant, cost) → Decision`:

```ts
// SELECTED API shape — DR-P4-1
import { weightedFairEscrow } from "throttlekit/twotier";

const escrow = weightedFairEscrow({
  limit: 10_000,                                    // L: budget per window
  windowMs: 60_000,
  weightOf: (tenant) => tenantWeights[tenant] ?? 1, // wᵢ
  quantum: 100,                                     // DRR quantum (= per-tenant grant size)
  // Multi-process backing (optional):
  l2: redisStore,                                   // Store from throttlekit/redis
  windowCoupled: true,                              // inherit Pillar-1 Δ = 0
  l1: { maxKeys: 1024 },                            // bounded tenant set
  clock,
});

const decision = await escrow.check("tenant-A", 5);

// Composes with unifiedAdmission (the LLM-gateway shape):
const admit = unifiedAdmission({
  rate: rateLimit({ strategy: gcra({...}) }),
  concurrency: adaptiveConcurrency({...}),
  cost: escrow,                                     // ← the weighted-fair cost meter
});
const { decision, release } = await admit.admit({ cost: outputTokens, tenant: "tenant-A" });
```

**Why selected:**

1. **It is the smallest delta to the shipped surface.**
   `weightedFairShare` already lives in `src/admission/`; this adds a
   second sibling in `src/twotier/` that swaps the equal-share
   approximation for the exact `weightedMaxMin` algorithm running
   against an L2-backed budget. **Both ship**; the user picks the right
   one for the workload. `weightedFairShare` is documented as the
   single-process fast-path; `weightedFairEscrow` as the distributed
   work-conserving one.
2. **It preserves the `combineDecisions` algebra unchanged.** The
   returned `Decision` slots directly into `unifiedAdmission`'s `cost`
   axis. No wire change, no type widening.
3. **It is composable with `twoTier` rather than coupled to it.** Users
   who want the strict-mode `twoTier` plus WFE can do
   `unifiedAdmission({ rate: twoTier(...), cost: weightedFairEscrow(...) })`.
   Users who want weighted fairness *without* `twoTier` (e.g.
   single-tier Redis) can use `weightedFairEscrow` standalone. The two
   primitives compose orthogonally.
4. **It matches the `fairShare` / `weightedFairShare` precedent.**
   Both existing fairness primitives ship as top-level limiters that
   take a `(tenant, cost)` check. WFE is the work-conserving sibling,
   not a deviation.

The `tenant` is a new first-class parameter to `.check()`, which is a
new method shape — but it's a **new** symbol with a new API, not a
widening of `Limiter.check`. The 0.9.0 `Limiter` interface is unchanged,
and `unifiedAdmission`'s cost axis accepts anything with a
`check(tenant, cost) → Promise<Decision>` shape via the existing
"axis accepts Limiter-shaped objects" duck-type rule. The DR-P4-3 below
formalizes which existing interface (if any) the new primitive
implements.

---

## 5  API surface (the decision lock)

### 5.1 Options + interfaces

```ts
// src/twotier/weighted-fair-escrow.ts (the file TK-1310 creates)

export interface WeightedFairEscrowOptions {
  /** Global per-window budget L (integer; > 0). */
  limit: number;
  /** Window length in ms (epoch-aligned: floor(now/windowMs)·windowMs). */
  windowMs: number;
  /**
   * Per-tenant weight wᵢ. Returns ≥ 1 for any tenant string. Default
   * `() => 1` (degenerates to equal-share = exact max-min,
   * dominating `fairShare` on work-conservation under skew).
   */
  weightOf?: (tenant: string) => number;
  /**
   * DRR quantum: the unit by which one tenant's ceiling is raised at a
   * time. Larger quantum = fewer ceiling-bookkeeping operations, looser
   * T4 bound `|aᵢ/wᵢ − aⱼ/wⱼ| ≤ Q·(1/wᵢ + 1/wⱼ)`.
   * Default 1 (tightest possible fairness, O(L) bookkeeping per window).
   * Tune up for high-throughput, weight-skewed workloads.
   */
  quantum?: number;
  /**
   * Optional L2 store for multi-process backing. When provided, the
   * shared budget lives in the store via the same Lua pattern as
   * `RedisRegionalEscrow` (single integer balance per key). When omitted,
   * the budget is in-process only.
   */
  l2?: Store;
  /** Key namespace prefix (L2 only). Default "tk:wfe". */
  prefix?: string;
  /**
   * Window-couple credits: when true (default), per-tenant local
   * ceilings reset at the window boundary so cross-window carryover is
   * forbidden — Pillar 1 Δ = 0 inheritance. Set false ONLY when
   * carryover semantics are desired and a looser overshoot is acceptable
   * (this option exists for symmetry with `twoTier`'s `lease.windowCoupled`,
   * but the WFE default is true because the safety claim depends on it).
   */
  windowCoupled?: boolean;
  /**
   * Bounded tenant set. Same role as `twoTier.l1.maxKeys`: caps the L1
   * per-tenant state map to prevent unbounded growth on untrusted tenant
   * input. Default unbounded; set on public surfaces.
   */
  l1?: { maxKeys?: number };
  /** Injected clock. Default systemClock. */
  clock?: Clock;
}

export interface WeightedFairEscrowLimiter {
  /** Synchronous check (no L2). Throws if `l2` is configured. */
  checkSync(tenant: string, cost?: number): Decision;
  /** Async check; resolves synchronously when no L2 store is configured. */
  check(tenant: string, cost?: number): Promise<Decision>;
  /** Reset one tenant's per-window usage, or the whole window. */
  reset(tenant?: string): Promise<void>;
  /** Release any L2 connection-side resources (no-op when l2 omitted). */
  close?(): Promise<void>;
}

export function weightedFairEscrow(
  options: WeightedFairEscrowOptions,
): WeightedFairEscrowLimiter;
```

### 5.2 `Decision.limit` and `Decision.remaining` semantics

A subtle point: WFE per-tenant `Decision.limit` is **the tenant's
current dynamic ceiling cᵢ**, not the global pool `L`. This matches
`weightedFairShare`'s existing contract — the user sees their *own*
share, not the global one. The 429-rendering contract is preserved:
client-side libraries reading `X-RateLimit-Limit: 100` see "you can do
100 in this window," which is correct for that tenant.

For `unifiedAdmission` composition (§4 Option C example),
`combineDecisions(rate, cost=weightedFairEscrow)` takes `min` of the
limits — which is the right thing (the binding axis's limit becomes
visible to the client). The `bindingAxisOf` OTel attribute shipped in
0.9.0 then surfaces `"cost"` when WFE bound — and the application can
add a `tk.cost.tenant_share` derived attribute for finer-grained
telemetry (mentioned in §10, not strictly necessary at 0.9.1).

### 5.3 `tenant` semantics + the empty-tenant-set degenerate case

A `tenant` is **any non-empty string** the caller chooses. Same shape as
`fairShare` and `weightedFairShare`. The validation rules match:

- Empty tenant string → `TypeError` ("tenant must be a non-empty string").
- Same tenant string, different weights between checks → use the latest
  weight (matches `weightedFairShare`); the previous-window's ceiling
  is preserved until window roll. This is the standard "weights drift"
  story, with the same self-correction per window.
- Zero active tenants this window → degenerate; returns the static
  allowance up to `L` for any tenant on first check.
- Same tenant calling concurrently → atomic per-tenant counter
  increment under L1 lock (single-threaded JS, so this is implicit;
  the L2 path uses Lua atomicity).

### 5.4 What `weightedFairEscrow` is **not**

The docstring will say this in 5 lines, but pinning it here for the
implementation:

- **Not strategy-proof.** A tenant can over-declare demand. T5
  (FairRide-conceded vertex) — documented prominently. Window-coupling
  bounds the gain.
- **Not exact at sub-quantum granularity.** T4 bound is
  `Q·(1/wᵢ+1/wⱼ)`. Setting `quantum: 1` gives the tightest possible bound
  but at full O(L) bookkeeping. The default is `quantum: 1`.
- **Not federated across regions.** Single-pool only at 0.9.1. The L2
  store can be regional Redis, but cross-region pooling is the
  federation track (DR-P4-7, §12).
- **Not hierarchical.** A flat tenant set, single weight per tenant.
  Nested weights (tenants-within-tenants, e.g. team-within-org) are
  out of scope at 0.9.1 (§12, DR-P4-8).
- **Not part of the `Limiter` interface.** WFE is a `WeightedFairEscrowLimiter`
  with a `(tenant, cost)` check, not a `Limiter` with a `(key, cost)`
  check. **DR-P4-3**: the new interface name distinguishes it; future
  WFE will not retroactively widen `Limiter`.

---

## 6  Algorithm (the realized split, made precise)

The PILLAR4-fairness.md "Mechanism" section (lines 41-56) gives the
intuition; this section pins the *exact* per-check pseudocode that
TK-1310 implements. Note this is a **lazy** algorithm — per-check,
no background sweeper.

### 6.1 L1 state per `weightedFairEscrow` instance

```ts
// In-process per-instance state (one weightedFairEscrow → one entry):
interface WindowState {
  windowStart: number;     // epoch-aligned floor(now/windowMs) · windowMs
  pool: number;            // remaining L budget for this window
  tenants: Map<string, TenantEntry>;
}

interface TenantEntry {
  weight: number;          // wᵢ (last observed)
  ceiling: number;         // cᵢ — dynamic; starts at gᵢ, grows on reclamation
  used: number;            // aᵢ — credits granted so far this window
}
```

### 6.2 Check pseudocode (single-process path)

```text
check(tenant, cost):
  now = clock.now()
  roll_window_if_needed(now)         // resets pool, ceilings, used

  W = sum(weights of active tenants ∪ {this tenant})
  g_tenant = floor(weight(tenant) / W · L)

  entry = tenants[tenant]  ?? new TenantEntry(weight=weightOf(tenant), ceiling=g_tenant, used=0)
  entry.weight = weightOf(tenant)  // update — may drift; takes effect next window

  if entry.used + cost > entry.ceiling:
    # Reclaim phase: redistribute the budget idle tenants have left untaken.
    surplus = pool - sum(t.ceiling - t.used for t in tenants if t.ceiling > t.used)
    if surplus > 0:
      # Raise *this* tenant's ceiling first, up to the quantum or what's needed.
      grant = min(surplus, max(cost, quantum), pool, weight(tenant) / W · pool)
      entry.ceiling += grant
      # If still not enough, keep iterating reclamation up to one quantum at a time,
      # honoring weight order (most-deserving = smallest used/weight ratio).
      while entry.used + cost > entry.ceiling and pool > sum(t.ceiling for t in active):
        # …loop …
        …
    if entry.used + cost > entry.ceiling:
      return DENY(remaining=ceiling-used, retryAfterMs=resetAt-now)

  if cost > pool:
    return DENY(remaining=0, retryAfterMs=resetAt-now)

  pool -= cost
  entry.used += cost
  return ALLOW(limit=ceiling, remaining=ceiling-used)
```

The fixed point of the reclamation loop is exactly the water-filling
solution — proved in PILLAR4-fairness.md Theorem T3. The lazy
realization (reclaim only when contention happens) means the steady
state matches `waterfillInt(demands, weights, L)` to within ≤ quantum
per tenant.

### 6.3 Multi-process path (when `l2` is configured)

The L1 state stays the same (per-tenant ceilings + used per process), but
the **`pool`** lives in L2 as a single Redis integer behind a Lua script.

Two reasonable Lua designs; the choice locks DR-P4-5:

**Option L2-A: New WFE Lua (decision-locked NO at 0.9.1).** Write a new
script `tk:v1:wfe:check` that takes `(tenant, cost, ceiling)` and
debits the shared pool atomically. **Rejected** because:

- It duplicates `RedisRegionalEscrow`'s LEASE+REFILL Lua nearly verbatim.
- It expands the wire-protocol surface that DR-14 cautions against.
- The fairness arithmetic (per-tenant ceilings + reclamation) is *local*
  to a process; the shared state is just one integer.

**Option L2-B: Re-use the existing `Store.apply` lease shape (selected).**
The L2 pool behaves identically to a `twoTier(leased)` lease loop with
batch = `quantum`: each time a process needs more credits for its local
tenant, it leases a quantum from L2. The lease is the *common* pool
debit; the tenant accounting is done locally.

```text
check(tenant, cost) — multi-process variant:
  # Local L1 logic identical to §6.2 EXCEPT pool is leased from L2.
  if pool < cost:
    # Lease one quantum from L2 — atomic Store.apply with the budget
    # strategy. Same shape as twoTier's lease loop.
    leased = await l2.apply(prefix:tenant_pool, decisionTransform(budgetStrategy, now, quantum))
    if leased.allowed:
      pool += quantum
    else:
      return DENY(retryAfterMs from leased)
  # Rest of §6.2 unchanged.
```

`budgetStrategy` is a `fixedWindow({ limit: L, windowMs })` — already
shipped, already conformance-tested. The L2 Store can be RedisStore or
MemoryStore for tests. **Zero new Lua.**

The DR-P4-5 selects Option L2-B explicitly.

### 6.4 Why the in-process split + the leased shared pool ARE the same split

This is the load-bearing claim of §6 — it's why we get to do *less work*
at the L2 layer than at the L1 layer:

**Claim.** Suppose `P` processes each run the §6.2 algorithm against an
L2-leased pool of common rate `L`. Let `aᵢ⁽ᵖ⁾` be tenant `i`'s
allocation in process `p`, and `aᵢ = Σₚ aᵢ⁽ᵖ⁾`. Then `aᵢ` realizes
weighted max-min fair allocation across the union of tenants, up to a
combined quantum-bounded slack of `Σₚ Q⁽ᵖ⁾ / wᵢ`.

**Proof sketch.** Each process individually satisfies T2 (sharing-
incentive) and T4 (bounded unfairness) against its own local ceiling
`cᵢ⁽ᵖ⁾`. The local ceiling is `gᵢ⁽ᵖ⁾ + reclaimed surplus`. The
*sum* of local ceilings = `L − unleased pool`, and the sum of local
`used` ≤ sum of local ceilings ≤ `L`. So T1 (safety) holds globally
(`Σ aᵢ ≤ L`).

For T2: each process's `gᵢ⁽ᵖ⁾ = ⌊wᵢ/W · L⁽ᵖ⁾⌋` where `L⁽ᵖ⁾` is the
locally-leased pool. If tenant `i` is backlogged in process `p`, it is
guaranteed `min(dᵢ⁽ᵖ⁾, gᵢ⁽ᵖ⁾)`. Summing across processes,
`aᵢ ≥ min(Σₚ dᵢ⁽ᵖ⁾, Σₚ gᵢ⁽ᵖ⁾) = min(dᵢ, gᵢ · L_leased/L)`. As
`L_leased → L` (steady state), this is `min(dᵢ, gᵢ)`. ∎

The leased quantum `Q⁽ᵖ⁾` shows up in T4's bound; **the multi-process
bound is at most `Σₚ Q⁽ᵖ⁾ · (1/wᵢ + 1/wⱼ)`**, larger than the
single-process bound by a factor of `P`. This is the multi-process
fairness cost — documented honestly. For most production workloads
(P ≤ 10, Q = 100), the bound is still negligible at scale.

**This is not Pillar-1 federation.** It is *single-region multi-process*
WFE; federation is the cross-region case where the L2 *itself* is
distributed across an L3 coordinator. WFE composes with federation
(`l2: regionalEscrow` is a valid `Store`) but doesn't *require* it.
Federation-fair WFE (regional shares × tenant shares) is out of scope at
0.9.1 (§12, DR-P4-7).

---

## 7  Composition rules

### 7.1 With `unifiedAdmission` (the LLM-gateway shape)

```ts
const escrow = weightedFairEscrow({
  limit: 200_000, windowMs: 60_000,
  weightOf: t => orgTier[t] === "enterprise" ? 4 : 1,
});

const admit = unifiedAdmission({
  rate: rateLimit({ strategy: gcra({ limit: 500, periodMs: 60_000 }) }),
  concurrency: adaptiveConcurrency({ minLimit: 10, maxLimit: 200 }),
  cost: escrow,
});

// The admit interface accepts (cost, tenant) — tenant routes WFE.
const { decision, release } = await admit.admit({ cost: 1500, tenant: "tenant-A" });
```

`unifiedAdmission` already handles per-axis `Decision`s via
`combineDecisions`. **There is one new piece**: passing `tenant` through
to the cost axis. The `admit({ cost })` shape needs to widen to
`admit({ cost?, tenant? })`, and the cost axis receives `tenant` only if
it implements a tenant-aware check.

**DR-P4-4** locks this widening as **additive**: `tenant` is optional;
when omitted, the cost axis receives `undefined` and behaves as before
(non-WFE limiters never read `tenant`). This is wire-compatible with
0.9.0 callers; no breaking change.

### 7.2 With `twoTier(leased)`

`weightedFairEscrow` does *not* replace `twoTier(leased)`. They compose
in two ways:

1. **WFE as the L2 backing of a twoTier-leased limiter** — no. WFE's
   `check(tenant, cost)` is not a `Store`; it's a limiter. This
   composition direction is meaningless.
2. **twoTier-leased rate axis + WFE cost axis** — yes. The LLM-gateway
   shape: rate-limit per provider quota via `twoTier(leased)`,
   weight-fair cost per tenant via `weightedFairEscrow`. They compose
   via `unifiedAdmission`.

### 7.3 With `RedisRegionalEscrow` (federation)

`RedisRegionalEscrow` is a `RegionalEscrow`, not a `Store`. WFE's `l2`
takes a `Store`. The two compose only through `federate(...)`:

```ts
// Future composition (NOT in 0.9.1):
const federated = federate({
  regions: [{ region: "us-east-1", regional: redisRegionalEscrow }, ...],
  coordinator: redisCoordinator,
  strategy: fixedWindow({ limit: L, windowMs }),
});

const escrow = weightedFairEscrow({
  limit: L_local,                  // regional share
  windowMs,
  weightOf: ...,
  l2: federated,                   // ← federated as the Store
});
```

This works in principle (the `Store` interface is the shared contract),
but the formal bound on `(region, tenant)` fairness is not proved
anywhere yet. **Federated-WFE is 0.10.x, gated on a proof.** See §12
DR-P4-7.

### 7.4 With `fairShare` / `weightedFairShare`

These are sibling primitives, not stacks. Each handles a distinct case:

| Primitive | Best for | Distributed? | Work-conserving? | Weight-honoring? |
|---|---|---|---|---|
| `fairShare` | Single-process equal-share | no | no (FCFS surplus) | no (equal weights) |
| `weightedFairShare` | Single-process weight-skewed | no | no (FCFS surplus) | yes (approximate) |
| `weightedFairEscrow` | **Multi-process, work-conserving, weight-honoring** | **yes** | **yes (water-filled)** | **yes (exact)** |

Users pick the right primitive for the workload. The wiki page (TK-1312)
will surface this comparison table prominently.

---

## 8  Failure modes

| Failure | Behavior | Recovery |
|---|---|---|
| `l2` Store unavailable | `check()` throws `StoreUnavailableError` (matches `twoTier` strict mode). No silent fallback to in-process; the leased pool is the safety boundary. | Operator inserts a fallback (try `weightedFairEscrow(l2)` → catch → fall back to `weightedFairShare`) at the app layer. |
| Process restart mid-window | L1 state lost; tenants restart at `g_i`; pool re-leases from L2. Δ ≤ `quantum · N_tenants` in the cross-restart window (bounded; documented). | Self-heals at the next window boundary. |
| Untrusted tenant flood (key blowup) | L1 `tenants` map grows unbounded. Mitigation: set `l1.maxKeys` (same role as `twoTier.l1.maxKeys`). | Mitigation must be set at construction. |
| Concurrent same-tenant checks (within process) | Atomic via single-threaded JS for L1; L2 atomic via Lua. No double-count. | n/a |
| Tenant weight changes mid-window | New weight takes effect next window. Current window honors the weight at first check. | Self-heals at the next window. |
| `windowCoupled: false` + L2 outage spans window boundary | Carried-over ceilings can briefly exceed the new window's `g_i`. Documented as the "carryover overshoot" caveat. | Set `windowCoupled: true` (the default) to avoid. |
| **Tenant over-declaration (T5)** | A tenant can request more than its actual demand to claim surplus. Window-coupling bounds the gain to one window; reclaimed surplus expires at window roll. | Not a bug — a stated impossibility (FairRide). Operators who need strategy-proofness should pre-clip per-tenant `cost` at the app layer. |

`docs/FAILURE-MODES.md` will add a `weightedFairEscrow` section (TK-1312).

---

## 9  Test gate (the TK-1311 contract)

Three test layers, mirroring the federation + unified pattern:

### 9.1 Pure-algebra property tests (port from `test/gale/fair-escrow.test.ts`)

The 4 theorems T1-T4 are already machine-checked at 20 000 trials over
random `(n, weights, demands, limit)`. The graduation port runs the same
theorems against `weightedFairEscrow().check()` (instead of
`waterfillInt()` directly):

- **T1 safety**: at window close, `sum over tenants of used ≤ L`.
  *No* sequence of `.check()` calls can violate this.
- **T2 sharing-incentive**: every backlogged tenant gets at least
  `min(dᵢ, gᵢ)` within the proven DRR slack `w_i · n / W`.
- **T3 work-conservation**: at end of window, `sum used = min(sum
  demand, L)` — no budget stranded.
- **T4 bounded unfairness**: at end of window, for any two backlogged
  tenants, `|aᵢ/wᵢ − aⱼ/wⱼ| ≤ quantum · (1/wᵢ + 1/wⱼ)`.

Implementation: fast-check `numRuns: 200` (matches the property-test
budget; 20 000 stays as the GALE-research-level pin). Each trial
generates `n ∈ [2, 6]`, weights in `[1, 8]`, demands in `[0, 200]`,
`limit ∈ [1, 150]`, replays the demand vector as `.check()` calls, and
asserts T1-T4 at window close.

### 9.2 Dual-path conformance (L1 vs L2)

Same `(seed, demand-vector)` driven through:

- **L1 path** — `weightedFairEscrow({ limit, windowMs, weightOf, quantum })`
  with no `l2`.
- **L2 path** — `weightedFairEscrow({ limit, windowMs, weightOf, quantum,
  l2: MemoryStore })`.

Assertion: at every window-close, the per-tenant `used` vectors are
**equal up to the quantum-bounded multi-process slack proved in §6.4**.
For `P = 1` process (single-test process), the slack is exactly the
single-process T4 bound, so the assertion is bit-equal `used` vectors.

Gated on Redis: same property test driven against `RedisStore` (Redis DB
7 — verified clear in §9.4).

### 9.3 Composition tests

- **WFE + `unifiedAdmission` short-circuit** — `unifiedAdmission({ rate,
  cost: WFE })`; the binding-axis OTel attribute correctly surfaces
  `"cost"` when WFE denies.
- **WFE + `windowCoupled: true`** — verify Δ = 0 across a forced window
  boundary mid-test (advance clock past `windowMs`, re-check, assert
  total used in old window ≤ L).
- **WFE + `tenant: undefined`** — when no `tenant` is passed via
  `unifiedAdmission.admit({ cost })`, WFE's `check` is not called; the
  cost axis short-circuits to `ALLOW_FULL`. **Note**: this *isn't* the
  composition Pillar 4 is for, but it must not crash.

### 9.4 Redis DB allocation (for the Redis-gated path)

Following the 0.9.0 collision fix (TK-1009), new test files claim a
**dedicated** Redis DB. `weighted-fair-escrow.test.ts` will use **DB 7**
— verified currently unused (the allocations as of 0.9.0 are: DB 0
conformance-grid, DB 2 lua-property, DB 6 check-many, DB 8
federation/redis-coordinator, DB 11 unified-fused, DB 12
fused-conformance; DB 7 is free).

A comment block at the top of `weighted-fair-escrow.test.ts` will
document this, matching the `// Dedicated DB 7 — …` convention.

### 9.5 Bench gate (regression guard)

`weightedFairEscrow` adds a new entry to `bench/baselines.json` and
`bench/micro.ts`:

| Bench | Expected ns/op | Notes |
|---|---|---|
| `wfe.checkSync.lightly_contended` | ~300 (target) | One tenant, low contention; baseline for the bookkeeping overhead |
| `wfe.checkSync.heavily_contended` | ~500 (target) | 8 tenants, reclamation loop active |
| `wfe.check.l2_redis` | ~150 µs (target, RTT-bound) | One round trip per quantum on Redis miss |

CI gate: ±20% drift threshold (matches existing entries).

---

## 10  Subtasks (bisectable commits)

| Task | Commit shape | Gate |
|---|---|---|
| **TK-1309** (THIS) | `docs(research): Pillar 4 design — weightedFairEscrow + twoTier composition + cross-tenant fairness invariants` | docs only; `npm run check` unchanged |
| **TK-1310** | `feat(twotier): weightedFairEscrow implementation (Pillar 4 graduation)` | New `src/twotier/weighted-fair-escrow.ts` + L1-only path; `src/index.ts` + `src/twotier/index.ts` exports; basic happy-path tests |
| **TK-1311** | `test(twotier): cross-tenant fairness property tests + dual-path conformance` | T1-T4 property tests (numRuns ≥ 200); L1 ≡ L2 conformance; Redis-gated DB 7 path; composition tests with `unifiedAdmission` |
| **TK-1312** | `docs(twotier): wiki Pillar4-WFE page + example + FAILURE-MODES update` | New wiki `Pillar-4-Weighted-Fair-Escrow.md` (committed locally on tk-wiki master); new `examples/weighted-fair-escrow.ts` LLM-gateway-multi-tenant demo; FAILURE-MODES section; CHANGELOG `[0.9.1]` partial |
| **TK-1313** | `chore(release): prepare 0.9.1 (Pillar 4)` | Version 0.9.0 → 0.9.1 in package.json + src/index.ts + cli; CHANGELOG full entry; SCOREBOARD update; README badge/table; push wiki at tag time |

The chain is linear: TK-1310 depends on TK-1309, TK-1311 on TK-1310,
TK-1312 on TK-1311, TK-1313 on TK-1312. Each commit passes `npm run check`.
Each commit is reversible by `git revert` without touching prior steps.

---

## 11  Definition of done (the 0.9.1 release gate)

- `weightedFairEscrow(...)` shipped in `src/twotier/weighted-fair-escrow.ts`
- Root export AND `throttlekit/twotier` subpath export
- Theorems T1-T4 proven against `.check()` at `numRuns: 200`
- L1 ≡ L2 dual-path conformance (MemoryStore equivalent to RedisStore on
  the same property timeline)
- Redis-gated test on dedicated DB 7
- Composition tests: WFE + `unifiedAdmission`; `bindingAxisOf` surfaces
  `"cost"` when WFE binds
- `examples/weighted-fair-escrow.ts` LLM-gateway-multi-tenant demo
- Wiki: new `Pillar-4-Weighted-Fair-Escrow` page; Home + sidebar updated
  locally on tk-wiki master
- `docs/FAILURE-MODES.md` updated with the WFE outage matrix
- CHANGELOG `[0.9.1]` entry
- Bench: WFE entries added to baseline; CI gate green ±20%
- Release authorized + published as **0.9.1** (patch — additive surface)

---

## 12  Out of scope at 0.9.1 (the explicit deferrals)

- **Federated WFE** — `(region, tenant)` joint fairness. Composes
  trivially via `l2: federated`, but the formal `(region, tenant)`
  cross-fairness bound isn't proved yet. **Target 0.10.x** after the
  distributed-adaptive-concurrency proof (DR-18) and after the joint-LP
  productization (DR-19) are done; the `(region, tenant)` algebra
  benefits from both. DR-P4-7.
- **Hierarchical (nested) weights** — tenants-within-organizations
  (e.g. team-within-org). The single-level WFE handles this approximately
  via `weightOf(tenant)` returning a composed weight, but a true
  hierarchical scheduler (recursive WFE) needs `O(depth)` state and
  has its own fairness theorem. **Target 0.10.x or later.** DR-P4-8.
- **Hot-path-fused leased WFE inside `twoTier`** — Option B in §4.
  Conditional on a benchmark demonstrating a meaningful improvement over
  the §6.3 leased pattern. **Target 0.10.x** if needed. DR-P4-9.
- **Strategy-proof variant (FairRide concession)** — would require
  conceding either sharing-incentive or work-conservation per the
  SIP impossibility. Not on the roadmap; documented as a deliberate
  vertex choice. DR-P4-10.
- **Adaptive quantum** (the WFE analog of `leaseSizer`'s adaptive batch)
  — `quantum` is a tunable knob at 0.9.1, not adaptive. Adaptive
  quantum is a clean follow-up; tracked as an enhancement, not blocking
  0.9.1.

---

## 13  Decision records

| ID | Decision | Status |
|---|---|---|
| **DR-P4-1** | API shape = **top-level `weightedFairEscrow()` primitive in `src/twotier/`** (Option C in §4). Decorator-above-twoTier (A) reinvents `weightedFairShare`; fairness-inside-twoTier (B) widens `Limiter.check` and bloats the hot path. C is the smallest delta to shipped surface, composes via `unifiedAdmission` unchanged, and matches the `fairShare`/`weightedFairShare` precedent. | Locked unless a benchmark in TK-1311 shows the §6.3 leased pattern is more expensive than Option B by >2× (in which case Option B is reconsidered for 0.10.x). |
| **DR-P4-2** | Quantum semantics = **`quantum` is the per-tenant ceiling-raise unit**, NOT the in-process lease size to L2. The L2 lease size in the §6.3 path is `quantum` by default (Option L2-B; see DR-P4-5) but can be tuned independently in a future option. At 0.9.1 they're the same number for simplicity. | Locked |
| **DR-P4-3** | The new interface is **`WeightedFairEscrowLimiter`**, with `(tenant, cost)` check. It does **not** widen `Limiter`. `unifiedAdmission`'s cost axis accepts any duck-typed `check(tenant?, cost?) → Promise<Decision>`. | Locked |
| **DR-P4-4** | `unifiedAdmission.admit({ cost? })` widens to `admit({ cost?, tenant? })` **additively** — `tenant` optional, non-WFE axes ignore it. 0.9.0 callers unaffected. **No wire change** (these are TS-type-level additions). | Locked |
| **DR-P4-5** | Multi-process backing = **Option L2-B (reuse existing Store.apply lease shape) NOT Option L2-A (new WFE Lua)**. Zero new wire surface; the L2 pool behaves like a single-key `twoTier(leased)` lease loop with `batch = quantum` and `budgetStrategy = fixedWindow({ limit: L, windowMs })`. Saves ~150 lines of new Lua + a new Redis schema. | Locked |
| **DR-P4-6** | `windowCoupled` defaults to **true**. The Pillar-1 Δ = 0 inheritance is the whole reason to use WFE; the option exists for symmetry with `twoTier.lease.windowCoupled` (`false` allowed but documented as forfeit of Δ = 0). | Locked |
| **DR-P4-7** | **Federated WFE is out of 0.9.1.** Single-pool only. The `(region, tenant)` fairness bound is unproved. Target 0.10.x with a TLA⁺-checked composition theorem in `spec/`. | Locked unless a customer demands it. |
| **DR-P4-8** | **Hierarchical (nested) weights are out of 0.9.1.** Flat tenant set. Target 0.10.x or later. | Locked |
| **DR-P4-9** | **Hot-path-fused leased WFE (§4 Option B) is out of 0.9.1.** Conditional on a benchmark in TK-1311 showing §6.3 is too expensive. 0.10.x or later. | Locked unless DR-P4-1's benchmark gate trips. |
| **DR-P4-10** | **WFE is NOT strategy-proof** (T5 / FairRide impossibility, conceded vertex). Documented in the API docstring + wiki + FAILURE-MODES, not hidden. | Locked — design choice, not a defect. |
| **DR-P4-11** | `Decision.limit` reported per tenant = the tenant's **current dynamic ceiling cᵢ** (NOT the global `L`). Matches `weightedFairShare`. `combineDecisions` then surfaces `min(rate.limit, cost.cᵢ)` to the client, which is the correct "your binding axis is X" hint. | Locked |
| **DR-P4-12** | Redis DB for `weighted-fair-escrow.test.ts` = **DB 7** (verified clear at 0.9.0 commit `bd6b384`). Documented inline per the 0.9.0 convention. | Locked |
| **DR-P4-13** | TK-1310's first commit ships **L1-only path** (no `l2`); TK-1310's second commit (or TK-1311 setup) ships the L2 path. Two commits inside TK-1310 are acceptable to keep `npm run check` green at every step. | Locked |
| **DR-P4-14** | WFE's per-tenant `Decision.remaining` reports `cᵢ − usedᵢ` (the tenant's remaining headroom) on allow, and `cᵢ − usedᵢ` (NOT zero) on deny. Matches `weightedFairShare`. Convention: `remaining` is the *post-decision* tenant headroom; clients reading `X-RateLimit-Remaining` see what they have left, not the global pool. | Locked |

When implementation reveals a decision needs to change, edit the row
in place and add a one-line "Why changed" — same convention as
`research/bigger-bets/federation/DESIGN.md` and
`research/bigger-bets/unified/DESIGN.md`.

---

## 14  Anchors

[bertsekas-gallager]: Bertsekas, D. P. & Gallager, R. G. (1992). *Data
Networks*, 2nd ed., Prentice-Hall. §6.5.2 "Max-min flow control."
[drr]: Shreedhar, M. & Varghese, G. (1995). "Efficient Fair Queuing
using Deficit Round Robin." *SIGCOMM '95*.
[wfq]: Demers, A., Keshav, S. & Shenker, S. (1989). "Analysis and
Simulation of a Fair Queueing Algorithm." *SIGCOMM '89*.
[gps]: Parekh, A. K. & Gallager, R. G. (1993). "A Generalized Processor
Sharing Approach to Flow Control in Integrated Services Networks."
*IEEE/ACM ToN*, 1(3).
[csfq]: Stoica, I., Shenker, S. & Zhang, H. (1998). "Core-Stateless Fair
Queueing." *SIGCOMM '98*.
[pisces]: Shue, D., Freedman, M. J. & Shaikh, A. (2012). "Performance
Isolation and Fairness for Multi-Tenant Cloud Storage." *OSDI '12*.
[drf]: Ghodsi, A., Zaharia, M., Hindman, B., Konwinski, A., Shenker, S.
& Stoica, I. (2011). "Dominant Resource Fairness: Fair Allocation of
Multiple Resource Types." *NSDI '11*.
[fairride]: Pu, Q., Ananthanarayanan, G., Bodik, P., Kandula, S.,
Akella, A., Bahl, P. & Stoica, I. (2016). "FairRide: Near-Optimal,
Fair Cache Sharing." *NSDI '16*.
[little]: Little, J. D. C. (1961). "A Proof for the Queuing Formula:
L = λW." *Operations Research*, 9(3).

---

## 15  How to start TK-1310

1. Read this file (TK-1309 deliverable) + `research/gale/PILLAR4-fairness.md`
   (the proofs) + `test/gale/fair-escrow.ts` (the algebra) +
   `src/admission/index.ts` (existing `weightedMaxMin` and
   `weightedFairShare`).
2. Create `src/twotier/weighted-fair-escrow.ts` with the §5 API shape
   and the §6.2 single-process algorithm. **First commit ships
   L1-only** (per DR-P4-13).
3. Re-use `weightedMaxMin()` from `src/admission/` — do NOT duplicate
   the integer drip / continuous water-filling math. Import and call.
4. Add the export in `src/twotier/index.ts` and `src/index.ts`.
5. Write a happy-path test (`test/twotier/weighted-fair-escrow.test.ts`):
   2 tenants, equal weights, one over-demands, asserts both get exactly
   `L/2` admitted; equivalent assertion for weight 4:1; assertion that
   idle tenant's share flows to the backlogged one (work-conservation
   sanity check).
6. Verify `npm run check` is green. Commit
   `feat(twotier): weightedFairEscrow L1-only path (Pillar 4 — DR-P4-13)`.
7. **Then** add the L2 path per §6.3 (Option L2-B). Second commit inside
   TK-1310 or first commit of TK-1311 — caller's choice. Verify
   `npm run check` is green at every commit.
8. Mark TK-1310 complete; claim TK-1311 (the full property + conformance
   gate).
