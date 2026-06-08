import type { ConfigStrategy } from "../../config";
import type { Strategy } from "../../core/types";
import { ReplayRefusedError } from "./errors";
import { type ReplayFingerprint, luaSha1 } from "./spec";
import { type ReplayTrace, assertWellFormedTrace } from "./trace";

/**
 * The strategies `buildStrategy` can construct from a spec — the set replay can rebuild. This mirrors
 * config's `ConfigStrategy` union; `buildStrategy` itself is the runtime backstop (it throws on an
 * unknown strategy), but checking here lets replay refuse with a clear, replay-specific message before
 * the generic config error fires. Notably absent: `leakyBucket` (a stable algorithm with no spec form),
 * concurrency, and any composite/joint-LP admitter — none is rebuildable from a single `LimiterSpec`.
 */
const REBUILDABLE_STRATEGIES: ReadonlySet<string> = new Set<ConfigStrategy>([
  "gcra",
  "tokenBucket",
  "fixedWindow",
  "slidingWindow",
  "slidingWindowLog",
  "quota",
]);

/** Whether `name` is a strategy `buildStrategy` can construct (and therefore replay can rebuild). */
export function isRebuildableStrategy(name: unknown): name is ConfigStrategy {
  return typeof name === "string" && REBUILDABLE_STRATEGIES.has(name);
}

/**
 * Refuse, loudly, any fingerprint that cannot be deterministically and faithfully replayed. Each
 * refusal is a distinct `ReplayRefusal`. When `rebuilt` is supplied, the two cross-checks that need
 * the actually-rebuilt strategy run as well: identity (name/limit/window) and Lua-SHA-1 — these catch
 * a tampered trace or a library build that drifted from the one that produced it.
 */
export function assertReplayable(fp: ReplayFingerprint, rebuilt?: Strategy): void {
  if (fp.clock !== "manual") {
    throw new ReplayRefusedError(
      "non-manual-clock",
      `replay: trace was recorded over a ${fp.clock} clock; only a ManualClock recording is deterministically replayable`,
    );
  }
  if (fp.axis !== "rate") {
    throw new ReplayRefusedError(
      "unreplayable-axis",
      `replay: the "${fp.axis}" axis is not replayable from a decision trace (releases are not decisions)`,
    );
  }
  if (fp.policy !== null) {
    throw new ReplayRefusedError(
      "unreplayable-policy",
      `replay: the "${fp.policy}" admission policy is a bid-price filter, not a leaf decision, and cannot be replayed from a decision trace`,
    );
  }
  const strategyName = (fp.spec as { strategy?: unknown }).strategy;
  if (!isRebuildableStrategy(strategyName)) {
    throw new ReplayRefusedError(
      "unrebuildable-strategy",
      `replay: strategy ${JSON.stringify(strategyName)} cannot be rebuilt from a spec ` +
        `(buildStrategy supports: ${[...REBUILDABLE_STRATEGIES].join(", ")})`,
    );
  }
  if (rebuilt !== undefined) {
    if (
      rebuilt.name !== fp.strategy.name ||
      rebuilt.limit !== fp.strategy.limit ||
      rebuilt.windowMs !== fp.strategy.windowMs
    ) {
      throw new ReplayRefusedError(
        "strategy-mismatch",
        `replay: rebuilt strategy (${rebuilt.name}/limit=${rebuilt.limit}/window=${rebuilt.windowMs}) ` +
          `does not match the recorded fingerprint (${fp.strategy.name}/limit=${fp.strategy.limit}/window=${fp.strategy.windowMs})`,
      );
    }
    const rebuiltSha = luaSha1(rebuilt);
    if (rebuiltSha !== fp.luaSha1) {
      throw new ReplayRefusedError(
        "lua-sha1-mismatch",
        `replay: rebuilt strategy Lua SHA-1 (${rebuiltSha}) differs from the recorded ${fp.luaSha1} — the build drifted from the one that produced this trace; re-record`,
      );
    }
  }
}

/**
 * Refuse a trace that is structurally unreplayable before any rebuild work: truncated (partial),
 * empty (nothing to replay), or whose fingerprint is itself unreplayable. The strategy/Lua
 * cross-checks need the rebuilt strategy and run later, inside the engine.
 */
export function assertReplayableTrace(trace: ReplayTrace): void {
  assertWellFormedTrace(trace); // trust boundary: a serialized/hand-built trace is untrusted input
  // Derive truncation from `dropped`, not the self-declared `truncated` flag — a tampered or
  // hand-built trace that dropped steps but left the flag false must still be refused.
  const dropped = trace.dropped ?? 0;
  if (trace.truncated || dropped > 0) {
    throw new ReplayRefusedError(
      "trace-truncated",
      `replay: trace is truncated (${dropped} step(s) dropped at the recording cap); a what-if over a prefix understates the effect — re-record with a larger maxSteps`,
    );
  }
  if (trace.steps.length === 0) {
    throw new ReplayRefusedError("trace-empty", "replay: trace has no steps to replay");
  }
  assertReplayable(trace.fingerprint);
}
