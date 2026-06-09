# Scaling design — service door, distributed features, monitoring API

Status: **active** (engineering design record). Scope: make every limiter feature reachable from every
client language through the gRPC service door, add a programmable monitoring API, and let a fleet stay
globally correct — while the previously-stable wire evolves under a machine-checked additive-only contract.

This document is the durable rationale; the phased task breakdown lives with the work (P0–P9).

---

## 1. Why

The core computes every decision. The server (`throttlekit-server`) exposes a subset of the core over a
gRPC contract (`wire/throttlekit.proto`); other-language clients (e.g. `throttlekit-py`) and edge runtimes
are thin and inherit only what that contract serves. Three gaps follow:

1. **No programmable monitoring.** Operational state is rendered only by an in-process terminal dashboard;
   there is no transport to read it remotely or from another language.
2. **Distributed features are unserved.** The core has cross-region federation, distributed concurrency,
   a fleet-shared token budget, and cross-region fair-share — but the server wires none of them, so they
   are unreachable from any non-embedded client.
3. **The wire had no compatibility enforcement.** It is loaded dynamically with no `buf`, no codegen, and
   no breaking-change check — so evolving it safely was risky enough to defer.

**Outcome:** one service door reaches every feature from any language; monitoring is remotely readable;
fleets stay globally correct; and the wire grows additively under a CI gate so today's clients keep working.

---

## 2. Architecture — one oracle, four doors, two coordination tiers

**One oracle (invariant).** Only the core computes a limit or a grant. Other languages and edge stay thin;
they never re-implement decision logic. This keeps every platform bit-consistent with one implementation.

**Four doors** (how a caller reaches the oracle):
1. **Service door** — gRPC. The supported cross-language path.
2. **Direct door** — the vendored, checksum-pinned store scripts, for runtimes that talk to the shared store
   directly (edge).
3. **Embedded** — in-process for Node callers.
4. **Monitoring door** (new) — a read-only gRPC `Monitor` service + a Prometheus `/metrics` endpoint + the
   standard gRPC health service.

**Two coordination tiers** (how a multi-instance deployment stays globally correct):
- **Tier 1 — shared-store coordination (default).** A policy is configured as a distributed variant with
  *server-side* fleet identity (`node.id` / `node.region`). Server instances coordinate through a shared
  store; **every client reaches it through the existing decision RPCs with no client change.** This is the
  default and needs no wire change.
- **Tier 2 — client-held lease.** A high-throughput client reserves a chunk of the global budget and
  enforces it locally, contacting the server only to refresh — removing the per-request round trip. The
  oracle computes the lease *size*; the client only *spends* it (see §6).

Each distributed feature maps onto an existing core coordination seam:

| Feature | Core seam | Coupling |
|---|---|---|
| Cross-region federation | global coordinator (`lease` / `reconcile`) | window-coupled |
| Distributed concurrency | concurrency coordinator (`heartbeat` / `leave`) | heartbeat / TTL |
| Cross-region fair-share | region fair pool (`grant` / `release`) | window-coupled |
| Fleet token budget | atomic shared store counter | window-coupled (no coordinator) |

---

## 3. The wire — additive-only evolution

The wire is a public, multi-language contract. Touching it is effectively irreversible: a client built today
must keep working forever. The rule, enforced mechanically:

- **`buf breaking` runs in CI** against a committed baseline image of the frozen contract (FILE level). Any
  non-additive change — renumbering, retyping, removing, changing cardinality — fails the build.
- **Additive-only, in place, under the existing `v1` package.** Add fields with new numbers, add enum values,
  and add **new services**. A `v2` package is reserved only for a change the rules forbid (none planned).
- **New capabilities are new services, not new methods on the decision service.** They never touch the
  locked decision messages; a second/third service registration shares the same port.
- **The decision message is never extended with lease fields.** Lease data lives only in its own message.
- **The first enum carries an explicit `*_UNSPECIFIED = 0`** (the zero default), so an old reader never
  silently maps to a real value.
- **Removed numbers/names are reserved, never reused.**
- The server's packaged copy of the contract is generated verbatim from the single `wire/` source at pack
  time (a `copyFileSync`), so the two cannot drift; `buf` validates that one source, which transitively
  covers what the server publishes.

---

## 4. The monitoring door

A new read-only `Monitor` service projects the operational snapshot the in-process dashboard already builds
(throughput, per-policy deny breakdown and binding-axis lanes, top keys, latency, concurrency health,
fairness, capacity/forecast, the overshoot-headroom view, cost burn-down):

- **`GetSnapshot` (unary)** — a point-in-time snapshot. Stateless, cacheable, individually load-balanced.
- **`Watch` (server-streaming)** — a live decision/denial feed, opened with a minimal filter (policy +
  allow/deny), a server-side rate cap, and backpressure (gate each send on consumer-ready) so a slow reader
  throttles the producer rather than growing memory unbounded.
- **`/metrics` (HTTP, Prometheus text)** — the universal scrape door, additive and separate from the gRPC
  port, exposing the existing metric set (including the per-axis denial counter).
- **gRPC health** — the standard health service for liveness/readiness probes.

**Posture.** The monitoring door is available by default but bound to loopback; exposing it beyond loopback
requires an explicit host **and** auth/TLS, with a loud warning (mirroring the existing insecure-transport
warning). It is strictly read-only. It must require auth when exposed — it carries traffic keys.

---

## 5. Honest boundaries (carried into docs and copy)

- **Fleet token-budget key semantics:** the request `key` selects *which* budget (a per-policy key→budget
  mapping); a fleet-budget policy's `key` therefore means something different from a single-instance budget
  policy. Documented and conformance-pinned so two clients can't wrongly believe they share a budget.
- **Distributed batch checks fan out** to one coordinator round trip per key — not the single consistent
  instant a local batch gives. Documented; distributed batch size is capped.
- **`Peek` / `Forecast` are unsupported under federation/leasing** (those limiters are asynchronous and
  window-based). The server already returns an explicit "unsupported" status; verified to fire cleanly here.
- **Cross-region fair-share** is correct on a single arbiter instance immediately; **horizontal scale**
  (N instances) requires the store-backed pool (P3) or each instance grants the full global budget. The
  single-arbiter limitation is labeled until the store-backed pool ships.
- **Capture is blind to Tier-2 lease decisions** — they are made on the client, off the server. Tier-1
  decisions remain fully captured.
- **Edge gets distributed *decisions*, not the *doors*.** Edge runtimes are ephemeral, so the gRPC `Monitor`
  and lease services are server-runtime only; edge inherits distributed decisions through store-backed
  limiters (where the shared store is reachable) and observes through metrics/logs.

---

## 6. The one-oracle line for client-held leases

The oracle computes the **grant size** (a coordinator lease, a fair-share grant, or a concurrency share).
The client may only **subtract from the granted balance and synthesize a decision**, identical to the
core's existing local-credit spend in the leased two-tier path. This holds the one-oracle invariant **iff
the client's local spend is byte-identical to the core's** — which is proven by extending the cross-language
conformance vectors to cover a granted-lease spend timeline: spend within capacity, exact exhaustion,
post-exhaustion denial with the correct retry hint, discard of remaining credit at the window boundary,
cost greater than one and greater than capacity, and a refresh arriving mid-window. The vectors are generated
from the core first; the client helper must replay them exactly.

**Correctness hazards the helper must defend:**
- **Clock skew** — the grant's expiry is the store's window; the client treats it as authoritative and never
  extends it.
- **Window alignment** — leftover credit is discarded at the boundary, never carried across.
- **Refresh race** — concurrent misses coalesce onto one in-flight refresh and re-resolve after it lands.
- **Partial grant** — the lease capacity is the *granted* amount, which may be less than requested.

---

## 7. Decisions

- **SC-01** One oracle preserved; lease-tier local spend is mechanical and vector-verified, not policy.
- **SC-02** Two coordination tiers: shared-store (default, transparent) and client-held lease (scale ceiling).
- **SC-03** Additive-only wire under `v1`, machine-gated by `buf breaking` in CI; `v2` only for a forbidden
  change (none planned).
- **SC-04** Monitoring = a read-only `Monitor` gRPC service (`GetSnapshot` + `Watch`) on the same gRPC port,
  a separate loopback-bound `/metrics` HTTP port, and the standard gRPC health service.
- **SC-05** The lease tier is a new `Fleet` service, `Reserve` unary only in v1; a single `axis` enum
  (`AXIS_UNSPECIFIED=0`, `RATE`, `CONCURRENCY`, `TOKEN_BUDGET`) unifies the three.
- **SC-06** Server-side fleet identity for Tier 1; client-supplied identity only on the lease path.
- **SC-07** Monitoring door available by default, loopback-bound, off switch; exposing it requires host +
  auth/TLS with a loud warning.
- **SC-08** Distributed features reach other languages via Tier 1 over the existing RPCs (no client change);
  the `Monitor` and `Fleet` stubs are additive client surface.
- **SC-09** Build the store-backed cross-region fair budget so multi-instance fair-share is correct.
- **SC-10** Edge inherits distributed decisions via store-backed limiters; the doors are server-runtime.
- **SC-11** All shipped and committed design copy is engineering-only and vendor-neutral.
- **SC-12** Extend the conformance vectors to cover the local-spend path.
- **SC-13** `buf generate` is the polyglot codegen path; Node keeps dynamic loading.
- **SC-14** The lease request carries caller identity, wants, current lease, used, and axis; the response
  carries the granted lease (capacity, expiry, refresh interval) and a safe fallback capacity; times are
  epoch-ms integers to match the existing contract style.
- **SC-15** Auth is mandatory on `Monitor` (carries traffic keys) and `Fleet` (hands out budget); `/metrics`
  defaults to loopback.
- **SC-16** The server's per-client lease lifecycle and the core guard's node↔coordinator lease lifecycle
  coexist independently; they are never merged.

---

## 8. Compatibility & release gates

The server consumes the **published** core, so a new core export is invisible until the core is released.
The federation, distributed-concurrency, fleet-budget, and single-arbiter fair-share primitives are already
published, so Tier-1 wiring and the monitoring door need no core release. The store-backed fair pool (P3) and
the lease conformance vectors (P6) are new core code and ride the next core release. Every push and every
tag/publish is gated on explicit human authorization.
