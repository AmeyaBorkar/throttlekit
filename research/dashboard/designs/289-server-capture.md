# #289 Replay P3 — Server opt-in capture + durable redacted encrypted trace store (contract note)

> Status: BUILD note for P3 (the design's **Phase B**). Grounded against the shipped P1 trace seam
> (`src/testkit/replay/*`), the server core (`server/src/{service,config,monitor/hub}.ts`), and
> `src/security/keys.ts`. Locks the architecture + security model + the two user decisions.

## 0. The two locked decisions (2026-06-08)

- **Scope = Full Phase B**: durable encrypted store + TTL sweeper + tenant-scoping + fail-closed audited
  CLI + load test, not a capture-core-only first cut.
- **Replayability = record now, deterministic-mode later**: ship the durable **forensic record** now
  (captures stamped `clock:"system"`, honestly **replay-refused** except the deterministic subset); the
  server-side *deterministic-capture mode* (thread a logical `now` / forbid Redis `TIME` so live captures
  become replayable) is a **documented follow-on**, NOT built in this task.

## 1. The decisive constraint (why this is forensic-first)

Live server decisions run over `Date.now()` + a real store (`service.ts:230`). A trace of them is
`non-manual-clock` (and, with Redis `TIME`, server-clock) — which **P1's guards HARD-refuse as
non-replayable**. So P3 capture is a **durable, redacted, encrypted forensic record**; `replay`/`scorecard`
work only on the deterministic subset and **refuse the rest loudly via P1's existing taxonomy** — no core
change, just honest `clock:"system"` stamping.

The hub already taps **every** decision (`hub.ts:148,167`, `tapDecisions`/`admissionTap` — sync, O(1),
exception-swallowing). Capture hooks the **same tap layer** (control-path-safe by construction); the feared
`onDenial`→`onDecision` widening is unnecessary.

## 2. Architecture — durable `CaptureSegment` (forensic) + `ReplayTrace` projection (replayable subset)

Most server policies are **admitters / meters / fair-escrow**, which P1's leaf-rate `ReplayTrace` does not
model. So the durable format is a **superset**:

```
CaptureSegment (durable, any policy, forensic)
  └─ export/replay of a LEAF-RATE segment ──► P1 ReplayTrace (clock:"system" ⇒ replay refuses, honest)
     non-leaf (admitter/meter/fair) segment ──► forensic JSON only (not replayable; stated plainly)
```

`CaptureSegment` = `{ policy, policyKind, scope(tenant), createdAt, redaction, count, dropped, events[] }`
where each event = `{ keyRef (redacted), cost, at (clock.now()), decision }` — `durationMs` deliberately
absent (wall-clock). A leaf-rate segment additionally carries the `LimiterSpec` + strategy identity so its
projection to a `ReplayTrace` is exact (fingerprint `clock:"system"`).

**Linkage reality (verified):** the server depends on the **published `throttlekit@1.1.0`** (registry, not a
local link), which has the stable surface (`hashKey`/`ThrottleKitError`/`./config` `LimiterSpec`/`Decision`)
but **not** the replay testkit (P1/P2 are committed-unpublished). So the capture module is **self-contained**
— it imports only the published-stable core, defines its own `CaptureClock` enum, and **export emits the
documented `ReplayTrace` JSON *format*** (a versioned `TRACE_FORMAT_VERSION:1` shape) rather than importing
`throttlekit/testkit`. **Replay/scorecard runs downstream** with a testkit-capable core (once P1/P2 ship, just
`throttlekit`); the server records, it does not replay. The CLI's actions are therefore list / export
(/forensic decrypt) — `replay` is a downstream step on the exported JSON, not an in-server call.

## 3. Files (all net-new under `server/src/capture/`, mirroring `monitor/`)

- `types.ts` — `CaptureConfig`, `CaptureScope`, `CaptureSegment`, `CaptureEvent`, `AuditRecord`, `CaptureMeta`
- `config.ts` — parse/validate the top-level `capture:` block (opt-in **default-OFF**; redaction mandatory
  when enabled; encryption mandatory when a durable `dir` is set) → resolved `CaptureConfig`
- `redact.ts` — redaction reusing `hashKey`/`hmacKeyer` (`throttlekit` security helpers — no parallel HMAC);
  whole-segment whitelist (keyRef + `prefix` + string `strategyOptions`); **full digest, never truncated**;
  collision guard (reuse P1's keyref-collision semantics)
- `recorder.ts` — the capture producer: tap → bounded per-`(scope,policy)` ring; **O(1) sync emit**,
  redact-at-capture, drop-with-counter; `maxTrackedScopes` (FIFO) + per-ring depth; never crypto/IO on emit
- `store.ts` — durable **AES-256-GCM** segment store: size-rotated immutable segments under a config `dir`,
  **no plaintext on disk**; TTL sweeper enforced at write (a past-TTL segment is unreadable/auto-deleted)
- `flush.ts` — async, back-pressured flush consumer (drops-with-counter under load; never reaches the
  decision path)
- `audit.ts` — append-only `AuditRecord {principal, tenant, policy, window, action, redactionMode, ts}`
- `cli.ts` — **fail-closed** audited admin tool (`list`/`replay`/`export`): refuses unless an operator
  credential (env secret / mTLS cert) is configured; out-of-band, **not** over the gRPC port
- `index.ts` — barrel; wiring in `server/src/{index,bin}.ts`; `capture:` parsed via `config.ts`

## 4. Security model (locked defaults — design §5/§6)

- **Opt-in, default-OFF** — the documented exception to available-by-default (it records PII). No capture
  without a redaction choice; a loud startup log states capture is ON + mode + retention.
- **Redaction mandatory when enabled.** Default **`hmac`** (server-HMAC, stable cross-incident grouping a
  durable store needs) requiring a configured secret; `per-trace-salt` (privacy-maximal) and `drop`
  available. Reuse `hashKey`/`hmacKeyer`. **Whole-segment whitelist** (not just keyRef): `prefix` and any
  string `strategyOption` are redacted/asserted-clean. **Full digest, never truncated** (a truncated keyRef
  raises collision probability → a collision merges two keys' state → a *wrong* record).
- **Encryption mandatory when durable.** AES-256-GCM envelope per segment (key from config/env ref; KMS-ref
  is a seam). No plaintext-on-disk mode.
- **Bounded retention.** TTL (default 24h) enforced at write; size-rotated segments; `maxTrackedScopes`
  (FIFO) + per-ring depth; overflow drops-with-counter → P1's `truncated`/`dropped` HARD-refuse on the
  projected trace.
- **Tenant scoping, fail-closed.** A config-declared `tenantOf(policy, key)` rule; if **absent ⇒ counts-
  only** (no per-key rows, no durable segments) rather than `__untenanted__`. Replay/export names exactly
  one tenant and hard-fails if selected segments aren't uniformly that tenant.
- **Who-can-trigger — BUILD, don't inherit.** The server has no auth today. The CLI **fails closed** unless
  an explicit operator credential is configured; every enable/flush/replay/export writes an append-only
  audit record; the surface is out-of-band, not the default-insecure gRPC port.
- **Control-path safety (non-negotiable).** Emit is **sync + exception-swallowing + O(1)** (mirror the hub
  taps); flush is async/back-pressured/separately-budgeted and **drops under load with a counter** — a
  capture backlog can never block or break a decision. Bench-gated.

## 5. Honest non-claims (into copy)

- Live captures are **forensic/audit records**; what-if **replay** works only on the leaf-rate deterministic
  subset and is **refused loudly** otherwise (`clock:"system"` ⇒ `non-manual-clock`). Non-leaf
  (admitter/meter/fair) segments are forensic-only, never claimed replayable.
- **Opt-in default-OFF** (the PII exception); **no inherited server auth** — P3 builds a fail-closed audited
  CLI.
- Tenant isolation is only as correct as the operator-supplied `tenantOf` rule (a wrong rule is a
  cross-tenant disclosure, not silent best-effort).
- Engineering copy only (no optimal/learned/predict/regret/bound/proof); no TALE/GALE hints.

## 6. Phased plan (bisectable; each green on `main`)

- **P3.0** — this note + spike: confirm the tap-sees-all seam + `node:crypto` AES-GCM round-trip.
- **P3.1** — `types.ts` + `config.ts` (opt-in default-OFF, mandatory-redaction-when-enabled,
  mandatory-encryption-when-durable, validation) + `redact.ts` (whole-segment whitelist, collision guard).
- **P3.2** — `recorder.ts` (tap → bounded per-scope ring, redact-at-capture, drop-counter, O(1) sync,
  control-path-safe) + the leaf-rate → `ReplayTrace` projection (clock:"system", replay-refused).
- **P3.3** — `store.ts` (AES-256-GCM size-rotated immutable segments, TTL-at-write, no-plaintext) +
  `flush.ts` (back-pressured, drop-counter).
- **P3.4** — `audit.ts` + `cli.ts` (fail-closed operator credential, append-only audit, list/replay/export;
  replay refuses non-replayable forensic segments loudly).
- **P3.5** — server wiring (`index.ts`/`bin.ts`: `--capture` off by default, loud-on log, flush timer off
  the decision path) + load test (distinct-key/scope flood can't OOM; flush back-pressure never reaches a
  decision) + bench gate; `MONITOR_VERSION`/docs.
- **P3.6** — **security-focused** adversarial review (PII leakage, encryption, fail-closed auth, tenant
  isolation, control-path), full backend-gated green + the #286 gate, docs (README + wiki), memory.

**Ask-before-tag** at any release point; **deterministic-capture mode** is the documented follow-on.
