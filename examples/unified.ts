/**
 * Unified admission — one decision across rate / concurrency / cost.
 *
 * The LLM-gateway canonical example. A chat-completion request must
 * clear three orthogonal admissions:
 *
 *   - rate        — req/min against the provider's RPM quota
 *   - concurrency — one inference seat held for ~5–30 s
 *   - cost        — tokens against the provider's TPM quota
 *
 * Today these are stacked as three separate middleware checks. With
 * `unifiedAdmission(...)` they become ONE decision: AND on `allowed`,
 * MIN on `limit`/`remaining`, MAX on `resetAt`/`retryAfterMs`. See
 * `research/bigger-bets/unified/DESIGN.md` §4.1 for the algebra.
 *
 * Lifecycle: `admit()` returns `{ decision, release }`. On admit,
 * wire `release()` to your request lifecycle (`res.on("finish", release)`,
 * a `finally` block, etc.) — this returns the concurrency slot when
 * the work finishes. `release({ dropped: true })` signals an overload
 * (timeout / error), contracting the adaptive concurrency limit.
 *
 * Run with:  npx tsx examples/unified.ts
 */

import {
  ManualClock,
  adaptiveConcurrency,
  gcra,
  rateLimit,
  tokenBucket,
  unifiedAdmission,
} from "../src/index";
import { bindingAxisOf } from "../src/observability";

function llmGatewayScenario(): void {
  const clock = new ManualClock(0);

  // Three axes for an LLM gateway:
  //   rate         — 60 req/min against the provider's RPM quota
  //   concurrency  — at most 4 in-flight completions (adaptive ceiling)
  //   cost         — 100k tokens/min against the provider's TPM quota
  const admit = unifiedAdmission({
    rate: rateLimit({ strategy: gcra({ limit: 60, periodMs: 60_000 }), clock }),
    concurrency: adaptiveConcurrency({ clock, minLimit: 4, initialLimit: 4, maxLimit: 4 }),
    cost: rateLimit({
      strategy: tokenBucket({ capacity: 100_000, refillPerSec: 100_000 / 60 }),
      clock,
    }),
    clock, // pass through so the lease-shim's Decision.resetAt is on the same clock
  });

  // Workload: a mix of "small" calls (200 tokens) and "large" calls (8000 tokens).
  // The concurrency cap of 4 binds first (we only release after each "call").
  const calls = [
    { tenant: "alice", tokens: 200 },
    { tenant: "alice", tokens: 200 },
    { tenant: "bob", tokens: 8_000 },
    { tenant: "alice", tokens: 200 },
    { tenant: "bob", tokens: 8_000 },
    { tenant: "carol", tokens: 200 },
  ];

  // ── Synchronous demo. All axes are in-process here (MemoryStore + adaptiveConcurrency),
  //    so admitSync works. In a Redis deployment, use the async `await admit.admit(...)`.
  const heldReleases: Array<() => void> = [];
  for (const call of calls) {
    const { decision, release } = admit.admitSync({ key: call.tenant, cost: call.tokens });
    if (decision.allowed) {
      heldReleases.push(release);
      console.log(
        `✓ admit ${call.tenant} ${call.tokens} tok → limit=${decision.limit} remaining=${decision.remaining}`,
      );
    } else {
      // OBSERVABILITY: which axis bound this decision?
      const axis = bindingAxisOf(admit.lastDecisions());
      console.log(
        `✗ deny  ${call.tenant} ${call.tokens} tok → binding=${axis ?? "?"} retryAfter=${decision.retryAfterMs}ms`,
      );
    }
  }

  // Release every held slot (simulating completed work).
  console.log(`releasing ${heldReleases.length} held concurrency slots`);
  for (const r of heldReleases) r();

  // After releasing, more admits succeed (concurrency slots free).
  for (const call of calls.slice(0, 2)) {
    const { decision, release } = admit.admitSync({ key: call.tenant, cost: call.tokens });
    if (decision.allowed) {
      console.log(`✓ re-admit ${call.tenant} after releases`);
      release();
    }
  }

  console.log("\nFinal per-axis decisions (lastDecisions snapshot):");
  console.log(JSON.stringify(admit.lastDecisions(), null, 2));
}

/** Async / Express-style usage shape. Not executed in this demo. */
function asyncShape(): void {
  void (async () => {
    const admit = unifiedAdmission({
      rate: rateLimit({ strategy: gcra({ limit: 60, periodMs: 60_000 }) }),
      concurrency: adaptiveConcurrency({ minLimit: 4, maxLimit: 16 }),
      cost: rateLimit({ strategy: tokenBucket({ capacity: 100_000, refillPerSec: 1_667 }) }),
    });

    // In an express handler:
    //   app.post("/completions", async (req, res, next) => {
    //     const { decision, release } = await admit.admit({
    //       key: req.user.id,
    //       cost: req.body.maxTokens ?? 1000,
    //     });
    //     if (!decision.allowed) {
    //       res.setHeader("Retry-After", Math.ceil(decision.retryAfterMs / 1000));
    //       res.status(429).json({
    //         error: "rate_limited",
    //         retryAfterMs: decision.retryAfterMs,
    //         bindingAxis: bindingAxisOf(admit.lastDecisions()),
    //       });
    //       return;
    //     }
    //     // Wire release to res.on("finish") so the concurrency slot
    //     // frees when the response completes. Idempotent — safe to
    //     // also call from an error handler.
    //     res.on("finish", () => release({ dropped: false }));
    //     res.on("close", () => release({ dropped: true }));  // client hung up
    //     try { await callLLM(req.body); } catch (err) { next(err); }
    //   });
    const { decision, release } = await admit.admit({ key: "u1", cost: 1500 });
    console.log("async shape: decision =", decision);
    release();
  })();
}

llmGatewayScenario();
asyncShape();
