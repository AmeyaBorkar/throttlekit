# ThrottleKit — Audit Findings

**Date:** 2026-05-27 · **Scope:** shipped library source under `src/`, audited at v0.7.0 (commit
`6b06b38`, i.e. *before* `DurableObjectStore`) · **Status:** consolidated & verified.

## Method

Four specialized audit agents swept `src/` in parallel, each emitting ID'd findings with a
self-skeptical *"genuine defect vs. intentional design choice"* assessment:

| Agent | Prefix | Raw findings |
|---|---|---|
| Security | `SEC-` | 10 |
| Performance | `PERF-` | 13 |
| Correctness & robustness | `ROB-` | 10 |
| Code quality, cleanliness & integration | `CQ-` | 19 |

**Every actionable finding was then re-verified by hand against the cited code** (not taken on the
agent's word). This document **dedupes** across agents, assigns **canonical IDs** (`TK-*`), **groups**
by theme, and records a **validation verdict** + action for each. 52 raw → 31 canonical.

### Verdict legend

- ✅ **Valid — act**: a real defect/win; remediate.
- 🟡 **Valid trade-off**: real, but a configurable/documented choice — document and/or offer an opt-in, no forced behavior change.
- ⚪ **By design / already-optimal**: verified *not* a defect — recorded so it is never "re-fixed".

## Summary

| ID | Title | Sev | Verdict | Sources |
|---|---|---|---|---|
| TK-S01 | Edge adapters trust `cf-connecting-ip`/XFF ignoring `trustProxy` | High | ✅ | SEC-01 |
| TK-S02 | Fail-open default + adapters catch *all* errors, not just outages | Med | 🟡 | SEC-02, ROB-08 |
| TK-S03 | `policyName` unsanitized in structured headers | Low | ✅ | SEC-04 |
| TK-S04 | Crypto / Lua / SQL / IP-parsing / deps verified sound | Info | ⚪ | SEC-05…10 |
| TK-R01 | Two-tier on-demand path double-leases under intra-node concurrency | High | ✅ | ROB-01 |
| TK-R02 | `twoTier` leaks `returnIdleAfterMs` timer; no limiter `close()` | High | ✅ | ROB-02 |
| TK-R03 | `fixedWindow`/`slidingWindowLog` Lua `PEXPIRE` not clamped ≥1 like JS | Low | ✅ | ROB-04, ROB-05 |
| TK-R04 | Count-Min Sketch truncates fractional `cost` (Uint32) | Low | ✅ | ROB-06 |
| TK-R05 | `leakyBucket.schedule` setTimeout 32-bit overflow at huge `maxQueueMs` | Low | 🟡 | ROB-07 |
| TK-R06 | `adaptiveThrottle` boundary attribution | Info | ⚪ | ROB-10 |
| TK-R07 | Unbounded in-memory maps (twoTier L1 + admission) by default | Med | 🟡 | SEC-03, ROB-03, ROB-09 |
| TK-P01 | `checkSync` allocates 3 objects (strategy outcome re-wrap) | High | ✅ | PERF-01 |
| TK-P02 | `clock.now()` read twice per sync check | High | ✅ | PERF-02 |
| TK-P03 | TimingWheel double Map lookup on every hit | Med | ✅ | PERF-03 |
| TK-P04 | `wheel.set` allocates a `WheelEntry` per persisted check | High | ✅ | PERF-04 |
| TK-P05 | `twoTier` leased hit hashes the key 5–7× across 4 maps | Med | ✅ | PERF-07 |
| TK-P06 | `slidingWindow` rebuilds the bucket `Record` every check | Med | ✅ | PERF-05 |
| TK-P07 | `slidingWindowLog` filter+slice+closure per check | Med | 🟡 | PERF-06 |
| TK-P08 | `multiRateLimit.runSync` per-dimension closures | Med | 🟡 | PERF-08 |
| TK-P09 | Hot paths verified already-optimal (gcra, sketch, Redis, eviction, keyFor alloc) | Info | ⚪ | PERF-09…13 |
| TK-Q01 | `validateCost` duplicated in 4+ modules | Med | ✅ | CQ-01 |
| TK-Q02 | key-prefixing logic duplicated in 5 places | Med | ✅ | CQ-02, PERF-09 |
| TK-Q03 | `clampNum`/`clamp` defined 3× with **two arg orders** (foot-gun) | Med | ✅ | CQ-03 |
| TK-Q04 | epoch-aligned `rollWindow` duplicated across primitives | Med | ✅ | CQ-04 |
| TK-Q05 | `DimResult` is a verbatim duplicate of `Decision` | Low | ✅ | CQ-05 |
| TK-Q06 | `predictiveReservation` reads `holdCost`/`overrunCost` before validation | Low | ✅ | CQ-10 |
| TK-Q07 | Primitive surface inconsistency (`reset()` void vs `Promise`, `debit`, no `checkMany`) | Med | 🟡 | CQ-09, CQ-11 |
| TK-Q08 | Export-map gaps + `otel`↔`observability` entry-name mismatch | Med | 🟡 | CQ-18 |
| TK-Q09 | Casts/decoders/deprecated alias verified acceptable; JSDoc is a strength | Info | ⚪ | CQ-06,07,08,12,13,14 |
| TK-I01 | No edge-native stores (CF DO/D1/KV, DynamoDB, Deno/Vercel KV) | High | ✅ | CQ-15 |
| TK-I02 | `tokenBudget` is single-instance — no distributed token budget | High | ✅ | CQ-16 |
| TK-I03 | Missing adapters: NestJS, AWS Lambda, tRPC, SvelteKit, Remix, Elysia | Med | ✅ | CQ-17 |
| TK-I04 | No gRPC / transport-agnostic `enforce()` | Low | 🟡 | CQ-19 |

**Tally:** 6 High · 11 Medium · 7 Low · (+ Info). Of the actionables: **2 High correctness**
(TK-R01, TK-R02), **1 High security** (TK-S01), **4 High performance** (TK-P01,02,04 + TK-P05/P06
Medium), the duplication cluster (TK-Q01–Q05), and the integration roadmap (TK-I01–I04, with TK-I01
already begun).

---

## Security

### TK-S01 — Edge adapters trust `cf-connecting-ip` / XFF ignoring `trustProxy` · High · ✅ Valid
`src/adapters/core.ts:139-151` (`edgeClientIp`), default key for `fetch`/`next`/`hono`.
**Verified:** `edgeClientIp` returns `clientIp({ remoteAddr: cf.trim() }, trust)` for any
`cf-connecting-ip`, and falls back to the rightmost (client-settable) `x-forwarded-for` entry — the
`trustProxy` policy never gates the `cf` branch. An app *not* actually behind Cloudflare lets a client
set `Cf-Connecting-IP: <rand>` per request and rotate rate-limit buckets, defeating the limiter. The
Node path (`nodeClientIp`, uses the real socket peer) is sound.
**Action:** gate `cf-connecting-ip` behind an explicit opt-in (a trusted-header flag), and when
`trustProxy` is unset/`false` return `"anon"` instead of a spoofable XFF token; at minimum document the
edge default's trust assumption loudly. *(Behavior change → do under a clear changelog note.)*

### TK-S02 — Fail-open default + over-broad catch · Medium · 🟡 Trade-off
`src/adapters/core.ts:95` (`fail ?? "open"`); every adapter catch (e.g. `express.ts:58-73`).
**Verified:** on `limiter.check` throwing, the default admits the request; the catch is untyped, so a
*logic* bug (not just a store outage) is also swallowed into "allow". This is documented and uniform,
and `onError` is always offered. **Action:** keep configurable; (a) recommend `fail: "closed"` for
auth/payments at the call sites, (b) consider applying the fail policy only to `StoreUnavailableError`
and surfacing unexpected errors. Document either way.

### TK-S03 — `policyName` unsanitized in structured headers · Low · ✅ Valid
`src/http/headers.ts:68,72`. **Verified:** `policyName` is interpolated into a quoted RFC 9651 field
value. It is developer-supplied (defaults to `strategy.name`), so not attacker-controlled, but the
library does no validation of its own. **Action:** strip/validate CR/LF and `"` (cheap hardening).

### TK-S04 — Verified-sound areas · Info · ⚪ No action
SHA-1-for-EVALSHA (mandated by Redis, library-controlled script — `SEC-05`); HMAC-SHA-256 keying with
no comparison path (`SEC-06`); Lua built only from constant templates, all data via KEYS/ARGV — no
injection (`SEC-07`); Postgres fully parameterized + allow-listed identifier, advisory-lock collisions
only over-serialize (`SEC-08`); no prototype-pollution / ReDoS / `eval` / dynamic require, **zero
runtime deps** (`SEC-09`); IPv4/IPv6 parsing, `/64` aggregation, CIDR masking correct & fail-closed
(`SEC-10`). Recorded so these are not "re-investigated".

## Robustness & correctness

### TK-R01 — Two-tier on-demand path double-leases under intra-node concurrency · High · ✅ Valid
`src/twotier/index.ts:241-249`. **Verified:** the synchronous-miss lease (`await l2.apply(... leaseAmount)`)
has no in-flight dedup — the `refilling` set guards only `maybeRefill`. `Promise.all` of N concurrent
misses on a cold key issues **N** leases, so a node can hold up to `C×batch` outstanding leased credits
vs. the `≤ batch` the published overshoot bound (`Limit + N·(Batch−1)`, and the windowCoupled `= Limit`)
assumes — plus a thundering herd of round trips exactly under load. Not an L2-safety break (the shared
counter stays exact), but a real divergence from the *stated* bound.
**Action:** dedup in-flight on-demand leases per key (a `Map<string, Promise<Decision>>` of pending
leases; a concurrent miss awaits the pending one, then re-checks local credits) — collapses N → 1 round
trip and restores ≤ batch outstanding per node.

### TK-R02 — `twoTier` leaks the `returnIdleAfterMs` timer; no limiter `close()` · High · ✅ Valid
`src/twotier/index.ts:209-217`; `Limiter` has no disposal (`src/core/types.ts:143`).
**Verified:** the `setInterval` is only `unref`'d (prevents keeping Node alive at exit; does *not* stop
the leak), the returned limiter exposes no `close`, and `Limiter` declares none — so a discarded
two-tier limiter (config reloads, tests) leaks the timer + its captured maps forever in a long-running
process. `MemoryStore`/`PostgresStore` already have `close()`, but it's unreachable through `Limiter`.
**Action:** add optional `close?(): Promise<void>` to `Limiter`; have `twoTier` clear its timer (and
forward to `l2.close?.()`); document that timer-owning limiters must be closed.

### TK-R03 — `fixedWindow` / `slidingWindowLog` Lua `PEXPIRE` not clamped ≥1 · Low · ✅ Valid
`src/algorithms/fixed-window.ts:39` (vs JS `Math.max(1, …)` at :98), `sliding-window-log.ts:30`.
**Verified:** gcra/token-bucket/leaky-bucket Lua all clamp `px<1 ⇒ 1`; `fixedWindow` and
`slidingWindowLog` pass `reset_at-now` / `windowMs` straight to `PEXPIRE`. Reachable only with a
fractional custom clock + `useServerTime:false` (sub-1-ms TTL → Redis rejects/immediate-expire), so the
"JS≡Lua bit-identical" claim has a sub-ms TTL corner. **Action:** mirror the clamp in both scripts.

### TK-R04 — Count-Min Sketch truncates fractional `cost` · Low · ✅ Valid
`src/sketch/index.ts` (`Uint32Array` counters; `cost` validated only `>0`). **Verified:** `checkSync`
gates on the float `cost` but `add` writes into a `Uint32Array` (truncates), so a fractional `cost`
checks against more than it stores, weakening the "never over-admits" guarantee for fractional costs.
**Action:** `requireInteger` on the sketch's `cost` (matches `tokenBudget`), or round up before the gate.

### TK-R05 — `leakyBucket.schedule` setTimeout overflow at huge `maxQueueMs` · Low · 🟡 Trade-off
`src/algorithms/leaky-bucket.ts` (`sleep` via `setTimeout`; `maxQueueMs` has no upper bound).
**Verified:** an accepted `delayMs ≤ maxQueueMs`; `setTimeout` clamps delays > 2³¹−1 ms (~24.8 d) to 1,
firing immediately. Pathological config only (`reserve`/`reserveSync` unaffected). **Action:** document a
sane `maxQueueMs` ceiling, or chunk long sleeps. Low priority.

### TK-R06 — `adaptiveThrottle` boundary attribution · Info · ⚪ By design
`src/admission/index.ts:178-200`. The request/record pair straddling a window boundary is the intended
time-weighted rolling approximation (documented). Not a defect.

### TK-R07 — Unbounded in-memory maps by default · Medium · 🟡 Trade-off
`twoTier` L1 maps (`src/twotier/index.ts:111`, `maxKeys ?? Infinity`); `fairShare`/`weightedFairShare`/
`tokenBudget` per-tenant maps (`src/admission/index.ts`), cleared only on window roll.
**Verified:** `MemoryStore` is also unbounded-by-default but *documents* it and offers `maxKeys` + CLOCK
eviction; `twoTier`'s `L1Options.maxKeys` doesn't state the unbounded default, and the admission
primitives have no bound at all (a high-cardinality / adversarial tenant set grows them within a window).
**Action:** document the per-window O(distinct keys) cost prominently; offer an optional `maxKeys`/
`maxTenants` on the admission primitives; default `twoTier` `l1.maxKeys` to finite or document loudly.

## Performance

### TK-P01 — `checkSync` allocates 3 objects (outcome re-wrap) · High · ✅ Valid
`src/core/limiter.ts:49-52` + every `strategy.check` (e.g. `gcra.ts`). **Verified:** `strategy.check`
returns a `StrategyOutcome {state, decision, ttlMs, persist}` (object + nested `Decision`), then
`syncTransform` builds a third `ApplyOutcome {state, result, ttlMs, persist}`. The `Decision` escapes
(necessary); the two wrappers are transient garbage. The "allocation-free" claim relies on JIT scalar
replacement of escaping objects (fragile). **Action:** unify `StrategyOutcome` and `ApplyOutcome` so
`check` returns the exact shape `applySync` consumes — removes one object; (optionally) reuse scratch
slots to remove the second. Behavior-preserving (`Decision` byte-identical); touches the `Strategy`
contract + all algorithms (moderate effort, high value).

### TK-P02 — `clock.now()` read twice per sync check · High · ✅ Valid
`src/core/limiter.ts:69,83` + `src/stores/memory.ts:133`. **Verified:** the limiter sets
`syncNow = clock.now()` then `MemoryStore.applySync` reads `clock.now()` again — two reads (and a subtle
strategy-vs-TTL time skew). **Action:** thread `now` from the limiter into the store (widen the internal
sync path), one read per check. Tightens consistency too.

### TK-P03 — TimingWheel double Map lookup on every hit · Medium · ✅ Valid
`src/stores/memory.ts:134-141` + `timing-wheel.ts:74-77`. **Verified:** every `applySync` calls
`wheel.advance` (cheaply early-returns within a tick) then `map.get(key)` then `wheel.isExpired` (a
second `entries.get`) — two parallel maps consulted on the hot read. **Action:** fold the expiry epoch
into the store's `Entry` so the hit path checks `entry.exp <= now` with no wheel lookup (wheel keeps
only slot membership for sweeps).

### TK-P04 — `wheel.set` allocates a `WheelEntry` per persisted check · High · ✅ Valid
`src/stores/timing-wheel.ts:52-63`. **Verified:** every allowed check does `entries.set(key, {exp, slot})`
— a fresh object + Set delete/add — even when the slot is unchanged within a tick. **Action:** mutate the
existing `WheelEntry` in place when present; only touch slots when the slot actually changes (skip both
Set ops + the allocation in the common same-tick case).

### TK-P05 — `twoTier` leased hit hashes the key 5–7× across 4 maps · Medium · ✅ Valid
`src/twotier/index.ts:227-247`. **Verified:** one leased key's state is spread across `credits`,
`lastDecision`, `lastUse`, `refilling`; a local hit hashes it 5–7×. **Action:** collapse into one
`Map<string, LeaseEntry>`, fetched once. *(Do together with TK-R01/TK-R02 — same code.)*

### TK-P06 — `slidingWindow` rebuilds the bucket `Record` every check · Medium · ✅ Valid
`src/algorithms/sliding-window.ts:110-133`. **Verified:** each allowed check allocates a new
`Record<number,number>` and copies surviving buckets (numeric-keyed object → dictionary-mode). **Action:**
use a fixed ring (`Float64Array` of `S+1` indexed by `tick % (S+1)`) like the Lua already does; pruning
becomes implicit. Must keep JS≡Lua bit-identity. *(Not the default strategy → Medium.)*

### TK-P07 — `slidingWindowLog` array work · Medium · 🟡 Act-optional
`src/algorithms/sliding-window-log.ts:82-89`: per-call closure + `filter` then `slice` (double copy) +
push-loop. Partly inherent (O(limit) by design). **Action (optional):** single sized allocation, drop the
closure, copy the surviving tail once.

### TK-P08 — `multiRateLimit.runSync` per-dimension closures · Medium · 🟡 Act-optional
`src/multi/index.ts:305-345`: a `peek` + `commit` closure per dimension per check. **Action (optional):**
depends on the TK-P01 contract change; then read outcomes directly into preallocated arrays.

### TK-P09 — Verified already-optimal · Info · ⚪ No action
`keyFor` prefix concat is inherent (the store is keyed by the full string — `PERF-09`; dedupe is TK-Q02,
not a perf change); gcra rounding is load-bearing for JS≡Lua (`PERF-10`); Redis argv spread is noise vs
the round trip (`PERF-11`); the CMS hot path uses a reused scratch buffer + typed arrays + `Math.imul`
(`PERF-12`); CLOCK eviction is O(1) amortized and allocates only on first-touch (`PERF-13`).

## Code quality & cleanliness

### TK-Q01 — `validateCost` duplicated · Medium · ✅ Valid
`limiter.ts:18`, `twotier/index.ts:64`, `leaky-bucket.ts:152`, `multi/index.ts:373` (+ inline async
copies in `limiter.ts:58,89`). **Action:** add `requireCost` to `core/validate.ts`; one message source.

### TK-Q02 — key-prefixing duplicated 5× · Medium · ✅ Valid
`limiter.ts:37`, `twotier/index.ts:97`, `leaky-bucket.ts:105`, `redis/store.ts:68`, `postgres/store.ts:135`.
**Action:** extract `prefixer(prefix?)` into `core/`; the `prefix:key` format defined once. (Resolves the
PERF-09 dedupe angle without changing the per-call allocation, which is inherent.)

### TK-Q03 — `clamp` defined 3× with two arg orders · Medium · ✅ Valid (foot-gun)
`admission/index.ts:765` & `twotier/sizing.ts:37` (`clampNum(v,lo,hi)`) vs `concurrency/adaptive.ts:158`
(`clamp(lo,hi,v)`). **Verified:** same op, **transposed signature** — an active transposed-argument
hazard. **Action:** one `clamp(value, lo, hi)` in `core/`, delete all three, standardize value-first.

### TK-Q04 — `rollWindow` duplicated · Medium · ✅ Valid
`admission/index.ts` (×3: fairShare/weightedFairShare/tokenBudget) + `sketch`/`analytics` variants.
**Action:** a shared epoch-window roller taking a reset callback; at minimum factor the
`floor(now/windowMs)*windowMs` alignment into one named helper.

### TK-Q05 — `DimResult` duplicates `Decision` · Low · ✅ Valid
`src/multi/index.ts:60-66`. Structurally identical to `Decision`; forces `as DimResult` casts.
**Action:** delete `DimResult`, use `Decision`.

### TK-Q06 — `predictiveReservation` validates late · Low · ✅ Valid
`src/admission/index.ts` — reads `holdCost`/`overrunCost` before `learnedReservation(options)` validates
them. Not a live bug (throw fires before use) but an implicit ordering dependency. **Action:** add
`requirePositive` immediately after the reads, mirroring `learnedReservation`. *(Self-inflicted in 0.7.0.)*

### TK-Q07 — Primitive surface inconsistency · Medium · 🟡 Trade-off
`fairShare`/`weightedFairShare`/`tokenBudget`/`sketchRateLimit`/`MultiLimiter` diverge from `Limiter`:
`reset()` returns `void` not `Promise<void>`; `tokenBudget` uses `debit`; no `checkMany`; no `strategy`
field — so none flow into the adapters. **Action:** make every primitive's `reset()` return
`Promise<void>` (resolve sync) for one signature; document `debit` as an intentional exception; consider
an `asLimiter()`/single-key sub-interface. Partly justified divergence — do the cheap uniformity first.

### TK-Q08 — Export-map gaps + `otel`↔`observability` mismatch · Medium · 🟡 Trade-off
Many features ship only from the root barrel (no `throttlekit/admission`, `/twotier`, `/sketch`, …); the
`./otel` entry maps to `src/observability/`. **Action:** pick a convention (root-only for non-peer-dep
modules, dedicated entries for adapters/stores/otel) and **document** it; rename the entry or dir so name
== path. Low urgency (treeshaking + `sideEffects:false` mean little consumer impact today).

### TK-Q09 — Verified acceptable · Info · ⚪ No action
Ad-hoc Lua decoders differ by reply shape (`CQ-06`); indexed-access `as`/`!` casts are forced by
`noUncheckedIndexedAccess` (`CQ-07`); `as Strategy<unknown>` is required by the deliberately-non-generic
`Limiter` (`CQ-08`); the one `@deprecated` alias is a harmless shim (`CQ-12`); `MemoryStore.close` hand
reset is theoretical (`CQ-13`); **JSDoc coverage is a documented strength** (`CQ-14`).

## Integration / reach (roadmap)

### TK-I01 — Edge-native stores · High · ✅ In progress
**`DurableObjectStore` shipped** (`throttlekit/cloudflare`, commit after this audit) — the correct atomic
Cloudflare backend. Remaining, in priority order: **Cloudflare D1** (OCC/version-CAS, like the Redis OCC
fallback — strongly consistent, documented contention), **DynamoDB** (conditional writes → exact),
**Deno KV** (`kv.atomic()` → exact). **Workers KV / Vercel KV** are eventually-consistent with no CAS →
only ever an *approximate* limiter; do not present them as exact `Store`s (gate behind `approximate:true`
+ a separate conformance profile, or omit).

### TK-I02 — Distributed `tokenBudget` · High · ✅ Roadmap
The LLM meter is single-instance (documented at `admission/index.ts:679`). Build `distributedTokenBudget`
backing `served` with an atomic shared counter via `Store.apply` (a windowed stop-at-boundary
debit), reusing the leased-budget machinery; with windowCoupled leasing the overshoot stays bounded
independent of fleet size (the proven GALE property). Strongly-consistent backend only (Redis/DO/DynamoDB).

### TK-I03 — More adapters · Medium · ✅ Roadmap
`createGate`/`nodeClientIp`/`edgeClientIp` make each adapter ~50 lines. Highest value: **NestJS**
(guard/interceptor), **AWS Lambda / API Gateway** (event → `requestContext…sourceIp`, neither Node-socket
nor edge-`fetch`). Then **tRPC**, **SvelteKit**, **Remix**, **Elysia**.

### TK-I04 — gRPC / transport-agnostic enforce · Low · 🟡 Roadmap
Add a transport-agnostic `enforce(limiter, key, cost?)` returning the `Decision` or throwing
`RateLimitExceededError` (the error type already exists, unused), plus a gRPC interceptor mapping denials
to `RESOURCE_EXHAUSTED`.

---

## Remediation plan

Ordered to land low-risk cleanups first, then correctness/security, then performance, each as its own
gated commit. Roadmap items (TK-I*) are tracked separately as features.

**Batch 1 — cleanup & dedup (low risk):** TK-Q01 `requireCost`, TK-Q02 `prefixer`, TK-Q03 unified
`clamp`, TK-Q05 delete `DimResult`, TK-Q06 `predictiveReservation` validation. *(TK-Q04 roller after.)*

**Batch 2 — correctness & security hardening:** TK-R01 in-flight lease dedup, TK-R02 `Limiter.close()`
+ `twoTier` timer cleanup, TK-R03 Lua `PEXPIRE` clamps, TK-R04 sketch integer `cost`, TK-S01 edge-IP
trust gate, TK-S03 header sanitize, TK-R07 map-bound docs/options.

**Batch 3 — performance:** TK-P02 single clock read, TK-P04 in-place `WheelEntry`, TK-P03 inline expiry,
TK-P05 single lease record (with Batch 2's twoTier work), TK-P01 unify outcome shape, TK-P06 sliding-window
ring.

**Roadmap (features):** TK-I01 D1/DynamoDB/Deno-KV stores, TK-I02 distributed `tokenBudget`, TK-I03
NestJS/Lambda/tRPC/SvelteKit/Remix/Elysia adapters, TK-I04 gRPC/`enforce`.
