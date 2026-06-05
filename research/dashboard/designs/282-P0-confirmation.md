# #282 Cost Room — P0 (confirm + spike) confirmation note

**Task:** #291. **Status:** P0 complete — no shippable change (test-only). **P1 (#292, additive types) unblocked.**

P0 is the design's §9 gate: *confirm three load-bearing facts against source, and spike the one window-roll
invariant the burn estimator rests on.* All three claims were verified by reading source **and** by a 3-lens
adversarial verification pass (each skeptic instructed to *refute*, not confirm). Every claim came back
**confirmed**; the burn-source edge-case hunt surfaced **no P0 blockers** — only P2/P3/P4 implementation
duties the design's §3 typed-field taxonomy already anticipates. The committed spike is
`server/test/cost-room-burn-source.test.ts`.

## The three confirmed claims

### (a) The cost lane is structurally dark on the server today — CONFIRMED
`buildAdmitter` (`server/src/config.ts:336-340`) assembles `unifiedAdmission({ concurrency, rate? })` and
**never passes a `cost:` Limiter**. There is exactly one `unifiedAdmission(...)` construction in
`server/src/**`, and it has no cost axis. The kind blocks are mutually exclusive
(`server/src/config.ts:198-204` rejects declaring more than one of
`tokenBudget`/`fairEscrow`/`concurrency`/`twoTier`), so a `tokenBudget` meter can never be wired in as an
admitter's cost axis either. Consequence: `AdmissionAnalyticsSnapshot.deniedByLane.cost` and
`topDeniedByLane.cost` are **always 0 / empty** server-side, and an admitter's `lastDecisions().cost` is
always `undefined`. v1 therefore ships the cost-denial fields as **optional-absent** and renders
"cost lane not configured" — never an always-empty panel dressed as a feature (design §8 blocker 1).

### (b) Exact per-tenant attribution is available only via `fairEscrow`, key === tenant — CONFIRMED
`buildFairEscrow` (`server/src/config.ts:368-375`) passes the request key straight through as the WFE tenant
(`weightOf: (tenant) => weights[tenant] ?? 1`), and the serving path `service.ts:287` calls
`fair.check(key, cost)` with **no namespacing** — so the request key *is* the tenant, exactly. No other
server policy kind exposes a synchronous per-tenant roster: `tokenBudget`/`MeterPolicy` is a single-key meter
(no per-tenant map), the concurrency guard's `stats()` is aggregate-only (`limit/inflight/rttNoload/lastRtt`),
two-tier `Limiter`s have no `stats()`, and `distributedTokenBudget` is async (`Promise<number>`) — unreadable
from a synchronous snapshot thunk. `WeightedFairEscrowStats.tenants[]`
(`src/twotier/weighted-fair-escrow.ts:188-194`) is the **only** per-tenant roster.

### (c) WFE `used` resets at the window roll; `stats()` does NOT roll — CONFIRMED (+ the load-bearing subtlety)
`rollWindow` (`src/twotier/weighted-fair-escrow.ts:278-284`) sets
`windowStart = floor(now/windowMs)*windowMs`, `lEffective = L`, and **`tenants.clear()`** (zeroing every
tenant's `used`) when `now >= windowStart + windowMs`. Initial `windowStart = Number.NEGATIVE_INFINITY`
(`:270-271`) guarantees the first check at any finite `now` opens a fresh epoch-aligned window. Crucially,
`rollWindow` runs **only** inside `check`/`checkSync` — `stats()` (`:478-493`) is a pure read that does **not**
roll. So:

> A passive `stats()` read taken after a window boundary, with **no intervening check**, still reports the
> *previous* window's `windowStart` and the previous (non-reset) `used` — until the next check rolls it.

This is the single most important thing the burn estimator must handle (it is the foundation of design §3
step 1's "if `windowStart` advanced since last sample → reset the ring"). The spike pins it directly: after
advancing the clock several windows forward without checking, `stats().windowStart` is unchanged and
`windowStart + windowMs < now` — a naive "resets in (`windowStart + windowMs − now`)" countdown would go
**negative**. The existing core test (`test/twotier/weighted-fair-escrow.test.ts:226-256`) asserts `used`
resets but never asserts on `windowStart` and never exercises the passive-lag read — so this contract was
previously untested. The spike now guards it.

## Burn-source edge cases (all P2/P3/P4 duties; none are P0 blockers)

The adversarial hunt enumerated six ways a burn estimator could read `WeightedFairEscrowStats` dishonestly.
Each is already covered by the design's §3 typed-field taxonomy; the note is *which* P-phase must enforce it.

| Edge case | Risk if unhandled | Covered by design § | Enforced in |
|---|---|---|---|
| **Passive-stats-lag** (stale `windowStart`/`used` after a boundary with no check) | negative "resets in Ns" countdown | §3 step 1 (windowStart-advance detection + ring reset) | P2 accumulator |
| **Used-decrease-without-roll** (`reset(tenant)` / tenant leaves mid-window) | phantom negative burn | §3 step 2 (negative-delta discard) + §4 (drop absent tenants) | P2 accumulator |
| **maxKeys FIFO eviction mid-window** (tenant evicted then reappears at `used:0`) | unaccounted burn / ghost ring | §4 (rank rings by activity, not FIFO; drop tenants absent from successive snapshots) | P2 accumulator |
| **`windowStart = -Infinity`** initial state | `-Infinity`/NaN in arithmetic | §3 (`burnPerSec: null` warming; `< 2` samples) | P2 accumulator |
| **`{error}`-shape guard** (`safeRead` returns a truthy `{error}`, not `undefined`) | NaN into ETA | §4 error-shape guard (`if (!stats || 'error' in stats)`) | P2 hub block |
| **L2 mode** (`effectiveLimit` grows lazily) | false pool-exhaustion rate | §3 L1-only (`fairShareReliable:false`); server never wires `l2` | n/a in v1 (L1-only) |

The spike asserts the first four directly (the ones expressible as a pure WFE-stats contract). The last two
are hub-integration concerns proven at P2.

## Honest refinements from the adversarial pass (carry into P1+)

1. **`stats()` enumeration is O(tenants), not O(renderCap).** `wfe.stats()` copies the full tenant map each
   call (`:478-493`). The design's "per-frame O(min(tenants, renderCap))" is the *accumulator's* `sample()`
   cost; the underlying `stats()` walk is O(tenants). **But that walk is already paid every frame by the
   existing Fairness view** (which taps `wfe.stats()` via `trackStats(name,'wfe',…)`), so the Cost Room adds
   **no new** O(tenants) cost — its marginal cost is `sample()` = O(renderCap). The 4Hz snapshot already
   absorbs the enumeration today. (The hunter flagged this "blocker"; it is real but pre-existing and
   amortized — reclassify as a P1 doc clarification, not a new cost.)
2. **The "analytics-reuse" optimization is moot in v1.** Design §4 says read `deniedByLane.cost` off the
   already-materialized `LensPolicySnapshot.analytics` rather than calling `analytics()` twice. The hub's
   custom-stats loop has no reference to peer policy snapshots — but it does not need one in v1, because the
   cost lane is dark (claim a): the Cost Room never reads `deniedByLane.cost` at all. The optimization only
   matters *if/when* a cost axis is ever wired (a deferred follow-up); P2/P3 should pick the access pattern
   then, not now.
3. **The four `FairEscrowConfig` fields land in P3, not P1.** `costRoom` / `costRoomMaxKeys` /
   `costRoomRingSize` / `unit` are not yet in `server/src/config.ts:111-124` — correct for design-phase. Per
   the design's own §9 phasing, P1 is **types-only** (the additive `LensTenantBurnRow` / `LensCostRoomSnapshot`
   on the snapshot envelope, `MONITOR_VERSION` bump from `0.2.0-experimental.2`); the config fields arrive in
   **P3** (server wiring). The exclusivity guard (`config.ts:198-204`) needs **no change** — `costRoom` is a
   sub-field of `FairEscrowConfig`, not a new sibling kind (design §4 / §8 blocker 2, verified).

## Verdict

P0 clean. No `src/**` change, no `wire/throttlekit.proto` change, no decision-path tap — exactly the §8
guardrail. The committed spike (`server/test/cost-room-burn-source.test.ts`) is a permanent contract guard
on the WFE-stats burn source + the dark cost lane. **P1 (#292) is unblocked**; it remains paused pending the
user's go (and the §11 decisions: real server cost axis vs WFE-only; `costRoom` default-on; declared `unit`;
`redactKey` seam; naming deferred sources in copy).
