/**
 * Zero-config, in-process traffic analytics (withAnalytics).
 *
 * Wrap any limiter to get allow/deny counts and bounded-memory top-K "heavy hitters" for the
 * current window — no OpenTelemetry backend, no peer dependency. Top-K uses Space-Saving, so memory
 * is bounded by `topK` even under a flood of unique keys, and it never drops a genuine heavy hitter.
 *
 * Run with:  npx tsx examples/analytics.ts
 */

import { ManualClock, gcra, rateLimit, withAnalytics } from "../src/index";

const clock = new ManualClock(0);

// A tight limit so we generate denials to observe. withAnalytics is a drop-in Limiter: same
// check/checkSync/reset, plus analytics() and resetAnalytics().
const limiter = withAnalytics(
  rateLimit({ strategy: gcra({ limit: 3, periodMs: 60_000 }), clock }),
  { topK: 5, windowMs: 60_000, clock },
);

// One abusive client far over its limit, plus a couple of well-behaved ones.
for (let i = 0; i < 10; i++) limiter.checkSync("198.51.100.7"); // 3 allowed, 7 denied
for (let i = 0; i < 2; i++) limiter.checkSync("203.0.113.9"); // both allowed
limiter.checkSync("203.0.113.10"); // allowed

const snap = limiter.analytics();
console.log("window:", { allowed: snap.allowed, denied: snap.denied, total: snap.total });
console.log("denyRate:", snap.denyRate.toFixed(3));
console.log("topRequested:", snap.topRequested.map((h) => `${h.key}=${h.count}`).join(", "));
console.log("topDenied:", snap.topDenied.map((h) => `${h.key}=${h.count}`).join(", "));

// Windows are fixed and epoch-aligned: crossing windowMs starts a fresh snapshot.
clock.advance(60_000);
console.log("after window roll, total:", limiter.analytics().total);
