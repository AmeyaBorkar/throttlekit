# Changelog

All notable changes to **throttlekit-server** are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This server tracks the frozen `throttlekit` 1.0
core's public, frozen API and versions independently of it (0.x maturity; the gRPC wire is frozen and
conformance-tested against the golden vectors).

## [Unreleased]

### Added

- **Programmable Monitor door (`throttlekit.v1.Monitor`).** A new **read-only** gRPC service — the same
  operational state the `--tui` dashboard renders, readable remotely from any language. `GetSnapshot` returns
  a typed envelope (per-policy `allowed`/`denied`/`limit`/latency + top keys, concurrency-guard health, the
  recent denial feed) plus a `raw_json` field carrying the full dashboard snapshot for depth +
  forward-compatibility. `Watch` opens a **live, policy-filtered denial stream**, rate-capped and
  backpressured server-side (a slow reader drops events — the feed never grows server memory or perturbs the
  control path). It runs on the **same port** as the rate limiter and is **on by default**
  (`--monitor off` to disable); it is strictly non-mutating. **Auth (the snapshot carries traffic keys =
  PII):** loopback-only by default; set `--monitor-secret` (or `THROTTLEKIT_MONITOR_SECRET`, presented in
  call metadata) to read it from another host — a non-loopback call without the secret is rejected
  `UNAUTHENTICATED`. This is the **first additive wire change** under the new `buf breaking` gate: the
  `Monitor` service + its messages are purely additive (a new service; the locked `RateLimiter` messages are
  untouched), machine-verified non-breaking against the frozen baseline. Not composed with **capture** in this
  version (it serves alongside the dashboard and the decision RPCs). See the README's *Monitor door* section.
- **Cross-region federation (`federated`).** A new policy block that enforces **one global per-window rate
  budget across regions** through a cross-region coordinator (the core's `federate()`), served over the
  **same `Check` RPC** (no client change, **no wire change**). Each instance leases a slice of the global
  budget, so the fleet admits at most the strategy's `limit` per window regardless of region/instance count.
  Built on the published core's `RedisCoordinator` / `PostgresCoordinator` (no core release needed) — the
  store resolver (`createStore`) now exposes a coordinator factory over the raw client/pool for `redis` /
  `postgres` (and closes the Postgres GC timer on dispose); `memory` / `dynamodb` cannot federate. Requires a
  **window-coupled** strategy (`fixedWindow` / `slidingWindow` / a fixed-cadence quota) — a continuous-rate
  strategy (`gcra` / `tokenBucket`, which has a `windowMs` but no discrete window) and a calendar-cadence
  quota are rejected at load. `Peek` / `Forecast` are `UNIMPLEMENTED` on a federated policy. New `--region`
  flag (or `TK_REGION`; default `"default"`) sets the instance's region. See the README's *Cross-region
  federation* section.
- **Fleet token budgets (`fleetBudget`).** A new policy block that enforces **one** token budget across every
  server instance pointed at a shared store — the fleet-shared face of `tokenBudget`. It is the same cost axis
  served by the **same `Debit` RPC** (no client change, **no wire change** — the wire stays frozen and
  conformance-tested), built on the published core's atomic `distributedTokenBudget` (one oracle; no core
  release needed). Each per-key counter lives in the shared store (`--redis` / `--postgres` / DynamoDB) and is
  debited atomically, so the budget holds regardless of instance count. **Key-semantics:** the request `key`
  selects *which* budget (an independent counter at store key `"<prefix>:<key>"`, prefix defaulting to the
  policy name); same-config instances coordinate automatically, and an explicit `prefix` can deliberately share
  one budget across differently-named policies. Without a shared store it is process-local (identical to
  `tokenBudget`), so it is correct single-instance and fleet-coordinated the moment a store is configured.
  `check` on a `fleetBudget` policy returns `UNIMPLEMENTED` (it is a meter). See the README's *Fleet token
  budgets* section.

### Changed

- The cost-axis debit path now uses the meter's async `debit()` (was `debitSync()`), so a `fleetBudget` policy
  backed by an async store (Redis/Postgres/DynamoDB) debits correctly. Decisions for an in-process `tokenBudget`
  policy are byte-identical — `debit()` resolves synchronously there — so existing behavior is unchanged.

## [0.2.0] — 2026-06-09

### Added

- **Deterministic What-If Replay (`@experimental`, opt-in, default-OFF).** A new `--tui` **Replay** tab
  answers *"how many requests would this config change have flipped?"* against real traffic. Enable a
  top-level `replay:` block and the server runs an isolated, deterministic (`ManualClock`) **shadow** of each
  leaf-rate policy's live arrival stream — a post-decision, O(1), never-throw tail over the shadow's **own**
  store (it can never change, delay, or break a production decision), bounded at `maxSteps` (default 50,000)
  so a distinct-key flood can't exhaust memory (the trace is then flagged *truncated* and the what-if refuses
  rather than understating). Press `r` to replay an operator-configured candidate (`set` / `scale` / `swap`)
  and read the directional allow↔deny **flip ledger**, or an honest empty / truncated / refused state. Built
  entirely on the published `throttlekit/testkit` (no core change). Keys are redacted before entering a
  shadow; the flip count is candidate-vs-deterministic-baseline over the recorded traffic — **not** a replay
  of production's exact decisions. Replay is a `--tui` feature (configuring `replay:` without `--tui` warns)
  and is distinct from **capture** (the durable forensic record). See the README's *What-If Replay* section.

### Changed

- The monitor snapshot stamp `0.2.0` → `0.3.0` (the additive `replay` panel field). The `--tui` dashboard now
  has **seven** views — added **Replay**, and the README now documents the **Cost Room** view (shipped in
  0.1.0) alongside the rest.

## [0.1.0] — 2026-06-09

Graduated out of the `-experimental` prerelease tag: the gRPC wire is frozen and conformance-tested against
the golden vectors (a polyglot client's decisions are identical to the embedded library). One opt-in
surface — **decision capture** — remains `@experimental`.

### Added

- **Decision capture (`@experimental`, opt-in, default-OFF).** Record the live decision stream into a
  durable, redacted, **AES-256-GCM-encrypted** forensic store, with a fail-closed, **audited** admin CLI
  (`throttlekit-server capture list|export|sweep`). Keys **and** tenants are redacted at capture (full HMAC
  digest, never the raw value); captures are stamped `clock:"system"` (forensic — `export` emits a
  `ReplayTrace` JSON for **downstream** replay/what-if). The capture path is **control-path-safe** (a
  post-decision, O(1), never-throw tail) and **bounded** under a key/tenant flood; with no tenant rule it
  drops to counts-only (no per-key rows). See the README's *Decision capture* section.

### Changed

- Graduated the package version `0.1.0-experimental.7` → `0.1.0` and the monitor snapshot stamp
  `0.2.0-experimental.3` → `0.2.0`. The decision-only gRPC service door is stable and wire-frozen.

## [0.1.0-experimental.7] — 2026-06-05

### Added

- **Tabbed views in the `--tui` dashboard.** Press `1`–`5` or `Tab` / `Shift-Tab` to switch views (see
  `research/dashboard/ROADMAP.md` for the panel roadmap; the remaining tabs land panel-by-panel).
- **Latency view** — per-policy admit-path latency (avg / p50 / p99 / max) over the hub's rolling sample
  ring; p50/p99 are nearest-rank, and a policy with no samples this window shows an honest "no samples" row.
- **Fairness view** — for a weighted-fair-escrow source, per-tenant guaranteed share vs used vs borrowed
  against the shared budget (green = within the tenant's guarantee, yellow = borrowed idle surplus). Renders
  from any `trackStats(name, "wfe", …)` hub source — including a server `fairEscrow` policy (below).
- **Capacity view** — per-policy non-consuming forecast for the hottest key: how many requests are spendable
  now, when capacity next returns (`+1 in`), and when it is fully replenished (`full in`). Synchronous-store
  limiters only; an async store / admitter / no-traffic policy renders "n/a" honestly.
- **Guarantee view** — concurrency **headroom to a known line** as an observed-state readout (never a
  "proof holding" needle): each guard's inflight vs its **enforced** ceiling (`min(share, local.limit)`),
  how many guards are draining over their slice, self-fence status, and the live self-fence feed. Renders
  from tracked concurrency guards; the proven `Σinflight <= L_global` bound (machine-checked in TLA+ for the
  acknowledged-handoff protocol) and the per-key two-tier overshoot are fleet properties (the Fleet view).
- **Fairness and Guarantee populate on the server.** A new `fairEscrow` policy block serves a
  weighted-fair-escrow limiter over the gRPC `Check` RPC — the request key is the **tenant**, per-tenant
  state is bounded by `maxKeys` (default 100_000, mirroring the token-budget meter), and configured weights
  must be positive — feeding the Fairness view. Each `concurrency` policy's encapsulated guard is surfaced
  to the Concurrency + Guarantee views. (Both already worked for embedded / demo use.)

## [0.1.0-experimental.6] — 2026-06-05

### Changed

- **Monitoring moved from a browser dashboard to a built-in terminal dashboard (TUI).** `throttlekit-server
  --config … --tui` renders a live, zero-dependency dashboard right in the terminal, alongside gRPC — the
  binding-axis attribution hero (which of rate / concurrency / cost bound each denial), throughput, top
  denied keys, concurrency health, and a live denial feed with exact per-axis numbers — off the same
  in-process telemetry hub (synchronous, exception-swallowing, O(1)). `q` quits, `↑↓` scroll, `p` pauses.

### Removed

- **The web Lens.** The `--lens` / `--lens-host` / `--lens-port` / `--lens-token` / `--lens-aggregator`
  flags and the `throttlekit-lens` dependency are gone. A TUI owns the terminal, so it is **opt-in** via
  `--tui` (not on-by-default) and needs an interactive TTY — a non-TTY warns and serves without it. For
  headless / production, emit OpenTelemetry → Grafana (including `throttlekit.denies_by_axis{lane}`).

## [0.1.0-experimental.5] — 2026-06-04

### Added

- **Built-in `--lens` dashboard (on by default, loopback-bound).** `throttlekit-server --config …` now
  serves the **ThrottleKit Lens** monitoring dashboard alongside the gRPC service — live binding-axis
  attribution (which of rate / concurrency / cost is throttling each key — the one view no other
  rate-limiter dashboard can render), the full ops board, and a proven-bound Guarantee panel. The server
  taps each limiter + unified admitter into an in-process Lens hub (synchronous, exception-swallowing,
  O(1) — the gRPC decisions are unchanged) and serves the read-only UI on `127.0.0.1:9090` by default.
  - `--lens off` disables it; `--lens-host` / `--lens-port` move or expose it (a non-loopback host warns
    and wants a `--lens-token`); `--lens-token <tok>` requires `Authorization: Bearer <tok>` on the Lens;
    `--lens-aggregator <url>` pushes this node's snapshot to a fleet Lens aggregator.
  - Powered by the new **`throttlekit-lens`** package; requires **`throttlekit >= 1.1.0`** (the
    `@experimental` `admissionTap` / `withAdmissionAnalytics` telemetry primitives).

### Changed

- Bumped the `throttlekit` dependency to `^1.1.0` and added `throttlekit-lens`.

## [0.1.0-experimental.4] — 2026-06-04

### Added

- **Pluggable store resolver — Postgres and DynamoDB store doors.** The backing store is now selected with
  `--store memory|redis|postgres|dynamodb` (inferred from the connection flag when omitted). Previously the
  server could only be backed by in-process memory or Redis.
  - **Postgres** — `--postgres-url <url>` (+ `--postgres-table`, `--postgres-prefix`). No Redis required;
    per-key advisory-lock atomicity, durable across reconnects/restarts.
  - **DynamoDB** — `--dynamodb-table <t>` (+ `--dynamodb-region`, `--dynamodb-endpoint`, `--dynamodb-prefix`),
    plus `--dynamodb-create-table` to provision the single-`pk` table on boot (a dev convenience; production
    usually points at a pre-provisioned table). No Redis required; version-CAS atomicity + native TTL.
  - The Postgres/DynamoDB drivers (`pg`, `@aws-sdk/client-dynamodb` + `@aws-sdk/lib-dynamodb`) are
    **optional, lazily-imported** dependencies — a Redis-only or memory-only deployment never loads them and
    a clear error is raised if a `--store` is selected without its driver installed.
  - The decision still runs **server-side in the core** (the one-oracle invariant); the store only
    transports state, so decisions are bit-identical across every backend.
  - Edge-runtime stores (Deno KV, Cloudflare D1 / Durable Objects / Workers KV) are **not** hostable by a
    Node server — they run only inside their own runtimes, not behind the service door.
- Cross-language end-to-end coverage: gated server e2e tests boot a real gRPC server through the resolver
  against Postgres and dynamodb-local and prove state lands in the store; the reference Python client
  (`throttlekit-py`) reaches both backends through the service door with bit-identical decisions.

### Changed

- `--redis`, `--redis-prefix`, and the default in-process memory behaviour are **unchanged** (backward
  compatible); `--redis <url>` is now equivalent to `--store redis`.

### Security

- Bumped the `vitest` dev dependency to `^4.1.8`, clearing the critical advisory
  [GHSA-5xrq-8626-4rwp](https://github.com/advisories/GHSA-5xrq-8626-4rwp) (`vitest <4.1.0`: arbitrary file
  read/execute when the Vitest UI server is listening). Dev/test-only — it does not affect the published
  server runtime.
