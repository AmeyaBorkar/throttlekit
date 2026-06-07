# Replay P1 — library recorder + replayer (the v1 deliverable)

Task **#287**. Builds on the P0 determinism gate (**#286**, landed): MemoryStore ↔ Redis-Lua decisions are
bit-identical, so a decision trace replays deterministically.

## Scope (locked)
- **Leaf `Limiter`, synchronous `check`, `ManualClock` only.** The concurrency axis is **not** replayable
  from a decision trace (releases aren't decisions) — hard refusal, fail-loud.
- **Library-only** in v1 (no server capture, no wire).

## §11 decisions (taken)
1. v1 = library-only + single-field candidate compare.
2. The one core change: `export { buildStrategy }` from `src/config` — no other core / wire / hot-path change.
3. Redaction: per-trace salt, off by default (a seam, mirroring the Cost Room `redactKey`).
4. Recording is synchronous-only.

## Files (`src/testkit/replay/`)
- `recorder.ts` — wrap a leaf limiter; record `(key, cost, now, Decision)` into a bounded trace.
- `trace.ts` — the trace + spec (config fingerprint) types; a fail-loud hazard → guard taxonomy.
- `rebuild.ts` — rebuild a limiter from a recorded spec (uses the exported `buildStrategy`).
- `engine.ts` — replay the trace against the same or a candidate policy.
- `divergence.ts` — per-step `Decision` diff; an identity self-check (replay-vs-recorded must be
  zero-divergence) as a refusal precondition.

## Gate
- A deterministic replay-identity property test (same config → zero divergence) + a candidate-compare
  smoke test.
- Whole-repo lint + full suite green (read a real run). Lands as a PR on a branch; no publish.

## Then (deferred)
P2 candidate-compare DSL + scorecard (#288); P3 server capture + redacted trace store (#289); P4 TUI
trigger + divergence pane (#290).
