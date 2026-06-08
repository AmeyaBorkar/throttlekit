# #281 Deterministic What-If Replay — Implementation-Ready Design Note

> Status: DESIGN ONLY. No code is written by this document. Anchors are verified against the
> grounding (`research/dashboard/designs/CODEBASE-SURFACE.md`) and spot-read against source.
> Spine: minimal-robust architecture (versioned-Trace contract + exhaustive guard taxonomy +
> verification strategy), with an **identity self-check** promoted into the Engine as a runtime
> precondition. Candidate-comparison ergonomics and the durable/server/PII tier are designed here
> as **deferred, additive** phases that bolt onto the frozen seam.

---

## 1. Thesis

**What it is.** A library-tier testkit harness that records the real `Decision` stream of a running
limiter (opt-in), serializes it with a policy fingerprint into a versioned `Trace`, then **replays**
that trace against a limiter rebuilt under `ManualClock` + a fresh synchronous store. Because every
decision transition is a pure function `(state, now, cost) ↦ {state, Decision}` whose only wall-clock
input is the injected `Clock` (grounding §2; `src/core/types.ts:6-10,49-59`), and because the five
`Decision` fields are integers (`src/core/types.ts:22-33`), a faithfully-rebuilt limiter reproduces
the recorded decisions **bit-for-bit** under the conditions in §3. The harness's value is that it can
*compare a candidate policy against what actually happened* and report exactly which decisions would
have flipped — and refuse, loudly, when it cannot do so soundly.

**The deterministic-replay uniqueness.** The harness does not estimate. It replays the recorded
arrival stream through a candidate and, before attributing any difference to the candidate, **first
replays the trace against its own recorded spec (the identity case)**. Under §3's conditions that
identity replay must be zero-divergence; if it is not, the run is non-deterministic for reasons
outside the candidate delta and the harness sets `selfCheckFailed` and declines to attribute the
candidate diff. This **identity self-check** is what converts "a diff" into a *trustworthy* diff:
every reported flip is provably caused by the candidate, because the harness proved it can reproduce
the past exactly first. Static fingerprint guards (§3) catch *known* hazards at record time; the
self-check catches *harness-construction bugs* and *within-run* drift empirically at use time. The
two are **complementary with disjoint coverage** — neither subsumes the other (see §3.5).

**Honest delta vs sampling / observability replay.** This is not request-sampling (we replay the
*whole* recorded window, not a sample), not a load generator (the arrival pattern is fixed — the
trace we captured), not a concurrency-race reproducer (replay is single-threaded; original async
interleavings are not reconstructed), and **not a proof**. It is bit-exact *only* under §3's
conditions; outside them it refuses to emit a number rather than emit a wrong one. There are no
research claims here (no "optimal/learned/predict/regret/bound/proof"); this is an engineering tool
for regression-testing a config change against recorded traffic.

---

## 2. Goals & non-goals

### v1 goals (library tier only)

- **G1.** Record a single leaf `Limiter`'s `Decision` stream, opt-in, O(1), off the hot path, into a
  bounded ring, with key redaction applied *at capture*.
- **G2.** A versioned, JSON-able `Trace` format + a `ReplayFingerprint` (distinct from the config
  `LimiterSpec`) that observes the replayability envelope from the live limiter+store at record time.
- **G3.** An exhaustive determinism-guard sweep that marks a trace replayable/non-replayable with
  typed HARD/WARN reason codes, and **refuses** rather than guessing.
- **G4.** A `ReplayEngine` that rebuilds the limiter via the shared config `buildStrategy`, drives it
  deterministically (`ManualClock`, fresh `MemoryStore`, sweep off), runs the identity self-check,
  and diffs candidate vs recorded into a `DivergenceReport`.
- **G5.** A one-call CI ergonomic (`assertAcceptable`) keyed on the **decision-flip** headline.
- **G6.** A verification suite that *proves* bit-exactness (round-trip identity, cross-store
  Memory-vs-Redis equivalence over many epochs, guard-refusal, non-consuming-invariant,
  format-version rejection) before any release-readiness claim.

### Deferred, with the reason (designed here as additive phases, not omitted)

- **Candidate-comparison DSL + multi-candidate scorecard** → **Phase C.** A delta DSL that mutates an
  *unproven* baseline produces meaningless diffs; the bit-exact substrate (G1–G6) must land first. The
  DSL consumes the same rebuilder via a modified spec without touching the engine (§7).
- **Server opt-in capture + durable/encrypted/tenant-partitioned trace store + redaction-at-rest +
  TTL sweeper + audited CLI** → **Phase B.** This captures production PII and touches server-internal
  decision plumbing (a once-checked branch widening `onDenial`→`onDecision`, grounding `hub.ts`
  denial-only emission). It is a separate, security-dominated product. v1 makes **zero** server
  changes.
- **TUI trigger / divergence rendering** → **Phase D.** Render-only; no proto/wire (grounding §6).
- **Composite / admitter recording** (the binding-axis-flip ops case) → **deferred, partially
  out-of-domain** (§3.6, §7). The concurrency axis is *structurally* unreplayable from a decision
  trace (§3.3); v1 fails-fast on composites/admitters.
- **Fleet / multi-node** → far-deferred; would touch the frozen wire and needs reauthorization
  (grounding §6; memory DR-14 / #78). Explicitly out of scope.

---

## 3. The deterministic-replay model

### 3.1 The oracle

The replay oracle is: **rebuild the limiter exactly as recorded (same strategy + options, fresh state,
`ManualClock`, synchronous store with the sweep disabled), drive the recorded arrivals in recorded
order at recorded timestamps, and the resulting `Decision`s equal the recorded ones, field-for-field.**
This holds because (grounding §2): the transition is pure in `(state, now, cost)`; `now` is the only
wall-clock input and is supplied by the injected clock; the store is an atomic RMW keyed by the (opaque)
key string; and the `Decision` fields are integers so JS and Lua produce bit-identical values.

### 3.2 Exact conditions for bit-exactness

A trace is bit-exact replayable **iff all** of the following hold (each is recorded as a fact in the
`ReplayFingerprint`, §4.3, and gated in §3.4):

1. **`ManualClock` recording.** A `systemClock` trace is non-reproducible (grounding §2 cond.1).
2. **No server-clock substitution.** Redis Lua may use `redis.call('TIME')` / `now=0` / `LUA_NOW`
   preamble (`src/core/types.ts:102-119`); the recorded `at` is then *not the decision time*. Such a
   trace is non-replayable regardless of `luaSha1` (grounding §2 cond.2; §3.4 HARD).
3. **No uninjected randomness.** Only `adaptiveThrottle` carries `random?: () => number` default
   `Math.random` (grounding §2 cond.3). Three-way severity in §3.4.
4. **Single-threaded synchronous tape/playback.** Concurrent async-store interleavings are not
   reconstructed (grounding §2 cond.4). Replay is single-threaded by construction.
5. **Fresh / reset baseline.** Replay rebuilds from spec into a fresh store; warm state diverges
   (grounding §2 cond.5). Stateful-history strategies need cold-start or `preState` (§3.7).
6. **Stable Map iteration.** `unified.ts:520` (`[...st.buckets.values()]`, verified) and multi
   decision-combining rely on v8 insertion order (grounding §2 cond.6) — not an ES guarantee.
7. **Wall-clock duration excluded.** `DecisionEvent.durationMs` (`tap.ts`) is `performance.now()`/
   wall-clock and must never be recorded (grounding §2 cond.7). Structurally absent from the trace.
8. **Lua script version pinned.** Record `luaSha1`; a script fix diverges old traces (grounding §2
   cond.8).
9. **Composite boundary.** Composites produce synthetic combined decisions; a leaf decision does not
   reproduce a composite (grounding §2 cond.9). v1 records leaf limiters only (§3.6).

**The only fully-deterministic record/replay pairing** is `ManualClock` recording over a synchronous
store, replayed over a synchronous store (grounding §1a last row / §35). Cross-store *replay* (record
Redis client-time → replay Memory) is valid **only** when `serverClock === false` AND `luaSha1`
matches AND the recording passed an explicit client-supplied `now`. This is distinct from the
cross-store *equivalence test* (§9 P0), which validates the implementation and does **not** license
replaying a server-time trace.

### 3.3 The hero case is the canonical UNREPLAYABLE case (must-fix, determinism critique #1)

The "binding axis flipped from rate to concurrency at 14:08" scenario is **structurally unreplayable
from a decision trace** and is hereby retracted as a v1 capability. Verified: the concurrency axis is a
`ConcurrencyGuard` whose state is the live in-flight count, mutated by acquire/**release** pairs.
Releases are request *completions* — they are not decisions, are never emitted by `tapDecisions` or
`admissionTap` (which emit only on admit), and carry no timestamp in any trace. A trace therefore
contains *zero* information to reconstruct the in-flight timeline. Driving only admit decisions through
a rebuilt concurrency guard yields a *fabricated* in-flight count and a **wrong** divergence number,
not a refusal. The identity self-check does **not** catch this: it would mis-track concurrency
identically in both legs and show zero divergence while both are wrong relative to reality (the
self-check cannot detect a *missing input dimension* — releases — that was never in the trace).

**Resolution:** the fingerprint records an `axes` set; any composite including a concurrency axis is
**HARD-non-replayable** (`CONCURRENCY_AXIS_UNREPLAYABLE`). This is a *domain limitation*, not a "needs
more capture" deferral — capturing releases would require a new tap on the guard's release path that
does not exist and is outside the frozen `DecisionEvent`/`AdmissionEvent` shapes. The motivating ops
example for any future phase must be re-scoped to **rate/cost-axis flips only** (pure-function
replayable).

### 3.4 Hazard → guard table (the failure-taxonomy gate)

`assertReplayable(trace): Replayability` runs before any replay. Each grounding §2 hazard maps to
exactly one code. **Any HARD blocker ⇒ the engine refuses to run.** WARN degrades the claim
("advisory, not bit-exact") without blocking.

| # | Hazard (grounding §2) | Guard condition | Code | Severity |
|---|---|---|---|---|
| 1 | systemClock recording | `fp.clock === "manual"` | `WALL_CLOCK_RECORDING` | **HARD** |
| 2 | Redis `TIME`/`now=0` substitution | `fp.serverClock === false` (independent of luaSha1) | `SERVER_CLOCK_SUBSTITUTION` | **HARD** |
| 3a | adaptiveThrottle absent | n/a — no code emitted | — | N/A |
| 3b | adaptiveThrottle present + random **injected/seeded** | recorded `randomInjected === true` | `PRNG_CROSS_ENGINE_DRIFT` | **WARN** |
| 3c | adaptiveThrottle present + random **uninjected** | `randomInjected === false` | `UNINJECTED_RANDOM` | **HARD** |
| 4 | concurrent async-store interleaving | replay forced single-threaded; `store.sync === false` | `ASYNC_STORE_REPLAY` | **WARN** (degraded) |
| 5 | warm baseline | engine rebuilds fresh; stateful-history w/o cold-start or `preState` | `NON_FRESH_BASELINE` | **HARD** |
| 6 | v8 Map-iteration order | `fp.engine.mapIterationAssumed` && composite/warm-up path present | `MAP_ITERATION_ASSUMED` | **WARN** |
| 7 | wall-clock `durationMs` | never captured (structurally absent) | — | N/A by construction |
| 8 | Lua SHA1 drift | rebuilt `luaSha1` === `fp.luaSha1` | `LUA_SCRIPT_MISMATCH` | **HARD** |
| 9 | composite boundary mismatch | `fp.composite === rebuilt composite kind` | `COMPOSITE_BOUNDARY_MISMATCH` | **HARD** |
| — | concurrency axis present | `fp.axes` contains `"concurrency"` | `CONCURRENCY_AXIS_UNREPLAYABLE` | **HARD** |
| — | joint-LP online-learning admitter | `fp.policy === "joint-lp"` && not cold+duals-injected | `ONLINE_LEARNING_UNREPLAYABLE` | **HARD** |
| — | unrebuildable strategy (leakyBucket / non-config) | strategy ∉ the six config strategies | `UNREBUILDABLE_STRATEGY` | **HARD** |
| — | dropped events during capture (any) | `recorder.onDrop` fired (`droppedCount > 0`) | `TRACE_TRUNCATED` | **HARD** |
| — | unknown format version | exact-match on `TRACE_FORMAT_VERSION` | `UNSUPPORTED_FORMAT` | **HARD** |
| — | keyRef collision (distinct raw keys → one ref within trace) | recorder-side collision detect | `KEYREF_COLLISION` | **HARD** |

Notes on three must-fix severities:

- **`TRACE_TRUNCATED` is HARD, whole-trace** (must-fix, determinism #7 / scope #8 / security #5). A
  FIFO drop in the *middle* of a trace removes events whose per-key state effects every later same-key
  event depended on (gcra TAT, token-bucket `{tokens,last}`, slidingWindowLog timestamp array). The
  drop counter is global, not per-key, so the engine cannot bound which keys' tails are corrupted. A
  truncated trace is therefore potentially **wrong** for the tail, not merely partial → refuse the
  whole trace. No soft per-row flag. Re-record with a larger ring (§6).
- **Random three-way** (must-fix, gap + scope #10): absent ⇒ N/A; present+injected ⇒ WARN
  (`PRNG_CROSS_ENGINE_DRIFT`); present+uninjected ⇒ HARD. Additionally, for a **candidate** (non-identity)
  replay over an injected-random adaptive component, a config delta that changes the *number* of random
  draws desyncs the PRNG stream — the identity self-check passes (draw counts match) but the candidate
  diverges and the diff is mis-attributed. v1 therefore **excludes `adaptiveThrottle` from candidate
  what-if entirely**; identity record-and-replay is permissible as a sanity check only. Stated as a
  non-claim (§10).
- **`CONCURRENCY_AXIS_UNREPLAYABLE` / `ONLINE_LEARNING_UNREPLAYABLE`** (must-fix, determinism #1/#9):
  joint-LP admitters learn duals online (`unified.ts:506-538`, verified: warm `st.seen`/`st.buf`,
  Map-order `st.buckets` at `:520`, adopt-iff-strictly-better at `:533-537`) — warm-state +
  path-dependent + Map-order-dependent simultaneously. A fresh-state replay cannot reproduce a
  recording that began mid-learning, and the self-check is blind (it also starts fresh). HARD unless
  cold/frozen with duals injected. Only **marginal**-policy admitters with no concurrency axis and no
  online learning could ever be replay candidates (a Phase-B concern; v1 is leaf-only).

### 3.5 What the identity self-check does and does NOT catch (must-fix, determinism #2)

The self-check replays the trace against its own recorded spec in the **same JS engine, same process,
same Map-insertion-order-from-replay-order**. Its true scope:

- **Catches:** (1) harness-construction bugs (wrong rebuild, wrong ordering, wrong clock wiring);
  (2) any divergence observable **within a single in-JS replay run**.
- **Does NOT catch** (these stay covered by the *static* fingerprint guards + the cross-store
  equivalence test at build time, §9 P0):
  - **Cross-engine (Lua-vs-JS) ULP drift** — no Lua executes in an in-JS MemoryStore replay, so a
    Lua-vs-JS divergence can never surface in the self-check. Covered by the cross-store equivalence
    *test* (the only thing that actually runs Lua, grounding §2 last para).
  - **Replay-order-induced Map iteration drift** — identical in identity and candidate legs, so the
    self-check is blind. Covered by guard #6 (WARN) + the `axes`/`policy` HARD refusals.
  - **Path/warm-state-dependent learning** (joint-LP) — a fresh-baseline self-check reproduces its own
    fresh-state run cleanly. Covered by `ONLINE_LEARNING_UNREPLAYABLE` (HARD).

The self-check is therefore framed as a **runtime refusal precondition**, sitting *after* the static
`assertReplayable` guards, with **disjoint** coverage from them — not "belt and suspenders" on the
same hazards.

### 3.6 Composite / admitter recording (v1 scope)

v1 records a **single leaf `Limiter`** via the `tapDecisions` wrapper (`tap.ts:56`, verified: forwards
`limiter.strategy`, swallows tap exceptions). Composite admitters (`unifiedAdmission`/`twoTier`/`multi`)
produce synthetic combined decisions and must be recorded at the composite boundary (grounding §2
cond.9). v1 **fails-fast** on composites/admitters (no single `Limiter.strategy` to tap → unrecordable;
and the concurrency/joint-LP hazards above). The trace format nonetheless reserves an optional
`lane`/`perAxis` on `RecordedEvent` (§4.2) so the *same* format serves a future composite recorder —
the canonical event shape does not fork. A future composite `LimiterRebuilder` must rebuild a
`unifiedAdmission`/`twoTier`/`multi` from `ServerLimiterSpec` axis blocks, which is strictly more than
config `buildStrategy` does today (Phase B/C).

### 3.7 Stateful-history baseline (must-fix, determinism #15)

`slidingWindowLog` stores the timestamp of every accepted unit (`Strategy<number[]>`); `slidingWindow`
holds bucket counts; `quota` with `resetCadence:"rolling"` *delegates to `slidingWindow`* (verified
`quota.ts:154-162`). A warm recording starting mid-window has pre-existing state a fresh-baseline
replay cannot reconstruct from the trace — decisions diverge until the trailing window rolls past the
unrecorded history. **Resolution:** for these strategies a trace is bit-exact **iff** it begins from a
cold key OR the recorder captured a `preState` snapshot (grounding §5 trace format mentions optional
`preState` — adopt it for these strategies). Otherwise `NON_FRESH_BASELINE` HARD. Do not assume
`reset()`-to-empty reproduces a mid-window recording.

### 3.8 Failure taxonomy (replayable / non-replayable / divergent)

- **Replayable, bit-exact:** all §3.2 conditions hold; identity self-check zero-divergence;
  `mismatches` reflect only the candidate delta. The trustworthy case.
- **Non-replayable:** any HARD blocker (§3.4) — the engine returns `replayable:false` with the blocker
  codes and **no `mismatches` array**. A refusal, not a number.
- **Divergent (self-check failure):** static guards pass but identity replay is non-zero-divergence
  (unmodeled drift or harness bug) — `selfCheckFailed:true`; the engine **declines to attribute** the
  candidate diff. Also a refusal of the *candidate result*, surfaced loudly.

---

## 4. Architecture & API surface

Four layers, each depending only downward, so Phase B (ops capture) and Phase C (DSL) bolt on as
additive producers/consumers of the frozen seam without touching the core.

```
Layer 3  Surface     (DEFERRED) TUI trigger / golden-trace store / what-if DSL / scorecard
Layer 2  Engine      ReplayEngine: identity self-check → drive checkSync deterministically → diff
Layer 1  Contract    Trace format (versioned) + ReplayFingerprint + guard taxonomy
Layer 0  Capture     DecisionRecorder: tapDecisions consumer → canonical RecordedEvent
```

The **seam** is Layer 1's serialized `Trace`. Recorder (L0) and engine (L2) communicate *only* through
it; neither imports the other. All net-new code lands under `src/testkit/replay/`, re-exported from
`src/testkit/index.ts`, reachable via the existing `./testkit` subpath (`package.json:259-268`), marked
`@experimental` (`STABILITY.md:64-83`). It reads/writes only stable types (`Decision`, `Forecast`,
`ManualClock`, config `LimiterSpec`). **No core hot-path code, no wire/proto change** (grounding §6).

### 4.0 The single core change (be precise — must-fix, scope #4/#5)

v1 touches the core package in **exactly one additive way**: `export { buildStrategy }` from
`src/config/index.ts:141` (currently module-private, verified). No signature change, no behavior
change, no hot-path code. This is the single source of truth for rebuild (§4.4). It still requires a
core `npm run lint` + full green suite before any tag (release discipline). Everything else is net-new
under `src/testkit/replay/`. (Fallback if even the export feels like scope: copy the six-arm switch
into the rebuilder with a comment pinning config as source of truth — but the export is preferred.)

### 4.1 `DecisionRecorder` (Layer 0)

```ts
// src/testkit/replay/recorder.ts   @experimental
export type DecisionKind = "checkSync" | "check" | "checkMany" | "checkManySync";

export interface RecordedEvent {
  at: number;             // the injected clock.now() — see capture rule below. NOT Date.now().
  keyRef: string;         // redacted key handle (raw key never enters the ring)
  cost: number;
  decision: Decision;     // the 5 frozen integer fields (src/core/types.ts:22-33)
  kind: DecisionKind;     // batch-boundary discriminant
  lane?: AdmissionLane;   // RESERVED for the future composite recorder (v1 always undefined)
  perAxis?: Partial<Record<UnifiedAxis, Decision>>;  // RESERVED (v1 always undefined)
  // durationMs DELIBERATELY ABSENT — wall-clock, non-replayable (grounding §2 cond.7)
}

export interface RecorderOptions {
  clock: Clock;                          // the SAME instance the limiter reads (must be ManualClock to replay)
  capacity: number;                      // bounded ring; FIFO; default 10_000 (§6)
  redactKey: (key: string) => string;    // MANDATORY — no capture without a redaction choice (§5)
  onDrop?: (lost: number) => void;       // fired on eviction; any drop ⇒ TRACE_TRUNCATED (§3.4)
}

export interface DecisionRecorder {
  limiter: Limiter;        // the WRAPPED limiter you call
  drain(): Trace;          // snapshot { formatVersion, fingerprint, events, redacted, droppedCount, ... }
  clear(): void;
}

export function recordDecisions(limiter: Limiter, opts: RecorderOptions): DecisionRecorder;
```

**Composite-boundary recording rule.** The recorder *is* the `onDecision` callback of
`tapDecisions(limiter, …)` plus a bounded ring. It never invents an emission point and never sits on
the strategy/store path, so it cannot perturb the decisions it records. For v1 it taps a single leaf
`Limiter`; the reserved `lane`/`perAxis` fields keep the format forward-compatible with a Phase-B
composite recorder that taps `admissionTap` at the composite boundary (the recorders are **different
producers of the same `Trace` seam**, grounding §2 cond.9).

**The `at` capture rule (must-fix, determinism #6 — async skew).** `at` must equal the `now` the
*decision* used, not the value at emit time. On the **synchronous** path (`checkSync`/`checkManySync`)
the limiter reads the clock once and the tap emits with no `await` in between (verified `tap.ts`: sync
methods are fully synchronous) — so `clock.now()` read inside the callback equals the decision's `now`.
This is the **supported, bit-exact recording path.** On the **async** path (`check`/`checkMany`) the
tap emits *after* an `await` (verified `tap.ts:78-83`: `await limiter.check(...)` then `emit`), so a
`ManualClock` mutated between the clock read and the microtask that runs `emit` would record a skewed
`at`. v1 therefore **restricts the deterministic recording contract to the synchronous methods +
`ManualClock`**, and the recorder **fails-fast / refuses to record async checks under a `ManualClock`**
(or marks them advisory/non-bit-exact). Do not assert the sync-path invariant for the async path.

**Batch/timestamp grouping rule (must-fix, determinism #13).** `checkMany`/`checkManySync` read the
clock **once** for the whole batch (verified grounding §1a; `limiter.ts` reads once at batch entry) and
emit per-key with `kind` ∈ batch-kinds. The engine reconstructs the **original** batch boundaries from
`kind`, never by synthesizing a batch from coincident timestamps: group only contiguous same-`at` runs
whose recorded `kind` is itself a batch-kind. Independent `checkSync` records that happen to share an
`at` (common — `ManualClock` only moves on `set()`) are replayed as **separate** `checkSync` calls in
recorded order, because that is what happened. The grouping key is `(kind ∈ batch-kinds) AND at AND
contiguous-recording-order`; coincident-`at` single checks are **not** a batch.

**Recorder-side collision guard.** Within the in-memory window, the recorder tracks raw→keyRef; if two
distinct raw keys map to one keyRef, recording **fails** (`KEYREF_COLLISION`) — a collision would merge
two keys' state on replay and silently corrupt both (§5).

### 4.2 The versioned `Trace` format (Layer 1)

```ts
// src/testkit/replay/trace.ts   @experimental
export const TRACE_FORMAT_VERSION = "1" as const;   // monotonic, breaking-only

export interface Trace {
  formatVersion: typeof TRACE_FORMAT_VERSION;
  fingerprint: ReplayFingerprint;     // §4.3 — NOT the config LimiterSpec
  events: RecordedEvent[];            // recording order preserved verbatim
  redacted: boolean;                  // were keys passed through redactKey? (always true in v1)
  redactionMode: "per-trace-salt" | "hmac" | "prefix" | "drop";
  droppedCount: number;               // >0 ⇒ TRACE_TRUNCATED (HARD)
  preState?: Record<string, unknown>; // OPTIONAL per-key snapshot for stateful-history strategies (§3.7)
  recordedAt: number;                 // provenance only — never used in replay logic
}
```

Three format rules: (1) `formatVersion` bumps **only** on a breaking change; the engine *rejects* a
version it does not understand — no best-effort parse (`UNSUPPORTED_FORMAT`). (2) Consumers tolerate
unknown *optional* fields (mirror the "don't `zod.strict()` a `Decision`" rule, `types.ts:18-20`).
(3) `Decision` serializes as its five integers exactly, so the serialized form is canonical across
stores. Events are stored in recording order; replay order is derived from `at`+`kind`, never array
position alone. A `redacted:boolean` + `redactionMode` stamp lets the Phase-B grouping decision land
later without a breaking format bump (§5, §12).

### 4.3 `ReplayFingerprint` — distinct from config `LimiterSpec` (must-fix, gap + scope #3)

The config `LimiterSpec` (`src/config/index.ts:46-75`, verified) is a public, SemVer-stable type
carrying **only** strategy + policy fields (limit/period/burst/capacity/windowMs/buckets/resetCadence/
prefix/…). It has **no** clock/store/random/lua/composite/axes/optionalMethods fields and **cannot
express admitters/composites**. We must **not** reuse the name. The replay fingerprint *composes* the
config spec as a sub-field plus a replayability envelope **observed from the live limiter+store at
record time, never user-authored**:

```ts
// src/testkit/replay/spec.ts   @experimental
export interface ReplayFingerprint {
  spec: import("../../config").LimiterSpec;   // the POLICY slice (reused for what to rebuild)
  strategyName: string;                        // observed limiter.strategy.name (discriminant)
  strategyOptions: Record<string, unknown>;    // full options incl. resetCadence/periodMs/buckets/anchor (§ quota trap)
  clock: "manual" | "system";                  // §3.2 cond.1 — master gate
  serverClock: boolean;                        // §3.2 cond.2 — Lua TIME / now=0 used? (master gate)
  store: { kind: "memory" | "redis" | "postgres" | "dynamodb" | "other"; sync: boolean };
  luaSha1?: string;                            // §3.2 cond.8 — script pin
  randomInjected: boolean | "n/a";            // §3.2 cond.3 — three-way severity
  composite: "leaf" | "twoTier" | "multi" | "unified";   // §3.2 cond.9 — v1 only "leaf"
  axes?: ReadonlyArray<"rate" | "concurrency" | "cost">;  // concurrency ⇒ HARD (§3.3)
  policy?: "marginal" | "joint-lp";            // joint-lp ⇒ HARD unless cold+injected (§3.4)
  optionalMethods: { peek: boolean; forecast: boolean };
  engine: { name: "v8"; mapIterationAssumed: boolean };  // §3.2 cond.6
  tkVersion: string;                           // for cross-version diffing
}

export function fingerprint(limiter: Limiter, store: Store): ReplayFingerprint;

export type Replayability =
  | { replayable: true; warnings: ReplayWarning[] }
  | { replayable: false; blockers: ReplayBlocker[]; warnings: ReplayWarning[] };

export function assertReplayable(trace: Trace, candidate?: import("../../config").LimiterSpec): Replayability;
```

`strategyOptions` carries the **full** options including `resetCadence`/`periodMs`/`buckets`/`anchor`,
because `strategy.name` is **not** a sufficient discriminant: `quota({resetCadence:"rolling"})` reports
`name:"quota"` but its state and math are `slidingWindow`'s (verified `quota.ts:154-162`). Rebuild must
go through config `buildStrategy` so the rolling→slidingWindow relabel is reproduced identically
(§4.4).

### 4.4 `LimiterRebuilder` — six config strategies, single source of truth (must-fix: seven-vs-six)

**Correction of the grounding §5 line-119 error.** The config `ConfigStrategy` union and
`buildStrategy` switch cover **SIX** strategies (verified `src/config/index.ts:37-43,150-197`): `gcra`,
`tokenBucket`, `fixedWindow`, `slidingWindow`, `slidingWindowLog`, `quota`. `leakyBucket` is **not** in
the union and **not** in the switch. Moreover `leakyBucket` is a `Shaper` (`reserve`/`reserveSync`/
`schedule` → `Reservation`, verified `leaky-bucket.ts:50-60`), **not** a `Strategy`, and produces **no
`Decision`** — so it has no `DecisionEvent` to tap and is architecturally outside the replay domain.

**Resolution:** the rebuilder **delegates to the shared config `buildStrategy`** (the §4.0 export) — a
single source of truth, no hand-rolled name→factory table that could drift. Any trace whose strategy is
not one of the six is a HARD `UNREBUILDABLE_STRATEGY` fail-fast (not a silent miss), including any
`leakyBucket`/`Shaper` trace (which in practice never records, since there is no `Decision` to tap). If
`leakyBucket` ever needs replay it is a separate feature with its own `Reservation`-trace format and
must first be made config-expressible (out of scope). All prose says **six**.

```ts
// src/testkit/replay/rebuild.ts   @experimental
export interface RebuildOptions {
  clock: ManualClock;     // replay ALWAYS uses ManualClock (grounding §2 cond.1)
  store: Store;           // MUST be constructed per §4.5
}
// Delegates to config buildStrategy via the new export; throws UNREBUILDABLE_STRATEGY otherwise.
export function rebuildLimiter(spec: import("../../config").LimiterSpec, opts: RebuildOptions): Limiter;
```

### 4.5 Replay store construction invariant (must-fix, determinism #3)

The replay store is **not** "a fresh MemoryStore" — it is, exactly:

```ts
const clock = new ManualClock(/* start = events[0].at - δ */);
const store = new MemoryStore({ clock, sweepIntervalMs: 0 });   // ONE clock instance; sweep OFF
const limiter = rebuildLimiter(spec, { clock, store });          // SAME clock to limiter
```

Verified rationale (`stores/memory.ts:55-75`): `MemoryStore` takes its **own** `clock` (default
`systemClock`) and arms a wall-clock `setInterval` sweep (default `sweepIntervalMs:5000`) that calls
`wheel.advance(clock.now())` at real-time intervals. For determinism: (a) the store's clock **must be
the same `ManualClock` instance** the limiter reads, or TTL expiry/key-drop keys off a different time
base than the decisions; and (b) `sweepIntervalMs` **must be 0**, else a background timer advances the
wheel against `ManualClock.now()` at nondeterministic real-time moments (especially after a
`clock.set()` far forward). Expiry during replay is then purely access-driven (the inline `exp <= now`
check + on-apply `wheel.advance`), which **is** deterministic. This is a **hard construction invariant**
in the Engine, with a verification test asserting store-clock identity === limiter-clock and that no
sweep timer is armed (§9 P0).

### 4.6 `ReplayEngine` + identity self-check (Layer 2)

```ts
// src/testkit/replay/engine.ts   @experimental
export function replay(trace: Trace, candidate?: import("../../config").LimiterSpec): DivergenceReport;

export class ReplayEngine {
  constructor(trace: Trace);
  against(candidate?: import("../../config").LimiterSpec): DivergenceReport;  // omit candidate ⇒ identity
}
```

Engine procedure:

1. **`assertReplayable(trace, candidate)`** — refuse on any HARD blocker (§3.4); return
   `replayable:false` with codes, no `mismatches`.
2. **Identity self-check (the precondition).** Rebuild from `trace.fingerprint.spec` (the *recorded*
   spec), construct the store per §4.5, drive the recorded arrivals, and assert zero divergence vs the
   recorded `Decision`s. If non-zero ⇒ `selfCheckFailed:true`, **decline** to attribute the candidate
   diff (§3.5). This sits *after* the static guards and has disjoint coverage from them.
3. **Candidate replay.** Rebuild from `candidate ?? trace.fingerprint.spec` into a *separate* fresh
   store/clock; drive the same arrivals in deterministic order (§4.1 grouping; `clock.set(at)` per
   step — jump-safe `clock.ts:37`).
4. **Non-consuming replay (reserved).** If a record's `kind` is a peek/forecast (a future trace shape;
   v1 records consuming checks only), replay via `peekSync`/`forecastSync` and enforce the
   non-consuming invariant **at runtime**: capture `strategy.readState` (verified exists,
   `gcra.ts`/`token-bucket.ts`) before/after and assert byte-identity; on mismatch HARD-fail (a rebuild
   bug). `forecast` is **limiter-only** — admitters expose no `Forecast` (grounding §46) — so a
   composite trace rejects any forecast record.
5. **Diff** candidate `Decision` vs recorded, field-by-field → `DivergenceReport`.

### 4.7 `DivergenceReport` + candidate-policy delta

```ts
// src/testkit/replay/divergence.ts   @experimental
export interface FieldDelta {
  field: "allowed" | "limit" | "remaining" | "resetAt" | "retryAfterMs";
  expected: number | boolean; actual: number | boolean;
}
export interface Mismatch { index: number; at: number; keyRef: string; cost: number; deltas: FieldDelta[]; }

export interface DivergenceReport {
  replayable: boolean;
  blockers?: ReplayBlocker[];          // populated when replayable === false (no mismatches then)
  warnings: ReplayWarning[];
  selfCheckFailed: boolean;            // §3.5 — true ⇒ candidate diff NOT attributed
  fingerprint: ReplayFingerprint;
  candidate?: import("../../config").LimiterSpec;
  total: number; matched: number; mismatches: Mismatch[];
  flipped: { allowedToDenied: number; deniedToAllowed: number };  // the EXACT, integer headline
  nonClaims: readonly string[];        // honest disclaimers baked in as data
  // One-call CI ergonomic (graft from A): throws on breach; flips are bit-exact integer comparisons.
  assertAcceptable(policy?: { maxFlips?: number; ignore?: FieldDelta["field"][] }): void;
}
```

The candidate is just **another config `LimiterSpec`** with a field changed (`{ ...spec, limit: 200 }`)
fed to the same rebuilder — no DSL needed for v1. The **decision-flip** headline
(`allowedToDenied`/`deniedToAllowed`) is the primary assertion target: flips are what an embedder gates
a config change on, and they are bit-exact integer comparisons with no float fuzz. Secondary
`remaining`/`resetAt`/`retryAfterMs` deltas are reported but assertable separately. The Phase-C DSL,
scorecard, comparability classes, and approximate metrics layer on top (§7) without touching this
shape.

---

## 5. Security & privacy model

v1 is library-tier and in-process; the heavy PII machinery (durable store, encryption, audit, sweeper)
is **Phase B**. But the invariants below are designed now so Phase B is purely additive.

- **Opt-in, default-OFF — a flagged exception to the "available-by-default/universal" preference.**
  Capture happens only when an embedder explicitly calls `recordDecisions`. The Phase-B *server*
  capture field defaults absent/false. This is the deliberate, documented exception to the user's
  default-on memory preference, justified because it records production PII. There is **no** "universal"
  or auto-enable path. Enabling requires naming a `redactionMode` (no capture without a redaction
  choice). Phase B emits a startup log line stating capture is ON, its mode, and its retention, so an
  accidental enable is loud.
- **Redaction at capture, reusing the shipped primitive (must-fix, security #4).** Redaction runs
  *inside* the recorder before the ring push, so a raw key never enters the trace. Use the existing
  `src/security/keys.ts` `hashKey(raw, secret)` / `hmacKeyer(secret)` (verified: HMAC-SHA-256, full
  64-char hex) as the **single** redaction primitive — do **not** author a parallel HMAC. Per-trace-salt
  mode is a thin wrapper over the same crypto.
- **Redaction ↔ replay-correctness invariant (must-fix, gap #9 / determinism #14 / security #8).**
  Replay is **identity-insensitive**: every strategy keys state purely by the (opaque) key string via
  the store map; the decision math never inspects key *content*. Therefore a consistently-redacted key
  replays bit-identically. The hard invariant: **redaction is replay-safe IFF it is deterministic AND
  collision-free *within the trace* AND applied to every occurrence.** Forbid **truncated** keyRefs for
  replayable traces (a truncated HMAC raises collision probability; a collision merges two keys' state
  and produces a *wrong*, not refused, diff). Use the full digest; derive any short display handle only
  for rendering, never as the replay key. Enforce with the recorder-side `KEYREF_COLLISION` guard
  (§4.1).
- **Per-trace-salt vs server-HMAC — explicit, documented trade.** v1 default is **per-trace-salted
  hash** (privacy-maximal, salt not persisted, no cross-trace correlation). Stable **server-HMAC** (for
  cross-incident key grouping) is **deferred to Phase B**, where durable storage actually needs
  grouping and the operator can accept the cross-trace linkage. The `redactionMode` stamp in the format
  lets this land without a breaking bump.
- **Beyond the key: whitelist the whole serialized trace (must-fix, security #2).** PII leaks through
  more than `keyRef`. v1 records only leaf-limiter `Decision`s (no `value`/`perAxis`), but the
  fingerprint serializes `spec.prefix` and `strategyOptions`, and `prefix` is often a tenant identifier.
  **Resolution:** at record time, redact/hash `prefix` and any string-valued `strategyOption`, or assert
  they contain no tenant identifier (fail capture if an unexpected free-text field appears). Phase-B
  composite recording must additionally treat the admission `value` (per-request token count — a
  per-customer usage profile) as sensitive: `drop`/`bucket`/`keep` modes, default bucketed, never raw
  in a human-readable diff; and `remaining`/`limit` disclose ceiling+consumption, so per-tenant
  breakdown is gated behind the same auth as raw access.
- **Bounded retention.** v1: fixed-capacity ring (caller owns the drained bytes; no implicit durable
  store). Any drop ⇒ `TRACE_TRUNCATED` HARD (§3.4). Phase B: TTL sweeper (net-new, owned work; default
  e.g. 24h) **enforced at write time** (a segment past TTL is unreadable/auto-deleted), immutable
  size-rotated segments.
- **Tenant scoping — config-asserted, fail-closed (must-fix, security #6).** v1: one recorder per
  limiter, so a trace never mixes tenants. Phase B: there is **no tenant metadata on the Limiter/tap**
  (grounding §3), so tenant derives from a config-declared `tenantOf(policy, keyRef)` rule. If
  `tenantOf` is not configured, capture **drops to counts only** (no per-key rows, no durable segments)
  rather than recording everything under `__untenanted__`. `__untenanted__` data is excluded from every
  multi-tenant surface **and** from cross-tenant aggregation. The replay/export call must name exactly
  one tenant scope and hard-fail if selected segments are not uniformly that tenant. State plainly:
  tenant isolation is only as correct as the operator-supplied rule — a wrong rule is a cross-tenant
  disclosure, not a silent best-effort grouping.
- **At-rest (Phase B).** Mandatory-when-durable AES-GCM envelope encryption, key from config/KMS ref;
  no plaintext-on-disk mode. Closes the grounding §3 "encrypt traces at rest" gap (which v1's
  library-only treatment leaves to the caller).
- **Who-can-trigger — no inherited auth exists (must-fix, security #1).** There is **no** server auth,
  RBAC, or audit primitive today (gRPC defaults to `createInsecure()`; no authorization layer in
  `server/src`). v1 has no trigger surface (it is a library call in the embedder's own test/script).
  **Phase B must build, not inherit:** durable capture and the replay/export CLI **fail closed** unless
  an explicit operator credential (env secret or mTLS client cert) is configured; every
  enable/flush/replay/export writes an append-only audit record `{principal, tenant, policy, window,
  action, redactionMode, ts}`; and the surface is an out-of-band, locally-authenticated admin tool —
  **not** reachable over the default-insecure gRPC port. Drop every claim of inherited operator auth.
- **Confidently-wrong-replay is an operational-safety stake (must-fix, security #9).** A divergence
  report is decision support an operator acts on (e.g. shipping `limit=200` to prod). Any unsound
  replay must **refuse** (§3.4), never emit a number — a confidently-wrong diff is a self-inflicted
  outage. This is the framing reason the HARD `serverClock`/`luaSha1`/truncation refusals are
  non-negotiable.

---

## 6. Scalability

- **Bounded capture buffer.** Fixed-capacity FIFO ring; **default capacity 10,000 events** per recorder
  (library tier). Capture is O(1) per decision (redact key, build `RecordedEvent`, ring-push) — no I/O,
  no crypto-on-the-hot-path beyond the single HMAC the redactor already does.
- **Per-event serialized cost.** A `RecordedEvent` ≈ `at` + `cost` + the 5 integer `Decision` fields +
  `keyRef` (64-hex or salted hash) + `kind` ≈ a bounded, small byte budget (order ~120–160 bytes
  serialized). A 10k-event trace is a few hundred KB.
- **Trace-size budget (must-fix, gap #10 / scope #8).** Because truncation is HARD-fatal (§3.4), the
  default capacity is chosen so realistic windows do not overflow; overflow **refuses the trace** rather
  than silently truncating. Golden-trace fixtures checked into a repo are keyed `{policyName, dateRange}`
  (grounding §5) and capped (e.g. ≤ a few hundred KB each); redaction is **mandatory** for any committed
  fixture (a test asserts committed fixtures are redacted), so a repo trace can never be a raw-PII audit
  trail.
- **Replay cost.** O(events) single pass per candidate. Batch-grouping by `at`+`kind` keeps replay
  proportional to distinct batches, not raw count.
- **Many-candidate fan-out (Phase C).** Replays are embarrassingly parallel — each candidate forks
  independent limiter state over the read-only shared trace. Phase C caps total candidates and may run a
  worker pool; streaming O(1) score reducers (§7) keep per-candidate memory bounded.
- **Phase-B scope/ring bounds.** Phase B caps **both** dimensions: per-ring depth **and** total tracked
  scopes (`maxTrackedScopes`, FIFO scope eviction); refuses an `__untenanted__` ring unless explicitly
  enabled (else a single counter); keeps `emit` O(1) and never does crypto/I/O on the emit path (flush
  is an async, back-pressured, separately-budgeted consumer that drops-with-counter under load); makes
  100%-capture an explicit choice with a sampling/rate-cap option; and is load-tested so a
  distinct-key/distinct-scope flood cannot OOM the server.

---

## 7. Flexibility & adaptability

- **Strategy coverage.** Rebuild delegates to config `buildStrategy` (§4.4) — all **six** config
  strategies. A new strategy added there is picked up by replay with **zero** replay-code change
  (single source of truth). New `Decision` fields (the frozen contract grows by optional fields,
  `types.ts:18`) are picked up structurally by `FieldDelta`.
- **Candidate DSL (Phase C, graft from C).** A typed **closed-union `SpecPath`** (the real
  `LimiterSpec` keys plus dotted axis paths) — unknown field = **compile error**, unknown path =
  **fail-fast**, never a silent no-op (maps the grounding silent-drop hazard to an explicit failure).
  `set`/`scale`/`swap` delta algebra with documented resolution order (`scale` resolves against the
  *base*, last-write-wins on `set`). The DSL produces a modified `LimiterSpec` consumed by the same
  `LimiterRebuilder` — **no engine change**. It enforces the server's mutual-exclusivity guard
  (`config.ts:198-204`) as an explicit candidate **failure** when a delta would introduce a second axis
  kind block (mapping the server's silent first-match-wins drop to a loud failure).
- **Comparability classes (Phase C, graft from C).** Each candidate is tagged `comparable` /
  `cross-strategy` / `cross-axis`. The scorecard refuses to silently rank `retryAfterMs` distributions
  across structurally different strategies (GCRA smooth pacing vs token-bucket bursty refill).
  **Exact** metrics (decision flips, integer `Decision` fields) are kept strictly separate from
  **approximate** metrics (p99 retry via a seeded sketch, `sketch/index.ts`), so the bit-exact core is
  never contaminated by an approximate column. Streaming O(1) `ScoreReducer` (`{init;observe;finalize}`)
  registered in an array (mirrors the "add a body builder" pattern) lets new metrics compose without a
  hot-path touch.
- **Store/clock variants.** Replay always forces `ManualClock` + sync `MemoryStore` (sweep off, §4.5).
  The cross-store *equivalence test* (§9 P0) validates Memory-vs-Redis bit-identity at build time;
  cross-store *replay* of a server-time trace is refused at runtime (§3.2).
- **Extension seams for later layers.** The serialized `Trace` is the frozen seam: Phase B (server
  ops-capture) emits the **identical** `Trace` via a *different producer* (the `admissionTap`/widened-
  `onDecision` path), and Phase C (DSL/scorecard) produces a *modified `LimiterSpec`* consumed by the
  same rebuilder. Neither touches Layer 2.
- **Future fleet path (deferred).** Any fleet-global aggregation (#283 — cross-node merge) **would touch
  the frozen wire** and must carry its own wire-freeze decision and reauthorization (grounding §6;
  memory DR-14/#78). Out of scope here; the single-node design is composition-ready but makes no fleet
  claim.

---

## 8. Integration surface

- **v1 lands entirely under `src/testkit/replay/`** (files in §4), re-exported from
  `src/testkit/index.ts`, reachable via the existing `./testkit` subpath (`package.json:259-268`),
  `@experimental` (`STABILITY.md:64-83`).
- **The only core change** is the additive `export { buildStrategy }` from `src/config/index.ts:141`
  (§4.0). **v1 makes ZERO changes to `server/`** (no `hub.ts`, `wire.ts`, `config.ts`, `render.ts`) and
  **ZERO changes to the core hot path.**
- **Phase B (deferred) server opt-in capture seams** — stated now so they are not rediscovered later:
  the server capture producer needs a **new gated `emitDecision`/`onDecision` widening** because
  `hub.subscribe`'s `onDenial` fires on **denials only** (verified grounding `hub.ts:149,168`), and a
  what-if that flips denies→allows needs allow events too. Registered as an **exception-isolated hub
  subscriber** (inherits the `hub.ts:131-137` try/catch). This is a once-per-decision branch
  (`if (capture === undefined) return;`) adjacent to (not on) the hot path — it must be benchmarked
  under the control-path-safety guardrail (grounding §6) and gated default-off so the zero-capture path
  pays nothing. It is **server-internal observer plumbing, not a wire change.**
- **Phase D (deferred) TUI trigger** — a keybind that runs the engine and renders the `flipped`/totals
  block via a `*Body(snap, cols): Line[]` builder + `renderFrame` dispatch case (grounding §4a;
  width-clamped, never-throw). A transient results pane suffices; promoting to a full `TabId` is a
  follow-up.
- **The no-wire / no-core-hot-path guardrail.** `wire/throttlekit.proto` is untouched (no replay RPC,
  no divergence message — grounding §6). Nothing in v1 or the deferred phases adds a proto message. The
  core hot path is untouched; capture is always an observer.

---

## 9. Phased plan (bisectable)

Each phase is an ordered sequence of small, independently-green PRs. **Green-gate + ask-before-tag
ritual applies to every release point:** read a real full-suite green run (don't infer from a
backgrounded shell), run core `npm run lint` (whole repo incl. bench/) + sub-package lint, fix flakes
at the root, and **ask for explicit OK before EVERY tag/publish** (one "ship" ≠ standing authorization;
memory).

**P0 — determinism spike (no shipping surface).** Prove the substrate before building on it.
- PR0.1: cross-store **Memory-vs-Redis equivalence** harness (gated, **port 6380** per memory) — rebuild
  the same spec on `MemoryStore` and a Redis store, drive identical arrivals over **many epochs**, assert
  identical `Decision`s. This is the only thing that exercises Lua and proves the `%.17g` round-trip /
  refill / TAT ULP claim (grounding §2 last para). **This is the load-bearing gate.**
- PR0.2: the §4.5 store-construction invariant test (store-clock identity === limiter-clock; no sweep
  timer armed).
- Verify: both green on `main` before any P1 ships.

**P1 — primitives (library, the v1 deliverable).**
- PR1.1: `trace.ts` (format + version) + serialize/parse + **format-version-rejection** test.
- PR1.2: `spec.ts` `ReplayFingerprint` + `fingerprint()` + `guards.ts` `assertReplayable` +
  **guard-refusal** tests (synthesize bad fingerprints — systemClock, serverClock, luaSha1-mismatch,
  truncated, composite-mismatch, concurrency-axis, joint-lp, unrebuildable, keyref-collision — assert
  each refuses; no engine needed).
- PR1.3: `recorder.ts` + **round-trip identity** test on `MemoryStore` (sync path only), incl.
  adversarial timing (backward `set()`, zero-`at` deltas, batch boundaries) and the
  coincident-`at`-not-a-batch grouping test.
- PR1.4: `rebuild.ts` (delegating to `buildStrategy`) + `UNREBUILDABLE_STRATEGY` / leakyBucket-refusal
  test + the quota-rolling-alias rebuild test.
- PR1.5: `engine.ts` + the **identity self-check** + `divergence.ts` + `assertAcceptable` + the
  non-consuming-invariant runtime check; the **cross-store equivalence test (P0) is re-run as the final
  gate.**
- Verify: full green + lint; then **ask before tagging.** v1 release = library-only replay-against-
  recorded-spec with the self-check precondition + single-field candidate.

**P2 — candidate compare (DSL + scorecard, graft from C).** `SpecPath` closed union, `set/scale/swap`,
comparability classes, exact-vs-approximate metric separation, streaming `ScoreReducer`, mutual-
exclusivity-as-failure. Consumes P1's rebuilder; no engine change. Verify: green + lint; ask before tag.

**P3 — server opt-in capture + redaction (graft from B).** Gated `emitDecision` widening (benchmarked
under control-path-safety), per-(tenant,policy) rings with `maxTrackedScopes`, durable segment store,
mandatory-when-durable AES-GCM, TTL sweeper, fail-closed audited CLI, full whole-trace whitelist
redaction. Verify: green + lint + load test (flood cannot OOM, flush back-pressure never reaches the
decision path); ask before tag.

**P4 — TUI trigger (graft from B/render pattern).** Transient results pane via `*Body` + dispatch.
Render-only. Verify: width-invariance tests; ask before tag.

**Release rule (graft from C, verbatim intent):** nothing in P2/P3/P4 ships until P0's cross-store
determinism test is green on `main`.

---

## 10. Honest non-claims

- This is **live-trace replay against a candidate policy**, **single-threaded** — **not a proof**, not
  a concurrency-race reproducer, not a fleet/multi-node tool.
- It reproduces **one recorded ordering** of a **fixed arrival pattern** under the exact conditions the
  fingerprint records — it is **not** a guarantee under different/heavier load, and not a load
  generator.
- The **concurrency axis is structurally unreplayable** from a decision trace (releases are not
  decisions, §3.3) — refused, not estimated.
- **joint-LP** online-learning admitters are unreplayable unless cold + duals-injected (§3.4) — refused.
- **`adaptiveThrottle` is excluded from candidate what-if** (PRNG draw-count desync, §3.4); identity
  record/replay is permissible as a sanity check only.
- **Cross-store / server-time traces are refused**, not reconstructed (§3.2). The only fully-
  deterministic pairing is `ManualClock` recording over a sync store replayed over a sync store.
- **Six** config-expressible strategies; `leakyBucket` is a `Shaper` outside the `Decision`/replay
  domain and is refused.
- Outside §3.2's conditions the harness **refuses to emit a number** rather than emit a wrong one.
- No "oracle guarantee", "optimal", "learned", "predict", "regret", "bound", or "proof" language in any
  `@experimental` JSDoc, report header, or user-facing copy (the internal boolean `selfCheckFailed` is
  fine; the mechanism is a **refusal precondition**, not a guarantee). No TALE/GALE research hints.

---

## 11. Open questions / decisions the user must make

1. **Phase boundary for v1 release.** Confirm v1 = P1 (library-only, single-field candidate) and that
   the DSL (P2), server capture (P3), and TUI (P4) are separate, separately-OK'd releases.
2. **`buildStrategy` export vs copied switch (§4.0).** Approve exporting `buildStrategy` from
   `src/config` (preferred, single source of truth) — a purely-additive core change requiring a full
   core green run before tag — or prefer the copied-switch fallback.
3. **Redaction mode default.** Confirm v1 default = **per-trace-salted hash** (privacy-maximal, no
   cross-trace grouping), deferring stable server-HMAC grouping to Phase B.
4. **Async-path recording (§4.1).** Confirm v1 restricts the bit-exact recording contract to the
   **synchronous** limiter methods and refuses/down-labels async-check recording.
5. **Should `leakyBucket` ever be replay-able?** That requires first making it config-expressible (a
   separate change). Confirm it stays out of scope.
6. **Golden-trace fixtures in-repo.** Approve committing redacted golden traces under a fixtures dir
   with the size cap + mandatory-redaction test (§6).

---

## 12. Appendix — six-dimension scorecard

| Dimension | How this design satisfies it |
|---|---|
| **Robust** | Fail-loud-never-lie. Exhaustive HARD/WARN guard taxonomy (§3.4) refuses unsound traces before any diff; the identity self-check (§3.5) refuses unmodeled within-run drift at runtime; `TRACE_TRUNCATED`/`SERVER_CLOCK_SUBSTITUTION`/`CONCURRENCY_AXIS`/`ONLINE_LEARNING`/`UNREBUILDABLE` are HARD whole-trace refusals; the replay store invariant (§4.5) removes the one nondeterministic element (background sweep); recorder is O(1), bounded, exception-swallowed, drops loudly. |
| **Carefully-planned** | The versioned `Trace` + `ReplayFingerprint` are a frozen-by-discipline contract; every grounding §2 hazard maps to exactly one coded guard; the seven-vs-six error and the fingerprint/LimiterSpec naming collision are corrected; deferrals (DSL, server PII tier, composite, fleet) are reasoned, not omitted; the P0→P4 plan is bisectable PR-by-PR with a single load-bearing gate (cross-store equivalence). |
| **Scalable** | O(1) bounded capture (default 10k ring, ~120–160 B/event); O(events) single-pass replay; embarrassingly-parallel candidate fan-out with streaming O(1) reducers (Phase C); concrete trace-size + fixture budgets; Phase-B caps both ring depth and scope count with flush back-pressure off the emit path. |
| **Flexible** | Candidate = another `LimiterSpec`; Phase-C closed-union `SpecPath` + set/scale/swap + comparability classes + exact/approximate metric separation; pluggable `redactKey`; reserved `lane`/`perAxis` keep the format composite-ready; rebuild flows through the shared config switch. |
| **Adaptable** | The serialized `Trace` is the extension seam: Phase B emits the identical trace from a different producer; Phase C produces a modified spec for the same rebuilder; Phase D renders the existing report — none touch the engine. New strategies/Decision-fields flow through structurally. Fleet path explicitly deferred (would touch the wire → reauth). |
| **Secure** | Opt-in default-OFF (flagged exception to the default-on preference); redaction-at-capture reusing the shipped `src/security/keys.ts` HMAC; the deterministic+collision-free-within-trace+applied-to-every-occurrence redaction invariant enforced with a `KEYREF_COLLISION` guard and a full-trace whitelist; per-trace-salt default; bounded retention with HARD truncation refusal; fail-closed tenant scoping; Phase-B mandatory at-rest encryption, TTL sweeper, audited fail-closed CLI built (not inherited — no server auth exists today); confidently-wrong-replay framed as an operational-safety stake → refuse, never emit. |

---

### Files (v1, all net-new `@experimental` under `src/testkit/replay/`, plus one additive core export)

- `src/testkit/replay/recorder.ts` — `RecordedEvent`, `RecorderOptions`, `recordDecisions`
- `src/testkit/replay/trace.ts` — `Trace`, `TRACE_FORMAT_VERSION`, serialize/parse
- `src/testkit/replay/spec.ts` — `ReplayFingerprint`, `fingerprint(limiter, store)`
- `src/testkit/replay/guards.ts` — `ReplayBlocker`/`ReplayWarning`, `Replayability`, `assertReplayable`
- `src/testkit/replay/rebuild.ts` — `LimiterRebuilder` (delegates to config `buildStrategy`)
- `src/testkit/replay/engine.ts` — `ReplayEngine`, `replay`, identity self-check
- `src/testkit/replay/divergence.ts` — `DivergenceReport`, `Mismatch`, `FieldDelta`, `assertAcceptable`
- `src/testkit/replay/*.test.ts` — verification suite (incl. gated cross-store on port 6380)
- `src/testkit/index.ts` — re-export the replay surface (auto-exposed via `./testkit`)
- `src/config/index.ts:141` — **additive** `export { buildStrategy }` (the single core change)
