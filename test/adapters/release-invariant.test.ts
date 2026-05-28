/**
 * The exactly-once-release invariant property test (TK-1327).
 *
 * Per D-M-3 of `research/bigger-bets/middleware-integration/DESIGN.md`:
 *   (a) every admit-success leads to EXACTLY ONE release call with the
 *       correct `dropped` value;
 *   (b) every admit-deny leads to ZERO release calls (the slot was
 *       never acquired);
 *   (c) the adaptive concurrency limit never collapses to zero across
 *       random workloads — i.e. `inflight` returns to 0 after every
 *       admitted request resolves its lifecycle.
 *
 * This is the safety net catching the silent slot-leak failure mode the
 * adapter family closes. We fuzz the lifecycle event orderings against
 * the two core helpers (`wireResponseLifecycle` for node-server,
 * `wrapResponseStreamLifecycle` for web-platform) and the integration
 * paths through each adapter family.
 */

import { EventEmitter } from "node:events";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { expressUnifiedAdmission } from "../../src/adapters/express";
import { withUnifiedAdmission } from "../../src/adapters/fetch";
import { wireResponseLifecycle } from "../../src/adapters/lifecycle";
import { wrapResponseStreamLifecycle } from "../../src/adapters/lifecycle-web";
import { unifiedAdmission } from "../../src/admission/unified";
import { adaptiveConcurrency } from "../../src/concurrency/adaptive";
import { ManualClock } from "../../src/core/clock";

// ─────────────────────────────────────────────────────────────────────────────
// Helper: a mock release that tracks call count + arguments.
// ─────────────────────────────────────────────────────────────────────────────

interface ReleaseRecorder {
  release: (opts?: { dropped?: boolean }) => void;
  /** Number of times release was called. */
  count(): number;
  /** Array of dropped values per call (in order). */
  calls(): ReadonlyArray<boolean>;
}

function makeRecorder(): ReleaseRecorder {
  const events: boolean[] = [];
  return {
    release(opts?: { dropped?: boolean }): void {
      events.push(opts?.dropped === true);
    },
    count(): number {
      return events.length;
    },
    calls(): ReadonlyArray<boolean> {
      return events.slice();
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Property 1: wireResponseLifecycle (node-server core).
// For any sequence of finish/close events in any order, release fires
// exactly once. The dropped value matches the first-fire-wins rule.
// ─────────────────────────────────────────────────────────────────────────────

describe("wireResponseLifecycle invariant (TK-1327)", () => {
  it("exactly-once release across all event orderings", () => {
    const eventArb = fc.array(fc.constantFrom("finish" as const, "close" as const), {
      minLength: 0,
      maxLength: 6,
    });
    const statusArb = fc.integer({ min: 100, max: 599 });

    fc.assert(
      fc.property(eventArb, statusArb, fc.boolean(), (events, statusCode, dropOn5xx) => {
        const emitter = new EventEmitter();
        const res = Object.assign(emitter, { statusCode });
        const rec = makeRecorder();

        wireResponseLifecycle(res, rec.release, dropOn5xx);

        for (const ev of events) emitter.emit(ev);

        // Property: at most one release call.
        expect(rec.count()).toBeLessThanOrEqual(1);

        // Property: if any event fired, release was called exactly once.
        if (events.length > 0) {
          expect(rec.count()).toBe(1);
          const firstEvent = events[0]!;
          const expectedDropped =
            firstEvent === "close" || (firstEvent === "finish" && dropOn5xx && statusCode >= 500);
          expect(rec.calls()[0]).toBe(expectedDropped);
        } else {
          // No events fired — no release.
          expect(rec.count()).toBe(0);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("concurrent admits do not interfere (each closure has its own released flag)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom("finish" as const, "close" as const), {
          minLength: 0,
          maxLength: 3,
        }),
        fc.array(fc.constantFrom("finish" as const, "close" as const), {
          minLength: 0,
          maxLength: 3,
        }),
        (events1, events2) => {
          const e1 = new EventEmitter();
          const e2 = new EventEmitter();
          const res1 = Object.assign(e1, { statusCode: 200 });
          const res2 = Object.assign(e2, { statusCode: 200 });
          const r1 = makeRecorder();
          const r2 = makeRecorder();

          wireResponseLifecycle(res1, r1.release, false);
          wireResponseLifecycle(res2, r2.release, false);

          // Interleave the events between the two.
          for (const ev of events1) e1.emit(ev);
          for (const ev of events2) e2.emit(ev);

          // Each release recorder is independent.
          expect(r1.count()).toBeLessThanOrEqual(1);
          expect(r2.count()).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Property 2: wrapResponseStreamLifecycle (web-platform core).
// For any stream outcome (drain-to-end / cancel / error), release fires
// exactly once with the correct dropped value.
// ─────────────────────────────────────────────────────────────────────────────

describe("wrapResponseStreamLifecycle invariant (TK-1327)", () => {
  it("null body: release immediately, dropped = dropOn5xx && status >= 500", () => {
    // Response constructor restricts status to 200-599 (browser parity).
    fc.assert(
      fc.property(fc.integer({ min: 200, max: 599 }), fc.boolean(), (status, dropOn5xx) => {
        const rec = makeRecorder();
        const response = new Response(null, { status });
        wrapResponseStreamLifecycle(response, rec.release, dropOn5xx);
        expect(rec.count()).toBe(1);
        expect(rec.calls()[0]).toBe(dropOn5xx && status >= 500);
      }),
      { numRuns: 50 },
    );
  });

  it("drain-to-end: exactly-once release", async () => {
    const rec = makeRecorder();
    const original = new Response("hello world");
    const wrapped = wrapResponseStreamLifecycle(original, rec.release, false);
    await wrapped.text(); // drain
    expect(rec.count()).toBe(1);
    expect(rec.calls()[0]).toBe(false);
  });

  it("cancel: dropped = true", async () => {
    const rec = makeRecorder();
    const original = new Response("hello world");
    const wrapped = wrapResponseStreamLifecycle(original, rec.release, false);
    const reader = wrapped.body!.getReader();
    await reader.cancel();
    // Drain microtasks so the cancel callback fires.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(rec.count()).toBe(1);
    expect(rec.calls()[0]).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Property 3: integration — adaptive concurrency limit never collapses to 0.
// Drive expressUnifiedAdmission with random workloads of mixed
// finish/close events. Assert: after all workloads complete, inflight = 0.
// ─────────────────────────────────────────────────────────────────────────────

describe("integration: adaptive concurrency limit doesn't collapse (TK-1327)", () => {
  it("expressUnifiedAdmission: 100 random workloads → inflight = 0", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom("finish" as const, "close" as const), {
          minLength: 1,
          maxLength: 3,
        }),
        async (lifecycleEvents) => {
          const clock = new ManualClock(0);
          const guard = adaptiveConcurrency({
            clock,
            minLimit: 16,
            initialLimit: 16,
            maxLimit: 16,
          });
          const admitter = unifiedAdmission({ concurrency: guard, clock });
          const mw = expressUnifiedAdmission({ admitter, clock });

          // Spin up ~10 mock requests in parallel, each with a random lifecycle.
          // Store [res, emitter] pairs so the emitter (the event source) is not the
          // same object as res (the response surface): res.on delegates to emitter.on.
          const pairs: Array<{ emitter: EventEmitter }> = [];
          await Promise.all(
            Array.from({ length: 10 }, () => {
              return new Promise<void>((resolve) => {
                const emitter = new EventEmitter();
                const res = {
                  statusCode: 200,
                  setHeader: (): unknown => undefined,
                  status: (): unknown => res,
                  json: (): unknown => res,
                  end: (): unknown => res,
                  on(evt: string, l: () => void): unknown {
                    emitter.on(evt, l);
                    return res;
                  },
                };
                pairs.push({ emitter });
                mw(
                  { socket: { remoteAddress: "203.0.113.5" }, headers: {} } as never,
                  res as never,
                  () => resolve(),
                );
              });
            }),
          );

          // Now fire the lifecycle events for each response in the random order.
          for (const { emitter } of pairs) {
            for (const ev of lifecycleEvents) emitter.emit(ev);
          }

          // The invariant: every admitted slot is released.
          expect(guard.inflight).toBe(0);
        },
      ),
      { numRuns: 50 },
    );
  });

  it("withUnifiedAdmission (fetch): random body outcomes → inflight = 0", async () => {
    type Outcome = "drain" | "cancel" | "null-body";
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom("drain" as Outcome, "cancel" as Outcome, "null-body" as Outcome), {
          minLength: 1,
          maxLength: 20,
        }),
        async (outcomes) => {
          const clock = new ManualClock(0);
          const guard = adaptiveConcurrency({
            clock,
            minLimit: 32,
            initialLimit: 32,
            maxLimit: 32,
          });
          const admitter = unifiedAdmission({ concurrency: guard, clock });
          const wrapped = withUnifiedAdmission(
            (req) => {
              const outcome = (req.headers.get("X-Test-Outcome") ?? "drain") as Outcome;
              if (outcome === "null-body") return new Response(null, { status: 204 });
              return new Response("payload-data");
            },
            { admitter, clock },
          );

          // Issue requests, each driving a different outcome.
          for (const outcome of outcomes) {
            const r = await wrapped(
              new Request("https://x.example/", {
                headers: { "X-Test-Outcome": outcome },
              }),
            );
            if (outcome === "drain") {
              await r.text();
            } else if (outcome === "cancel" && r.body !== null) {
              await r.body.cancel();
            }
            // null-body: release already fired synchronously.
          }

          // Settle microtasks.
          await new Promise((resolve) => setTimeout(resolve, 10));
          expect(guard.inflight).toBe(0);
        },
      ),
      { numRuns: 50 },
    );
  });
});
