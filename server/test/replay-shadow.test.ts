import { replay } from "throttlekit/testkit";
import { describe, expect, it } from "vitest";
import { type Redactor, createRedactor } from "../src/capture/redact.js";
import { createShadow } from "../src/replay/shadow.js";

/**
 * #299 Server replay P1 — the deterministic-capture shadow. A per-leaf-rate-policy `recordLimiter` fed the
 * live arrival stream, producing a genuinely replayable trace; bounded (stop-feeding-at-cap = the OOM guard),
 * PII-clean (upstream redaction), never-throw on the control-path tail.
 */

const fixedWindow3 = { strategy: "fixedWindow", limit: 3, windowMs: 1000 } as const;
const saltRedactor = (): Redactor => createRedactor({ mode: "per-trace-salt" });

describe("deterministic-capture shadow", () => {
  it("records fed decisions into a replayable (identity-clean) trace", () => {
    const s = createShadow(fixedWindow3, {
      redactor: saltRedactor(),
      maxSteps: 100,
      now: () => 1000,
    });
    for (let i = 0; i < 5; i++) s.feed("u1");

    const t = s.trace();
    expect(t.steps.length).toBe(5);
    // fixedWindow(limit 3): first three admit, the rest deny — within one window (all at the same instant).
    expect(t.steps.map((x) => x.decision.allowed)).toEqual([true, true, true, false, false]);
    expect(t.truncated).toBe(false);
    // The trace replays bit-for-bit against its own spec (identity self-check throws if the substrate broke).
    expect(() => replay(t)).not.toThrow();
  });

  it("is bounded under a distinct-key flood: stops feeding at maxSteps (the OOM guard)", () => {
    const s = createShadow(fixedWindow3, {
      redactor: saltRedactor(),
      maxSteps: 1000,
      now: () => 1000,
    });
    for (let i = 0; i < 5000; i++) s.feed(`key-${i}`);

    // 4000 feeds never reached the shadow's checkSync ⇒ its MemoryStore / ring / key-map are all capped.
    expect(s.steps).toBe(1000);
    expect(s.truncated).toBe(true);
    const t = s.trace();
    expect(t.steps.length).toBe(1000);
    expect(t.truncated).toBe(true);
    expect(t.dropped).toBe(4000);
  });

  it("clamps timestamps non-decreasing (NTP backstep safe), reading now() once per feed", () => {
    const ts = [1000, 500, 2000, 1500];
    let i = 0;
    const s = createShadow(fixedWindow3, {
      redactor: saltRedactor(),
      maxSteps: 100,
      now: () => ts[i++] ?? 9999,
    });
    for (let k = 0; k < 4; k++) s.feed("u1");

    // 500 clamps up to the prior 1000; 1500 clamps up to the prior 2000. (Exactly 4 now() reads — one/feed.)
    expect(s.trace().steps.map((x) => x.at)).toEqual([1000, 1000, 2000, 2000]);
    expect(i).toBe(4);
  });

  it("redacts keys upstream — the trace carries refs, never the raw key", () => {
    const s = createShadow(fixedWindow3, {
      redactor: saltRedactor(),
      maxSteps: 100,
      now: () => 1000,
    });
    s.feed("secret-tenant-key");

    const t = s.trace();
    expect(t.steps[0]?.key).not.toBe("secret-tenant-key");
    expect(t.redacted).toBe(true);
  });

  it("never throws from feed; a redaction collision poisons the shadow instead", () => {
    const throwing: Redactor = {
      mode: "hmac",
      redact: () => {
        throw new Error("keyref collision");
      },
      redactSpec: (x) => x,
    };
    const s = createShadow(fixedWindow3, { redactor: throwing, maxSteps: 100, now: () => 1000 });

    expect(() => s.feed("u1")).not.toThrow();
    expect(s.poisoned).toBe(true);
    expect(s.steps).toBe(0);
  });
});
