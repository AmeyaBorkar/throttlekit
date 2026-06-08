import { createHash } from "node:crypto";
import type { LimiterSpec } from "../../config";
import type { Strategy } from "../../core/types";

/**
 * Which clock a recording ran on. Only `"manual"` (a {@link ManualClock}) is deterministically
 * replayable — a `"system"` (wall-clock) or `"server"` (Redis `TIME`) recording records instants
 * that cannot be reproduced, and is refused at replay. The non-manual values exist so the fingerprint
 * type can faithfully *represent* such a recording (e.g. a future server-side capture) and refuse it.
 */
export type ReplayClockSource = "manual" | "system" | "server";

/**
 * The one admission axis a *decision* trace can replay. Concurrency is intentionally excluded:
 * releases are not decisions, so a concurrency limit's behaviour cannot be reconstructed from a
 * trace of admit/deny decisions. A non-`"rate"` value is refused.
 */
export type ReplayAxis = "rate";

/** Recorded strategy identity — a cheap structural cross-check against the spec-rebuilt strategy. */
export interface StrategyIdentity {
  readonly name: string;
  readonly limit: number;
  readonly windowMs?: number;
  readonly ttlMs: number;
}

/**
 * Everything needed to rebuild — and to validate the rebuild of — the exact leaf limiter a trace was
 * recorded over. Captured once at record time; checked by `assertReplayable` before any replay.
 *
 * The `spec` is the rebuild input (re-run through the single source of truth, `buildStrategy`). The
 * other fields are guards: `strategy`/`luaSha1` catch a rebuild that drifted from (or doesn't match)
 * the recording; `clock`/`axis`/`policy` refuse a recording that is not deterministically replayable.
 */
export interface ReplayFingerprint {
  /** The declarative spec the limiter was built from. */
  readonly spec: LimiterSpec;
  /** Recorded strategy identity, cross-checked against the spec-rebuilt strategy. */
  readonly strategy: StrategyIdentity;
  /** Clock the recording ran on; replay refuses anything but `"manual"`. */
  readonly clock: ReplayClockSource;
  /** The replayable axis; always `"rate"` for a library recording. */
  readonly axis: ReplayAxis;
  /** A non-null admission policy (e.g. `"joint-lp"`) is refused; `null` for a plain leaf limiter. */
  readonly policy: string | null;
  /** SHA-1 of the strategy's Lua script when present (else `null`), so a drifted rebuild is caught. */
  readonly luaSha1: string | null;
  /** Key prefix at record time, so the rebuild reproduces the exact store keys. */
  readonly prefix?: string;
}

/** SHA-1 of a strategy's Lua program source, or `null` when the strategy carries no Lua form. */
export function luaSha1(strategy: Strategy): string | null {
  return strategy.lua ? createHash("sha1").update(strategy.lua.script).digest("hex") : null;
}

/**
 * Build the fingerprint for a freshly-built recording limiter. The recorder always supplies
 * `clock: "manual"` (it requires a {@link ManualClock}); `axis`/`policy` are the safe leaf-rate
 * values. A trace that needs to represent a non-replayable recording sets those fields directly.
 */
export function fingerprint(params: {
  spec: LimiterSpec;
  strategy: Strategy;
  clock: ReplayClockSource;
  prefix?: string;
}): ReplayFingerprint {
  const { spec, strategy, clock, prefix } = params;
  return {
    spec,
    strategy: {
      name: strategy.name,
      limit: strategy.limit,
      ...(strategy.windowMs !== undefined ? { windowMs: strategy.windowMs } : {}),
      ttlMs: strategy.ttlMs,
    },
    clock,
    axis: "rate",
    policy: null,
    luaSha1: luaSha1(strategy),
    ...(prefix !== undefined ? { prefix } : {}),
  };
}
