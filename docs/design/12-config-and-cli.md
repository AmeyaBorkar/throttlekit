# 12 · Config & CLI

> `.throttlekit.yaml` rate-limit-as-code, and the `throttlekit` operator CLI. Source: `src/config/`,
> `src/cli/`.

## Purpose

Two operator-facing surfaces: a declarative config that turns a `.throttlekit.yaml`/`.json` into ready
`Limiter` instances, and a zero-dependency CLI for benchmarking, environment diagnosis, and replaying a
traffic log against a limiter.

## Config — rate-limit-as-code (`src/config/`)

A config declares **strategies + policies**, not live clients — a `Store` (an ioredis client, a pool) can't
be serialized into YAML, so it is injected at load time. `loadConfig(text, { store?, format? })` auto-detects
JSON (text starts with `{`/`[`) else YAML, and builds one independently-namespaced limiter per entry (the
prefix defaults to the policy name). Missing fields or an unknown strategy throw a `ThrottleKitError` naming
the exact config path.

The YAML parser (`src/config/yaml.ts`) is a **deliberately narrow, zero-dependency subset**: block maps,
scalars, inline flow maps `{ k: v }`, comments. It does **not** support block lists, anchors/aliases,
multiline scalars, multi-doc, or **nested flow maps** — anything outside the subset throws a `YamlParseError`
with a 1-based line number. *Why so narrow:* a small, auditable grammar has an unambiguous meaning and no
YAML-bomb / billion-laughs attack surface.

The one quirk worth knowing: because the parser rejects nested flow `{…}`, a value that is itself a sub-map
must be written as an indented **block**, not inline. Flat strategy specs fit on one line
(`api: { strategy: gcra, limit: 100, period: 1m }`); composite blocks with nested sub-objects
(the `twoTier`/`concurrency`/`tokenBudget` shapes the server consumes, [14](14-grpc-server.md)) must use
block form.

## CLI — `throttlekit` (`src/cli/`)

A small hand-rolled CLI with a pluggable `Output` (so the commands are testable without touching
`process.stdout`):

- **`benchmark`** — an in-process micro-bench across the single-state strategies (gcra, tokenBucket,
  fixedWindow) on a memory store, reporting ops/s and ns/op via `process.hrtime.bigint()`.
- **`doctor`** — checks Node ≥ 18, probes the optional peer dependencies (`ioredis`, `redis`, `pg`,
  `@opentelemetry/api`, `@nestjs/common`) via dynamic import, and locates + validates a `.throttlekit.yaml`/
  `.json` in the cwd, listing the limiter names. Exit 0 if all pass, 1 otherwise.
- **`replay`** — re-runs a JSON-lines `{ key, cost? }` log through a limiter built from `--config FILE
  [--name NAME]` or from `--strategy/--limit/--period` flags, printing total/allowed/denied/deny-rate and
  the top-10 denied keys. A usage error (no log arg) exits 2.

## Design decisions & rationale

- **Config declares policies, not clients** — the live `Store` is injected at load, because infrastructure
  handles can't be serialized.
- **A narrow, zero-dep YAML subset** — an auditable grammar with no parser-bomb surface; nested flow maps are
  rejected to keep the parser predictable, which is what produces the block-only quirk for composite policies.
- **A pluggable `Output` on the CLI** — the commands are unit-testable without capturing stdout.

## Caveats

- The `src/config` builder itself constructs single-strategy limiters; the `twoTier`/`concurrency`/
  `tokenBudget` composites are assembled by the server's config layer ([14](14-grpc-server.md)). The
  nested-block quirk is a property of the shared YAML parser those blocks pass through.

## What proves it

- `test/config/yaml.test.ts` — every scalar kind, inline flow maps, comment stripping, and the rejections
  (not-at-root, missing colon, **nested flow maps**, empty key, over-indent) each with a line number.
- `test/config/config.test.ts` — builds independently-namespaced limiters, auto-detects JSON, rejects missing
  fields / unknown strategy / missing `limiters` map.
- `test/cli/cli.test.ts` — `parseArgs` forms; dispatch (help, unknown → 2); benchmark output rows; doctor
  node/peer/config reporting; replay summaries through both flag-built and `--config`-named limiters.

## Source map

`src/config/yaml.ts` (the parser) · `src/config/index.ts` (`loadConfig`, `buildLimiter`) · `src/cli/index.ts`
(commands) · `src/cli/bin.ts` (entry).
