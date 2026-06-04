# Changelog — throttlekit-lens

All notable changes to **throttlekit-lens** are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The package is `@experimental` and versions
independently of the core `throttlekit`.

## [0.1.0-experimental.1] — 2026-06-05

Reliability hardening of the transport + hub. **No API or snapshot-shape changes** — every export keeps its
`0.1.0-experimental.0` signature; this is a pure robustness pass.

### Fixed

- **No more silent hang on a port clash.** `serveLens` / `serveLensAggregator` now **reject** when the bind
  fails (e.g. `EADDRINUSE` because the default Lens port is already taken) instead of awaiting a `listen`
  callback that never fires — so the on-by-default server surfaces the conflict as an error.
- **One dead dashboard can't starve the others.** Every SSE write is guarded: a write to a gone client can
  neither throw nor break the fan-out loop to the other live streams, and a failed write tears down its own
  subscription + timers. A throwing snapshot subscriber is isolated from the rest of the feed.
- **A throwing `guard.stats()` can no longer crash the host.** `snapshot()` (also pushed from the SSE
  timer, where an uncaught throw would take the process down) now reads each guard defensively.
- **The "O(1) tap" guarantee is now real under load.** The hub's denial / fence / latency rings are true
  fixed-capacity ring buffers (O(1) append, no per-append `Array.shift`), so a sustained denial stream no
  longer makes the synchronous tap O(n).

### Security

- **Constant-time bearer-token comparison** (`crypto.timingSafeEqual`) on every Lens and aggregator request,
  removing the early-out timing side channel when the dashboard is exposed beyond loopback with a token.

### Changed

- IPv6 bind hosts are bracketed in the returned `url` (`::1` → `http://[::1]:9090`).
- `pushSnapshots` bounds each push with a request timeout so a black-holed aggregator can't pile up
  overlapping in-flight requests.
- `exports` now exposes `./package.json`.

## [0.1.0-experimental.0] — 2026-06-04

The first release of the **ThrottleKit Lens** — a zero-dependency, read-only monitoring dashboard for
ThrottleKit. Its hero is the one view no other rate-limiter dashboard can render: **live binding-axis
attribution** (which of rate / concurrency / cost — or the joint-LP `policy` lane — is throttling you
right now). `@experimental`: the surface and snapshot shapes may change in a minor.

### Added

- **`createLensHub`** — an in-process telemetry hub. Register limiters / unified admitters / concurrency
  guards; it returns tapped wrappers to use in their place and maintains a rolling snapshot (per-policy
  allow/deny, per-axis denials for admitters, Space-Saving top-K heavy hitters, observed ceiling +
  admit-path latency, guard health) plus a bounded live feed of denials — each with its exact per-axis
  `Decision` — and self-fence events. The taps are synchronous, exception-swallowing, and O(1), so the
  dashboard can never perturb the control path. **Universal**: a plain `rateLimit()` gets the full board;
  the binding-axis lane is the premium layer for `unifiedAdmission` users.
- **`lensHandler`** — a framework-agnostic, strictly read-only `(req, res)` handler: `GET /api/snapshot`
  (JSON), `GET /api/stream` (SSE), and the static UI. No mutation endpoints; optional bearer-token gate.
- **`serveLens`** — a standalone sidecar on Node `http`/`https`, **loopback-bound by default**, with a
  loud warning when exposed beyond loopback without TLS or a token.
- **The Lens UI** — a single self-contained static page (no build, no CDN): a hand-rolled SVG **Sankey**
  (binding axis → top-denied keys), a stacked-area deny-rate-by-axis timeline, a click-to-snapshot drawer
  with the exact per-axis numbers, a first-class **Guarantee** panel (per-policy headroom + live
  `Σinflight ≤ L` PASS/FAIL chips + a static link to the TLA⁺-proven overshoot bound), and the
  conventional ops board (throughput, deny rate, top keys, latency, concurrency health + a live fence
  feed, fairness, store/fleet health).
- **Fleet aggregation** — `serveLensAggregator` + `mergeSnapshots` + `pushSnapshots`: nodes push their
  snapshot to an aggregator that merges them into one `mode:"fleet"` view (additive counters, merged
  top-K, node-qualified guards). Best-effort and eventually-consistent.

### Requires

- `throttlekit >= 1.1.0` — the `@experimental` `admissionTap` / `withAdmissionAnalytics` primitives the
  hub is built on.
