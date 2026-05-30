# Benchmarks

Measured numbers for ThrottleKit's hot paths and a head-to-head against the two most-used Node rate
limiters. Everything here was produced by the harnesses in [`bench/`](bench/) — reproduce it yourself
with the commands at the bottom; nothing below is a vendor claim.

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
| ThrottleKit | 1.0.0 |
| Redis | `redis:7-alpine` in Docker Desktop, port 6380 |
| Postgres | `postgres:16` in Docker Desktop, port 5433 |
| Date | 2026-05-31 |

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
| `gcra` | **169** | 5.9M | ~1 B/op |
| `tokenBucket` | 181 | 5.5M | 0 B/op |
| `fixedWindow` | 193 | 5.2M | 0 B/op |

A complete GCRA decision (`allowed`, `limit`, `remaining`, `resetAt`, `retryAfterMs`) in **169 ns** with
no Promise, no microtask, and no steady-state allocation. `checkSync` is available whenever the store is
synchronous (in-process, or a warmed two-tier lease).

### Asynchronous `check`

| Strategy | ns/op | ops/sec |
|---|--:|--:|
| `gcra` | ~300 | 3.3M |

The `Promise` wrapper roughly doubles the cost (~130 ns of microtask overhead) — still 3.3M decisions/sec
on one core.

### Concurrency guards — `acquire()` + `release()`

Per-request overhead of an in-flight limiter in a tight `acquire → release` loop (the ceiling never
binds, isolating guard cost).

| Guard | ns/op | ops/sec | alloc |
|---|--:|--:|--:|
| `adaptiveConcurrency` (AIMD, single process) | 291 | 3.4M | 1 B/op |
| `distributedAdaptiveConcurrency` (post-heartbeat, local fast path) | 138 | 7.2M | ~0 B/op |

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
| **throttlekit** `checkSync` | GCRA | sync | **169** | 5.9M |
| throttlekit `check` | GCRA | async | 301 | 3.3M |
| throttlekit `check` | fixed-window | async | 300 | 3.3M |
| rate-limiter-flexible | fixed-window | async | 331 | 3.0M |
| express-rate-limit | fixed-window¹ | async | 199 | 5.0M |

¹ express-rate-limit's measured op is its `MemoryStore.increment()` — a bare counter bump that returns a
hit count; the limit decision happens later in middleware and is **not** included. So ThrottleKit's sync
path computes a *full GCRA decision* in **169 ns — faster than a bare counter increment (199 ns)** — and
on the same async API shape its GCRA (`301 ns`) beats rate-limiter-flexible's counter (`331 ns`). The
sync API has no equivalent in either incumbent.

### Redis tier (single hot key, one atomic round trip, ALLOW path)

| Contender | Algorithm | ops/sec | p50 | p99 | p99.9 |
|---|---|--:|--:|--:|--:|
| **throttlekit** `RedisStore` | GCRA | 778 | 1.19 ms | 2.39 ms | 3.87 ms |
| rate-limiter-flexible | fixed-window | 752 | 1.23 ms | 2.58 ms | 4.45 ms |

Both do exactly one atomic Lua round trip per request (`EVALSHA`/`EVAL`) and land within noise of each
other — ThrottleKit's proven GCRA transform costs nothing extra over a counter. **The absolute latency
is the Docker-Desktop-on-Windows loopback (~1.2 ms p50), not Redis** — a same-AZ managed Redis is
typically 150–300 µs. Use these rows to compare the two libraries, not to predict your p50.

### Postgres tier (single hot key, ALLOW path)

| Contender | Algorithm | round trips | ops/sec | p50 | p99 |
|---|---|--:|--:|--:|--:|
| throttlekit `PostgresStore` | GCRA | ~5 (txn) | 121 | 7.9 ms | 12.9 ms |
| rate-limiter-flexible | fixed-window | 1 (upsert) | 348 | 2.7 ms | 5.2 ms |
| **throttlekit** `twoTier(leased)` | GCRA | 1 per 100 reqs | **12.3k** | **81 µs/op** | — |

An honest split: on a *single shared counter*, rate-limiter-flexible's specialized one-statement `UPSERT`
beats ThrottleKit's generic read-modify-write transaction (advisory lock + read + write + commit, ~5 round
trips) that reuses the same proven transform across **every** strategy. But front that same Postgres store
with **`twoTier` leasing** — amortize one transaction over a batch of 100 local grants — and throughput
jumps to **12.3k ops/sec (81 µs/op)**, ~35× the raw path, with no equivalent in the incumbent.

---

## The two-tier lever

The headline of the distributed design: an exact global limit that doesn't pay a network round trip per
request. Each node leases a batch of credits in one round trip and serves them locally at in-process
speed (`checkSync`). Measured against Redis (`bench/run.ts --redis`):

| Mode | ops/sec | L2 round trips |
|---|--:|--:|
| strict GCRA (1 `EVALSHA` / request) | 783 | 1 per request |
| **`twoTier(leased)`, batch 100** | **66.4k** | **1 per 100 requests** |

Same correctness envelope (the lease math is machine-checked), **~85× the throughput**, because 99% of
requests never leave the process. Larger batches trade a looser per-node burst for fewer round trips;
adaptive lease sizing (1.0's default sizer) tunes the batch to observed demand.

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

# Head-to-head vs. rate-limiter-flexible and express-rate-limit:
npm run bench:compare
# with the distributed tiers:
THROTTLEKIT_TEST_REDIS=redis://localhost:6380 \
THROTTLEKIT_TEST_POSTGRES=postgres://throttlekit:throttlekit@localhost:5433/throttlekit \
  node --expose-gc --import tsx bench/compare.ts
```

The CI **bench-regression gate** (`npm run bench:gate`) guards these numbers on every push using a
machine-independent relative metric, so a hot-path regression fails the build rather than silently
shipping.
