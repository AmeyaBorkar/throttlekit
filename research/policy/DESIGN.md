# Admission Policy Plans — design record

> Status: **DESIGN (pre-build)**, 2026-06-09. Engineering design record for the next
> feature arc after the Replay workstream (`throttlekit@1.3.0` testkit + `throttlekit-server@0.2.0`
> What-If Replay). No code yet — this doc freezes the shapes, the honest boundary, and the
> phased task plan. Build begins only on explicit go-ahead.
>
> Maintainer rule (same as `bigger-bets/PLAN.md`): this is a *living* record — when a
> decision is revisited during the build, edit the row in §7 in place with a one-line
> "Why changed," don't drop a new doc.

---

## 0  The decision, in one line

Ship **Admission Policy Plans**: replay your own *recorded* traffic against a *candidate*
limit policy and get the exact, per-policy, per-key **allow↔deny decision diff** — *before*
you deploy. A `terraform plan` for rate / cost admission, with the binding-axis attribution
the dashboard already speaks.

This is a **synthesis feature**: it turns the two capabilities we already shipped —
deterministic decision **replay** and live binding-axis **attribution** — into a *workflow*
(author → plan → deploy → observe), and gives that workflow a durable, diffable, CI-gateable
artifact: the **Plan**.

It is built **entirely on existing surface** (`throttlekit/config`'s `buildStrategy` +
`throttlekit/testkit`'s recorder/replayer/candidate-DSL + the server's capture export and
shadow). **Zero change to the frozen 1.x core.** It ships as a new `@experimental` core
subpath `throttlekit/policy` plus server CLI/TUI verbs — same shape as how the Replay arc
landed.

---

## 1  The problem

Changing a production limit is a blind, one-way bet. Today the only honest way to learn
whether a new limit is right is to **deploy it and watch** — and the whole industry has
codified that as "best practice" (cloud WAFs ship a *count / log / simulate* mode whose
entire pitch is "turn it on, let real traffic flow, and look at what *would* have happened").
Every one of those modes is **live-forward**: it observes *future* traffic without enforcing,
so you still ship the change-under-test and wait hours-to-days for enough traffic to judge it.

Three sharp consequences:

- **You break real users to find the right number.** A limit set too low silently 429s
  paying tenants; too high and the dependency you were protecting falls over. Even a careful,
  feature-flagged, percentage rollout can ship a limiter bug that rejects legitimate requests
  (this is a documented, real postmortem pattern, not a hypothetical).
- **The cost axis is the worst.** LLM token-budget limiters generally **cannot apply a budget
  retrospectively** — you set it blind and the counter starts from zero, so there is no way to
  ask "what would last week's spend have done against this budget?"
- **No blast-radius number exists at review time.** A rate-limit change lands in a PR with
  *zero* machine-readable signal of who it will lock out. Compare every other infra change,
  which has a `plan`/diff before `apply`.

We are uniquely positioned to fix this because we already record decisions deterministically
and can rebuild any leaf policy bit-exactly from its spec. We can **replay history**, not just
*watch the future*.

---

## 2  The feature

### 2.1 The hero — `plan()`

```
plan(current, candidate, corpus)  →  Plan
```

Given the **current** policy set, a **candidate** policy set (or a single edit), and a
**corpus** of recorded traffic, `plan()` replays the corpus through both and returns a
**Plan**: a serializable artifact with, per policy, the **decision diff** —

- `allowToDeny` / `denyToAllow` flip counts (the headline blast radius),
- the top **keys/tenants** that flip (who is affected),
- the **binding axis** the attribution layer would report for the flipped denials,
- and — crucially — an **honest per-policy state** (`ok` / `empty` / `truncated` /
  `not-replayable` / `refused`) so a policy we *can't* faithfully replay is never silently
  scored as "0 impact."

The Plan is a value, not a side effect: print it as a human summary, emit it as JSON on a PR,
or assert on it in CI.

### 2.2 The artifact — a Policy is versioned and content-addressed

A **Policy** is `{ name, spec: LimiterSpec, fingerprint }` — the `spec` is the existing pure
config, the `fingerprint` is the existing per-limiter `ReplayFingerprint` (strategy identity +
Lua SHA + axis + clock source). A **PolicySet** is `{ label?, policies, contentHash }`.

Because policies are **immutable and content-addressed**, "which policy is running" is a hash,
"did it change" is a hash compare, and "what changed" is a structural diff. This fits the
existing operational model exactly: there is **no hot-reload** — a policy change is a new
process with new config — so a Policy is naturally a frozen, cold-startable artifact. We lean
into that rather than fighting it.

### 2.3 The frame — a lifecycle, not a button

```
author ──▶ plan (diff vs recorded traffic) ──▶ deploy ──▶ observe (live attribution) ──▶ (rollback)
                         │                                          │
                    CI gate on blast radius              binding-axis attribution
                    (assertPlanAcceptable)                  (already shipped)
```

v1 delivers the load-bearing half: **author → plan → the diff artifact → observe** (the
"observe" leg already exists as the binding-axis dashboard + `denies_by_axis`). Canary /
staged rollout and fleet-wide plans are **explicit future** (§6, §9) — the artifact and the
gate are designed so they slot in without rework.

---

## 3  Why this is the right bet

**It fits the locked product direction (Road B): embedded, multi-axis, attributable,
replayable admission-control *library* — not a gateway / distributed service.** Policy Plans
is a library + local-server + artifact feature. It **does not reopen the gRPC wire** (the one
near-irreversible bullet we are deliberately holding). The optional fleet extension aggregates
*plan artifacts*, which are collected/posted, not a new RPC.

**It compounds both live moats instead of opening a third front.** Basic rate limiting is
commoditized and LLM cost burn-down is crowded; the two things no competitor does are (a) live
binding-axis attribution and (b) deterministic decision replay. Policy Plans is the product
that *only those two capabilities together* can build.

**The novelty is real but must be stated precisely** (this is the load-bearing positioning
note). The field is full of *dry-run / shadow / count / log* modes and of *preview
environments* and of *traffic-replay regression tools* — but:

- dry-run/shadow/count/log are all **live-forward** (observe the future, zero use of your
  recorded history → you wait);
- preview environments exercise **synthetic/test** traffic and yield pass/fail, not a
  per-tenant decision diff;
- traffic-replay tools (record/replay HTTP) diff **responses between two service versions**,
  and are **decision-blind**.

The single closest honest analog is **`terraform plan`** — genuine "preview the exact diff
before apply" — but it diffs *declared desired state vs current infra*, and **never touches
traffic**. Our diff is *candidate policy vs your recorded request history*. So the one-line
differentiator, which all copy must lead with, is the **three-part delta over shadow mode**:

> **(1) recorded traffic → zero wait; (2) multi-axis with per-axis binding attribution;
> (3) a deterministic, reproducible, per-tenant diff *artifact*.**

If we don't lead with those three, a skeptic waves it off as "Envoy already has shadow mode."

---

## 4  Scope and the honest boundary  *(the most important section)*

The credibility of a "plan" is exactly the credibility of the claim that the replayed
decisions are faithful. Replay fidelity is the load-bearing wall and is invisible until it
cracks — one "the plan said allow but prod denied" anecdote would undo the whole pitch. So the
boundary is drawn conservatively and stated loudly, reusing the refusal taxonomy we already
ship.

**What a Plan covers (replayable):**
- **Leaf rate limiters** — `gcra` / `tokenBucket` / `fixedWindow` / `slidingWindow` / `quota`,
  synchronous, single key-space.
- **The cost axis *as a leaf limiter*** — a rate-shaped limiter consuming per-call `cost`
  (tokens). The recorder already captures per-step `cost`, so a cost-leaf policy diffs
  naturally. *(P0 spike confirms this end-to-end before we commit.)*

**What a Plan does NOT cover — reported honestly, never scored as zero:**
- **The concurrency axis.** Unreplayable by design — a lease release is not a decision (the
  recorder's axis is `"rate"` only). A concurrency policy in the set renders
  `state: "not-replayable" → observe live via attribution`.
- **Escrow / leased / two-tier / joint-LP / weighted-fair** paths. These carry warm
  cross-process or post-hoc state that a cold replay cannot reconstruct; they map to the
  existing `refused` reasons. The Plan shows the refusal reason, not a fabricated diff.

**The headline non-claim (carry verbatim into UI + docs):** the diff is the candidate spec vs
the **cold deterministic baseline over the recorded arrival timing** — it is **not** a replay
of what a warm / Redis production node actually decided. A warm production store and a cold
replay can legitimately differ at a window edge (the documented cross-store wall-clock race);
the Plan answers "how would this policy have treated this arrival stream from a clean start,"
which is the right question for *choosing a limit* and the only one that is deterministic.

**Other non-claims:** the corpus is a *sample* (bounded; truncation is flagged, never silently
dropped); top-K movers may over-count (upper bounds, never misses a true heavy hitter); this is
**not** HTTP response/regression replay; redacted corpora diff on redacted key refs (the
capture store never retains raw keys).

---

## 5  Architecture

**One pure core engine, three consumption shapes — minimal deps, matching the repo ethos.**

### 5.1 New core subpath: `throttlekit/policy`  (`@experimental`, zero-dep)

Built on `throttlekit/config` (`buildStrategy`, `LimiterSpec`, the constrained YAML/JSON
loader) and `throttlekit/testkit` (recorder, `replay`, `divergence`, candidate DSL,
`scorecard`, `ReplayFingerprint`, the refusal taxonomy). **No frozen-core change**; marked
`@experimental` in `STABILITY.md`, outside the 1.x freeze, exactly like the testkit.

Frozen shapes (the P0 contract — as built; see PP-09 for the corpus-model refinement):

```ts
interface Policy            { name: string; spec: LimiterSpec; fingerprint: ReplayFingerprint }
interface UnreplayablePolicy { name: string; reason: string }     // concurrency / escrow / joint-LP
interface PolicySet         { label?: string; policies: Policy[]; unreplayable?: UnreplayablePolicy[]; contentHash: string }

// A corpus is fundamentally an ARRIVAL STREAM (key, cost, at) grouped by policy — NOT a decision
// trace. The baseline is re-derived by cold-recording `current` over the arrivals (see PP-09).
interface Arrival       { key: string; cost: number; at: number }
interface PolicyCorpus  { arrivals: Arrival[]; truncated: boolean; traces: number }
type TraceCorpus = Readonly<Record<string /*policy*/, PolicyCorpus>>

interface KeyFlip   { key: string; allowToDeny: number; denyToAllow: number; total: number }
interface PolicyDiff {
  policy: string;
  state: "ok" | "empty" | "truncated" | "not-replayable" | "refused";
  allowToDeny: number; denyToAllow: number; flippedTotal: number;
  divergent: number; steps: number; affectedKeys: number;
  topFlippedKeys: KeyFlip[];
  refusal?: { reason: ReplayRefusal | "not-replayable"; message: string };
}
interface Plan {
  current:   { contentHash: string; label?: string };
  candidate: { contentHash: string; label?: string };
  corpus:    { policies: number; steps: number; truncated: boolean };
  diffs: PolicyDiff[];
  summary: { policies: number; replayable: number; allowToDeny: number; denyToAllow: number;
             flippedTotal: number; affectedKeys: number; added: string[]; removed: string[] };
}

function plan(current: PolicySet, candidate: PolicySet, corpus: TraceCorpus): Plan  // pure, never throws
```

`plan()` is a **pure orchestration** over the existing `replay()` / `divergence` machinery: for each
policy present in both sets it **cold-records `current` over the recorded arrivals** to derive the
baseline trace, replays the `candidate` against it, and folds the per-step `divergence` into the
directional flip ledger + top-K movers; every testkit refusal maps to an honest `PolicyDiff.state`. It
mirrors `runWhatIf`'s "never throw, always return a typed state" contract, generalized from one policy to
a whole set. (Per-key lane labels were dropped: a leaf diff is single-axis by construction — the
*multi-axis* story is that a Plan covers every policy, diffing rate/cost and flagging concurrency/escrow
as `not-replayable`, not that one leaf decomposes into axes.)

### 5.2 Corpus adapters — pluggable, reuse all three existing producers

```ts
// core (throttlekit/policy) — manual-clock traces / recordings
corpusFromRecordings(recordings: Record<name, Recording | Recording[]>): TraceCorpus
corpusFromTraces(traces: Record<name, ReplayTrace | ReplayTrace[]>): TraceCorpus
arrivalsFromTrace(trace: ReplayTrace): Arrival[]

// server (P5) — adapters over the server-only producers, built on the core helpers
corpusFromShadow(name, shadow): TraceCorpus               // live shadow (#290/#299) — manual clock
corpusFromCaptureExport(json: string): TraceCorpus        // `capture export` (#289) — see PP-09
```

No new capture mechanism is invented — the durable forensic store (#289) already emits ReplayTrace JSON,
and the shadow (#290/#299) already produces a `clock:"manual"` trace. Because `plan()` only consumes the
**arrivals** and re-derives the baseline cold (PP-09), even the system-clock capture export is usable —
its warm-production decisions are intentionally ignored, only its arrival timing is replayed.

### 5.3 The governance hook — the adaptive lever

```ts
assertPlanAcceptable(plan: Plan, budget: {
  maxAllowToDeny?: number;          // blast-radius ceiling
  maxTenantsLockedOut?: number;     // fully-denied distinct keys
  requireAllReplayable?: boolean;   // fail if any policy is refused/not-replayable
}): void                            // fail-loud, like assertAcceptable / assertWellFormedTrace
```

This is the "plan in CI" loop: a policy change is gated in PR/CI on its *predicted blast
radius*, with a machine-readable Plan JSON as the evidence. This is what makes the feature
**adaptive** — the promote-or-hold decision becomes objective, not a guess.

### 5.4 Server consumption — CLI verbs + TUI

- **CLI:** `throttlekit-server policy plan --current a.yaml --candidate b.yaml --corpus
  capture-export.json` (+ `policy show`, `policy diff`). **Fail-closed and audited**, reusing
  the capture CLI's audit-log discipline. Emits the human summary by default, `--json` for the
  artifact.
- **TUI:** a **Plan** surface (new tab, or generalize the existing single-policy Replay tab to
  a whole-config plan). Pure render reading a `Plan` off the snapshot, same width-invariant
  style as the other panels.

### 5.5 Data flow

```
            ┌─ recordLimiter (library) ──┐
recorded ──▶├─ capture export (#289) ────┤──▶ TraceCorpus ─┐
 traffic    └─ shadow trace (#290/#299) ─┘                 ▼
                                          plan(current, candidate, corpus) ──▶ Plan ──▶ { human summary | JSON | TUI | assertPlanAcceptable }
```

---

## 6  Long-term, flexible, adaptive  *(the platform frame)*

This is deliberately a **platform**, not a point feature, because the artifact is the leverage:

- **Long-term — the Plan is a durable contract.** A serializable, content-addressed,
  structurally-diffable artifact is something you check into git, attach to a PR, archive for
  audit, or feed to the next tool. New axes (memory, egress) and new strategies extend
  `LimiterSpec` and flow into the diff for free; the Plan shape doesn't change.
- **Flexible — three deploy shapes, pluggable corpus, honest degradation.** The same pure
  engine serves the embedded library, the local server, and (future) a fleet; the corpus
  source is an adapter; unreplayable axes degrade to a typed state instead of a crash or a
  lie. The candidate is the existing typed `set/scale/swap` DSL plus whole-policy swap.
- **Adaptive — a feedback loop, not a one-shot.** `plan → assertPlanAcceptable → promote`
  closes a loop: the blast-radius number drives the decision, `scorecard`/`rankByFlips` ranks
  competing candidates, and a CI gate turns "we think this is safe" into "the recorded traffic
  says this flips N requests across M tenants." Canary (apply to a key subset) and rollback
  (the prior content hash is *right there*) are natural next turns of the same loop.

**Future extensions the design must not preclude (and doesn't):**
1. **Fleet plans** — aggregate per-node Plan *artifacts* into a fleet blast-radius (additive
   flip counts; merge top-K via the existing mergeable sketch). Rides the deferred
   Fleet-aggregation track (#283) and, importantly, needs **no wire change** (artifacts, not
   RPCs). Gated behind that track's reauthorization.
2. **Canary / staged rollout** — apply a candidate to a deterministic key subset; the Plan
   already knows per-key flips, so "canary the 5% least-affected tenants first" is a query over
   the artifact.
3. **Continuous plans** — re-plan on a schedule against a rolling capture window to catch
   *traffic* drift (your limit didn't change, but your traffic did).

**Explicit non-goal:** self-tuning / auto-adjusting limits. That touches the deliberately
deferred live-adaptation work on the proven async hot path and is out of scope here; Policy
Plans informs a *human/CI* decision, it does not silently move limits.

---

## 7  Decisions (revisitable)

| ID | Decision | Rationale |
|---|---|---|
| **PP-01** | Ship as a new `@experimental` core subpath `throttlekit/policy` built on `./config` + `./testkit`. **No frozen-core change.** | Same containment as the Replay testkit; keeps it outside the 1.x freeze while the surface settles. |
| **PP-02** | A Policy is **immutable + content-addressed**; "versioning" = content hash + optional human label. No hot-reload. | Fits the existing cold-start model (which is the determinism precondition) instead of adding a config-mutation path on the hot path. |
| **PP-03** | `plan()` is a **pure function**, never throws; every unreplayable/refused policy maps to a **typed honest state**, never a fabricated zero. | Reuses the `runWhatIf` contract; fidelity/honesty is the whole value. |
| **PP-04** | The Plan covers **leaf rate + cost limiters only**; concurrency = `not-replayable`, escrow/leased/joint-LP/WFE = `refused`. | The recorder's axis is `"rate"`; concurrency releases aren't decisions; warm/post-hoc state can't be cold-replayed. Drawing the line conservatively protects the credibility wall. |
| **PP-05** | Corpus is a **pluggable set of `ReplayTrace`s** from the three existing producers (recording / capture export / shadow). No new capture mechanism. | The forensic store (#289) and shadow (#290/#299) already emit replayable traces. |
| **PP-06** | Ship a **CI-gate assertion** + machine-readable Plan JSON from day one. | The artifact-in-CI loop is the adaptive lever and the sharpest differentiator vs live-forward shadow modes. |
| **PP-07** | **Positioning leads with the 3-part delta** over shadow mode (recorded→zero-wait, multi-axis binding attribution, deterministic per-tenant artifact). Closest honest analog named = `terraform plan`; no competitor-by-name matrix in public docs. | The novelty is a *combination*; stated imprecisely it reads as me-too. Public `research/` docs stay vendor-neutral (per the established practice of stripping competitor comparisons from public notes). |
| **PP-08** | Fleet plans + canary + continuous-plan are **future**; fleet rides the deferred #283 track and stays artifact-based (**no wire reopen**). | Road B holds the wire bullet; the artifact design slots these in without rework. |
| **PP-09** | A corpus is an **arrival stream** `(key, cost, at)`, not a decision trace; `plan()` **cold-rederives the baseline** by recording `current` over the arrivals (it never trusts a trace's recorded decisions). *Why changed (P0 spike): `replay()` refuses non-manual clocks, and the #289 capture is `clock:"system"`. Rederiving from arrivals makes the baseline always = current-cold (never stale), works for every source uniformly, and turns the warm-vs-cold caveat (§4) into a structural guarantee rather than a footnote.* | The arrival stream is the only honest, source-agnostic input; the recorded warm decision is never the baseline. |

---

## 8  Phased task plan (bisectable; each phase → one tracked task)

Mirrors the Replay arc's design-first, every-commit-passes-`check` cadence. Linear chain (each
phase assumes the prior phase's types exist).

| Phase | Task | Commit shape | Pass-`check` gate |
|---|---|---|---|
| **P0** | Design note + **contract freeze** + spike | `docs(policy): admission policy plans design + contract` (this doc) **+** a throwaway spike proving (a) a cost-leaf limiter records+replays end-to-end and (b) a `capture export` JSON round-trips into a `TraceCorpus`; commit a contract-test **stub** pinning the Policy/PolicySet/Plan/PolicyDiff shapes | `check` unchanged; stub compiles |
| **P1** | Core `throttlekit/policy` artifact + fingerprint | `feat(policy): Policy/PolicySet content-addressing + serialize/parse` over `buildStrategy` + `ReplayFingerprint`; root + `throttlekit/policy` subpath export; `@experimental` in `STABILITY.md` | new `test/policy/artifact.test.ts`; hash stability + parse round-trip |
| **P2** | The `plan()` engine + `PolicyDiff` (**the hero**) | `feat(policy): plan() pure engine + per-policy flip ledger + top-K movers` folding `replay`/`divergence`/`scorecard`; honest per-axis state | `test/policy/plan.test.ts`: determinism, every honest state, multi-trace corpus |
| **P3** | Corpus adapters | `feat(policy): fromRecordings / fromCaptureExport / fromShadow` | tests against each producer; truncation/redaction flags preserved |
| **P4** | CI gate + renderers | `feat(policy): assertPlanAcceptable + Plan JSON + human summary renderer` (pure) | `test/policy/gate.test.ts`: fail-loud on budget breach; renderer width/shape |
| **P5** | Server `policy plan` CLI | `feat(server): policy plan/show/diff CLI (fail-closed, audited) consuming capture export` | server suite green; audit-log discipline mirrors capture CLI |
| **P6** | TUI Plan surface | `feat(server): TUI Plan tab/keybind — whole-config plan render` (pure render off snapshot) | `render.test.ts` Plan-tab describe; width-invariance |
| **P7** | Docs + examples + release-readiness | `docs(policy): README/wiki page + examples/policy-plan.ts (multi-tenant + LLM-cost) + CHANGELOG`; core minor (adds `throttlekit/policy`) + server minor | full green gate read from a real run; **tag/publish only on explicit OK** |

**Critical path: 8 tasks, two releases** (a core minor adding `throttlekit/policy`
`@experimental`, and a server minor adding the `policy` CLI + Plan tab). The chain is linear
because each phase consumes the prior phase's interfaces; parallelizing would churn the same
files.

---

## 9  What v1 explicitly does NOT do

- **No hot-reload / dynamic reconfiguration** — policies stay cold-startable (PP-02).
- **No concurrency-axis diff** — unreplayable by design; reported `not-replayable` (PP-04).
- **No canary / staged-rollout enforcement** — the app wires rollout; we provide the artifact +
  the per-key flip data that makes a canary decidable (future, §6).
- **No fleet-global plan** — rides the deferred #283 track; stays artifact-based, no wire
  reopen (PP-08).
- **No self-tuning limits** — Policy Plans informs a human/CI decision; it never moves a limit
  (§6 non-goal).
- **No hosted web UI** — human summary (CLI/TUI) + JSON artifact; visualization is downstream.

---

## 10  Definition of done (the release gate)

- `throttlekit/policy` ships `plan`, `Policy`/`PolicySet`/`Plan`/`PolicyDiff`/`TraceCorpus`,
  the three corpus adapters, and `assertPlanAcceptable`; `@experimental` in `STABILITY.md`;
  **zero change to frozen-core exports**.
- `plan()` is pure + never-throws; a property test proves the flip ledger equals the
  `divergence` fold, and every honest state (`ok`/`empty`/`truncated`/`not-replayable`/
  `refused`) is exercised.
- A cost-leaf policy and a multi-trace corpus both produce a correct diff; a concurrency policy
  and an escrow policy both render their honest non-replayable/refused state.
- Server `policy plan` consumes a real `capture export` and prints both the human summary and
  the JSON; the TUI Plan surface renders a whole-config plan width-invariantly.
- README/wiki page leads with the 3-part delta and carries **every** §4 non-claim;
  `examples/policy-plan.ts` shows a multi-tenant and an LLM-cost scenario.
- Full green gate read from a **real** full-suite run (serial backends where relevant); any
  flake fixed at the root.
- CHANGELOG entries for the core minor and the server minor; **release authorized + published
  only on explicit user OK** (one design approval is not publish authorization).
