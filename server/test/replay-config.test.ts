import { ThrottleKitError } from "throttlekit";
import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_STEPS, resolveReplayConfig } from "../src/replay/config.js";

/**
 * #299 Server replay P2 — the `replay:` config block. Opt-in default-OFF (records redacted keys), a distinct
 * block from `capture:`, redaction defaulting to per-trace-salt, and a `candidate:` parsed into the testkit
 * candidate DSL. A bad config fails fast with a clear message.
 */

describe("resolveReplayConfig", () => {
  it("is disabled for an absent block", () => {
    expect(resolveReplayConfig(undefined).enabled).toBe(false);
  });

  it("is disabled unless enabled is exactly true (a typo'd flag never enables PII capture)", () => {
    expect(resolveReplayConfig({ enabled: false }).enabled).toBe(false);
    expect(resolveReplayConfig({ enabled: "yes" }).enabled).toBe(false);
    expect(resolveReplayConfig({}).enabled).toBe(false);
  });

  it("enables with defaults: maxSteps=50000, redaction per-trace-salt", () => {
    const c = resolveReplayConfig({ enabled: true });
    expect(c.enabled).toBe(true);
    expect(c.maxSteps).toBe(DEFAULT_MAX_STEPS);
    expect(c.redaction).toEqual({ mode: "per-trace-salt" });
    expect(c.policies).toBeUndefined();
    expect(c.candidate).toBeUndefined();
  });

  it("parses maxSteps + a policies whitelist (array or comma-separated string)", () => {
    const c = resolveReplayConfig({ enabled: true, maxSteps: 1000, policies: ["api", "search"] });
    expect(c.maxSteps).toBe(1000);
    expect(c.policies).toEqual(["api", "search"]);
    // A YAML config can't express a sequence, so a comma/space string is accepted and split.
    expect(resolveReplayConfig({ enabled: true, policies: "api, search" }).policies).toEqual([
      "api",
      "search",
    ]);
    // An empty string ⇒ undefined (shadow all), not an empty whitelist that silently shadows nothing.
    expect(resolveReplayConfig({ enabled: true, policies: "" }).policies).toBeUndefined();
  });

  it("rejects a non-positive maxSteps and a malformed policies value", () => {
    expect(() => resolveReplayConfig({ enabled: true, maxSteps: 0 })).toThrow(ThrottleKitError);
    expect(() => resolveReplayConfig({ enabled: true, policies: 42 })).toThrow(ThrottleKitError);
  });

  it("parses a `set` candidate into ops", () => {
    const c = resolveReplayConfig({
      enabled: true,
      candidate: { policy: "api", set: { limit: 200 } },
    });
    expect(c.candidate?.policy).toBe("api");
    expect(c.candidate?.candidate.ops).toEqual([{ kind: "set", path: "limit", value: 200 }]);
  });

  it("parses `scale` and `swap` candidates", () => {
    const scaled = resolveReplayConfig({
      enabled: true,
      candidate: { policy: "api", scale: { limit: 2 } },
    });
    expect(scaled.candidate?.candidate.ops).toEqual([{ kind: "scale", path: "limit", factor: 2 }]);

    const swapped = resolveReplayConfig({
      enabled: true,
      candidate: {
        policy: "api",
        swap: { strategy: "tokenBucket", capacity: 100, refillPerSec: 10 },
      },
    });
    expect(swapped.candidate?.candidate.ops).toEqual([
      { kind: "swap", strategy: "tokenBucket", fields: { capacity: 100, refillPerSec: 10 } },
    ]);
  });

  it("rejects a candidate with no policy or no delta", () => {
    expect(() => resolveReplayConfig({ enabled: true, candidate: { set: { limit: 1 } } })).toThrow(
      /candidate\.policy/,
    );
    expect(() => resolveReplayConfig({ enabled: true, candidate: { policy: "api" } })).toThrow(
      /set.*scale.*swap/,
    );
  });

  it("requires a secret for hmac redaction; reads it from secretEnv", () => {
    expect(() => resolveReplayConfig({ enabled: true, redaction: { mode: "hmac" } })).toThrow(
      /hmac mode requires/,
    );
    const c = resolveReplayConfig(
      { enabled: true, redaction: { mode: "hmac", secretEnv: "TK_SECRET" } },
      { env: { TK_SECRET: "s3cr3t" } },
    );
    expect(c.redaction).toEqual({ mode: "hmac", secret: "s3cr3t" });
  });
});
