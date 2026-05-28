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

| Failure shape | What happens | What's **lost** | Recovery | Δ (cross-region overshoot) |
|---|---|---|---|---|
| **Region partitioned from coordinator** (e.g. cross-region link down) | Region serves out its existing in-process escrow; once empty, fails closed (denies until reachable). `onCoordinatorOutage: "fail-closed"` (default). | Any not-yet-leased capacity in the coordinator that this region might have used. | Heal the link → next lease succeeds; in-process escrow refills. | **0** — by construction, no new admissions during outage. |
| **Coordinator crash, recovered within the same window** | Same as above; existing escrow keeps serving briefly, then denies. On recovery, leases resume against the original budget remaining. | Nothing committed — the coordinator's remaining budget is preserved across the crash (assuming durable Redis). | Re-attach client → resume. `reconcile()` is idempotent on `windowStart` so retries through the partition converge. | **0** — coordinator's remaining budget is exact across crash. |
| **Coordinator unavailable across a window boundary** | Every region denies until coordinator returns. When it does, window-N+1's fresh budget is acquired. | All admissions during the outage (federation is fully unavailable). | Coordinator returns → next request leases against the new window's fresh budget. | **0** — zero admissions during the outage. |
| **Regional store outage** (regional Redis L2 down, while coordinator reachable) | Out of scope at TK-906 — regional escrow lives in process memory. Future (TK-906+): regional Redis backs multi-process escrow; outage reverts to per-process escrow until L2 returns. | Multi-process atomicity within the region. | L2 reconnect → resume. | **0** — coordinator still enforces the global bound. |

**Federation fails closed across every outage shape.** There is no outage
scenario where Δ exceeds 0; the worst case is full unavailability. This
matches the `windowCoupled` twoTier safety story one layer up — the
formal `Roll` rule guarantees regional escrow forfeits at the window
boundary, so a coordinator outage cannot leak un-leased capacity.

**Optional softer mode**: `onCoordinatorOutage: "regional-only"` (TK-906+)
falls back to per-region limits during a coordinator outage, accepting Δ
bounded by the regional limit (rather than the federation limit) in
exchange for availability. Opt-in only; the default stays fail-closed.

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
