/**
 * Static-partition baseline — the simplest correct federation scheme:
 * split the global budget evenly across regions, no coordination, no pooling.
 *
 * **This is the BASELINE that window-coupled federation (TK-904) improves
 * on.** It gives Δ = 0 trivially (by construction — each region's slice is
 * independent of every other region's), but loses pooling under skew: a hot
 * region binds at `L/K` while idle regions sit on un-used capacity. The
 * window-coupled federation in TK-904 pools dynamically while preserving
 * the same Δ = 0 bound.
 *
 * Why a factory rather than a Strategy transform: Strategy<S> is opaque
 * (the internal Lua + state encoding aren't generically re-parametrisable
 * by `limit`). Asking the caller to supply a closure that captures the
 * other strategy params is the simplest portable interface; it works for
 * every built-in strategy and any custom one. See DESIGN.md §4.2.
 *
 * Usage:
 *
 *     import { gcra } from "throttlekit";
 *     import { staticPartition } from "throttlekit/federation";
 *
 *     const perRegion = staticPartition({
 *       globalLimit: 1000,
 *       regions: ["us-east", "eu-west", "ap-south"],
 *       strategyFactory: (limit) => gcra({ limit, periodMs: 60_000 }),
 *     });
 *     // perRegion["us-east"]  -> gcra({ limit: 334, periodMs: 60_000 })  (remainder)
 *     // perRegion["eu-west"]  -> gcra({ limit: 333, periodMs: 60_000 })
 *     // perRegion["ap-south"] -> gcra({ limit: 333, periodMs: 60_000 })
 *
 * Then each region wires its own `rateLimit(...)` with its slice.
 *
 * Remainder distribution: when `globalLimit` doesn't divide evenly across
 * `regions.length`, the leftover units go to the EARLIEST regions in the
 * list (regions[0..remainder-1] each get +1). This makes the partition
 * SUM-PRESERVING — `Σ forRegion(r) === globalLimit` exactly. Lopsided
 * allocation isn't an issue because the static partition is the baseline
 * (the federation scheme will pool the unused capacity anyway).
 */

import type { Strategy } from "../core/types";
import type { Region } from "./types";

export interface StaticPartitionOptions<S> {
  /** The total budget to split across regions. */
  globalLimit: number;
  /** The set of regions to partition into. Non-empty; iteration order matters for remainder. */
  regions: readonly Region[];
  /**
   * Strategy factory parameterised by the per-region limit. Called once per
   * region with that region's slice as the argument. The factory MUST capture
   * any other strategy params (periodMs, burst, etc.) in its closure.
   */
  strategyFactory: (perRegionLimit: number) => Strategy<S>;
}

/** What {@link staticPartition} returns alongside the per-region strategies. */
export interface StaticPartitionResult<S> {
  /**
   * Per-region strategies. Use these to construct each region's
   * `rateLimit(...)` / `twoTier(...)`. The map preserves the input ordering
   * of `regions` (so iterating `Object.entries(strategies)` is deterministic).
   */
  strategies: Record<Region, Strategy<S>>;
  /**
   * The slice assigned to each region, in input order. `sum(slices) === globalLimit`.
   * Useful for telemetry, asserts, and the skew analysis.
   */
  slices: Record<Region, number>;
}

/**
 * Partition a global budget across regions and produce a per-region strategy
 * for each slice. See file-level docs for semantics + remainder rule.
 *
 * Throws:
 * - `RangeError` if `globalLimit` is < 1 or not finite.
 * - `RangeError` if `regions` is empty.
 * - `RangeError` if `globalLimit < regions.length` (a slice would round to 0,
 *   which is degenerate — every region would always deny). Operators with
 *   `globalLimit < K` should not be using a static partition.
 * - `TypeError` if `regions` has duplicates.
 */
export function staticPartition<S>(options: StaticPartitionOptions<S>): StaticPartitionResult<S> {
  const { globalLimit, regions, strategyFactory } = options;

  if (!Number.isFinite(globalLimit) || globalLimit < 1) {
    throw new RangeError(`globalLimit must be a finite number >= 1, got ${String(globalLimit)}`);
  }
  if (regions.length === 0) {
    throw new RangeError("regions must be non-empty");
  }
  if (globalLimit < regions.length) {
    throw new RangeError(
      `globalLimit (${globalLimit}) must be >= regions.length (${regions.length}); a slice rounding to 0 means every region always denies`,
    );
  }
  const seen = new Set<Region>();
  for (const r of regions) {
    if (seen.has(r)) throw new TypeError(`duplicate region "${r}" in regions list`);
    seen.add(r);
  }

  const K = regions.length;
  const base = Math.floor(globalLimit / K);
  const remainder = globalLimit - base * K;

  const strategies: Record<Region, Strategy<S>> = {};
  const slices: Record<Region, number> = {};

  for (let i = 0; i < K; i++) {
    const region = regions[i] as Region;
    // Earlier regions get +1 from the remainder until exhausted.
    const slice = base + (i < remainder ? 1 : 0);
    slices[region] = slice;
    strategies[region] = strategyFactory(slice);
  }

  return { strategies, slices };
}
