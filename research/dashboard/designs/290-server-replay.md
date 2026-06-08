# #290 + #299 Server What-If Replay — deterministic in-server capture + TUI divergence pane

> Status: DESIGN. No code is written by this document. Anchors are verified against source read this
> session (`server/src/capture/*`, `server/src/monitor/render.ts`, `src/testkit/replay/*`). This note
> bridges **#299** (deterministic-capture mode — the replayable trace source) and **#290** (Replay P4 —
> the TUI trigger + divergence pane), which are one workstream: the pane is inert without the source.

---

## 1. Thesis

Publishing `throttlekit@1.3.0` (the replay testkit) lets the **server** depend on a registry build that
*contains* `recordLimiter` / `replay` / `candidateField` (exported from `throttlekit/testkit`, confirmed in
the published `./testkit` subpath). For the first time the server can run a what-if in-process.

But the existing **forensic** capture (#289) is *not* replayable: it stamps `clock:"system"` (HARD-refused
by the P1 guards) and registers an intentionally **lossy** `{strategy, limit}` spec. So the value lever is
the **deterministic-capture mode**: a per-leaf-rate-policy **shadow recorder** built from the policy's full
`LimiterSpec` via `recordLimiter`, fed each live decision's `(redactedKey, cost)` as a post-decision O(1)
never-throw tail, advancing the shadow's `ManualClock` to wall-clock at each step. The shadow's trace is a
genuine `clock:"manual"`, full-spec, cold-start `ReplayTrace` → **replayable for real**. The TUI then runs
`replay(trace, { candidate })` for an operator-configured candidate and renders the **decision-flip**
headline.

**Why a shadow, not a tap.** `recordLimiter` does **not** tap an existing limiter — it builds its *own*
cold leaf limiter over `MemoryStore({ sweepIntervalMs: 0 })` + a `ManualClock` it owns and exposes
(`recording.clock`), verified `src/testkit/replay/recorder.ts:63-83`. So the shadow is a parallel,
isolated reconstruction of the arrival stream. It **physically cannot perturb the production decision**
(separate store, separate clock; we record the shadow's decision, never production's), which is the
strongest possible control-path-safety guarantee — stronger than the forensic tap, which at least reads
the live decision.

---

## 2. Goals & non-goals

### Goals
- **G1.** Opt-in, **default-OFF** deterministic capture of leaf-rate policies into replayable traces (PII →
  flagged exception to the default-on preference, same as forensic capture #289).
- **G2.** **Bounded** under a distinct-key / distinct-tenant flood: the shadow stops feeding at `maxSteps`
  (default **50,000**), so its MemoryStore key-cardinality is capped — the load-bearing OOM guard (#299's
  "50k-cap regression test").
- **G3.** Redaction-at-capture reusing the server's existing redactor (`server/src/capture/redact.ts`), so a
  raw key never enters a shadow trace.
- **G4.** A `replay:` config block carrying which policies to shadow + the operator's what-if **candidate**.
- **G5.** A TUI **Replay** tab: shadow status + the configured candidate's live **divergence** (flips,
  totals), with honest empty/refusal/truncation states — never a faked number.
- **G6.** Tests proving: real flips for a fed shadow, honest refusal for a truncated shadow, the 50k flood
  bound, leaf-rate-only gating, and width-invariant rendering.

### Non-goals (deferred / refused, with the reason)
- **Replaying *forensic* (`clock:"system"`) captures** — still HARD-refused; the pane renders the refusal.
- **Non-leaf policies** (admitter / meter / fairEscrow / twoTier / concurrency) — `recordLimiter` rebuilds
  only the **six** config strategies (verified `rebuild.ts` / `guards.ts:isRebuildableStrategy`); everything
  else is gated out, fail-loud (mirrors P1 scope).
- **Interactive candidate entry in the TUI** — the render layer is pure width-clamped segments, not a text
  input. The candidate is **operator-configured** (sound + testable); richer entry is a follow-on.
- **Async-store / cross-store replay of production's *actual* decisions** — impossible and never claimed; see
  §6 non-claims. The shadow is the deterministic baseline, not a mirror of production truth.
- **Fleet / multi-node** — would touch the frozen wire (reauth required, #283). Out of scope.

---

## 3. The shadow soundness model

`replay()`'s `drive()` rebuilds a cold limiter and `clock.set(step.at)` per step (absolute, not a delta) —
verified `engine.ts:41-57`. So a trace replays bit-exactly iff each recorded `at` equals the `now` the
recorded decision used, over a synchronous store from cold. The shadow satisfies this **by construction**:

1. **It IS a `recordLimiter`.** Its decisions are produced by `recording.limiter.checkSync(k, cost)` over the
   testkit's own `MemoryStore({ sweepIntervalMs: 0 })` + `ManualClock`. The trace it emits is the canonical
   replayable trace the engine round-trips (the P1 identity self-check passes by definition).
2. **`at` is faithful.** We do `shadow.clock.set(now())` immediately before `shadow.checkSync(k, cost)`, with
   **no `await` between** (the whole feed is synchronous). `recordLimiter.checkSync` reads `clock.now()` as
   `at` (recorder.ts:122-128), so `at` == the set value == the decision's `now`. JS single-threadedness makes
   `set`+`check` atomic w.r.t. other requests — no interleaving skew.
3. **`clock:"manual"`, honestly.** The shadow's clock is a real `ManualClock`; the fingerprint stamps
   `"manual"` truthfully (recorder.ts:84). Values track wall-clock, but it is genuinely a manual clock, so the
   guard (`fp.clock === "manual"`) accepts it without a lie.
4. **Cold-start.** Each shadow is built fresh from spec; replay rebuilds equally fresh → same cold baseline.
5. **`now()` is clamped non-decreasing** (`at = max(lastAt, now())`) so an NTP backward step can't produce a
   non-monotonic trace; injected as `now: () => number` (default `Date.now`) for deterministic tests.

The what-if is then `replay(trace, { candidate })`: candidate decisions vs the shadow's recorded baseline.
The `flipped` headline (`allowedToDenied` / `deniedToAllowed`) is the integer "how many requests would
change," with no float fuzz.

---

## 4. Bounded memory — the load-bearing guard (#299 G2)

`recordLimiter.checkSync` **always** calls its inner `checkSync` (recorder.ts:122-128); past `maxSteps` the
*trace* stops appending (tail-stop, flagged `truncated`) but the inner **MemoryStore keeps accreting one
entry per distinct key** (sweep is off). A shadow fed a live distinct-key flood would therefore grow
unbounded. **Fix:** the server's shadow wrapper keeps its own fed-count and **stops calling
`shadow.checkSync` once it reaches `maxSteps`** — capping MemoryStore cardinality at ≤ `maxSteps`. Past the
cap the policy's trace is honestly `truncated` (and the what-if for it reports truncation → refusal, never a
silent understate). Default `maxSteps = 50_000`. A 200k-distinct-key flood regression test asserts the
shadow store stays bounded and the trace is flagged truncated.

This is independent of the forensic capture's bounds (ring depth + `maxScopes`); det-capture has its **one**
knob, `maxSteps` per policy, because a shadow is per-policy whole-arrival-stream (no tenant partition — a
leaf limiter is keyed by request key, so one shadow over all keys IS the faithful reconstruction).

---

## 5. Surfaces

### 5.1 Config — a distinct `replay:` block (opt-in, default-OFF)
```yaml
replay:
  enabled: true                 # anything but true ⇒ OFF (the default)
  policies: [api, search]       # leaf-rate policies to shadow; omit ⇒ all leaf-rate
  maxSteps: 50000               # per-policy shadow cap (the OOM bound)
  redaction: { mode: per-trace-salt }   # reuses the capture redactor; default per-trace-salt
  candidate:                    # the operator's what-if, run by the TUI trigger
    policy: api
    set: { limit: 200 }         # P2 candidate DSL (set/scale/swap) or a single field
```
Resolution mirrors `resolveCaptureConfig`: enabled is opt-in; redaction defaults to `per-trace-salt`;
`candidate` is parsed against the P2 `candidate()` DSL and validated (unknown field ⇒ fail-fast). `replay:`
is independent of `capture:` (either, both, or neither).

### 5.2 Files (all server-package; net-new under `server/src/replay/`)
- `shadow.ts` — `createShadow(spec, { redactKey, maxSteps, now })`: wraps `recordLimiter`; `feed(key, cost)`
  (O(1), never-throw, stops at cap); `trace()`; `truncated`. The bounded shadow.
- `config.ts` — `resolveReplayConfig(raw, { env })` → `ReplayConfig` (enabled, policies?, maxSteps, redaction,
  candidate?). Opt-in, candidate parsed via the P2 DSL.
- `wire.ts` — `wireReplay(text, loadOptions)`: build a shadow per selected leaf-rate policy from its **full**
  parsed `LimiterSpec` (from the config loader, not the lossy forensic identity); a service tap that feeds
  shadows post-decision (composes after `captureService`).
- `whatif.ts` — `runWhatIf(shadows, candidate)` → `ReplayDivergenceSnapshot { policy, flippedAllowToDeny,
  flippedDenyToAllow, total, matched, state: "ok"|"empty"|"truncated"|"refused", refusal? }`. Wraps
  `replay(trace, { candidate })`; maps a `ReplayRefusedError` / truncation to an honest `state`, never throws
  up to the UI.
- `index.ts` — barrel.
- `server/src/replay/*.test.ts` — unit + the 50k flood regression.

### 5.3 TUI — the Replay tab (#290 P4)
- `render.ts`: add `"replay"` to `TabId` + `TABS`; a pure `replayBody(snap, cols): Line[]` rendering: a
  header (which policies are shadowed, step counts, `truncated` flags, the configured candidate), and the
  last divergence result as a flip ledger (`a→d N`, `d→a N`, `matched`, `total`) with the honest state
  (`empty` = "drive traffic"; `truncated`/`refused` = the reason). Pure projection over a new optional
  `snap.replay?: ReplayDivergenceSnapshot[]` + shadow status — no wall clock, width-clamped, never-throw
  (the Cost Room body is the template).
- `tui.ts` (imperative shell): a keybind (e.g. `r`) runs `runWhatIf` for the configured candidate and stashes
  the result; the renderer just displays it. `runWhatIf` is synchronous, bounded (≤ maxSteps), and runs in
  the TUI shell off the gRPC path → cannot perturb production.
- `hub.ts`: the snapshot carries shadow status + the latest `runWhatIf` result (optional-absent when
  `replay:` is off, so the tab placeholder shows honestly).
- Bump `MONITOR_VERSION`.

---

## 6. Honest non-claims (carry into copy + JSDoc)
- **The baseline is a deterministic cold-start reconstruction of the arrival stream — NOT production's exact
  decisions.** When production runs over Redis/Postgres or warm state, its real decisions differ from the
  cold Memory shadow. The what-if answers "candidate-spec vs baseline-spec over *this* arrival timing," which
  is the legitimate config-comparison question — not "what production actually did." Stated plainly.
- **Leaf-rate, synchronous, single-node, single-threaded.** Not a concurrency-race reproducer, not a load
  generator, not a fleet tool. Concurrency/admitter/joint-LP axes are refused (P1 taxonomy).
- **Truncation refuses, never understates.** A policy past `maxSteps` reports `truncated` and its what-if is
  a refusal, not a smaller flip count.
- **Forensic (`clock:"system"`) captures stay refused** — the pane renders the refusal, honestly.
- **No research language.** No "optimal/learned/predict/regret/bound/proof"; no TALE/GALE hint. The flip count
  is a mechanism output, framed as "how many decisions would change," never a guarantee.

---

## 7. Phased plan (each independently green; build on `main`; ask before any tag)

- **P0 — design + unblock (this note).** Write this note; bump `server` `throttlekit` `^1.1.0 → ^1.3.0`;
  `npm install`; confirm `recordLimiter`/`replay` import and the full server + core suites stay green.
- **P1 — the bounded shadow.** `shadow.ts` + the **50k-cap flood regression** (200k distinct keys ⇒ store
  bounded, trace `truncated`). Pure unit; no wiring.
- **P2 — config + wiring.** `config.ts` (opt-in `replay:` block, candidate via P2 DSL) + `wire.ts` (shadow
  per leaf-rate policy from the full `LimiterSpec`; post-decision feed tap). Tests: default-off; leaf-rate
  only; full-spec enrichment; redaction reuse.
- **P3 — on-demand what-if.** `whatif.ts` (`replay` → `ReplayDivergenceSnapshot`, honest `state`). Tests:
  real flips for a fed shadow; refusal for a truncated one; identity self-check passes.
- **P4 — TUI Replay tab + trigger.** `render.ts` `replayBody` + `TabId`; `tui.ts` keybind; `hub.ts` snapshot
  field; `MONITOR_VERSION` bump. Width-invariance + render tests.
- **P5 — docs + release-readiness.** README replay section; server `CHANGELOG`; full green gate from a real
  run (core whole-repo lint + server suite); **ask before tag/publish** (likely server `0.2.0`).

## 8. Open decisions (defaulted; revisit on request)
1. **Default posture** — opt-in default-OFF (PII), consistent with #289. *Decided: opt-in.*
2. **Candidate entry** — operator-configured (`replay.candidate`) for v1; interactive entry is a follow-on.
   *Decided: configured.*
3. **Config home** — a distinct top-level `replay:` block (not a `capture:` sub-mode), since it has its own
   bound and produces traces, not durable forensic segments. *Decided: distinct block.*
4. **Trigger key** — `r` (free in the current `q`/`p`/`↑↓`/`1-6`/`Tab` set). *Decided: `r`, confirm in P4.*
