# #288 Replay P2 — Candidate-compare DSL + multi-candidate scorecard (contract note)

> Status: BUILD note for P2 (the design's "Phase C"). Grounded against the shipped P1 surface
> (`src/testkit/replay/*`, commit `917dc08`) and `src/config/index.ts`. Frozen shapes + the two
> recon corrections to the #281 design note + the §11 decisions locked for the build.

## 1. Scope — a pure orchestration layer over P1

P2 adds a typed **candidate delta DSL** (`set`/`scale`/`swap`) that produces candidate `LimiterSpec`s,
and a **multi-candidate scorecard** that drives each candidate through P1's existing `replay()` over the
recorded arrival stream and scores the result. It is the design's deferred **Phase C** (§7), built on the
P1 substrate.

**Load-bearing invariant (carried from P1): P2 adds ZERO core / wire / server / hot-path code.** Every
new file is `@experimental` under `src/testkit/replay/`, re-exported via the existing `./testkit` subpath.
`buildStrategy` is already exported (P1); `replay(trace, { candidate, skipIdentityCheck })` already returns
`replayed: Decision[]` + `divergence`. The scorecard *consumes* `replay()` — it does **not** touch the
engine (the design is explicit: "consumes P1's rebuilder; no engine change").

## 2. Two recon corrections to the #281 design note

1. **The library `LimiterSpec` is flat** (`config/index.ts:46–75`): `strategy` + 12 scalar fields, no axis
   blocks. So the note's "dotted axis paths", the **cross-axis** comparability class, and
   "mutual-exclusivity between axis blocks as a candidate failure" are **server/composite (Phase B)
   concerns, unreachable in library v1**. P2's `SpecPath` closed union is therefore exactly
   `keyof LimiterSpec`; the axis dimension is documented as deferred, not faked.
2. **The repo sketch is a Count-Min *frequency* estimator, not a quantile sketch** (`sketch/index.ts`).
   The note's "p99 retry via a seeded sketch" cannot come from CMS. But replay output is **bounded**
   (≤ `maxSteps`), so v1 computes **exact** p50/p99 over the replayed array. We keep the design's
   **exact-vs-approximate separation** (the structural guard against contaminating the bit-exact core) but
   the **default reducers are exact**; a sketch/streaming reducer is the reserved seam for the unbounded /
   fleet (Phase B) case.

## 3. Frozen shapes

### 3.1 Candidate DSL (`candidate.ts`)
```ts
type SpecPath = keyof LimiterSpec;                 // closed union — unknown field = COMPILE error
type CandidateOp = SetOp | ScaleOp | SwapOp;
function set<K extends keyof LimiterSpec>(path: K, value: LimiterSpec[K]): SetOp;
function scale(path: keyof LimiterSpec, factor: number): ScaleOp;   // numeric base; resolves against BASE
function swap(strategy: ConfigStrategy, fields: Partial<LimiterSpec>): SwapOp;   // cross-strategy
function candidate(name: string, ...ops: CandidateOp[]): Candidate;
type ComparabilityClass = "comparable" | "cross-strategy";          // cross-axis: N/A in library v1
function resolveCandidate(trace, candidate): { spec: LimiterSpec; class: ComparabilityClass };
```

**Delta algebra (fail-loud, no surprise):**
- Ops apply against the **base** = the trace's recorded spec.
- `scale` reads the **base** numeric value (so it never compounds off a prior op); a non-finite/non-numeric
  base or factor ⇒ loud `candidate-invalid`. `scale` does exact multiplication (no silent rounding — round
  via `set` if an integer is needed).
- **At most one op per field.** A second op on a path (incl. two `swap`s, both writing `strategy`) ⇒ loud
  `candidate-invalid` (compounding is ambiguous).
- **Unknown path** (untyped/JS caller slipping past the closed union) ⇒ loud `candidate-invalid`
  (fail-fast, never a silent no-op). The valid path set is compile-checked to cover `keyof LimiterSpec`.
- **Classification is by outcome:** `resolved.strategy !== base.strategy ⇒ "cross-strategy"`, else
  `"comparable"`. `swap` is ergonomic sugar; `set("strategy", …)` classifies identically.

### 3.2 Score reducers (`score.ts`)
```ts
type MetricKind = "exact" | "approx";
type ComparableAcross = "any" | "same-strategy";
interface ScoreReducer { id; kind; comparableAcross; reduce(decisions: readonly Decision[]): number; }
const DEFAULT_REDUCERS = [allowRate, allowCount, denyCount, retryP99, remainingP50];
```
- `allowRate`/`allowCount`/`denyCount`: exact, `comparableAcross:"any"` (a yes/no admit decision is
  comparable across any strategy).
- `retryP99` (retryAfterMs) / `remainingP50` (remaining): exact, `comparableAcross:"same-strategy"` —
  these fields' *semantics* differ across strategies (GCRA smooth pacing vs fixed-window time-to-edge), so
  they are reported but flagged not-comparable on a cross-strategy row.
- `reduce(array)` is the **bounded** form (v1). The streaming `{init;observe;finalize}` reducer + a
  sketch-backed approximate reducer are the **seam** for unbounded/Phase-B data.
- Exact quantile = nearest-rank over the sorted values.

### 3.3 Scorecard (`scorecard.ts`)
```ts
interface DirectionalFlips { allowedToDenied; deniedToAllowed; total; }   // vs recorded — exact headline
interface ScoreColumn { id; value; kind; comparable; }                    // comparable=false ⇒ not ranked
interface ScorecardRow { name; class; status: "ok"|"refused"; refusal?; spec?; flips?; divergent?; columns; }
interface Scorecard { baseline: { columns }; rows: ScorecardRow[]; }
function scorecard(trace, candidates, opts?): Scorecard;
function rankByFlips(card): ScorecardRow[];        // ok rows, most behavioural change first
```

**Procedure:**
1. **Identity self-check ONCE** up front (`replay(trace)` → throws `identity-divergence` on a broken
   substrate). The whole scorecard is refused, not emitted, if the trace can't reproduce itself. This also
   runs P1's `assertReplayableTrace` (truncated / malformed / non-rate ⇒ the scorecard throws — these are
   trace-level, not per-candidate).
2. Per candidate: `resolveCandidate` → `replay(trace, { candidate, skipIdentityCheck: true })`,
   **failure-isolated**: a `ReplayRefusedError` or unbuildable-spec error (e.g. a `swap` missing the new
   strategy's required fields) becomes `status:"refused"` carrying the loud `reason` — **never a silent
   zero-flip row**. One bad candidate does not sink the batch.
3. Reducer columns over `result.replayed`; **non-`any` columns on a cross-strategy row are flagged
   `comparable:false`** (reported, not rankable). Directional flips derived from `divergence.steps`.
4. `baseline` columns computed over the recorded decisions.

## 4. Honest non-claims (carried into copy)
- The scorecard ranks the **exact decision-flip** metric universally; **secondary columns are comparable
  only within a comparability class** — cross-strategy retry/remaining are reported, not ranked.
- A candidate that can't build/replay is a **loud `refused` row**, never a silent zero.
- Library-tier, single-threaded, bounded-trace compare — **not** a proof, load generator, or fleet tool.
  Axis/cross-axis candidates need the deferred composite recorder (Phase B).
- Engineering copy only (no "optimal/learned/predict/regret/bound/proof"); no TALE/GALE hints.

## 5. §11 decisions locked for the build
1. **DSL** = `set`/`scale`/`swap` over `keyof LimiterSpec`; **one op per field** (conflicts are loud).
2. **Metrics** = exact reducers (bounded v1); sketch/streaming reducer deferred as a seam.
3. **One new refusal reason** `candidate-invalid` added to the (experimental) `ReplayRefusal` taxonomy —
   covers a bad delta or an unbuildable candidate spec; `unrebuildable-strategy` (swap → leakyBucket/
   unknown) keeps its existing reason from `rebuildLimiter`.
4. **Release:** lands on `main` `@experimental`, **not published** until an explicit OK (folds into #296 or
   its own lane).

## 6. Files (all net-new `@experimental` under `src/testkit/replay/`, plus the barrel + STABILITY)
- `candidate.ts` — `SpecPath`, `set`/`scale`/`swap`, `candidate`, `resolveCandidate`, `ComparabilityClass`
- `score.ts` — `ScoreReducer`, default exact reducers, exact quantile
- `scorecard.ts` — `scorecard`, `Scorecard`/`ScorecardRow`/`ScoreColumn`/`DirectionalFlips`, `rankByFlips`
- `errors.ts` — **+1** additive `candidate-invalid` reason
- `index.ts` — re-export the P2 surface; `STABILITY.md` — extend the replay bullet
- `test/testkit/replay/replay-p2.test.ts` — DSL algebra + reducers + scorecard (hand-verified)

## 7. Build phase + adversarial review (2026-06-08)

Built green: 22 P2 tests + 63 across P1+guards+invariant+P2 (no regression); `tsc` clean; whole-repo
`biome check .` clean. **Zero core/wire/server/hot-path change confirmed** by review (the P2 files import
only `LimiterSpec`/`ConfigStrategy`/`Decision` *types* + sibling modules; `buildStrategy` is reached
transitively via `engine → rebuild`).

Two independent read-only reviewers (the P1 "same rigor" pattern) — one hunting the silent-misleading-
result class, one verifying DSL semantics against `buildStrategy`'s real required-field checks — found
**no soundness bug**. The P1 archetype (a non-array `steps` faking a zero-divergence PASS) is structurally
closed: `scorecard()` runs `replay(trace)` (→ `assertWellFormedTrace`) before any row is emitted; every
refusal path surfaces as a loud `status:"refused"` row with `flips`/`columns` absent, never a zero
(verified across ~40 adversarial inputs + a 160-case invariant stress test; `directionalFlips.total ===
DivergenceReport.flipped` held in all). Folded refinements:

- **1b (guard):** a `set`/`scale` on `windowMs`/`periodMs` while the spec sets `period` (a duration that
  shadows the ms field in every builder path) is now refused `candidate-invalid` — it would silently not
  apply. Scoped so it never refuses a delta that *would* take effect (only fires when `period` is present).
- **L1 (honesty):** a resolve-time refusal now derives a best-effort `intendedClass` from the ops (a failed
  strategy-swap is labelled `cross-strategy`, not `comparable`).
- **1a / 4a / L2 (docs):** a fractional `scale` result is applied verbatim and replayed faithfully (mirrors
  what `buildStrategy` accepts in prod — not a replay artifact); the comparability unit is the strategy
  *name* (two `quota` cadences compare); `divergent` is field-noise context, `flips` is the headline.
- **L3 (skipped):** speculative reducer-finiteness guard — every Decision field is already validated at
  rebuild (`requirePositive`/`requireInteger`), so non-finite values can't reach a reducer today. Not
  gold-plated.
