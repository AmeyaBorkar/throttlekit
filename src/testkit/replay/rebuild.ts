import { type LimiterSpec, buildStrategy } from "../../config";
import type { ManualClock } from "../../core/clock";
import { rateLimit } from "../../core/limiter";
import type { Limiter } from "../../core/types";
import { MemoryStore } from "../../stores/memory";
import { ReplayRefusedError } from "./errors";
import { isRebuildableStrategy } from "./guards";

export interface RebuildOptions {
  /**
   * The {@link ManualClock} replay drives — `set()` to each step's instant. The rebuilt store reads
   * this same instance, so decisions and TTL/expiry key off one time base (the #286 §4.5 invariant).
   */
  readonly clock: ManualClock;
  /** Key prefix; match the trace's recorded prefix so store keys line up exactly. */
  readonly prefix?: string;
  /** Config name — used only for `buildStrategy` error context. */
  readonly name?: string;
}

/**
 * Rebuild the exact leaf limiter a trace was recorded over (or a candidate spec) on a **fresh,
 * deterministic** store: `MemoryStore({ clock, sweepIntervalMs: 0 })` reading the same
 * {@link ManualClock} as the limiter. Two construction facts (pinned by the #286 store-invariant gate)
 * make replay reproducible: no wall-clock sweep timer, and one shared time base. The strategy comes
 * from the single source of truth, {@link buildStrategy}, so the rebuild is behaviourally identical to
 * the recording.
 *
 * Refuses (`unrebuildable-strategy`) any spec whose strategy `buildStrategy` cannot construct — e.g.
 * `leakyBucket` or a composite/unknown strategy — with a replay-specific message, before the generic
 * config error would fire.
 */
export function rebuildLimiter(spec: LimiterSpec, options: RebuildOptions): Limiter {
  const strategyName = (spec as { strategy?: unknown }).strategy;
  if (!isRebuildableStrategy(strategyName)) {
    throw new ReplayRefusedError(
      "unrebuildable-strategy",
      `replay: strategy ${JSON.stringify(strategyName)} cannot be rebuilt from a spec`,
    );
  }
  const strategy = buildStrategy(options.name ?? "replay", spec);
  const store = new MemoryStore({ clock: options.clock, sweepIntervalMs: 0 });
  return rateLimit({
    strategy,
    clock: options.clock,
    store,
    ...(options.prefix !== undefined ? { prefix: options.prefix } : {}),
  });
}
