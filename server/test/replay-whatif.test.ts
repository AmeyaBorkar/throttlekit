import { type Candidate, candidate, set } from "throttlekit/testkit";
import { describe, expect, it } from "vitest";
import { createRedactor } from "../src/capture/redact.js";
import { type Shadow, createShadow } from "../src/replay/shadow.js";
import { runWhatIf } from "../src/replay/whatif.js";

/**
 * #299/#290 Server replay P3 — the on-demand what-if. Replays a shadow trace against an operator-configured
 * candidate into a render-ready divergence snapshot, mapping every testkit refusal to an honest typed state
 * and never throwing to the UI. The "ok" rows prove the identity self-check passed (replay() runs it first).
 */

const fixedWindow3 = { strategy: "fixedWindow", limit: 3, windowMs: 1000 } as const;

/** A shadow fed 5 same-key checks at one instant: recorded = [allow, allow, allow, deny, deny]. */
const fed = (maxSteps = 100): Shadow => {
  const s = createShadow(fixedWindow3, {
    redactor: createRedactor({ mode: "per-trace-salt" }),
    maxSteps,
    now: () => 1000,
  });
  for (let i = 0; i < 5; i++) s.feed("u1");
  return s;
};

describe("on-demand what-if", () => {
  it("reports directional flips for a looser candidate (deny → allow)", () => {
    const r = runWhatIf("api", fed(), candidate("loosen", set("limit", 5)));
    expect(r.state).toBe("ok");
    expect(r.flippedDenyToAllow).toBe(2); // the two recorded denials would now admit
    expect(r.flippedAllowToDeny).toBe(0);
    expect(r.flippedTotal).toBe(2);
  });

  it("reports directional flips for a tighter candidate (allow → deny)", () => {
    const r = runWhatIf("api", fed(), candidate("tighten", set("limit", 1)));
    expect(r.state).toBe("ok");
    expect(r.flippedAllowToDeny).toBe(2); // limit 1 admits only the first; checks 2 & 3 flip to deny
    expect(r.flippedDenyToAllow).toBe(0);
  });

  it("a no-op candidate yields zero flips (and proves identity holds)", () => {
    const r = runWhatIf("api", fed(), candidate("noop", set("limit", 3)));
    expect(r.state).toBe("ok");
    expect(r.flippedTotal).toBe(0);
    expect(r.divergent).toBe(0);
  });

  it("an empty shadow reports state 'empty', never a fake zero", () => {
    const s = createShadow(fixedWindow3, { redactor: createRedactor({ mode: "per-trace-salt" }) });
    const r = runWhatIf("api", s, candidate("x", set("limit", 5)));
    expect(r.state).toBe("empty");
    expect(r.flippedTotal).toBe(0);
  });

  it("a truncated shadow reports state 'truncated' (a prefix would understate)", () => {
    const s = createShadow(fixedWindow3, {
      redactor: createRedactor({ mode: "per-trace-salt" }),
      maxSteps: 2,
      now: () => 1000,
    });
    for (let i = 0; i < 5; i++) s.feed(`k-${i}`);
    const r = runWhatIf("api", s, candidate("x", set("limit", 5)));
    expect(r.state).toBe("truncated");
  });

  it("an invalid candidate (unknown field) is a loud 'refused', not a silent no-op", () => {
    const bad: Candidate = { name: "bad", ops: [{ kind: "set", path: "nope" as never, value: 1 }] };
    const r = runWhatIf("api", fed(), bad);
    expect(r.state).toBe("refused");
    expect(r.refusal?.reason).toBe("candidate-invalid");
  });

  it("a poisoned shadow reports state 'poisoned'", () => {
    const throwing = {
      mode: "hmac" as const,
      redact: (): string => {
        throw new Error("collision");
      },
      redactSpec: <T>(x: T): T => x,
    };
    const s = createShadow(fixedWindow3, { redactor: throwing, maxSteps: 100, now: () => 1000 });
    s.feed("u1");
    const r = runWhatIf("api", s, candidate("x", set("limit", 5)));
    expect(r.state).toBe("poisoned");
  });
});
