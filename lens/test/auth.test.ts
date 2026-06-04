import { describe, expect, it } from "vitest";
import { bearerEqual } from "../src/auth.js";

describe("bearerEqual", () => {
  it("accepts the exact Bearer token", () => {
    expect(bearerEqual("Bearer s3cret", "s3cret")).toBe(true);
  });

  it("rejects a wrong token, a missing header, a bad scheme, and a length mismatch", () => {
    expect(bearerEqual("Bearer nope", "s3cret")).toBe(false);
    expect(bearerEqual(undefined, "s3cret")).toBe(false);
    expect(bearerEqual("s3cret", "s3cret")).toBe(false); // missing the "Bearer " prefix
    expect(bearerEqual("Bearer s3cre", "s3cret")).toBe(false); // one char short
    expect(bearerEqual("bearer s3cret", "s3cret")).toBe(false); // scheme is case-sensitive
  });
});
