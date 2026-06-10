# 16 · Policy Plans (`throttlekit/policy`)

> *`terraform plan`, but for rate/cost limits.* Replay your own recorded traffic against a **candidate**
> policy set and read the exact, per-policy, per-key allow↔deny decision diff *before* you deploy it.
> Source: `src/policy/`.

## Purpose

Changing a limit is a blind edit: raise `limit` from 100 to 150 and you find out who it lets through (or
who it newly blocks) in production. Policy Plans makes that effect **legible pre-deploy**. Given the policy
you run today (`current`), a policy you're considering (`candidate`), and a corpus of recorded arrivals, it
produces a directional **allow↔deny flip ledger** plus the top movers per policy — the blast radius of the
change, computed off the decision path.

It is built **entirely on `throttlekit/testkit`** (the [Replay](17-replay.md) substrate) and
`throttlekit/config` (`buildStrategy`, `LimiterSpec`) — **no frozen-core change**. The whole surface is
pure and **never throws** on traffic content; preconditions fail loud, but a diff itself only ever returns
an honest state. Marked **experimental** (opt-in; excluded from the 1.x SemVer surface).

## Architecture

`plan(current, candidate, corpus, options?) → Plan` (`src/policy/plan.ts`). For each policy name present in
both sets, over that policy's recorded arrivals:

1. **Cold-record the baseline.** The *current* policy is replayed cold over the recorded arrival timing to
   derive its decisions — this is the baseline, *not* a snapshot of a warm production node (see the honest
   boundary below).
2. **Replay the candidate** over the **same arrivals** via the testkit replayer.
3. **Diff the decision streams** into a `PolicyDiff`: `allowToDeny` (a *tightening* — the blast radius),
   `denyToAllow` (a *loosening*), `flippedTotal`, `divergent` (steps differing on any decision field),
   `affectedKeys`, and `topFlippedKeys` (the `KeyFlip` movers). The `Plan` rolls these into a `PlanSummary`
   with the set-level `added` / `removed` policy names.

Every diff carries an honest `PolicyDiffState` — never a fabricated zero:

| state | meaning |
|---|---|
| `ok` | replayed cleanly; the flip ledger is exact |
| `empty` | no recorded traffic for this policy |
| `truncated` | the corpus was a prefix (a source trace hit its cap); the ledger covers the prefix and **understates** the full effect |
| `not-replayable` | a known non-rate axis (concurrency / escrow / joint-LP) — observe live via binding-axis attribution, never faked |
| `refused` | a replay precondition was violated (carries the machine-readable `ReplayRefusal` reason) |

## Content-addressed artifacts

A `Policy` is one named **leaf** `LimiterSpec` plus the `ReplayFingerprint` needed to rebuild and validate
the exact limiter it describes; a `PolicySet` is a versioned, **content-addressed** bag of them
(`src/policy/artifact.ts`). `contentHash` is a SHA-256 over the canonical (name-sorted, key-sorted)
policies + the unreplayable list, so *"which policy is running"* is a hash and *"did it change"* is a hash
compare. A serialized set carries `POLICY_SET_FORMAT_VERSION` and is **refused on parse** if the version
differs (fail-loud, never silently mis-read). Constructors: `policy` / `policySet`, `policySetFromConfig`
(from a `.throttlekit.yaml`), `serializePolicySet` / `parsePolicySet`.

Non-replayable axes are carried on the set as `UnreplayablePolicy{name, reason}` — listed, never built as a
`Policy` — so a `plan` surfaces them as `not-replayable` rather than silently dropping an axis.

## Corpus adapters

A `PolicyCorpus` maps each policy name to its `Arrival` stream. Two adapters bridge the recorded traffic:

- **`corpusFromRecordings`** — from live [Replay](17-replay.md) `Recording`s (a recorded leaf limiter).
- **`corpusFromTraces`** — from already-serialized replay traces (`arrivalsFromTrace`).

`policyCorpus` / `emptyCorpus` round out the surface for hand-built or no-traffic cases.

## CI gate & rendering

- **`assertPlanAcceptable(plan, budget)`** (`src/policy/gate.ts`) — the *plan-in-CI* gate. A `PlanBudget`
  bounds the blast radius (`maxAllowToDeny`, `maxDenyToAllow`, `maxFlippedTotal`, `maxAffectedKeys`, and
  `requireAllReplayable`); any breach throws `PlanRejectedError` carrying the full machine-readable
  violation list, so a CI step exits non-zero on a too-large change and returns silently when within
  budget.
- **`renderPlan`** — a human-readable summary (`"api: 0 allow→deny, 2 deny→allow over 6…"`);
  **`planToJSON`** — the structured form for tooling.

## Design decisions & rationale

- **Built on testkit, zero frozen-core change.** Plans reuse the deterministic recorder/replayer rather
  than re-deriving any decision math; the core surface is untouched, so the feature ships as an opt-in
  subpath without touching the 1.x guarantee.
- **The baseline is the *current policy cold-replayed*, not warm production.** A cold replay can't
  reconstruct a warm node's exact decisions (its in-flight state, its real wall-clock arrivals), so the
  honest comparison is *current vs candidate, both cold over the same arrival timing* — the diff is
  attributable purely to the policy change. This is stated, not papered over.
- **Honest states over fabricated zeros.** `empty` / `truncated` / `not-replayable` / `refused` are
  first-class outcomes; a plan never reports "0 flips" when the real answer is "couldn't replay this".
- **Content-addressed policy sets** — a policy change is a hash diff, and a stored set is integrity-checked
  and version-gated on parse.

## Honest boundary

Plans diff the **leaf rate and cost** axis **exactly** (those replay bit-for-bit on the determinism
substrate). They do **not** model concurrency, escrow/leasing, or the joint-LP bid-price policy — those are
either non-decisions (a concurrency release isn't a decision) or warm/post-hoc state a cold replay can't
reconstruct, and they surface as `not-replayable` (observe them live via the
[binding-axis attribution](10-observability.md)). The baseline is your *arrival timing*, not a warm
production comparison. A `truncated` corpus understates — it never overstates.

## What proves it

- `test/policy/plan.test.ts` — the flip ledger (allow→deny / deny→allow direction), top movers, the
  per-policy state machine (`ok`/`empty`/`truncated`/`not-replayable`/`refused`), and the never-throws
  contract on adversarial corpora.
- `test/policy/artifact.test.ts` — content-hash stability + the parse-version refusal.
- `test/policy/gate.test.ts` — every `PlanBudget` bound and the `PlanRejectedError` violation list.
- `test/policy/corpus.test.ts`, `render.test.ts`.

## Source map

`src/policy/plan.ts` (the diff engine) · `artifact.ts` (`Policy`/`PolicySet`, content-addressing) ·
`corpus.ts` (the adapters) · `gate.ts` (`assertPlanAcceptable`) · `render.ts` (`renderPlan`/`planToJSON`) ·
`index.ts`. Built on `throttlekit/testkit` ([17](17-replay.md)) + `throttlekit/config` (`buildStrategy`).
