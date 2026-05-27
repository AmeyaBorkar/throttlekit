import { describe, expect, it } from "vitest";
import { edgeClientIp } from "../../src/adapters/core";

/**
 * TK-S01: edge adapters had no socket peer and trusted `cf-connecting-ip` and the rightmost
 * `X-Forwarded-For` as the key regardless of `trustProxy`, so off-Cloudflare a client could spoof
 * either header to mint a fresh bucket per request. Hardening: trust cf-connecting-ip by default
 * (opt-out via the third arg), but consult the spoofable XFF only when trustProxy is configured.
 */
const req = (headers: Record<string, string>): Request =>
  new Request("https://x.test/", { headers });

describe("edgeClientIp — trust hardening (TK-S01)", () => {
  it("trusts cf-connecting-ip by default and keys distinct IPs apart", () => {
    expect(edgeClientIp(req({ "cf-connecting-ip": "1.2.3.4" }), {})).not.toBe("anon");
    expect(edgeClientIp(req({ "cf-connecting-ip": "1.2.3.4" }), {})).not.toBe(
      edgeClientIp(req({ "cf-connecting-ip": "5.6.7.8" }), {}),
    );
  });

  it("ignores a spoofable X-Forwarded-For when trustProxy is not configured (→ anon)", () => {
    // No cf header, no trustProxy: a client-set XFF must NOT mint a fresh bucket.
    expect(edgeClientIp(req({ "x-forwarded-for": "1.1.1.1" }), {})).toBe("anon");
    expect(edgeClientIp(req({ "x-forwarded-for": "2.2.2.2" }), {})).toBe("anon");
  });

  it("uses X-Forwarded-For only once trustProxy is configured", () => {
    const a = edgeClientIp(req({ "x-forwarded-for": "8.8.8.8, 10.0.0.1" }), { trustProxy: 1 });
    const b = edgeClientIp(req({ "x-forwarded-for": "9.9.9.9, 10.0.0.2" }), { trustProxy: 1 });
    expect(a).not.toBe("anon");
    expect(a).not.toBe(b); // different real clients, one trusted hop
  });

  it("can opt out of trusting cf-connecting-ip (→ anon off a trusted platform)", () => {
    expect(edgeClientIp(req({ "cf-connecting-ip": "1.2.3.4" }), {}, false)).toBe("anon");
  });
});
