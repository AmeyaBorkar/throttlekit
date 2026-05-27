import { describe, expect, it } from "vitest";
import { buildRateLimitHeaders } from "../../src/http/headers";

/**
 * TK-S03: `policyName` is interpolated into the quoted RFC 9651 structured-field values. It is
 * developer-supplied, but the library must not let a stray CR/LF split the header or a stray quote
 * malform the field — so it drops control chars and escapes the sf-string specials.
 */
const decision = { allowed: true, limit: 100, remaining: 50, resetAt: 60_000, retryAfterMs: 0 };

describe("buildRateLimitHeaders — policyName sanitization (TK-S03)", () => {
  it("strips CR/LF from the policy name (no header injection)", () => {
    const h = buildRateLimitHeaders(decision, {
      now: 0,
      emit: { structured: true },
      policyName: "evil\r\nX-Injected: 1",
    });
    expect(h.RateLimit).not.toMatch(/[\r\n]/);
    expect(h["RateLimit-Policy"]).not.toMatch(/[\r\n]/);
  });

  it("escapes an embedded quote so the structured field stays well-formed", () => {
    const h = buildRateLimitHeaders(decision, {
      now: 0,
      emit: { structured: true },
      policyName: 'a"b',
    });
    expect(h.RateLimit).toContain('\\"'); // backslash-escaped, not raw
  });

  it("leaves a normal policy name intact", () => {
    const h = buildRateLimitHeaders(decision, {
      now: 0,
      emit: { structured: true },
      policyName: "gcra",
    });
    expect(h.RateLimit).toContain('"gcra"');
  });
});
