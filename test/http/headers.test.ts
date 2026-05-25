import { describe, expect, it } from "vitest";
import type { Decision } from "../../src/core/types";
import { buildRateLimitHeaders } from "../../src/http/headers";

const allowed: Decision = {
  allowed: true,
  limit: 100,
  remaining: 50,
  resetAt: 30_000, // epoch-ms
  retryAfterMs: 0,
};

const denied: Decision = {
  allowed: false,
  limit: 100,
  remaining: 0,
  resetAt: 30_000,
  retryAfterMs: 2400, // 2.4s -> ceil 3
};

describe("buildRateLimitHeaders", () => {
  it("defaults to the draft triple only", () => {
    const h = buildRateLimitHeaders(allowed, { now: 0 });
    expect(h).toEqual({
      "RateLimit-Limit": "100",
      "RateLimit-Remaining": "50",
      "RateLimit-Reset": "30", // ceil((30000 - 0)/1000)
    });
  });

  it("draft reset is delta-seconds from now (clamped at 0)", () => {
    expect(
      buildRateLimitHeaders(allowed, { now: 10_000, emit: { draft: true } })["RateLimit-Reset"],
    ).toBe("20");
    // resetAt already passed -> clamp to 0
    expect(
      buildRateLimitHeaders(allowed, { now: 40_000, emit: { draft: true } })["RateLimit-Reset"],
    ).toBe("0");
    // partial second rounds up
    expect(
      buildRateLimitHeaders(allowed, { now: 28_500, emit: { draft: true } })["RateLimit-Reset"],
    ).toBe("2");
  });

  it("emits structured fields (RFC 9651) with default policy 'default'", () => {
    const h = buildRateLimitHeaders(allowed, { now: 0, emit: { structured: true } });
    expect(h).toEqual({
      RateLimit: '"default";r=50;t=30',
      "RateLimit-Policy": '"default";q=100',
    });
  });

  it("structured uses policyName and adds ;w= only when windowSeconds is provided", () => {
    const withWindow = buildRateLimitHeaders(allowed, {
      now: 0,
      emit: { structured: true },
      policyName: "api",
      windowSeconds: 60,
    });
    expect(withWindow.RateLimit).toBe('"api";r=50;t=30');
    expect(withWindow["RateLimit-Policy"]).toBe('"api";q=100;w=60');

    const noWindow = buildRateLimitHeaders(allowed, {
      now: 0,
      emit: { structured: true },
      policyName: "api",
    });
    expect(noWindow["RateLimit-Policy"]).toBe('"api";q=100');
  });

  it("emits legacy X-RateLimit-* with an EPOCH-seconds reset", () => {
    const h = buildRateLimitHeaders(allowed, { now: 10_000, emit: { legacy: true } });
    expect(h).toEqual({
      "X-RateLimit-Limit": "100",
      "X-RateLimit-Remaining": "50",
      "X-RateLimit-Reset": "30", // epoch seconds = ceil(30000/1000), independent of `now`
    });
  });

  it("contrasts delta (draft) vs epoch (legacy) reset for the same decision", () => {
    const now = 25_000;
    const h = buildRateLimitHeaders(allowed, { now, emit: { draft: true, legacy: true } });
    // draft: delta = ceil((30000 - 25000)/1000) = 5
    expect(h["RateLimit-Reset"]).toBe("5");
    // legacy: epoch = ceil(30000/1000) = 30
    expect(h["X-RateLimit-Reset"]).toBe("30");
    expect(h["RateLimit-Reset"]).not.toBe(h["X-RateLimit-Reset"]);
  });

  it("can emit all three families at once", () => {
    const h = buildRateLimitHeaders(allowed, {
      now: 0,
      emit: { draft: true, structured: true, legacy: true },
      policyName: "p",
      windowSeconds: 30,
    });
    expect(h).toEqual({
      "RateLimit-Limit": "100",
      "RateLimit-Remaining": "50",
      "RateLimit-Reset": "30",
      RateLimit: '"p";r=50;t=30',
      "RateLimit-Policy": '"p";q=100;w=30',
      "X-RateLimit-Limit": "100",
      "X-RateLimit-Remaining": "50",
      "X-RateLimit-Reset": "30",
    });
  });

  it("adds Retry-After only on denial, rounded up, regardless of emit mode", () => {
    const h = buildRateLimitHeaders(denied, { now: 0, emit: { draft: true } });
    expect(h["Retry-After"]).toBe("3"); // ceil(2400/1000)
    // even with no families selected, denial still yields Retry-After
    const onlyRetry = buildRateLimitHeaders(denied, { now: 0, emit: {} });
    expect(onlyRetry).toEqual({ "Retry-After": "3" });
    // allowed decisions never get Retry-After
    expect(buildRateLimitHeaders(allowed, { now: 0 })["Retry-After"]).toBeUndefined();
  });

  it("Retry-After has a minimum of 1 second even for sub-second waits", () => {
    const tiny: Decision = { ...denied, retryAfterMs: 1 };
    expect(buildRateLimitHeaders(tiny, { now: 0 })["Retry-After"]).toBe("1");
    const zeroish: Decision = { ...denied, retryAfterMs: 0 };
    // a denied decision with 0ms still floors at 1 (never advertise "retry immediately")
    expect(buildRateLimitHeaders(zeroish, { now: 0 })["Retry-After"]).toBe("1");
  });

  it("returns all values as strings", () => {
    const h = buildRateLimitHeaders(denied, {
      now: 0,
      emit: { draft: true, structured: true, legacy: true },
    });
    for (const v of Object.values(h)) {
      expect(typeof v).toBe("string");
    }
  });
});
