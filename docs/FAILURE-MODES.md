# Failure modes — what happens when a store goes down

This is the page an infra team reads before adopting a rate limiter: for every backend, **what
happens when it goes down**, what state is **lost vs preserved**, and how it **recovers**. Every cell
below is cross-checked against the store implementations in `src/`.

## The model in one paragraph

A `Store` exposes one mutating primitive — an atomic `apply` (read‑modify‑write). When the backing
service is unreachable, `apply` **rejects** (it never silently allows or denies). The
limiter/adapter then applies your **`fail` policy** — `"open"` (allow) or `"closed"` (reject `503`) —
after firing `onError`. So "what happens on an outage" has two layers: (1) the store rejects, and
(2) you chose what a rejection means. The in‑process `MemoryStore` is the one store that **cannot**
reject — it has no network.

Two properties hold for **every** store and matter during an outage:

- **No partial writes.** Each store's RMW is atomic by construction — Redis `EVALSHA`, a Postgres
  advisory‑lock transaction, a DynamoDB/D1/Deno‑KV compare‑and‑set, or a Durable Object's
  single‑threaded `blockConcurrencyWhile`. An outage *mid‑operation* therefore never corrupts state:
  the operation either fully applied or not at all.
- **Errors are typed.** A store that gives up raises `StoreUnavailableError` (e.g. optimistic‑
  concurrency retries exhausted on D1/DynamoDB/Deno KV, or the Redis OCC fallback). The Redis Lua
  path propagates the underlying client connection error directly. Either way it is a rejected
  promise your `fail` policy catches.

## Per‑store outage behaviour

| Store | What "down" means | `apply()` during the outage | State **lost** vs **preserved** | Recovery when it returns |
|---|---|---|---|---|
| **MemoryStore** | process crash / restart (no network to fail) | **never rejects** — single‑threaded in‑process RMW | **Lost** on process restart (state is RAM only); fully preserved within the live process | Starts empty → at most one window/burst of over‑admission as counters re‑accrue. Bound the key map with `maxKeys` so a flood can't OOM. |
| **RedisStore** | client can't reach Redis | rejects (ioredis/connection error; the OCC fallback for custom strategies throws `StoreUnavailableError` after `maxRetries`) | **Preserved** in Redis across a client reconnect; **lost** only if Redis is flushed or restarted without persistence | Reconnect → counters resume exactly. One atomic `EVALSHA`/request means there is **no read‑then‑write window** to interrupt. |
| **PostgresStore** | pool can't reach Postgres | rejects (pg error) | **Preserved** — the table is durable across reconnect *and* a Postgres restart | Reconnect → resume. Each check is one advisory‑lock transaction (atomic; no partial write). |
| **DynamoStore** | SDK call fails / throttled | rejects (client error; `StoreUnavailableError` after CAS retries exhausted) | **Preserved** in DynamoDB | Resume. Conditional‑write CAS ⇒ no partial write; native TTL (`expires_at`, epoch‑seconds) reclaims rows. |
| **D1Store** | the D1 binding errors | rejects (`StoreUnavailableError` after version‑CAS retries exhausted) | **Preserved** in D1 (edge SQLite) | Resume. Version compare‑and‑set is atomic; call `sweep()` from a Cron Trigger to reclaim expired rows. |
| **DenoKvStore** | Deno KV unavailable | rejects (`StoreUnavailableError` after versionstamp‑CAS retries exhausted) | **Preserved** in Deno KV | Resume. Native `versionstamp` CAS is atomic; native `expireIn` TTL reclaims. |
| **DurableObjectStore** | the DO *is* the unit of consistency | RMW runs **inside** the DO under `blockConcurrencyWhile` — no client/network hop in the critical section, **no retry loop** | **Preserved** in DO transactional storage | A DO relocation carries its storage with it; single‑threaded execution means no contention to recover from. |

**Takeaway:** the four durable backends (Postgres, DynamoDB, D1, Deno KV) and a persistent Redis
**never lose committed counts** across an outage — recovery is just "reconnect and resume." Only
`MemoryStore` (on process restart) or a **flushed/non‑persistent Redis** resets counters, costing at
most one window of over‑admission.

## `twoTier` modes during an **L2** (distributed‑store) outage

`twoTier` fronts the distributed store (L2) with a local in‑process tier (L1). The modes differ in
exactly how an L2 outage degrades:

| Mode | Round trips / request | During an L2 outage | What's **lost** | Recovery |
|---|---|---|---|---|
| **`strict`** | 1 / request | every request hits L2, so every request rejects → your **`fail`** policy decides | nothing (no local authority) | immediate: the next request that reaches L2 is exact again |
| **`cached-deny`** | 1 / *allowed* request | the *allow* path hits L2 and rejects → `fail` policy; recent *denials* are still served from the local cache | nothing | immediate on L2 return |
| **`leased`** | ~1 / `batch` | **keeps serving** from each key's remaining **local credits** with no network; only when a key's credits run out **and** the synchronous re‑lease can't reach L2 does it reject → `fail` policy | un‑returned leased credits (a bounded over/under‑admission, never unbounded — see below) | re‑leases a fresh batch on the next miss once L2 returns; proactive refill failures are swallowed and retried |

So **`leased` is the outage hedge**: a brief L2 blip is invisible to any key that still has local
credits. That resilience is the same lever as its throughput win — one L2 round trip per `batch`
requests.

## How much over‑admission can an outage cause?

- **Durable store, reconnect:** none. Committed counts survive; the limit holds exactly.
- **MemoryStore restart / flushed Redis:** counters reset to empty, so a single window can admit up
  to a full fresh `Limit` on top of what was already spent — one burst, then exact again.
- **`leased` across an L2 blip:** worst‑case global admissions stay within the **proven** leasing
  bound — `Limit + N·(batch−1)` (carryover), or **exactly `Limit`, independent of node count `N`**,
  with `lease.windowCoupled: true` (which discards stale credits at the L2 window boundary). The
  outage does not loosen this bound; it only defers the re‑lease. See
  [`docs/FORMAL-MODEL.md`](FORMAL-MODEL.md).

## Federation outages (`federate(...)` / `FederatedStore`)

Federation adds a *cross-region* layer — a `GlobalCoordinator` pools the budget
across regions. Failure modes split between the region's local view and the
coordinator's global view. See `research/bigger-bets/federation/DESIGN.md` §5
for the formal failure semantics; tests in `test/federation/failure-modes.test.ts`.

The behavior is **identical across `RedisCoordinator` and `PostgresCoordinator`**
— both implement the same `GlobalCoordinator` interface with the same
window-coupling guarantee (Δ = 0). The choice of backend only affects HA
mechanics (Sentinel/Cluster vs synchronous replication + Patroni-style
failover) and latency (~0.5-1ms Redis vs ~1-3ms Postgres per lease).

| Failure shape | What happens | What's **lost** | Recovery | Δ (cross-region overshoot) |
|---|---|---|---|---|
| **Region partitioned from coordinator** (e.g. cross-region link down) | Region serves out its existing in-process escrow; once empty, fails closed (denies until reachable). `onCoordinatorOutage: "fail-closed"` (default). | Any not-yet-leased capacity in the coordinator that this region might have used. | Heal the link → next lease succeeds; in-process escrow refills. | **0** — by construction, no new admissions during outage. |
| **Coordinator crash, recovered within the same window** | Same as above; existing escrow keeps serving briefly, then denies. On recovery, leases resume against the original budget remaining. | Nothing committed — the coordinator's remaining budget is preserved across the crash (Redis: durable when AOF/RDB configured; Postgres: durable via WAL). | Re-attach client → resume. `reconcile()` is idempotent on `windowStart` so retries through the partition converge. | **0** — coordinator's remaining budget is exact across crash. |
| **Coordinator unavailable across a window boundary** | Every region denies until coordinator returns. When it does, window-N+1's fresh budget is acquired. | All admissions during the outage (federation is fully unavailable). | Coordinator returns → next request leases against the new window's fresh budget. | **0** — zero admissions during the outage. |
| **Postgres primary failover** (`PostgresCoordinator` only) | In-flight queries fail with `StoreUnavailableError`; regions fall back to existing escrow → fail-closed once empty. Once the new primary accepts writes (typically <10s with Patroni/pg_auto_failover), regions resume leasing. | All admissions during the failover window. | New primary promoted → next lease succeeds; `reconcile()` idempotent on partial-recovery retries. | **0** — bound preserved across the failover. |
| **Multi-process within a region** (M processes in the same region share an L2 `RegionalEscrow`) | Each process consults the shared L2 before reaching the coordinator; total in-flight per-region escrow is bounded by what L3 has actually granted instead of `M × batch`. Shipped 0.8.5. | Nothing committed — L2 is preserved across the shared regional Redis. | L2 still acts as the shared cache; no recovery action needed. | **0** — coordinator still enforces the global bound. |
| **Regional store outage** (regional Redis L2 down, while coordinator reachable) | The engine catches the L2 error and falls through to direct L3 leasing — matches the existing 0.8.4 in-process-only behavior for the duration of the L2 outage. Shipped 0.8.5. | Multi-process atomicity within the region (Δ per region degrades from `≤ perKeyBudget` to `≤ M × batch`); the federation bound is unchanged. | L2 reconnect → next refill cycle resumes the shared cache. | **0** — coordinator still enforces the global bound. |
| **Coordinator outage with `onCoordinatorOutage: "regional-only"`** (opt-in availability mode) | Engine continues admitting from the L2 balance until it depletes; subsequent requests deny. `maybeProbeHealth()` (clock-driven, `coordinatorHealthCheckMs` cadence) re-probes `coordinator.isHealthy()`; on success the engine flips back to healthy and normal lease + reconcile resumes. Shipped 0.8.5. | Capacity acquired during the outage is bounded by L2's remaining balance (≤ `perKeyBudget`) rather than 0 (`fail-closed`). | Coord recovers → next probe detects → resumes. | **≤ regional sub-bound during outage** (not 0); the federation bound is re-enforced from the recovery point onward. This is the documented availability-over-precision trade-off. |

### Choosing a coordinator backend

| Axis | `RedisCoordinator` | `PostgresCoordinator` |
|---|---|---|
| Latency per lease | ~0.5–1 ms (Lua EVALSHA) | ~1–3 ms (transactional SQL) |
| Throughput cap | 100K+ leases/sec | 5K–20K leases/sec (primary write throughput) |
| HA story | Sentinel / Cluster | Synchronous replication + Patroni / pg_auto_failover |
| Durability default | Configurable (RDB / AOF) | WAL + sync replication (byte-durable by design) |
| Best fit | Caching-shop default; lowest latency | Database-shop default; no extra infra; faster failover |

The federation bound (Δ = 0 K-independent) is identical. Pick the backend
your ops team already runs.

**Federation fails closed across every outage shape.** There is no outage
scenario where Δ exceeds 0; the worst case is full unavailability. This
matches the `windowCoupled` twoTier safety story one layer up — the
formal `Roll` rule guarantees regional escrow forfeits at the window
boundary, so a coordinator outage cannot leak un-leased capacity.

**Optional softer mode**: `onCoordinatorOutage: "regional-only"` (shipped
0.8.5; requires a `regionalEscrow`) keeps serving from the L2 balance
during a coordinator outage. The engine re-probes `coordinator.isHealthy()`
every `coordinatorHealthCheckMs` (default 5000) and resumes normal flow on
recovery. Accepts Δ ≤ regional sub-bound during the outage instead of 0;
opt-in only. The default stays `fail-closed`. See `research/regional-escrow/
DESIGN.md` for the full design + `examples/federation-regional-escrow.ts`
for a runnable demo.

## Choosing the `fail` policy

```ts
expressRateLimit({
  strategy: gcra({ limit: 100, periodMs: 60_000 }),
  store: redisStore,
  fail: "closed",                 // "open" (default) allows on outage; "closed" returns 503
  onError: (_req, _res, err) => log.warn({ err }, "rate-limit store down"),
});
```

- **`fail: "open"`** — availability beats the cap. The right default for most public APIs: a limiter
  outage shouldn't take down the service it protects.
- **`fail: "closed"`** — the cap is a hard guarantee (billing, abuse‑critical, capacity protection).
  Pair it with `twoTier({ mode: "leased" })` so a brief L2 blip is absorbed by local credits before
  any request is rejected.

Both policies are unit‑tested on every adapter, and `createEnforcer` surfaces the same decision as a
neutral `{ outcome: "error" }` result that never throws.

## `unifiedAdmission` — outage shapes (0.9.0)

`unifiedAdmission(...)` composes up to three axes (rate / concurrency /
cost) into one Decision. Failure semantics flow per-axis; the combined
Decision is always the AND, MIN, MAX algebra of whichever axes
contributed (see `research/bigger-bets/unified/DESIGN.md` §4.1).

| Failure shape | Sequential backend | Lua-fused backend (`tk:v1:fused-rc:check`) |
|---|---|---|
| Rate-axis store unreachable | Per-axis `failMode` of the rate Limiter (`"open"` admits, `"closed"` denies); the cost axis still runs | The fused EVAL fails; admit rejects the promise — release any held concurrency, surface the error to the caller (≈ `failMode: "closed"`) |
| Cost-axis store unreachable | Per-axis `failMode` of the cost Limiter; rate already ran | Same as above (atomic — both axes fail together) |
| Concurrency-axis: nothing (in-process, no store) | n/a — no failure mode | n/a |
| Caller forgets to call `release()` after a successful admit | Concurrency slot leak (the in-flight count grows monotonically until the process restarts) | Same — the unified layer cannot enforce caller lifecycle |
| Caller double-releases | Idempotent: `Lease.release()` is a no-op on second call (documented in `src/concurrency/adaptive.ts`) | Same |
| Concurrency-deny short-circuit | rate / cost are NOT consulted (concurrency runs first, in-process, cheapest fail) | Same |
| Rate-deny or cost-deny in sequential | the held concurrency slot is released before admit returns (`{ dropped: false }` — deny is upstream, not an overload) | Same — fused script returns combined+per-axis decisions; if denied, the wrapping `unifiedAdmission` releases the held slot |
| Mixed backends (Redis rate + Postgres cost + in-process conc) | Works in sequential mode | Throws at construction (`backend: "lua-fused"` requires the explicit `fused` option group; the limiter store paths are bypassed entirely) |
| `admitSync` on lua-fused mode | n/a | Throws — Redis EVALSHA is async; use `admit()` (the async path) or switch to `backend: "sequential"` |

**Observability**: the `tk.binding_axis` OTel attribute identifies which
axis bound a denied decision (`"concurrency"` | `"rate"` | `"cost"`).
Set it on your active span via `recordUnifiedAdmissionOnSpan(span,
decision, admit.lastDecisions())`. Conventions:
- The binding axis is the first denying axis in **concurrency → rate
  → cost** order (matches sequential evaluation order).
- When multiple axes deny (only possible in lua-fused mode), the same
  priority applies — deterministic and matches the user's mental model.
- Omitted from admitted decisions.

See `research/bigger-bets/unified/DESIGN.md` for the full design,
`examples/unified.ts` for an LLM-gateway-style example, and
`research/bigger-bets/unified/THEORY.md` for the joint-vs-marginal
empirical regret analysis (TK-1007 — verdict: SHIP joint-LP runtime in
0.10.1).

## `weightedFairEscrow` — outage shapes (0.9.1)

`weightedFairEscrow(...)` is the multi-tenant work-conserving budget
splitter (GALE Pillar 4). Failure semantics differ between L1-only
single-process and L2-backed multi-process modes.

| Failure shape | L1-only (no `l2`) | L2-backed (`l2: Store` + `quantum`) |
|---|---|---|
| Tenant set explodes (untrusted input) | L1 `tenants` map grows unbounded — set `l1.maxKeys` | Same; mitigation is at the L1 layer regardless |
| Process restart mid-window | All L1 state lost; tenants restart at `gᵢ`. `Δ = 0` still holds (next window starts fresh) | L1 state lost; pool re-leases from L2. Transient `Δ ≤ quantum · N_tenants` until tenants resaturate (bounded, documented) |
| L2 store unreachable (Redis down, etc.) | n/a (no L2) | `check()` rejects with `StoreUnavailableError`. No silent fallback — the leased pool is the safety boundary; caller's app-level fallback can downgrade to `weightedFairShare` |
| Tenant stops mid-window | Their guaranteed reserve stays pinned until the window rolls (pessimistic-correct — we can't distinguish "stopped" from "about to ask again"). End-of-window T3 still holds | Same — the L1 reserve math is identical across modes |
| Tenant over-declares demand (T5 / FairRide) | Window-coupling bounds the gain to one window; inflated credits expire at window roll. NOT a bug — a stated impossibility | Same; window-coupling holds at L2 too (the shared `fixedWindow` window-rolls on the store-server clock) |
| `checkSync` with `l2` configured | n/a (no L2) | Throws `ThrottleKitError` — lease step is async, use `check()` |
| Tenant weight changes mid-window | New weight takes effect from the next check; the current window keeps the first-check weight | Same |
| L2 lease denial (shared budget exhausted) | n/a | `check()` returns a deny with `retryAfterMs` from the shared store; tenant gets a 429 |
| Two processes race for the last lease | n/a | One wins atomically (fixedWindow's atomic Lua), the other gets a deny; correct without coordination |

**Composition with `unifiedAdmission`.** WFE returns a `Decision`; use
`combineDecisions` to merge it with rate / concurrency manually
(`Promise.all([rate.check(key), escrow.check(tenant, cost)])` then
`combineDecisions(...)`). When wired into `unifiedAdmission`'s cost
axis via the optional `tenant?` widening (DR-P4-4), the binding-axis
attribute surfaces `"cost"` when WFE denies.

See `research/bigger-bets/pillar4-wfe/DESIGN.md` for the full design,
`examples/weighted-fair-escrow.ts` for an LLM-gateway-multi-tenant
example, and `research/gale/PILLAR4-fairness.md` for the canonical
theorems and proofs.


## `unifiedAdmission` / `adaptiveConcurrency` middleware — outage shapes (0.9.2)

The 0.9.2 middleware integration adds 22 new exports across 11 frameworks
that wire `release()` to the request lifecycle. Failure shapes for the
adapter layer (the underlying primitives' failure shapes are above).

| Failure shape | Adapter behavior | Mitigation |
|---|---|---|
| User forgets to use the adapter (calls `admit.admit()` directly) | Silent slot leak — `release` never called → adaptive concurrency limit collapses to zero, server stops admitting | Use the adapter |
| `admit.admit()` throws (Redis hiccup, etc.) | Adapter applies `fail` policy: `open` ⇒ forwards to handler with no slot held; `closed` ⇒ 503 | Restore Redis |
| Handler throws AND no error middleware writes a response (node-server) | `res.on("close")` fires when socket times out → `release({dropped: true})` → adaptive contracts | None needed — first-fire-wins handles it |
| Client hangup mid-stream (node-server) | `res.on("close")` fires before `res.on("finish")` → `release({dropped: true})` | None needed |
| Client cancels Response body mid-stream (web-platform) | TransformStream `cancel` callback fires → `release({dropped: true})` | None needed |
| Handler returns `Response` with null body (web-platform) | `release` fires synchronously with `dropped = dropOn5xx && status >= 500` | None needed |
| Slow handler hangs forever (node-server) | Slot is held until server-side timeout. Server-side timeout middleware triggers `close` event → release | **Recommended:** add a timeout middleware ahead of the admission middleware |
| Slow handler hangs forever (web-platform stream-wrap) | Slot held until consumer cancels or response body errors | Use the runtime's request-timeout config |
| `dropOn5xx: true` + handler returns 500 | `release({dropped: true})` fires on finish; adaptive contracts | Application bug surfaces in metrics |
| Repeated `release()` calls (double-fire) | First call wins; subsequent calls are no-ops (idempotent at both adapter and `Lease` level) | None needed |
| Streaming response that never ends (SSE / chunked) | Slot held for the connection lifetime — **correct**, the resource IS in use | None needed; document expected resource use |

**Mitigation pattern (recommended for slow handlers).** Pair the
admission middleware with a request-timeout middleware ahead of it so
the timeout's `close` event releases the slot:

```ts
app.use(express.timeout("30s"));               // upstream of admission
app.use(expressUnifiedAdmission({ admitter })); // release fires on close
```

The exactly-once-release invariant is validated at numRuns 200 for the
node-server helper and numRuns 50 across integration paths
(`test/adapters/release-invariant.test.ts`). See
`research/bigger-bets/middleware-integration/DESIGN.md` §§5,12 for the
full failure-mode rationale and the `dropped`-decision matrix.

## `distributedAdaptiveConcurrency` — outage shapes (0.10.0)

`distributedAdaptiveConcurrency(...)` holds a fleet under one cooperatively-
inferred global ceiling `L_global`, parcelled into per-node shares by a
`ConcurrencyCoordinator` (Test / Redis). The coordinator's hard guarantee is
**GlobalCap** — `Σ granted shares ≤ L_global` under any heartbeat interleaving
(the budget cap, D-DAC-17). The **occupancy cap** (reserving each peer's
`max(share, inflight)`) plus monotonic grant application additionally **eliminate
the synchronous / protocol-level rebalance overshoot** in `Σ inflight` — in steady
state `Σ inflight → L_global`, and `InflightCap : Σ inflight ≤ L_global` holds on
every reachable state of the synchronous model (D-DAC-18). By default they do **not**
make `Σ inflight ≤ L_global` a hard *instantaneous* invariant of the async system: a
bounded (~1.5–2×), self-draining residual remains from grant-reply + reporting lag,
and converges back as in-flight drains. Setting `acknowledgedHandoff: true` on the
coordinator (opt-in, D-DAC-19) makes it a **hard** instantaneous bound — the
coordinator reserves each peer's max *un-acknowledged* grant (via an echoed grant
generation) unioned with its reported in-flight, so a joiner waits until incumbents
confirm they lowered AND drained; the cost is ~1–2 heartbeats of ramp latency
(TLC-verified, `spec/GaleHeartbeatHandoff.tla`). **`eagerHandoff: true` (0.11.0,
D-DAC-20) removes that cost** — the guard fires off-cycle beats on local triggers
(below-fair / drained / generation-acked), collapsing the ramp toward the physical
floor (drain + one round-trip) with no loosening of the bound; the "pitch-perfect"
config is `{ acknowledgedHandoff: true, eagerHandoff: true }`. The guard gates on
`min(share, local.limit)`; `onCoordinatorOutage` (default `fail-closed`) decides what
a coordinator outage means. **Under `fail-closed`, `selfFence` (0.11.0, D-DAC-21,
default ON) closes the partition/crash in-flight overshoot**: the node stops admitting
on its OWN clock at `lastSuccessfulBeatExpiresAt − fenceSafetyMargin`, before the
coordinator reclaims, and `onFenced` lets the app abort in-flight — eliminating the
residual below (under the stated bounded-clock-skew assumption).

| Condition | `fail-closed` (default) | `local-only` | Recovery |
|---|---|---|---|
| Coordinator unreachable (beat throws) | `share→0`, node sheds all (503) | `share→local.limit`, per-node self-limit; fleet may overshoot backend | Next successful heartbeat restores share |
| **Node PARTITIONED** (alive, beats hang — still serving in-flight) | **Self-fences** (D-DAC-21): stops admitting on its own clock at `expiresAt − fenceSafetyMargin`, before the coordinator reclaims; `onFenced` aborts in-flight ⇒ **no `Σ inflight` overshoot** (under skew ≤ margin). Without self-fence (`local-only`, or `selfFence:false`) it keeps serving ⇒ bounded-by-`leaseTtlMs` overshoot | `local-only`: keeps serving (availability over bound — overshoot bounded by the partition) | A successful beat un-fences; lease re-leased |
| Node crashes holding share (dead) | Its in-flight dies with it (no overshoot); lease TTL (`2·heartbeatMs`) expires → coordinator reclaims; survivors' shares grow next heartbeat | same | Automatic within `leaseTtlMs` |
| `L_global` shrinks (backend degraded) / rebalance | Over-allocated nodes admit nothing new; in-flight drains; `Σ inflight → L_global`. The occupancy cap (D-DAC-18) eliminates the **synchronous** rebalance overshoot (a joiner is granted 0 until peers drain); the async system keeps a bounded (~1.5–2×) self-draining `Σ inflight` residual from grant/report lag — never a runaway | same | Convergence as in-flight drains, within max request duration (§9.3) |
| Node JOINS (membership growth, `L_global` constant) | Budget cap gives the joiner `min(target, L_global − Σ_incumbent max(share, inflight)) = 0` until incumbents re-heartbeat DOWN to their fair shares AND drain; `Σ granted shares ≤ L_global` preserved at every instant (no over-commitment), robust even if the joiner re-heartbeats first. `Σ inflight` holds synchronously; the async path keeps the same bounded, self-draining residual (above) | same | Joiner earns its `≈ L/N` share over the next ≈ N heartbeats |
| Stale share (between heartbeats) | Node may admit up to a now-too-large share for ≤ `heartbeatMs`; bounded by `min(share, local.limit)` fast-shrink | same | Smaller `heartbeatMs` trades coordinator load for reaction speed |
| `nodeId` collision (operator error) | Two processes overwrite one HASH field → undercount → **under**-admission (safe direction) | same | Operational: enforce unique `nodeId` (doc warning) |
| Clock skew between node and coordinator | Redis uses node-supplied `expiresAt` vs coordinator `now`; large skew → premature evict (safe) or late evict (bounded by skew) | same | Keep nodes NTP-synced; doc note |

The `§`-prefixed references point at
`research/bigger-bets/distributed-adaptive-concurrency/DESIGN.md`. The
safety invariant `GlobalCap` (`Σ_active share ≤ L_global`) and the synchronous-model
`InflightCap` (`Σ_active inflight ≤ L_global`) are machine-checked by the
`GaleHeartbeatLeasing` BFS twin (`test/concurrency/distributed-leasing-model.test.ts`,
every reachable state). The property suite with simulated cross-node latency
(`test/concurrency/distributed-invariant.test.ts`) asserts `GlobalCap` end-to-end and
pins the bounded, self-draining async `Σ inflight` residual as a deterministic
regression (so no false hard end-to-end claim creeps back). See §§9,12 for the
full failure-mode rationale.