# ThrottleKit — Design & Architecture (per component)

> **Rate limiting you can prove.** This directory is the deep, component-by-component design
> reference: what each part is, how it works, and — for every non-obvious choice — *why it was
> built that way*. [`THROTTLEKIT.md`](../../THROTTLEKIT.md) is the narrative overview; these are
> the engineering internals behind it.

Each document is self-contained and follows the same shape:

1. **Purpose** — the problem the component solves.
2. **Architecture** — the real data structures, signatures, math, and control flow (with `file:line`).
3. **Design decisions & rationale** — the choices that could have gone another way, and why they didn't.
4. **Caveats & failure behavior** — the honest edges.
5. **What proves it** — the tests, properties, and machine-checked specs that hold the component to its contract.

## The shape of the system

ThrottleKit separates rate limiting into **three orthogonal concerns** so that the N algorithms ×
M backends × K frameworks matrix collapses to N + M + K independent pieces:

```
            ┌──────────────┐     check(key, cost)      ┌───────────────┐
 request ──►│   Adapter    │ ─────────────────────────►│   Limiter     │
            │ (express /   │                            │  strategy +   │
            │  fetch /     │◄───────────  Decision ─────│  store + key  │
            │  gRPC / …)   │                            └──────┬────────┘
            └──────────────┘                                   │ apply(key, transform)
                                                               ▼
                                              ┌────────────────────────────────┐
                                              │              Store              │
                                              │  Memory · Redis · Postgres · …  │
                                              └────────────────────────────────┘
```

- **Strategies** are *pure functions of time* — `(state, now, cost) → { state, decision }` — authored
  once and (where it matters for distribution) compiled to an equivalent atomic Lua form.
- **Stores** expose exactly **one** mutating primitive, an atomic `apply`. Adding a backend is
  implementing one method; adding an algorithm never touches a store.
- **Adapters** are thin glue that map a framework's request/response onto one `check`.

On top of that base sit the four **admission axes** — *rate*, *placement* (distributed leasing),
*cost* (token budgets), and *concurrency* — and the machinery that composes and distributes them.

## Component map

| # | Document | Component | Source |
|---|---|---|---|
| 01 | [Core model & the `apply` primitive](01-core-model.md) | `Decision`/`Strategy`/`Store`/`Clock`/`Limiter`, determinism, the dual-path contract | `src/core/` |
| 02 | [Algorithms](02-algorithms.md) | GCRA, token bucket, fixed & sliding window, leaky bucket, quota, multi-dimensional | `src/algorithms/`, `src/multi/` |
| 03 | [Storage layer](03-stores.md) | Memory (timer wheel, LRU), Redis (Lua/OCC), Postgres, DynamoDB, Deno KV, Cloudflare | `src/stores/`, `src/redis/`, `src/postgres/`, `src/dynamodb/`, `src/deno/`, `src/cloudflare/` |
| 04 | [Two-tier engine & leasing (GALE)](04-two-tier-and-leasing.md) | L1/L2, the three modes, the overshoot bound, window-coupling, EOQ lease sizing, weighted-fair escrow | `src/twotier/` |
| 05 | [Cost axis & token-budget escrow (TALE)](05-cost-axis-token-budget.md) | streaming meter, learned & predictive reservation, distributed token budget | `src/admission/` |
| 06 | [Concurrency](06-concurrency.md) | adaptive concurrency, the distributed coordinator, occupancy cap, handoff, self-fencing | `src/concurrency/` |
| 07 | [Unified admission](07-unified-admission.md) | the decision algebra, sequential vs Lua-fused, the joint-LP bid-price policy | `src/admission/`, `src/core/combine.ts` |
| 08 | [Federation](08-federation.md) | one global limit across regions, the coordinator abstraction, regional escrow, federated fair escrow | `src/federation/` |
| 09 | [Adapters & the request lifecycle](09-adapters.md) | the shared contract, `createEnforcer`, the exactly-once `release()` lifecycle, every binding | `src/adapters/` |
| 10 | [Observability](10-observability.md) | the frozen OTel metric/attribute contract, the analytics tap, in-process analytics | `src/observability/`, `src/analytics/` |
| 11 | [Overload & security](11-overload-and-security.md) | fixed-memory DDoS sketches, proxy-correct IP keying, PII-safe HMAC keys, HTTP headers | `src/sketch/`, `src/security/`, `src/http/` |
| 12 | [Config & CLI](12-config-and-cli.md) | `.throttlekit.yaml` rate-limit-as-code, the `throttlekit` CLI | `src/config/`, `src/cli/` |
| 13 | [Wire protocol](13-wire-protocol.md) | the single-sourced Lua, the manifest & drift-lock, golden vectors, the proto contract | `wire/` |
| 14 | [gRPC server](14-grpc-server.md) | the service core, the Doors, crash-reclaim, mTLS | `server/` |
| 15 | [Python client](15-python-client.md) | one oracle, two doors; the contract drift-gate | `throttlekit-py` |

## Conventions used throughout

- **"Decision record."** Where a choice was deliberate and load-bearing, it's called out as a
  *decision* with its rationale and the alternative it rejected. These mirror the `D-*` records the
  code comments reference.
- **"Machine-checked."** Several bounds are verified by a model checker: a [TLA⁺](https://lamport.azurewebsites.net/tla/tla.html)
  spec under [`spec/`](../../spec) run through TLC, *and* a dependency-free "BFS twin" that re-derives
  the same reachable-state invariants in TypeScript so the check runs in CI on every push. Treat these
  as an engineering verification technique (like exhaustive testing), not a formality.
- **Status tags.** Unless noted, a component is **shipped** (in `src/`, tested, part of the 1.x stable
  core per [`STABILITY.md`](../../STABILITY.md)). Pieces on the evolving frontier are marked
  **experimental** and are excluded from the SemVer surface guarantee.
- **GALE** (*Globally-Accounted Learned Escrow*) and **TALE** (*Temporally-Accounted Learned Escrow*) are the names for the two engines behind the distributed guarantees —
  *GALE* for provable distributed leasing (the placement axis), *TALE* for token-budget escrow (the
  cost axis). They ship as ordinary features; the names are just handles. See [04](04-two-tier-and-leasing.md)
  and [05](05-cost-axis-token-budget.md).

## See also

- [`THROTTLEKIT.md`](../../THROTTLEKIT.md) — the single-page narrative architecture overview.
- [`docs/FORMAL-MODEL.md`](../FORMAL-MODEL.md) — the machine-checked proof of the leasing overshoot bound.
- [`docs/DESIGN-NOTES.md`](../DESIGN-NOTES.md) — the verified-math audit trail (every formula vs its primary source).
- [`docs/FAILURE-MODES.md`](../FAILURE-MODES.md) — per-backend outage behavior and recovery.
- [`docs/METRICS.md`](../METRICS.md) — the observability contract reference.
- [`SCOREBOARD.md`](../../SCOREBOARD.md) — the feature/correctness matrix and benchmark summary.
