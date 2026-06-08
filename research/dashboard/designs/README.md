# Dashboard design notes

Implementation-ready design notes for the deferred, design-first dashboard features (roadmap T6/T7).
Each was produced by an adversarial design panel (4 independent angles → judge → 3 skeptics →
synthesis) grounded in a verified codebase-surface map. **Design only — no code is written by these.**

| File | Feature | Status |
|---|---|---|
| [`CODEBASE-SURFACE.md`](CODEBASE-SURFACE.md) | Verified primitives / determinism model / PII surface / integration pattern — the shared grounding both notes are built on | grounding |
| [`281-what-if-replay.md`](281-what-if-replay.md) | #281 Deterministic What-If Replay (testkit recorder + replayer) | design done — build deferred, awaiting go |
| [`282-token-budget-control-room.md`](282-token-budget-control-room.md) | #282 LLM Token-Budget Control Room (cost-axis burn-down TUI view) | design done — build deferred, awaiting go |

Shared guardrails carried by both designs: **no `wire/throttlekit.proto` change**, **no core
hot-path change** (replay adds exactly one additive `export { buildStrategy }`; the Control Room adds
none), **PII-bounded + opt-in**, and for #282 **strictly engineering copy** (TALE/GALE research stays
local until arXiv). Each note ends with the open decisions that need a call before implementation.

Not yet designed: **#283 Fleet-global aggregation** — reopens the frozen wire/transport, so it needs
explicit reauthorization before its design pass.
