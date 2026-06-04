# Changelog

All notable changes to **throttlekit-server** are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This server tracks the frozen `throttlekit` 1.0
core's public, frozen API and versions independently of it (it is pre-1.0 / experimental).

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
