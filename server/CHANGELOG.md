# Changelog

All notable changes to **throttlekit-server** are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This server tracks the frozen `throttlekit` 1.0
core's public, frozen API and versions independently of it (it is pre-1.0 / experimental).

## [Unreleased]

### Added

- **Tabbed views in the `--tui` dashboard.** Press `1`–`5` or `Tab` / `Shift-Tab` to switch views (see
  `research/dashboard/ROADMAP.md` for the panel roadmap). **Overview** and **Latency** are live;
  **Fairness**, **Capacity**, and **Guarantee** are landing panel-by-panel.
- **Latency view** — per-policy admit-path latency (avg / p50 / p99 / max) over the hub's rolling sample
  ring; p50/p99 are nearest-rank, and a policy with no samples this window shows an honest "no samples" row.

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
