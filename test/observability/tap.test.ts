import { describe, expect, it } from "vitest";
import { gcra } from "../../src/algorithms/gcra";
import { withAnalytics } from "../../src/analytics";
import { ManualClock } from "../../src/core/clock";
import { rateLimit } from "../../src/core/limiter";
import type { Limiter } from "../../src/core/types";
import { type DecisionEvent, tapDecisions } from "../../src/observability/tap";
import { MemoryStore } from "../../src/stores/memory";

function base(): Limiter {
  const clock = new ManualClock(1_000);
  return rateLimit({
    strategy: gcra({ limit: 3, periodMs: 1000 }),
    clock,
    store: new MemoryStore({ clock, sweepIntervalMs: 0 }),
  });
}

describe("tapDecisions", () => {
  it("fires once per check with a complete event, and returns the decision unchanged", async () => {
    const events: DecisionEvent[] = [];
    const limiter = tapDecisions(base(), (e) => events.push(e));

    const d = await limiter.check("k", 2);
    expect(d.allowed).toBe(true);
    expect(events).toHaveLength(1);
    const [e] = events;
    expect(e?.key).toBe("k");
    expect(e?.cost).toBe(2);
    expect(e?.strategy).toBe("gcra");
    expect(e?.kind).toBe("check");
    expect(e?.decision).toEqual(d);
    expect(e?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("covers sync, async, and batch paths with the right kind", async () => {
    const events: DecisionEvent[] = [];
    const limiter = tapDecisions(base(), (e) => events.push(e));
    limiter.checkSync("a");
    await limiter.check("b");
    await limiter.checkMany(["c", "d"]);
    limiter.checkManySync(["e", "f"]);
    expect(events.map((e) => e.kind)).toEqual([
      "checkSync",
      "check",
      "checkMany",
      "checkMany",
      "checkManySync",
      "checkManySync",
    ]);
    expect(events.map((e) => e.key)).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("a throwing tap never breaks the limiter", async () => {
    const limiter = tapDecisions(base(), () => {
      throw new Error("observer blew up");
    });
    await expect(limiter.check("k")).resolves.toMatchObject({ allowed: true });
    expect(() => limiter.checkSync("k")).not.toThrow();
  });

  it("forwards non-consuming introspection (peek / forecast) through the wrapper", async () => {
    const events: DecisionEvent[] = [];
    const limiter = tapDecisions(base(), (e) => events.push(e));
    // peek/forecast are present and do NOT fire the tap (only consuming checks do).
    const p = await limiter.peek?.("k");
    expect(p?.remaining).toBe(3);
    expect(limiter.peekSync?.("k")?.remaining).toBe(3);
    expect((await limiter.forecast?.("k"))?.spendableNow).toBe(3);
    expect(limiter.forecastSync?.("k")?.spendableNow).toBe(3);
    expect(events).toHaveLength(0); // peeking/forecasting taps nothing
  });
});

describe("wrapper introspection forwarding (TK-811 regression guard)", () => {
  it("withAnalytics preserves peek / forecast / peekSync / forecastSync", async () => {
    const limiter = withAnalytics(base());
    expect(typeof limiter.peek).toBe("function");
    expect(typeof limiter.peekSync).toBe("function");
    expect(typeof limiter.forecast).toBe("function");
    expect(typeof limiter.forecastSync).toBe("function");
    expect((await limiter.peek?.("k"))?.remaining).toBe(3);
    // Peeking doesn't inflate analytics counts (only real checks do).
    limiter.checkSync("k");
    expect(limiter.analytics().total).toBe(1);
  });
});
