# Benchmarks

Measured numbers for ThrottleKit's hot paths, the Tier-2 lease (the distributed scale lever), and a
head-to-head against the two most-used Node rate limiters. Everything here was produced by the harnesses in
[`bench/`](bench/) — reproduce it yourself with the commands at the bottom; nothing below is a vendor claim.
Every table traces back to a committed run manifest under [`bench/manifests/`](bench/manifests/).

> **Read the methodology before the numbers.** Micro-benchmarks measure one machine on one day. The
> in-process rows are the library's real cost; the Redis/Postgres rows are **dominated by the
> Docker-Desktop-on-Windows network round trip** on this box and are included for *relative* shape, not
> as absolute latency you'll see in production.

## Test machine

| | |
|---|---|
| CPU | AMD Ryzen AI 9 HX 370 (12 cores / 24 threads) |
| Memory | 31.1 GB |
| OS | Windows 11 (10.0.26200) |
| Node | v24.13.1 (V8, `process.hrtime.bigint` timer) |
| ThrottleKit | 1.4.0 |
| Redis | `redis:7-alpine` in Docker Desktop, port 6380 |
| Postgres | `postgres:16-alpine` in Docker Desktop, port 5433 |
| Date | 2026-06-10 |

## Methodology

- **Best of N independent process launches.** Each table reports the lowest-noise run; the hot rows
  (e.g. `gcra checkSync`) reproduced to ±1 ns/op across launches, the others to a few percent.
- **Warm up, then time.** Every loop JIT-warms (100k sync iterations / 10k async) before the timed
  window, so the numbers are steady-state, not cold-start.
- **ALLOW path, single hot key.** Limits are set high enough that no request is ever denied — this
  isolates the algorithm's cost and removes branch-prediction luck from deny handling.
- **Allocations** are the net heap delta across the timed loop under `node --expose-gc`, divided by
  iterations (`B/op`). A read of `0–1 B/op` means the path is effectively allocation-free in steady
  state (the returned `Decision` is short-lived and scavenged).
- **Comparative fairness:** every contender runs in the **same process, same machine, same warmup, same
  iteration count**, and the **algorithm each library actually implements is printed next to its row** —
  a bare counter and a GCRA cell are not the same guarantee even at the same ops/s.
- Distributed/Redis/Postgres rows `await` serially (one logical connection's request stream), so they
  are **latency-bound, not pipelined** — real deployments pipeline and run many connections.

---

## In-process (MemoryStore)

The path that runs on every request before you ever touch a network. Single hot key, ALLOW path.

### Synchronous `checkSync` — the fast path

| Strategy | ns/op | ops/sec | alloc |
|---|--:|--:|--:|
| `gcra` | **170** | 5.9M | ~1 B/op |
| `tokenBucket` | 175 | 5.7M | 0 B/op |
| `fixedWindow` | 217 | 4.6M | 0 B/op |

A complete GCRA decision (`allowed`, `limit`, `remaining`, `resetAt`, `retryAfterMs`) in **170 ns** with
no Promise, no microtask, and no steady-state allocation. `checkSync` is available whenever the store is
synchronous (in-process, or a warmed two-tier lease).

### Tier-2 client spend — `LeaseSpender.spend`

The hot path a **Tier-2 leased client** actually pays per request. It has leased a chunk of the global
budget up front (one `Fleet.Reserve` round trip) and now serves locally: a credit decrement plus a
synthesized allow — byte-identical to the core's `twoTier(leased)` L1 spend, pinned by the golden `lease`
vectors. No algorithm state machine, no store, no network.

| Path | ns/op | ops/sec | alloc |
|---|--:|--:|--:|
| **`LeaseSpender.spend`** | **10** | **102.9M** | ~0 B/op |
| `gcra checkSync` (for scale) | 175 | 5.7M | ~1 B/op |

Serving a leased credit costs **~10 ns — ~17× cheaper than computing a full GCRA decision**, and
allocation-free in steady state. That is the whole point of the lease: 99% of requests never run the
algorithm and never leave the process; only the occasional refresh does. This row is guarded by the
machine-independent regression gate (`bench/gate.ts`) alongside the `checkSync` strategies.

### Asynchronous `check`

| Strategy | ns/op | ops/sec |
|---|--:|--:|
| `gcra` | 277 | 3.6M |

The `Promise` wrapper roughly doubles the cost (~110 ns of microtask overhead) — still 3.6M decisions/sec
on one core.

### Concurrency guards — `acquire()` + `release()`

Per-request overhead of an in-flight limiter in a tight `acquire → release` loop (the ceiling never
binds, isolating guard cost).

| Guard | ns/op | ops/sec | alloc |
|---|--:|--:|--:|
| `adaptiveConcurrency` (AIMD, single process) | 277 | 3.6M | 1 B/op |
| `distributedAdaptiveConcurrency` (post-heartbeat, local fast path) | 136 | 7.4M | ~0 B/op |

The distributed guard's steady-state `acquire` is a lean local in-flight check against its leased share
(the coordinator round trip happens off the request path, on the heartbeat), so it is *cheaper* per
request than the single-process AIMD controller that samples RTT inline.

---

## Head-to-head vs. incumbents

Versus [`rate-limiter-flexible`](https://www.npmjs.com/package/rate-limiter-flexible) and
[`express-rate-limit`](https://www.npmjs.com/package/express-rate-limit), same process and budget.
([`@upstash/ratelimit`](https://www.npmjs.com/package/@upstash/ratelimit) is excluded — it requires the
Upstash cloud REST endpoint and can't be measured locally on equal footing.)

### Memory tier (in-process, ALLOW path)

| Contender | Algorithm | API | ns/op | ops/sec |
|---|---|---|--:|--:|
| **throttlekit** `checkSync` | GCRA | sync | **165** | 6.1M |
| throttlekit `check` | GCRA | async | 295 | 3.4M |
| throttlekit `check` | fixed-window | async | 284 | 3.5M |
| rate-limiter-flexible | fixed-window | async | 337 | 3.0M |
| express-rate-limit | fixed-window¹ | async | 203 | 4.9M |

¹ express-rate-limit's measured op is its `MemoryStore.increment()` — a bare counter bump that returns a
hit count; the limit decision happens later in middleware and is **not** included. So ThrottleKit's sync
path computes a *full GCRA decision* in **165 ns — faster than a bare counter increment (203 ns)** — and
on the same async API shape its GCRA (`295 ns`) beats rate-limiter-flexible's counter (`337 ns`). The
sync API has no equivalent in either incumbent.

### Redis tier (single hot key, one atomic round trip, ALLOW path)

| Contender | Algorithm | ops/sec | p50 | p99 | p99.9 |
|---|---|--:|--:|--:|--:|
| **throttlekit** `RedisStore` | GCRA | 745 | 1.25 ms | 2.38 ms | 4.81 ms |
| rate-limiter-flexible | fixed-window | 754 | 1.25 ms | 2.44 ms | 4.70 ms |

Both do exactly one atomic Lua round trip per request (`EVALSHA`/`EVAL`) and land within noise of each
other — ThrottleKit's proven GCRA transform costs nothing extra over a counter. **The absolute latency
is the Docker-Desktop-on-Windows loopback (~1.25 ms p50), not Redis** — a same-AZ managed Redis is
typically 150–300 µs. Use these rows to compare the two libraries, not to predict your p50.

### Postgres tier (single hot key, ALLOW path)

| Contender | Algorithm | round trips | ops/sec | p50 | p99 |
|---|---|--:|--:|--:|--:|
| throttlekit `PostgresStore` | GCRA | ~5 (txn) | 118 | 8.1 ms | 13.3 ms |
| rate-limiter-flexible | fixed-window | 1 (upsert) | 342 | 2.8 ms | 5.0 ms |
| **throttlekit** `twoTier(leased)` | GCRA | 1 per 100 reqs | **9.4k** | **106 µs/op** | — |

An honest split: on a *single shared counter*, rate-limiter-flexible's specialized one-statement `UPSERT`
beats ThrottleKit's generic read-modify-write transaction (advisory lock + read + write + commit, ~5 round
trips) that reuses the same proven transform across **every** strategy. But front that same Postgres store
with **`twoTier` leasing** — amortize one transaction over a batch of 100 local grants — and throughput
jumps to **9.4k ops/sec (106 µs/op)**, ~80× the raw path, with no equivalent in the incumbent.

---

## The two-tier lever (embedded store)

The headline of the distributed design: an exact global limit that doesn't pay a network round trip per
request. Each node leases a batch of credits in one round trip and serves them locally at in-process
speed (`checkSync`). Measured against Redis (`bench/run.ts --redis`):

| Mode | ops/sec | L2 round trips |
|---|--:|--:|
| strict GCRA (1 `EVALSHA` / request) | 735 | 1 per request |
| **`twoTier(leased)`, batch 100** | **71.2k** | **1 per 100 requests** |

Same correctness envelope (the lease math is machine-checked), **~97× the throughput**, because 99% of
requests never leave the process. Larger batches trade a looser per-node burst for fewer round trips;
adaptive lease sizing (1.x's default sizer) tunes the batch to observed demand.

---

## The Fleet door — Tier-2 lease over gRPC (the service-door lever)

The same lever, reached over the **`Fleet.Reserve`** service door instead of an embedded store — so a
**polyglot** client (Node, Python, …) gets it too. A `federated:` policy's global per-window budget is
leased in chunks: the **server is the one oracle** (it sizes every grant via the policy's coordinator);
the client only **spends** it locally with `LeaseSpender` (verified byte-identical to the core). It
round-trips only to refresh, collapsing the per-request hop.

Driven against a real gRPC server (`server/bench/fleet.ts`), Tier-1 (one `Check` RPC per request) vs
Tier-2 (one `Reserve` per batch, then local spend), across batch sizes and two coordinators. `p50` is the
served-request latency (the local spend); `p99` catches the periodic refresh round trip.

### In-process coordinator (isolates the client↔server gRPC hop)

| Mode | ops/sec | req / round trip | p50 | p99 | vs Tier-1 |
|---|--:|--:|--:|--:|--:|
| Tier-1 `Check` (1 RPC / req) | 2.0k | 1 | 391 µs | 1.60 ms | 1× |
| Tier-2 lease, batch 10 | 20.5k | 10 | 0.1 µs | 637 µs | **10×** |
| Tier-2 lease, batch 100 | 232.8k | 100 | 0.1 µs | 327 µs | **114×** |
| Tier-2 lease, batch 1000 | 1.26M | 1000 | 0.1 µs | 0.2 µs | **615×** |

### Redis-backed coordinator (the realistic distributed cost)

Here the server's grant hits Redis too, so the lease amortizes **both** the client↔server gRPC hop **and**
the server↔store hop:

| Mode | ops/sec | req / round trip | p50 | p99 | vs Tier-1 |
|---|--:|--:|--:|--:|--:|
| Tier-1 `Check` (1 RPC / req) | 433 | 1 | 2.18 ms | 4.44 ms | 1× |
| Tier-2 lease, batch 10 | 3.9k | 10 | 0.1 µs | 3.10 ms | **9×** |
| Tier-2 lease, batch 100 | 32.9k | 100 | 0.1 µs | 1.91 ms | **76×** |
| Tier-2 lease, batch 1000 | 350.5k | 1000 | 0.1 µs | 0.2 µs | **810×** |

The served-request `p50` is **0.1 µs** at every batch — the local `LeaseSpender.spend` — because only one
request in `batch` actually leaves the process. The batch size is the throughput-vs-burst dial: a larger
batch holds more of the global budget per node (bounded, and discarded at the window boundary, so the
global per-window total stays at the limit). As with the embedded lever, the absolute round-trip latency
is the Docker-on-Windows loopback, not the server — the load-bearing figure is the **req/round-trip
reduction**, which is machine-independent.

---

## Caveats (read these)

- **Redis/Postgres absolute latency is the local Docker network, not the database.** On Windows, Docker
  Desktop's loopback adds ~1 ms; the relative library-vs-library shape holds, the absolute p50 does not
  transfer. Re-run against your real backend for deployment numbers.
- **Sync vs. async rows are not directly comparable.** `checkSync` has no Promise/microtask cost; the
  incumbents expose only async APIs. The async GCRA / fixed-window rows are the fair head-to-head.
- **`Date.now()` is cheaper on Linux than on Windows.** The in-process numbers may be a few percent
  faster on a Linux CI runner (this is also why the CI bench-regression gate uses a *relative*,
  machine-independent metric — see [`bench/gate.ts`](bench/gate.ts)).
- **Single hot key.** Multi-key workloads add Map/connection-pool effects this harness deliberately
  excludes to isolate algorithm cost.
- These are one machine's numbers. **Run them on yours.**

## Reproduce

```bash
# In-process micro-benchmarks (+ allocations with --expose-gc, + Redis with --redis):
npm run bench
node --expose-gc --import tsx bench/run.ts --redis      # THROTTLEKIT_TEST_REDIS=redis://localhost:6380

# The Tier-2 client local-spend hot path (+ allocations):
node --expose-gc --import tsx bench/lease.ts             # npm run bench:lease

# The Fleet door — Tier-1 Check vs Tier-2 lease round-trip reduction (in-process + Redis coordinators):
THROTTLEKIT_TEST_REDIS=redis://localhost:6380 npm run bench:fleet

# Head-to-head vs. rate-limiter-flexible and express-rate-limit (+ the distributed tiers):
npm run bench:compare
THROTTLEKIT_TEST_REDIS=redis://localhost:6380 \
THROTTLEKIT_TEST_POSTGRES=postgres://throttlekit:throttlekit@localhost:5433/throttlekit \
  node --expose-gc --import tsx bench/compare.ts
```

Each run stamps a machine-tagged manifest into [`bench/manifests/`](bench/manifests/) (the JSON behind the
tables above). The CI **bench-regression gate** (`npm run bench:gate`) guards the in-process hot paths —
the three sync strategies **and the Tier-2 `lease spend`** — on every push using a machine-independent
relative metric, so a hot-path regression fails the build rather than silently shipping.
