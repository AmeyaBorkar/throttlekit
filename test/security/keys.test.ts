import { describe, expect, it } from "vitest";
import { hashKey, hmacKeyer } from "../../src/security/keys";

describe("hashKey", () => {
  it("is deterministic for the same input and secret", () => {
    expect(hashKey("user-42", "s3cret")).toBe(hashKey("user-42", "s3cret"));
  });

  it("produces 64 lowercase hex characters (HMAC-SHA-256)", () => {
    const h = hashKey("1.2.3.4", "secret");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs for different inputs under the same secret", () => {
    expect(hashKey("a", "secret")).not.toBe(hashKey("b", "secret"));
  });

  it("differs for the same input under different secrets", () => {
    expect(hashKey("a", "secret-1")).not.toBe(hashKey("a", "secret-2"));
  });

  it("matches a known HMAC-SHA-256 vector", () => {
    // RFC-style sanity check against a precomputed value.
    expect(hashKey("The quick brown fox jumps over the lazy dog", "key")).toBe(
      "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8",
    );
  });
});

describe("hmacKeyer", () => {
  it("binds a secret and hashes raw inputs", () => {
    const keyer = hmacKeyer("server-secret");
    expect(keyer("ip:1.2.3.4")).toBe(hashKey("ip:1.2.3.4", "server-secret"));
  });

  it("two keyers with different secrets disagree", () => {
    const a = hmacKeyer("one");
    const b = hmacKeyer("two");
    expect(a("x")).not.toBe(b("x"));
  });
});
