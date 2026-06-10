# 17 · Replay (`throttlekit/testkit`)

> Record a leaf limiter's decisions into a deterministic trace, then re-run that trace — to prove it
> reproduces bit-for-bit, or to ask a **what-if** ("what would `limit=5` have decided?") over the exact
> same traffic. Source: `src/testkit/replay/`.

## Purpose

A rate-limit decision is a pure function of `(state, now, cost)`, so a recorded stream of decisions is
*replayable*: rebuild the limiter cold, drive the recorded inputs through it, and you get the same
decisions — unless something diverged, which is itself the signal. Replay turns that into two tools: an
**identity** self-check (proof of deterministic reproducibility) and a **candidate** what-if (how many
admit/deny decisions a policy change would flip). It is the substrate the [Policy Plans](16-policy-plans.md)
arc and the server's What-If Replay are built on. Marked **experimental** (opt-in; excluded from the 1.x
SemVer surface).

## Record → trace → replay

**`recordLimiter(spec, opts?)` → `Recording`** (`src/testkit/replay/recorder.ts`). Returns a recording
limiter: each `checkSync` / `checkManySync` appends a `ReplayStep{key, cost, at, decision}` at the current
`ManualClock` instant. The async `check` / `checkMany` and `reset` are **refused** — recording is
synchronous-only (an async check wouldn't be captured deterministically) and a reset would desync the trace
from replay. A `maxSteps` cap is a **tail-stop**, deliberately *not* a drop-oldest ring: dropping the
oldest steps would lose the cold-start prefix replay needs to rebuild state, so the kept prefix stays
faithful and the trace is flagged `truncated`.

**`ReplayTrace`** (`src/testkit/replay/trace.ts`) is self-contained and JSON-serializable: a
`ReplayFingerprint` (everything needed to rebuild the *exact* leaf limiter — strategy identity + Lua SHA-1
+ prefix), an honest `redacted` / `truncated` / `dropped` disclosure, and the ordered steps. `at` is the
**absolute** epoch-ms; replay `set()`s the clock to it (never an accumulated delta), so coincident instants
(zero delta) and any recorded ordering reproduce faithfully. `serializeTrace` / `parseTrace` carry
`TRACE_FORMAT_VERSION` and refuse a mismatched version on parse.

**`replay(trace, opts?)` → `ReplayResult`** (`src/testkit/replay/engine.ts`). Drives every step through a
freshly-rebuilt **cold** limiter over `MemoryStore({ sweepIntervalMs: 0 })` sharing one `ManualClock`.

- **Identity** (no candidate): rebuild the recorded spec and confirm it reproduces the recording
  bit-for-bit. Any divergence throws (`identity-divergence`) — the determinism substrate is broken.
- **What-if** (a `candidate` spec, e.g. via `candidateField(trace, "limit", 5)`): the divergence of the
  candidate's decisions from the recording is the result. The identity self-check runs **first** (it's the
  trust precondition — it proves any candidate divergence is the candidate's, not a broken substrate);
  `skipIdentityCheck` opts out.

## Candidate-compare layer

Above single-field `candidateField`, a richer comparison API (`candidate.ts`, `scorecard.ts`):

- **Deltas** — `set`(field) / `scale`(field × factor) / `swap`(strategy), resolved against a trace into a
  concrete candidate spec. A `ComparabilityClass` groups candidates that are meaningfully comparable.
- **`scorecard(...)`** — runs many candidates and tabulates them; **`rankByFlips`** orders by how many
  decisions each would flip. Scoring reducers (`allowCount`, `allowRate`, `denyCount`, `quantile`,
  `remainingP50`, `retryP99`) summarize each column.

## Fail-loud: the trust boundary

Replay **never silently returns a misleading "zero divergence"**. A parsed or transmitted trace is
untrusted input, so any precondition violation throws a `ReplayRefusedError` carrying a single,
machine-readable `ReplayRefusal` reason (`src/testkit/replay/errors.ts`). The reasons span the real
hazards: `trace-format-version`, `trace-malformed`, `trace-empty`, `trace-truncated`,
`unrebuildable-strategy` (e.g. `leakyBucket` / a composite), `non-manual-clock` (recorded over a
system/server clock — non-reproducible instants), `lua-sha1-mismatch` / `strategy-mismatch` (build drift or
a tampered/mislabelled trace), `unreplayable-axis` (concurrency — a release is not a decision),
`unreplayable-policy` (joint-LP bid-price), `keyref-collision` (a redaction mapping two keys to one would
merge their state), `identity-divergence`, and `candidate-invalid`. In a scorecard a `candidate-invalid`
surfaces as a loud per-candidate `refused` row, never a silent zero-change. The guards (`assertReplayable`,
`assertReplayableTrace`, `isRebuildableStrategy`) and `assertWellFormedTrace` enforce this structurally.

## The determinism substrate

Replay is only meaningful if the rebuild is bit-exact. The substrate it stands on is the cross-store
determinism guarantee from the core: a strategy's transition is a pure `(state, now, cost)`, and a limiter
rebuilt over `MemoryStore` sharing one `ManualClock` reproduces a recording exactly — the same behavior the
[wire layer](13-wire-protocol.md) pins as **Memory↔Redis-Lua bit-exactness**. **`buildStrategy`**, exported
from `throttlekit/config`, is the **shared rebuilder** both record and replay use, so the recorded and
replayed limiter are constructed by the identical path.

**Server What-If Replay** ([10](10-observability.md), [14](14-grpc-server.md)) applies the same idea live:
it shadows production traffic through a *cold `ManualClock` copy* of a leaf policy, **bounded at `maxSteps`
(50k)** so the shadow can never grow unbounded, and surfaces the what-if in the Lens **Replay** tab.

## Design decisions & rationale

- **Synchronous, leaf, `ManualClock` only.** These are the conditions under which a decision is
  deterministically reproducible; anything outside them is *refused*, not faked. Async checks, concurrency
  releases, and system-clock instants are not replayable by construction.
- **Absolute instants, never deltas.** `set()`ing the clock to each step's absolute `at` reproduces
  coincident instants and ordering exactly; an accumulated delta would drift.
- **Tail-stop cap, not a ring.** Keeping the cold-start prefix is what makes a truncated trace still a
  *faithful* (if partial) recording; a drop-oldest ring would corrupt the rebuild.
- **Identity check gates every what-if.** Proving the trace replays faithfully first makes any candidate
  divergence attributable to the candidate alone.
- **Untrusted trace ⇒ fail loud.** A transmitted trace is validated structurally; replay refuses a
  malformed/truncated/drifted trace rather than failing open to a misleading zero.

## What proves it

- `test/testkit/replay/engine.test.ts` — identity reproducibility (bit-for-bit) and the what-if flip count.
- `test/testkit/replay/errors.test.ts` — every `ReplayRefusal` reason is raised on its precondition (no
  silent fall-through).
- `test/testkit/replay/{candidate,scorecard,recorder,trace}.test.ts` — the delta ops, scorecard ranking,
  the recorder's refusals + tail-stop, and the parse/serialize version gate.
- The Memory↔Redis-Lua determinism the substrate rests on is pinned by the core's dual-path tests
  ([01](01-core-model.md), [13](13-wire-protocol.md)).

## Source map

`src/testkit/replay/recorder.ts` (record) · `trace.ts` (the trace + version gate) · `engine.ts`
(`replay`/`candidateField`) · `candidate.ts`, `score.ts`, `scorecard.ts` (the compare layer) ·
`divergence.ts` (the diff) · `errors.ts` (the refusal taxonomy) · `guards.ts`, `rebuild.ts`, `spec.ts` ·
`index.ts`. Shared rebuilder: `buildStrategy` from `throttlekit/config`. Consumed by
[Policy Plans](16-policy-plans.md) and the server's What-If Replay ([14](14-grpc-server.md)).
