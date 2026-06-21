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
import { LeaseSpender } from "../../src/twotier/lease-spender";
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

// ── Tier-2 fleet-lease suites ─────────────────────────────────────────────────────────────────────
// The client-side, window-coupled spend of a leased budget — the `LeaseSpender`, a verbatim port of the
// `twoTier(leased, windowCoupled)` L1 path. A suite scripts an interleaving of `grant` events (a
// `Fleet.Reserve` response landing) and `spend` events (one local request); the oracle fills each spend's
// outcome — a synthesized allow, or `needsRefresh` (out of local credits ⇒ the client must Reserve). A
// denial is NOT modelled here: the client never synthesizes one (it surfaces the server's verbatim), so
// the post-exhaustion deny + retryAfterMs is pinned by the server's `Fleet.Reserve` test, not these vectors.

/** A granted lease landed: `capacity` units valid until the `expiresAt` window boundary (epoch-ms). */
export interface LeaseGrantEvent {
  op: "grant";
  capacity: number;
  expiresAt: number;
}

/** One local spend attempt of `cost` units at `now` (epoch-ms). */
export interface LeaseSpendEvent {
  op: "spend";
  now: number;
  cost: number;
}

type LeaseEvent = LeaseGrantEvent | LeaseSpendEvent;

/** The oracle outcome of a spend: a synthesized allow (with its Decision), or a refresh signal (no Decision). */
export type LeaseSpendVector =
  | { needsRefresh: false; decision: DecisionVector }
  | { needsRefresh: true };

interface LeaseSuite {
  primitive: "lease";
  name: string;
  /** The synthesized allow's `limit` (the strategy ceiling / global per-window budget). */
  limit: number;
  /** Fallback `resetAt` when no lease has been applied yet (rarely reached; see `LeaseSpender`). */
  ttlMs: number;
  /** Discard credits once their granting window rolls — the safe default the Tier-2 lease is built on. */
  windowCoupled: boolean;
  events: LeaseEvent[];
}

/** One op with the oracle-produced expected decision attached. */
type EmittedOp<Op> = Op & { expect: DecisionVector };

/** A spend event with its oracle-produced outcome attached; a grant event passes through unchanged. */
export type EmittedLeaseEvent = LeaseGrantEvent | (LeaseSpendEvent & { expect: LeaseSpendVector });

type EmittedSuite =
  | (Omit<RateLimitSuite, "ops"> & { ops: EmittedOp<RateLimitOp>[] })
  | (Omit<TokenBudgetSuite, "ops"> & { ops: EmittedOp<TokenBudgetOp>[] })
  | (Omit<LeaseSuite, "events"> & { events: EmittedLeaseEvent[] });

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
    // Timeline starts at 1000, not 0: a raw-Lua port replays each op with ARGV[1]=now, and the vendored
    // check scripts read ARGV[1]=0 as the "use Redis server TIME" sentinel — a now=0 op is unreproducible.
    // The whole timeline is offset by a constant (a full periodMs here), so only the absolute resetAt
    // shifts; allowed/remaining/retryAfterMs are skew-free and unchanged.
    ops: [
      { now: 1000, cost: 1 }, // cold bucket: 5 admitted instantly…
      { now: 1000, cost: 1 },
      { now: 1000, cost: 1 },
      { now: 1000, cost: 1 },
      { now: 1000, cost: 1 },
      { now: 1000, cost: 1 }, // …6th denied (burst exhausted)
      { now: 1100, cost: 1 }, // one emission interval later: one credit back
      { now: 1100, cost: 1 }, // denied again
      { now: 2000, cost: 1 }, // fully idle → recovered
    ],
  },
  {
    primitive: "rateLimit",
    name: "gcra/fractional-T",
    // periodMs/limit = 1000/3 = 333.333…ms → a non-terminating T, exercising the %.17g TAT round-trip.
    strategy: { kind: "gcra", options: { limit: 3, periodMs: 1000, burst: 3 } },
    key: "k",
    // Offset by a full periodMs so no op is now=0 (the Lua server-clock sentinel); decisions are unchanged.
    ops: [
      { now: 1000, cost: 1 },
      { now: 1000, cost: 1 },
      { now: 1000, cost: 1 },
      { now: 1000, cost: 1 }, // denied
      { now: 1334, cost: 1 }, // just past one fractional interval
      { now: 1667, cost: 1 },
      { now: 2000, cost: 1 },
    ],
  },
  {
    primitive: "rateLimit",
    name: "gcra/cost-gt-1",
    strategy: { kind: "gcra", options: { limit: 100, periodMs: 1000, burst: 50 } },
    key: "k",
    // Offset by a full periodMs so no op is now=0 (the Lua server-clock sentinel); decisions are unchanged.
    ops: [
      { now: 1000, cost: 10 },
      { now: 1000, cost: 25 },
      { now: 1000, cost: 20 }, // 55 > remaining 15 → denied
      { now: 1000, cost: 15 }, // exactly fills
      { now: 1500, cost: 5 },
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
    // Offset by a constant so no op is now=0 (the Lua server-clock sentinel); refill is elapsed-time
    // based, so only resetAt shifts.
    ops: [
      { now: 1000, cost: 4 },
      { now: 1000, cost: 6 }, // drains to 0
      { now: 1000, cost: 1 }, // denied
      { now: 1200, cost: 1 }, // 1 token refilled (5/sec → 1 per 200ms)
      { now: 2000, cost: 5 }, // 5 refilled over the second
      { now: 11_000, cost: 10 }, // long idle → capped at capacity, full burst
    ],
  },
  {
    primitive: "rateLimit",
    name: "tokenBucket/fractional-refill",
    strategy: { kind: "tokenBucket", options: { capacity: 7, refillPerSec: 3 } },
    key: "k",
    // Offset by a constant so no op is now=0 (the Lua server-clock sentinel); only resetAt shifts.
    ops: [
      { now: 1000, cost: 7 },
      { now: 1000, cost: 1 }, // denied
      { now: 1333, cost: 1 }, // ~1 token (3/sec)
      { now: 2000, cost: 3 },
    ],
  },
  {
    primitive: "rateLimit",
    name: "fixedWindow/limit5-1s",
    strategy: { kind: "fixedWindow", options: { limit: 5, windowMs: 1000 } },
    key: "k",
    // Offset by a FULL windowMs so no op is now=0 (the Lua server-clock sentinel): a whole-window shift
    // preserves each op's epoch-aligned window membership exactly, so only the absolute resetAt shifts.
    ops: [
      { now: 1000, cost: 1 },
      { now: 1100, cost: 1 },
      { now: 1200, cost: 3 }, // window total 5
      { now: 1300, cost: 1 }, // denied (window full)
      { now: 2000, cost: 1 }, // new epoch-aligned window → reset
      { now: 2999, cost: 4 },
      { now: 3000, cost: 1 }, // next window
    ],
  },
  {
    primitive: "rateLimit",
    name: "slidingWindow/limit10-1s-10buckets",
    strategy: { kind: "slidingWindow", options: { limit: 10, windowMs: 1000, buckets: 10 } },
    key: "k",
    // Offset by a FULL windowMs (a whole number of sub-buckets) so no op is now=0 (the Lua server-clock
    // sentinel): the bucket-ring alignment and per-bucket weights are preserved, so only resetAt shifts.
    ops: [
      { now: 1000, cost: 6 },
      { now: 1500, cost: 4 }, // window total 10
      { now: 1500, cost: 1 }, // denied
      { now: 2000, cost: 5 }, // earliest bucket rolls off → room
      { now: 2500, cost: 5 },
    ],
  },
  {
    primitive: "rateLimit",
    name: "slidingWindowLog/limit5-1s",
    strategy: { kind: "slidingWindowLog", options: { limit: 5, windowMs: 1000 } },
    key: "k",
    // Offset by a constant so no op is now=0 (the Lua server-clock sentinel): the trailing window depends
    // only on relative time (windowStart = now - windowMs), so only the absolute resetAt shifts.
    ops: [
      { now: 1000, cost: 1 },
      { now: 1100, cost: 1 },
      { now: 1200, cost: 1 },
      { now: 1300, cost: 1 },
      { now: 1400, cost: 1 }, // 5 in the trailing second
      { now: 1500, cost: 1 }, // denied
      { now: 2100, cost: 1 }, // the now=1000..1100 entries have aged out
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

const LEASE_SUITES: LeaseSuite[] = [
  {
    primitive: "lease",
    name: "lease/spend-to-exhaustion",
    // Serve a granted batch down to exactly 0 (overshoot Δ = 0 at the boundary), then signal a refresh.
    limit: 5,
    ttlMs: 1000,
    windowCoupled: true,
    events: [
      { op: "grant", capacity: 5, expiresAt: 1000 },
      { op: "spend", now: 0, cost: 1 }, // remaining 4
      { op: "spend", now: 0, cost: 1 },
      { op: "spend", now: 0, cost: 1 },
      { op: "spend", now: 0, cost: 1 },
      { op: "spend", now: 0, cost: 1 }, // exact exhaustion → remaining 0
      { op: "spend", now: 0, cost: 1 }, // out of credits → needsRefresh
    ],
  },
  {
    primitive: "lease",
    name: "lease/refresh-mid-window",
    // A refresh arriving inside the same window tops credits back up and serving resumes.
    limit: 3,
    ttlMs: 1000,
    windowCoupled: true,
    events: [
      { op: "grant", capacity: 3, expiresAt: 1000 },
      { op: "spend", now: 0, cost: 1 },
      { op: "spend", now: 0, cost: 1 },
      { op: "spend", now: 0, cost: 1 }, // remaining 0
      { op: "spend", now: 0, cost: 1 }, // needsRefresh
      { op: "grant", capacity: 3, expiresAt: 1000 }, // same-window refresh
      { op: "spend", now: 0, cost: 1 }, // remaining 2, resetAt still 1000
      { op: "spend", now: 500, cost: 1 }, // remaining 1
    ],
  },
  {
    primitive: "lease",
    name: "lease/window-coupled-discard",
    // Once the granting window rolls, the remaining credits are DISCARDED (not carried) — the sole source
    // of leased overshoot, removed. A fresh grant for the next window then serves.
    limit: 5,
    ttlMs: 1000,
    windowCoupled: true,
    events: [
      { op: "grant", capacity: 5, expiresAt: 1000 },
      { op: "spend", now: 0, cost: 2 }, // remaining 3
      { op: "spend", now: 1000, cost: 1 }, // now >= expiry → discard the 3 → needsRefresh
      { op: "grant", capacity: 5, expiresAt: 2000 }, // next window
      { op: "spend", now: 1000, cost: 1 }, // remaining 4, resetAt 2000
      { op: "spend", now: 2000, cost: 1 }, // now >= expiry → discard the 4 → needsRefresh
    ],
  },
  {
    primitive: "lease",
    name: "lease/cost-gt-1-and-gt-capacity",
    // cost > 1 spends in whole chunks; a cost that exceeds the local credits cannot be served from them
    // (needsRefresh) — even right after a too-small grant — until a grant large enough lands.
    limit: 100,
    ttlMs: 1000,
    windowCoupled: true,
    events: [
      { op: "grant", capacity: 10, expiresAt: 1000 },
      { op: "spend", now: 0, cost: 4 }, // remaining 6
      { op: "spend", now: 0, cost: 6 }, // remaining 0
      { op: "spend", now: 0, cost: 1 }, // needsRefresh
      { op: "grant", capacity: 5, expiresAt: 1000 }, // credits 5
      { op: "spend", now: 0, cost: 8 }, // cost 8 > credits 5 → needsRefresh
      { op: "grant", capacity: 10, expiresAt: 1000 }, // credits 15
      { op: "spend", now: 0, cost: 8 }, // remaining 7
      { op: "spend", now: 0, cost: 8 }, // credits 7 < 8 → needsRefresh
    ],
  },
  {
    primitive: "lease",
    name: "lease/large-epoch",
    // Realistic wall-clock epochs, where naive boundary math risks ULP/rounding surprises.
    limit: 60,
    ttlMs: 60_000,
    windowCoupled: true,
    events: [
      { op: "grant", capacity: 10, expiresAt: 1_700_000_040_000 },
      { op: "spend", now: 1_700_000_000_000, cost: 4 }, // remaining 6
      { op: "spend", now: 1_700_000_040_000, cost: 1 }, // now >= expiry → discard → needsRefresh
      { op: "grant", capacity: 10, expiresAt: 1_700_000_100_000 },
      { op: "spend", now: 1_700_000_040_000, cost: 1 }, // remaining 9, resetAt 1_700_000_100_000
    ],
  },
  {
    primitive: "lease",
    name: "lease/carry-over-when-not-coupled",
    // The legacy contrast: with windowCoupled:false the credits CARRY across the boundary and the stale
    // resetAt is retained until the next grant — pinned so the coupling toggle's effect can't drift.
    limit: 5,
    ttlMs: 1000,
    windowCoupled: false,
    events: [
      { op: "grant", capacity: 5, expiresAt: 1000 },
      { op: "spend", now: 0, cost: 2 }, // remaining 3, resetAt 1000
      { op: "spend", now: 2000, cost: 1 }, // no discard → remaining 2, resetAt still 1000
      { op: "spend", now: 2000, cost: 2 }, // remaining 0
      { op: "spend", now: 2000, cost: 1 }, // needsRefresh
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

/** Replay a lease suite through the {@link LeaseSpender} oracle, attaching each spend's outcome. */
function runLeaseSuite(suite: LeaseSuite): EmittedLeaseEvent[] {
  const spender = new LeaseSpender({
    limit: suite.limit,
    ttlMs: suite.ttlMs,
    windowCoupled: suite.windowCoupled,
  });
  return suite.events.map((ev) => {
    if (ev.op === "grant") {
      spender.applyLease({ capacity: ev.capacity, expiresAt: ev.expiresAt });
      return ev;
    }
    const r = spender.spend(ev.now, ev.cost);
    const expect: LeaseSpendVector = r.needsRefresh
      ? { needsRefresh: true }
      : { needsRefresh: false, decision: decisionVector(r.decision) };
    return { ...ev, expect };
  });
}

/** Produce the full, oracle-filled vector document. Pure — safe to call from tests. */
export function buildDocument(): VectorDocument {
  const suites: EmittedSuite[] = [
    ...RATE_LIMIT_SUITES.map((s) => ({ ...s, ops: runRateLimitSuite(s) })),
    ...TOKEN_BUDGET_SUITES.map((s) => ({ ...s, ops: runTokenBudgetSuite(s) })),
    ...LEASE_SUITES.map((s) => ({ ...s, events: runLeaseSuite(s) })),
  ];
  return {
    contractVersion: "1",
    generatedFrom: `throttlekit@${version}`,
    frozen: false,
    decisionFields: ["allowed", "limit", "remaining", "resetAt", "retryAfterMs"],
    suites,
  };
}
