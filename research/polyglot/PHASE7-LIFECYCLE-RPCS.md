# Phase 7 — Completing the polyglot surface: the stateful axes over the wire

Status: **SPEC / proposal.** Nothing here is built. Gated on explicit go-ahead per axis.
Companion to `DESIGN.md` (the polyglot arc), `PHASE2-SERVICE.md` (the service door), and
`PHASE4-REDIS-BACKEND.md` (the direct door).

## 0. The problem, in one line

The polyglot client today reaches the **rate-limit** axis fully (`check`/`check_many`/`peek`/
`forecast` over gRPC; `check` over direct Redis). The **advanced GALE/TALE axes — concurrency
admission, two-tier token leasing, and unified (fused) admission — are not on the wire**, so a
Python (or any non-Node) caller cannot reach them. This spec is the additive path that closes that
gap *without* re-deriving any decision client-side (the one-oracle invariant) and *without* touching
the frozen Lua wire (so no DR-78 reauthorization is needed — the `.proto` evolves independently).

## 1. What's reachable today vs. the gap

| Capability | Wire today | After Phase 7 |
|---|---|---|
| `check` / `check_many` / `peek` / `forecast` (rate) | ✅ `Check`/`CheckMany`/`Peek`/`Forecast` | unchanged |
| **Two-tier leased** rate limiting | ❌ | ✅ **config-only**, rides existing `Check` (Door A) |
| **Cost axis** (`tokenBudget` debit, TALE) | ❌ | ✅ additive `Debit` RPC (Door B) |
| **Concurrency** admission (acquire→release) | ❌ | ✅ `Admit`/`Release`/`Heartbeat` (Door C) |
| **Unified** admission (rate × concurrency × cost) | ❌ | ✅ same `Admit` trio, fused decision (Door C) |
| Stores / strategy *math* / framework adapters | ❌ by design | unchanged — client is never a reimplementation |

## 2. The core primitives we are exposing (grounded)

These are the *actual* shapes the wire must carry. We expose them; we do not reinvent them.

### 2a. Concurrency — `src/concurrency/`
- `unifiedAdmission(opts) → UnifiedAdmitter` with `admit()/admitSync()/lastDecisions()`
  (`src/admission/unified.ts:273,161`). Result **`UnifiedAdmission { decision, release(opts?),
  bindingAxis?, policyDenied? }`** (`unified.ts:122`).
- `adaptiveConcurrency(opts) → ConcurrencyGuard`; `guard.acquire() → Lease`
  (`src/concurrency/adaptive.ts:380,73`). **The permit is `Lease = { ok: boolean;
  release(opts?: { dropped?: boolean }): void }`** (`adaptive.ts:57`) — **two fields, no id, no token,
  no deadline.** `release` is an in-process bound closure; **nothing in it is serializable.**
- `distributedAdaptiveConcurrency(opts) → DistributedConcurrencyGuard` (`src/concurrency/distributed.ts:239`)
  adds `heartbeat()`, `close()`, fleet `stats()`; `acquire()` returns the *same* `Lease` shape.
- The fleet authority is the `ConcurrencyCoordinator` (`src/concurrency/coordinator.ts:68`):
  `heartbeat(report) → grant`, `leave()`. Implemented by `RedisConcurrencyCoordinator` /
  `PostgresConcurrencyCoordinator` (state lives in the store, keyed by `{key, nodeId}`, TTL'd).
- **Crash-safety contract** (`research/.../distributed-adaptive-concurrency/HARD-ASYNC-BOUND.md`,
  `DESIGN.md` D-DAC-7/12/19/20/21): lease-by-TTL + heartbeat-renewal + **time-based self-fence**
  (NOT a backend fence token — the budget is a fungible *count*, so there is no discrete handoff to
  order). Defaults: `heartbeatMs = 1000`, `leaseTtlMs = 2·heartbeatMs = 2000`; a crashed holder is
  reclaimed within `leaseTtlMs`; `onCoordinatorOutage` default **fail-closed** (`share = 0`);
  self-fence ON under fail-closed, firing at `leaseExpiresAt − fenceSafetyMargin` on the holder's
  *own* clock. The hard `Σinflight ≤ L` bound (acknowledged handoff, opt-in) needs `seq` + `appliedGen`
  sampled atomically with `inflight`.

**Wire consequence:** because `release` is an unserializable in-process closure, the **server** must
mint an opaque `lease_id`, hold the closure in a server-side table keyed by that id, and map
`Release(lease_id)` back to it. The client↔server lease then needs *its own* TTL + heartbeat —
which we deliberately make **the same contract as node↔coordinator, one layer out** (see §5).

### 2b. Two-tier token leasing — `src/twotier/`
- `twoTier(opts) → Limiter` (`src/twotier/index.ts:163`); `mode: "strict" | "cached-deny" | "leased"`.
- **There is no exposed lease object and no `acquire`/`spend`/`settle` API.** The whole lifecycle is
  internal, behind `Limiter.check(key, cost) → Promise<Decision>`. The held lease is the *non-exported*
  per-key `LeaseEntry` (`index.ts:133`); residual credits are **never returned to L2** — they are
  *forfeited* (window-coupled zeroing / idle drop / reset).
- Safety invariant: global admitted **≤ Limit + L·(batch−1)** (L = node count), or **= Limit** under
  `windowCoupled` (machine-checked, `spec/GaleWindowCoupledLeasing.tla`) — robust to *any* forfeiture
  timing.

**Wire consequence:** two-tier needs **no lifecycle RPC**. A server policy configured as
`twoTier({mode:"leased"})` already answers the existing `Check` RPC; the server *is* one node holding
L1 credits on behalf of all its clients, leasing batches from shared L2 (Redis). The only gap is
**config** — the YAML loader (`src/config/index.ts`, `buildStrategy`) is rate-limit-strategy-only.

### 2c. Cost axis — `tokenBudget` (TALE)
- `tokenBudget(...).debitSync(tokens) → Decision`; the golden-vector generator *already* has a
  `TokenBudgetSuite` primitive (`wire/vectors/vectors.ts`), but no `Debit` RPC exposes it. Additive,
  largely stateless (budget meter in the store). `learnedReservation`/`predictiveReservation`
  (`src/admission/index.ts:883`) are the cost-axis sizers — out of scope for the wire surface itself
  (they tune the meter, like adaptive lease sizing tunes two-tier).

## 3. Design principles (carried-over invariants)

1. **One oracle.** Exactly one thing computes a `Decision`. The client transports; it never derives.
2. **The direct Redis door stays single-shot `check`-only.** Two-tier (holds L1 credits) and
   concurrency (holds slots + needs the coordinator + the adaptive law) would each require client-side
   state/logic → re-derivation. So **everything stateful is service-door-only**, exactly as `peek`/
   `forecast` already are. The RedisBackend is unchanged by this phase.
3. **Additive proto only.** New RPCs + new messages + new tags; never renumber/retype/reuse
   (`wire/throttlekit.proto:11-15`). Backward-compatible by construction. No Lua-wire freeze touched.
4. **`bindingAxis` lives on the response wrapper, not the `Decision`** — matching the core's 1.0
   decision (D1): `AdmitResponse.binding_axis`, never a `Decision` field.
5. **Client↔server lease = node↔coordinator contract, one layer out.** We reuse the *proven* TTL +
   heartbeat + reclaim-on-crash pattern rather than inventing a new lease protocol.

## 4. The three doors, by difficulty (independent; ship in any order)

### Door A — Two-tier leased, via config (NO wire change). Lowest risk.
- **Core/config:** extend `LimiterSpec` + `buildStrategy` (`src/config/index.ts`) so a policy can be a
  `twoTier({ strategy, l2, mode, lease, … })`, not only a bare strategy. The server already builds its
  registry from config (`createRateLimiterServiceFromConfig`, `server/src/service.ts:161`).
- **Service/proto/client:** **unchanged.** `Check` carries it; `ServiceBackend.check` already works.
- **Conformance:** *not* a bit-exact golden vector (L1 lease timing is intentionally
  non-deterministic across processes — that's the point of leasing). Instead an **integration test
  asserting the bound**: N server instances sharing one Redis L2, hammered, observe global admits
  `≤ Limit + N·(batch−1)` (and `= Limit` with `windowCoupled`). This is the right correctness tool
  for leasing and mirrors the core's own two-tier property tests.
- **Outcome:** Python `check("leased-api", key)` gets leased semantics with zero client changes.

### Door B — Cost axis, via an additive `Debit` RPC. Medium.
- **Proto:** `rpc Debit(DebitRequest) returns (DebitResponse)` with
  `DebitRequest { policy, key, tokens }`. Stateless request/response, like `Check`.
- **Service/core:** add `debit(policy, key, tokens)` to `RateLimiterService`; map a policy to a
  `tokenBudget`. Config gains a `tokenBudget` policy kind.
- **Conformance:** the `TokenBudgetSuite` generator already exists — extend the Node-server gRPC
  conformance test and the Py↔Node test to drive `Debit` against those suites.
- **Client:** `ServiceBackend.debit(policy, key, tokens) → Decision`.

### Door C — Concurrency + unified admission, via `Admit`/`Release`/`Heartbeat`. The real work.
This is the headline: the first **stateful** surface on the wire. Detailed in §5.

## 5. Door C in detail

### 5.1 Proto additions (additive)
```proto
// ── Stateful admission lifecycle. Additive: new RPCs + messages. Unary, matching the existing door. ──

// Admit one unit of work against a policy with a concurrency and/or fused axis. Unlike Check
// (single-shot rate/cost), Admit may HOLD an in-flight slot that MUST be returned via Release.
// The returned decision is authoritative; lease_id is non-empty iff a slot is actually held.
message AdmitRequest {
  string policy = 1;
  string key    = 2;
  int64  cost   = 3;   // rate/cost units; 0 ⇒ 1
  int64  hold   = 4;   // 3-axis concurrency term (default 0)
  int64  value  = 5;   // joint-LP bid (default 1)
}
message AdmitResponse {
  Decision decision         = 1;   // combined decision across configured axes
  string   lease_id         = 2;   // opaque, server-minted; "" ⇒ nothing to release
  int64    lease_expires_at = 3;   // epoch-ms; server reclaims (Release dropped) if not renewed by then
  string   binding_axis     = 4;   // "rate"|"concurrency"|"cost"|"" — on the WRAPPER, matching core D1
  bool     policy_denied    = 5;   // joint-LP bid-price denial (all per-axis budgets had slack)
}

// Return a held slot. dropped:true signals overload (timeout/error) so the adaptive limit contracts.
message ReleaseRequest  { string lease_id = 1; bool dropped = 2; }
message ReleaseResponse {}                       // empty; Release is idempotent

// Renew ALL of a client's leases in one beat (mirrors the core's one-node-beat-covers-all-permits).
message HeartbeatRequest  { repeated string lease_ids = 1; }
message HeartbeatResponse {
  repeated string live_ids      = 1;   // still held; deadline extended
  repeated string reclaimed_ids = 2;   // already reclaimed (client too slow) — treat as dropped
  int64           next_deadline = 3;   // epoch-ms by which the next beat must arrive
}

service RateLimiter {
  // … existing Check / CheckMany / Peek / Forecast …
  rpc Admit(AdmitRequest)         returns (AdmitResponse);
  rpc Release(ReleaseRequest)     returns (ReleaseResponse);
  rpc Heartbeat(HeartbeatRequest) returns (HeartbeatResponse);
}
```
A concurrency-only policy and a fused (unified) policy share the **same** `Admit` trio — the only
difference is what `decision`/`binding_axis` reflect. Rate and cost stay on `Check`/`Debit` (no lease).

### 5.2 Server: the first stateful surface
The server gains a **lease table** and a **reclaim sweeper** (today it has neither — `server/src/service.ts`
is build-once, read-only, all-unary, no `setInterval`):
```ts
interface HeldLease { release(opts?: { dropped?: boolean }): void; expiresAt: number; policy: string; }
const leases = new Map<string, HeldLease>();          // keyed by opaque lease_id

// Admit:    const a = admitter.admit({ key, cost, hold, value });
//           if (a.decision.allowed && holdsConcurrencySlot(policy)) {
//             id = mint(); leases.set(id, { release: a.release, expiresAt: now + leaseTtlMs, policy });
//           } else { a.release(); /* no-op on deny; nothing to hold for rate/cost-only */ }
// Release:  leases.get(id)?.release({ dropped }); leases.delete(id);          // idempotent
// Heartbeat: for (id of ids) { const l = leases.get(id); if (l) l.expiresAt = now + leaseTtlMs; }
// Sweeper (setInterval ~heartbeatMs): for ([id,l] of leases) if (l.expiresAt < now) {
//             l.release({ dropped: true }); leases.delete(id);  // a crashed client's slot, reclaimed
//           }
```
**Crash-safety = the node↔coordinator contract, one layer out.** A client that crashes mid-hold is a
"node" that stopped heart-beating: the server (its "coordinator") reclaims the slot within `leaseTtlMs`,
releasing it with `dropped:true` (the same overload signal the core uses for a lost node). Defaults
mirror the core: `heartbeatMs=1000`, `leaseTtlMs=2000`.

- **Single server vs fleet.** A policy backed by in-process `adaptiveConcurrency` makes that server the
  sole concurrency authority (correct for a single instance). A policy backed by
  `distributedAdaptiveConcurrency({ coordinator: redis…, nodeId: <serverId> })` makes each server a
  *node* in the existing fleet protocol — so the global `L` is coordinated across servers by machinery
  that is **already built and TLA⁺-verified**. Config picks which.
- **`policy_denied` / `binding_axis`** come straight from `UnifiedAdmission` (`unified.ts:122`), so the
  wire field and an OTel attribute never disagree.

### 5.3 Python client: lifecycle ergonomics
```python
from throttlekit import ServiceBackend

with ServiceBackend("localhost:50051") as rl:
    # Short hold (< lease TTL): no heartbeat needed — acquire, work, release.
    with rl.admit("checkout", user_id) as adm:        # context-manager auto-releases on exit
        if not adm.allowed:
            return 429                                 # adm.binding_axis tells you which axis bound it
        do_work()                                      # raising inside ⇒ release(dropped=True)
```
- `admit(policy, key, cost=1, *, hold=0, value=1) → Admission`; `Admission` carries
  `decision`, `allowed`, `lease_id`, `binding_axis`, `policy_denied`, with `__enter__/__exit__`
  (exit calls `release(dropped = exc is not None)`; idempotent).
- **Heartbeat is opt-in and only for long holds.** Work shorter than `leaseTtlMs` needs none. For
  long-lived holds, a daemon thread (started lazily on the first long lease) batches
  `Heartbeat(all_open_lease_ids)` every `heartbeatMs`; `reclaimed_ids` marks an `Admission` lost.
- The advanced axes stay **service-door-only**; `RedisBackend` is untouched (principle 2).

### 5.4 Conformance
- **Lifecycle parity (the one-oracle proof for Door C):** a scripted op-list
  (`acquire`/`release`/`heartbeat`/`tick`) driven against the *same* server by both a Node client and
  the Python client, asserting identical decisions + `Σinflight ≤ L`. Use a **deterministic** setup —
  the `TestConcurrencyCoordinator` (in-memory) + a pinned local limit — because the adaptive RTT law is
  intentionally non-deterministic; we vector the *lifecycle + cap*, and **inherit the adaptive-law proof**
  from the core's existing TLA⁺ (`spec/GaleHeartbeatHandoff.tla`) + property tests.
- **New vector primitive** `"concurrency"` in `wire/vectors/vectors.ts` (alongside `rateLimit` /
  `tokenBudget`): ops are the scripted lifecycle, oracle is the core guard, `expect` captures the
  per-op decision and the running inflight. Locked by `test/wire/conformance-vectors.test.ts` as today.
- **Reclaim-on-crash test:** acquire, drop the client without releasing, assert the server frees the
  slot within `leaseTtlMs` (with `dropped:true`), and a subsequent acquire succeeds.

## 6. Phasing & sequencing
1. **Door A (two-tier via config)** — no wire change, immediate value, lowest risk. Ship first.
2. **Door C (Admit/Release/Heartbeat)** — the headline; the stateful lifecycle. The bulk of the work.
3. **Door B (Debit / cost)** — additive, adjacent; the `tokenBudget` vectors already exist. Ship when
   the cost axis is wanted on the wire.

Each door is independently shippable and independently version-bumped (`throttlekit-server` minor +
`throttlekit-py` minor). All are additive — no break to the 0.1.0 surfaces already published.

## 7. Open decisions to confirm (recommendations baked in)
- **D-P7-1 — Heartbeat transport: unary batch `Heartbeat(lease_ids[])` (recommended) vs. a bidi
  keep-alive stream.** Unary matches the existing all-unary door and the core's periodic-beat model,
  and keeps the client simple; a stream would auto-release on disconnect (elegant) but is a brand-new
  pattern and ties lease lifetime to connection liveness. **Recommend unary**, with connection-close as
  a best-effort early release.
- **D-P7-2 — Client-lease defaults + miss policy.** Recommend mirroring the core verbatim:
  `heartbeatMs=1000`, `leaseTtlMs=2000`, reclaim-with-`dropped:true`. Configurable per policy.
- **D-P7-3 — Door C scope.** Recommend exposing concurrency-only **and** unified (rate × concurrency)
  in the first cut; mark joint-LP (`policy:"joint-lp"`) `@experimental` on the wire, as it is in core.
- **D-P7-4 — Confirm the invariant:** two-tier and concurrency stay **service-door-only**; the
  `RedisBackend` remains single-shot `check`-only (preserves one-oracle). **Recommend yes.**

## 8. Non-goals
- No change to the frozen Lua wire (DR-78 untouched; this is all `.proto` + config + client).
- No port of stores, strategy math, or framework adapters to Python (client, not sibling library).
- No client-side decision derivation anywhere.
