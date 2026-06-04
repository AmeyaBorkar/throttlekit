# ThrottleKit Lens — frozen contracts (TK-LENS-0)

Local design note (kept out of the npm package). The spike (`research/lens/spike.ts`, PASSED) confirmed the
load-bearing claims; these are the data shapes the rest of the build (Phases 1–4) implements. All shapes are
**append-only** after this point (add optional fields; never remove/repurpose) — they are `@experimental`,
outside the 1.x core freeze.

## 0. Spike findings (verified)
- For `unifiedAdmission`, every deny attributes to **exactly one lane**: the binding axis
  (`concurrency → rate → cost`, first deny short-circuits) **or** the `policy` lane (`policyDenied`).
- `result.bindingAxis` **always equals** `bindingAxisOf(admitter.lastDecisions())` (independent
  reconstruction) — so the UI can trust either source.
- Short-circuit ⇒ downstream axes are `undefined` in `lastDecisions()` (no double-counting).
- `policyDenied` leaves every per-axis `Decision` `undefined` (budgets untouched) — **policy is not a 4th axis**.
- The **universal** path holds: a plain `rateLimit()` is fully attributable by `(strategy, key)` from the
  existing `tapDecisions` stream alone.

## 1. Lane type (shared)
```ts
// "policy" = a joint-LP bid-price denial (policyDenied), rendered as a distinct lane, NOT an axis.
type AdmissionLane = UnifiedAxis | "policy"; // "rate" | "concurrency" | "cost" | "policy"
```

## 2. Core primitive: `admissionTap` (Phase 1, src/admission/tap.ts)
Clones `tapDecisions` semantics (synchronous emit, swallow observer exceptions, O(1), forwards
introspection) but wraps a `UnifiedAdmitter` (`admit`/`admitSync`). Emits one event per completed admit:
```ts
interface AdmissionEvent {
  key: string;                 // admit key ("" = global bucket)
  cost: number;                // cost-axis weight (default 1)
  value: number;               // joint-LP bid value (default 1)
  decision: Decision;          // the combined decision
  bindingAxis?: UnifiedAxis;   // which axis bound a deny; undefined on allow OR policy deny
  policyDenied: boolean;       // joint-LP bid-price deny
  lane?: AdmissionLane;        // the single attributed lane on a deny (= bindingAxis ?? "policy"); undefined on allow
  perAxis: Readonly<Partial<Record<UnifiedAxis, Decision | undefined>>>; // = lastDecisions() at emit time
  durationMs: number;          // wall time inside admit (fractional ms)
  kind: "admit" | "admitSync";
}
type AdmissionTap = (e: AdmissionEvent) => void;
function admissionTap(admitter: UnifiedAdmitter, onAdmission: AdmissionTap): UnifiedAdmitter;
```
Note: `perAxis` must be read at emit time (the admitter overwrites it each admit). `lane` is a convenience
the tap computes once (cheaper than every consumer re-deriving).

## 3. Core primitive: `withAdmissionAnalytics` (Phase 1, src/admission/analytics.ts)
Forks `withAnalytics` (same epoch-aligned window, same `StreamSummary` Space-Saving top-K, same
`HeavyHitter`), wrapping a `UnifiedAdmitter` and segmenting denials by lane:
```ts
interface AdmissionAnalyticsOptions { topK?: number; windowMs?: number; clock?: Clock } // mirror AnalyticsOptions

interface AdmissionAnalyticsSnapshot {
  windowStartedAt: number;
  windowMs: number;
  allowed: number;
  denied: number;
  total: number;                                 // allowed + denied
  denyRate: number;                              // denied/total, 0 when total 0
  deniedByLane: Record<AdmissionLane, number>;   // EXACTLY-ONE-LANE: Σ over lanes === denied
  topRequested: HeavyHitter[];                   // Space-Saving, all admits
  topDenied: HeavyHitter[];                      // Space-Saving, denials (any lane)
  topDeniedByLane?: Partial<Record<AdmissionLane, HeavyHitter[]>>; // optional per-lane heavy hitters
}
interface AdmissionAnalyticsAdmitter extends UnifiedAdmitter {
  analytics(): AdmissionAnalyticsSnapshot;
  resetAnalytics(): void;
}
function withAdmissionAnalytics(a: UnifiedAdmitter, opts?: AdmissionAnalyticsOptions): AdmissionAnalyticsAdmitter;
```
Invariant pinned by the contract test (Phase 1): `Σ deniedByLane === denied`, and each lane key is one of
`rate|concurrency|cost|policy`.

## 4. Hub snapshot: `GET /api/snapshot` (Phase 2, @throttlekit/lens)
The universal in-process hub composes every registered source into one snapshot. A "policy" here is any
registered limiter/meter (via `tapDecisions`/`withAnalytics`) OR admitter (via `admissionTap`/
`withAdmissionAnalytics`); the axis lane only appears for admitter sources.
```ts
interface LensSnapshot {
  meta: { generatedAt: number; windowMs: number; mode: "process" | "fleet"; nodeId?: string; fleetNodes?: number; lensVersion: string };
  policies: LensPolicySnapshot[];
  guards: LensGuardSnapshot[];     // concurrency health
  fairness: LensFairnessSnapshot[];// WFE per-tenant
  guarantee: LensGuaranteeSnapshot[]; // admitted-this-window vs computed ceiling + invariant chips
  health: LensHealth;
  recentDenials: LensDenialRow[];  // bounded ring for the click-to-snapshot drawer
}
interface LensPolicySnapshot {
  name: string;
  kind: "limiter" | "admitter" | "meter";
  strategy?: string;               // limiters
  axes?: UnifiedAxis[];            // admitters: configured axes (drives "axis lane lights up")
  analytics: AnalyticsSnapshot | AdmissionAnalyticsSnapshot; // admitter carries deniedByLane
}
interface LensGuardSnapshot { // from ConcurrencyGuard.stats() / DistributedConcurrencyGuard.stats()
  name: string; limit: number; inflight: number; rttNoload: number; lastRtt: number;
  share?: number; lGlobal?: number; nodes?: number; fenced?: boolean;
  recentFences?: { at: number }[]; // fed by the onFenced hook
}
interface LensFairnessSnapshot { // from weightedFairEscrow().stats() / federated form
  name: string; windowStart: number; limit: number; effectiveLimit?: number; poolAvailable?: number;
  tenants: { tenant: string; weight: number; used: number; guaranteed: number; borrowed?: number }[];
}
interface LensGuaranteeSnapshot { // headroom-to-a-known-line; NEVER a "proof holding" needle
  policy: string; key: string; admittedThisWindow: number; ceiling: number;
  model: string;                 // e.g. "Limit + N*(B-1)" or "Limit (windowCoupled)"
  fleetSizeN?: number; batchB?: number; headroom: number; // ceiling - admittedThisWindow
  invariants: { name: string; pass: boolean; specRef: string }[]; // e.g. "Σinflight≤L_global", spec/DistributedLeasing.tla
}
interface LensHealth { backend: string; reachable: boolean; failMode: "open" | "closed"; leaseTableSize?: number; reclaimCount?: number }
interface LensDenialRow { at: number; policy: string; key: string; lane: AdmissionLane; decision: Decision; perAxis?: Partial<Record<UnifiedAxis, Decision>> }
```

## 5. Live stream: `GET /api/stream` (SSE, Phase 2)
SSE (not WebSockets — dep-free, proxy-friendly; `/api/snapshot` poll is the always-works fallback). Event
types (JSON `data:`):
- `event: snapshot` — a full `LensSnapshot` on connect and every UI tick (~1–2s).
- `event: denial` — a single `LensDenialRow` pushed as denials happen (drives the live deny feed + drawer).
- `event: fence` — `{ guard: string; at: number }` from the `onFenced` hook (live self-fence feed).

## 6. Fleet merge: `POST /api/ingest` + aggregator (Phase 4)
Nodes push their `LensSnapshot` (authed) on each tick; the aggregator merges into a `mode:"fleet"` snapshot:
- **counters** (`allowed`/`denied`/`deniedByLane`, `total`) — **sum** across nodes.
- **top-K** (`topRequested`/`topDenied`/per-lane) — merge via the existing `mergeableSketch`
  (`src/sketch/index.ts`): each node serializes its Space-Saving summary; the aggregator merges additively
  (stays an over-estimate, never drops a true heavy hitter).
- **guards** — listed per node (ceilings are per-node, NOT summed); show aggregate `inflight = Σ inflight`,
  `lGlobal`/`nodes` from any node.
- **guarantee** — `admittedThisWindow = Σ` across nodes (the only genuinely fleet-global overshoot number);
  `ceiling = f(N = fleetNodes, B)`.
- caveat surfaced in `meta`: fleet view is **best-effort, eventually-consistent** (per-tick snapshots).

## 7. Transport security (Phases 2/5)
Read-only: only `GET /api/snapshot`, `GET /api/stream`, `GET /` (static UI); `POST /api/ingest` exists ONLY
on the aggregator and is authed. No mutation endpoints. Default bind loopback; non-loopback ⇒ require
auth/TLS (bearer token and/or mTLS via the `server/src/runtime.ts` cert loaders) + a loud warning. The taps
stay synchronous + exception-swallowing + O(1) (bench-gated) so the dashboard can never perturb the control
path.

## 8. Contract test (authored in Phase 1, lands in test/admission/)
Can't exist before the primitives, so it ships WITH Phase 1 (not a failing stub now). It pins: the
`AdmissionEvent` field set; `Σ deniedByLane === denied`; exactly-one-lane membership; `result.bindingAxis
=== bindingAxisOf(lastDecisions())`; the universal `tapDecisions`→`(strategy,key)` attribution; and the
Space-Saving top-K bound (mirroring `test/analytics`). The spike (`research/lens/spike.ts`) is the
throwaway precursor; the Phase-1 test is its deterministic (`ManualClock`) permanent form.
```
