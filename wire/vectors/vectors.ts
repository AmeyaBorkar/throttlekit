/**
 * Golden conformance vectors — the language-neutral yardstick every ThrottleKit surface is checked
 * against (the Node library, the future gRPC service, and any polyglot client). See `wire/README.md`.
 *
 * The reference Node core is the **oracle**: each suite defines only the *inputs* (a strategy + a
 * scripted timeline of `(now, cost)` operations); the expected `Decision` for every op is produced by
 * running the shipped code path here, so the fixtures cannot be hand-computation-wrong. A cross-
 * language port replays the same inputs through *its* path (Lua-in-Redis, the service, …) and must
 * reproduce every `expect` byte-for-byte.
 *
 * `buildDocument()` is pure (no filesystem) so the conformance test can regenerate and diff it against
 * the committed `golden-vectors.json` — that diff is the lock that stops the Node wire behavior from
 * drifting silently. `wire/generate.ts` is the thin script that writes the JSON.
 */

import { tokenBudget } from "../../src/admission";
import { fixedWindow } from "../../src/algorithms/fixed-window";
import { gcra } from "../../src/algorithms/gcra";
import { slidingWindow } from "../../src/algorithms/sliding-window";
import { slidingWindowLog } from "../../src/algorithms/sliding-window-log";
import { tokenBucket } from "../../src/algorithms/token-bucket";
import { ManualClock } from "../../src/core/clock";
import { rateLimit } from "../../src/core/limiter";
import type { Decision, Strategy } from "../../src/core/types";
import { version } from "../../src/version";

/** The five frozen `Decision` fields, in their canonical order — the reply every port must match. */
export interface DecisionVector {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterMs: number;
}

/** A strategy + its options, language-neutrally (a port maps `kind` → its own constructor). */
type StrategySpec =
  | { kind: "gcra"; options: { limit: number; periodMs: number; burst: number } }
  | { kind: "tokenBucket"; options: { capacity: number; refillPerSec: number } }
  | { kind: "fixedWindow"; options: { limit: number; windowMs: number } }
  | { kind: "slidingWindow"; options: { limit: number; windowMs: number; buckets: number } }
  | { kind: "slidingWindowLog"; options: { limit: number; windowMs: number } };

interface RateLimitOp {
  /** Absolute epoch-ms the clock is set to before the check. */
  now: number;
  /** Units requested. */
  cost: number;
}

interface RateLimitSuite {
  primitive: "rateLimit";
  name: string;
  strategy: StrategySpec;
  /** Single hot key; state accumulates across the suite's ops. */
  key: string;
  ops: RateLimitOp[];
}

interface TokenBudgetOp {
  now: number;
  tokens: number;
}

interface TokenBudgetSuite {
  primitive: "tokenBudget";
  name: string;
  options: { budget: number; windowMs: number };
  ops: TokenBudgetOp[];
}

/** One op with the oracle-produced expected decision attached. */
type EmittedOp<Op> = Op & { expect: DecisionVector };

type EmittedSuite =
  | (Omit<RateLimitSuite, "ops"> & { ops: EmittedOp<RateLimitOp>[] })
  | (Omit<TokenBudgetSuite, "ops"> & { ops: EmittedOp<TokenBudgetOp>[] });

export interface VectorDocument {
  /**
   * The wire/contract version a client pins to. Bumped only on a *behavioral* break (a changed
   * `expect`); additive new suites do not bump it. Decoupled from the package version.
   */
  contractVersion: string;
  /** Provenance: the package version the oracle ran at. Informational, not part of the contract. */
  generatedFrom: string;
  /**
   * `false` until the raw wire is formally frozen (bet #78). Until then a polyglot client treats
   * these as an experimental, may-change contract. See `wire/README.md`.
   */
  frozen: boolean;
  /** The canonical `Decision` field order, echoed so a port can self-check its decoding. */
  decisionFields: ["allowed", "limit", "remaining", "resetAt", "retryAfterMs"];
  suites: EmittedSuite[];
}

// ── Canonical input suites ───────────────────────────────────────────────────────────────────────
// Timelines deliberately traverse the divergence-prone transitions: cold-burst exhaustion, steady
// pacing, denial + recovery, cost > 1, window rollover, fractional internal state (the `%.17g` TAT
// round-trip), and large real-epoch `now` values (the TTL-clamp regime).

const RATE_LIMIT_SUITES: RateLimitSuite[] = [
  {
    primitive: "rateLimit",
    name: "gcra/burst5-rate10ps",
    strategy: { kind: "gcra", options: { limit: 10, periodMs: 1000, burst: 5 } },
    key: "k",
    ops: [
      { now: 0, cost: 1 }, // cold bucket: 5 admitted instantly…
      { now: 0, cost: 1 },
      { now: 0, cost: 1 },
      { now: 0, cost: 1 },
      { now: 0, cost: 1 },
      { now: 0, cost: 1 }, // …6th denied (burst exhausted)
      { now: 100, cost: 1 }, // one emission interval later: one credit back
      { now: 100, cost: 1 }, // denied again
      { now: 1000, cost: 1 }, // fully idle → recovered
    ],
  },
  {
    primitive: "rateLimit",
    name: "gcra/fractional-T",
    // periodMs/limit = 1000/3 = 333.333…ms → a non-terminating T, exercising the %.17g TAT round-trip.
    strategy: { kind: "gcra", options: { limit: 3, periodMs: 1000, burst: 3 } },
    key: "k",
    ops: [
      { now: 0, cost: 1 },
      { now: 0, cost: 1 },
      { now: 0, cost: 1 },
      { now: 0, cost: 1 }, // denied
      { now: 334, cost: 1 }, // just past one fractional interval
      { now: 667, cost: 1 },
      { now: 1000, cost: 1 },
    ],
  },
  {
    primitive: "rateLimit",
    name: "gcra/cost-gt-1",
    strategy: { kind: "gcra", options: { limit: 100, periodMs: 1000, burst: 50 } },
    key: "k",
    ops: [
      { now: 0, cost: 10 },
      { now: 0, cost: 25 },
      { now: 0, cost: 20 }, // 55 > remaining 15 → denied
      { now: 0, cost: 15 }, // exactly fills
      { now: 500, cost: 5 },
    ],
  },
  {
    primitive: "rateLimit",
    name: "gcra/large-epoch",
    // A realistic wall-clock epoch, where naive `new_tat - now` math risks ULP/rounding surprises.
    strategy: { kind: "gcra", options: { limit: 60, periodMs: 60_000, burst: 10 } },
    key: "k",
    ops: [
      { now: 1_700_000_000_000, cost: 1 },
      { now: 1_700_000_000_000, cost: 1 },
      { now: 1_700_000_000_500, cost: 1 },
      { now: 1_700_000_060_000, cost: 1 },
    ],
  },
  {
    primitive: "rateLimit",
    name: "tokenBucket/cap10-refill5ps",
    strategy: { kind: "tokenBucket", options: { capacity: 10, refillPerSec: 5 } },
    key: "k",
    ops: [
      { now: 0, cost: 4 },
      { now: 0, cost: 6 }, // drains to 0
      { now: 0, cost: 1 }, // denied
      { now: 200, cost: 1 }, // 1 token refilled (5/sec → 1 per 200ms)
      { now: 1000, cost: 5 }, // 5 refilled over the second
      { now: 10_000, cost: 10 }, // long idle → capped at capacity, full burst
    ],
  },
  {
    primitive: "rateLimit",
    name: "tokenBucket/fractional-refill",
    strategy: { kind: "tokenBucket", options: { capacity: 7, refillPerSec: 3 } },
    key: "k",
    ops: [
      { now: 0, cost: 7 },
      { now: 0, cost: 1 }, // denied
      { now: 333, cost: 1 }, // ~1 token (3/sec)
      { now: 1000, cost: 3 },
    ],
  },
  {
    primitive: "rateLimit",
    name: "fixedWindow/limit5-1s",
    strategy: { kind: "fixedWindow", options: { limit: 5, windowMs: 1000 } },
    key: "k",
    ops: [
      { now: 0, cost: 1 },
      { now: 100, cost: 1 },
      { now: 200, cost: 3 }, // window total 5
      { now: 300, cost: 1 }, // denied (window full)
      { now: 1000, cost: 1 }, // new epoch-aligned window → reset
      { now: 1999, cost: 4 },
      { now: 2000, cost: 1 }, // next window
    ],
  },
  {
    primitive: "rateLimit",
    name: "slidingWindow/limit10-1s-10buckets",
    strategy: { kind: "slidingWindow", options: { limit: 10, windowMs: 1000, buckets: 10 } },
    key: "k",
    ops: [
      { now: 0, cost: 6 },
      { now: 500, cost: 4 }, // window total 10
      { now: 500, cost: 1 }, // denied
      { now: 1000, cost: 5 }, // earliest bucket rolls off → room
      { now: 1500, cost: 5 },
    ],
  },
  {
    primitive: "rateLimit",
    name: "slidingWindowLog/limit5-1s",
    strategy: { kind: "slidingWindowLog", options: { limit: 5, windowMs: 1000 } },
    key: "k",
    ops: [
      { now: 0, cost: 1 },
      { now: 100, cost: 1 },
      { now: 200, cost: 1 },
      { now: 300, cost: 1 },
      { now: 400, cost: 1 }, // 5 in the trailing second
      { now: 500, cost: 1 }, // denied
      { now: 1100, cost: 1 }, // the now=0..100 entries have aged out
    ],
  },
];

const TOKEN_BUDGET_SUITES: TokenBudgetSuite[] = [
  {
    primitive: "tokenBudget",
    name: "tokenBudget/per-token-to-L",
    // Debiting one token at a time stops exactly at L — overshoot Δ = 0.
    options: { budget: 5, windowMs: 60_000 },
    ops: [
      { now: 0, tokens: 1 },
      { now: 0, tokens: 1 },
      { now: 0, tokens: 1 },
      { now: 0, tokens: 1 },
      { now: 0, tokens: 1 }, // served reaches 5
      { now: 0, tokens: 1 }, // denied
    ],
  },
  {
    primitive: "tokenBudget",
    name: "tokenBudget/crossing-debit",
    // The stop-at-boundary contract: a chunk admitted while budget remains is counted in full, so the
    // crossing debit overshoots by up to tokens-1; the *next* debit is refused. (Pins the proven
    // semantics surfaced as a question against `debitSync`.)
    options: { budget: 100, windowMs: 60_000 },
    ops: [
      { now: 0, tokens: 80 },
      { now: 0, tokens: 50 }, // served 80 < 100 → admitted in full → served 130
      { now: 0, tokens: 1 }, // served 130 >= 100 → refused
    ],
  },
  {
    primitive: "tokenBudget",
    name: "tokenBudget/window-roll",
    options: { budget: 10, windowMs: 1000 },
    ops: [
      { now: 0, tokens: 10 },
      { now: 500, tokens: 1 }, // budget spent this window → denied
      { now: 1000, tokens: 6 }, // fresh epoch-aligned window
      { now: 1999, tokens: 4 },
      { now: 2000, tokens: 1 }, // next window
    ],
  },
];

// ── Oracle: run the inputs through the shipped Node core ────────────────────────────────────────

function decisionVector(d: Decision): DecisionVector {
  // Explicit field order → byte-stable serialization across regenerations.
  return {
    allowed: d.allowed,
    limit: d.limit,
    remaining: d.remaining,
    resetAt: d.resetAt,
    retryAfterMs: d.retryAfterMs,
  };
}

function buildStrategy(spec: StrategySpec): Strategy {
  switch (spec.kind) {
    case "gcra":
      return gcra(spec.options) as Strategy;
    case "tokenBucket":
      return tokenBucket(spec.options) as Strategy;
    case "fixedWindow":
      return fixedWindow(spec.options) as Strategy;
    case "slidingWindow":
      return slidingWindow(spec.options) as Strategy;
    case "slidingWindowLog":
      return slidingWindowLog(spec.options) as Strategy;
  }
}

function runRateLimitSuite(suite: RateLimitSuite): EmittedOp<RateLimitOp>[] {
  const clock = new ManualClock(0);
  const limiter = rateLimit({ strategy: buildStrategy(suite.strategy), clock });
  return suite.ops.map((op) => {
    clock.set(op.now);
    return { ...op, expect: decisionVector(limiter.checkSync(suite.key, op.cost)) };
  });
}

function runTokenBudgetSuite(suite: TokenBudgetSuite): EmittedOp<TokenBudgetOp>[] {
  const clock = new ManualClock(0);
  const meter = tokenBudget({
    budget: suite.options.budget,
    windowMs: suite.options.windowMs,
    clock,
  });
  return suite.ops.map((op) => {
    clock.set(op.now);
    return { ...op, expect: decisionVector(meter.debitSync(op.tokens)) };
  });
}

/** Produce the full, oracle-filled vector document. Pure — safe to call from tests. */
export function buildDocument(): VectorDocument {
  const suites: EmittedSuite[] = [
    ...RATE_LIMIT_SUITES.map((s) => ({ ...s, ops: runRateLimitSuite(s) })),
    ...TOKEN_BUDGET_SUITES.map((s) => ({ ...s, ops: runTokenBudgetSuite(s) })),
  ];
  return {
    contractVersion: "1",
    generatedFrom: `throttlekit@${version}`,
    frozen: false,
    decisionFields: ["allowed", "limit", "remaining", "resetAt", "retryAfterMs"],
    suites,
  };
}
