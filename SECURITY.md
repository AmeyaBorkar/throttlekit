# Security Policy

## Supported versions

ThrottleKit is **1.x** and follows SemVer (see [STABILITY.md](./STABILITY.md)). Security fixes land on the
latest published minor; the previous minor receives patches for critical issues.

| Version | Supported |
| ------- | --------- |
| 1.x (latest minor) | ✅ |
| < 1.0 | ❌ |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub's coordinated disclosure: on the
[repository](https://github.com/AmeyaBorkar/throttlekit), open the **Security** tab and choose
**“Report a vulnerability”** (GitHub Private Vulnerability Reporting). This opens a private advisory visible
only to the maintainers.

Please include:

- the affected version and environment (Node version; store: memory / Redis / Postgres / DynamoDB / Deno KV /
  Cloudflare; the adapter, or the gRPC service door),
- a minimal reproduction or proof of concept,
- the impact you observed, and
- any suggested remediation.

### What to expect

- **Acknowledgement** within 72 hours.
- An initial assessment and severity rating shortly after.
- A fix and a published advisory once a patch is available; we credit reporters who wish to be named.

## Scope notes

ThrottleKit is a library (plus an optional gRPC service), not a hosted service. The threats most relevant to it:

- **Key spoofing.** The default key derivation resolves client IPs through an explicit trusted-proxy policy
  (`trustProxy`) and ignores untrusted `X-Forwarded-For` hops. Misconfiguring `trustProxy` (e.g. trusting all
  proxies behind an untrusted edge) lets clients spoof their key — set it to your actual proxy topology. See
  [Operations](https://github.com/AmeyaBorkar/throttlekit/wiki/Operations).
- **Fail mode on a store outage.** Adapters fail **open** by default (allow). For hard quotas set
  `fail: "closed"`. A store outage never silently corrupts counts and never lands a partial write; full matrix
  in [docs/FAILURE-MODES.md](./docs/FAILURE-MODES.md).
- **PII in keys.** If you key on user identifiers, use `hmacKeyer` to avoid storing raw PII in the backing store.
- **Shared-budget poisoning (distributed / polyglot).** When instances share one Redis/Postgres budget — or
  reach the core through the gRPC **service door** (`throttlekit-server`) — any party that can write to the
  shared store or call the service can consume or distort the budget. Front the service door with **TLS/mTLS**
  (its default credentials are insecure: loopback/dev only) and restrict store access to trusted instances.
  The additive **Fleet lease door** (`Fleet.Reserve`) hands out chunks of a global budget, so it is
  **loopback-only by default** — set `--fleet-secret` (with TLS) before exposing it, or a remote caller could
  lease and exhaust the budget.
- **Monitoring surfaces carry traffic metadata.** The read-only **Monitor door** (`throttlekit.v1.Monitor`,
  `GetSnapshot` / `Watch`) exposes **traffic keys (PII)** and the live denial feed, so the gRPC door is
  **loopback-only by default** — set `--monitor-secret` (with TLS) to expose it. The Prometheus `/metrics`
  endpoint is aggregate and **PII-free** (loopback by default, no auth), and gRPC health reports only
  serving status. Optional **decision capture** records the live decision stream (PII) to a **redacted,
  AES-256-GCM-encrypted** durable store — opt-in, OFF by default, behind a fail-closed, audited CLI.
- **SemVer scope.** Only the **stable core** is covered by the 1.0 guarantee; the **experimental frontier**
  (the joint-LP policy, distributed-concurrency tuning knobs, the learned-escrow / sketch layer, and the
  not-yet-frozen polyglot Lua wire) may change in a minor — see [STABILITY.md](./STABILITY.md).

ThrottleKit has **zero runtime dependencies**, which minimizes supply-chain surface; optional peer deps (store
clients, framework packages) are your choice and your trust boundary.
