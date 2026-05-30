import { describe, expectTypeOf, it } from "vitest";
import type { UnifiedAdmission, UnifiedAxis } from "../../src/admission";
import type { Decision, FailMode, Forecast, ThrottleKitErrorCode } from "../../src/index";
import type { TwoTierMode } from "../../src/twotier";

/**
 * Type-level locks for the 1.0 frozen surface. These are checked by `tsc` (test/ is in tsconfig's
 * include), so a PR that makes a `Decision` field mutable, adds a member to a frozen union, changes
 * `bindingAxis`, or alters the error-code set fails the TYPECHECK — not just code review. The runtime
 * `it()` bodies are no-ops; the `expectTypeOf` assertions are the point. See STABILITY.md.
 */
describe("1.0 frozen surface (type-level)", () => {
  it("Decision is exactly five readonly fields (append-only-optional producer type)", () => {
    expectTypeOf<Decision>().toEqualTypeOf<{
      readonly allowed: boolean;
      readonly limit: number;
      readonly remaining: number;
      readonly resetAt: number;
      readonly retryAfterMs: number;
    }>();
  });

  it("Forecast fields are readonly", () => {
    expectTypeOf<Forecast>().toEqualTypeOf<{
      readonly spendableNow: number;
      readonly nextReplenishAt: number;
      readonly fullAt: number;
    }>();
  });

  it("closed unions have exactly their frozen members (a new member is a major bump)", () => {
    expectTypeOf<FailMode>().toEqualTypeOf<"open" | "closed">();
    expectTypeOf<UnifiedAxis>().toEqualTypeOf<"rate" | "concurrency" | "cost">();
    expectTypeOf<TwoTierMode>().toEqualTypeOf<"strict" | "cached-deny" | "leased">();
  });

  it("UnifiedAdmission.bindingAxis is an optional UnifiedAxis (not on the core Decision)", () => {
    expectTypeOf<UnifiedAdmission>().toHaveProperty("bindingAxis");
    expectTypeOf<UnifiedAdmission["bindingAxis"]>().toEqualTypeOf<UnifiedAxis | undefined>();
    // The universal Decision must NOT carry bindingAxis.
    expectTypeOf<Decision>().not.toHaveProperty("bindingAxis");
  });

  it("the error `code` discriminant set is frozen", () => {
    expectTypeOf<ThrottleKitErrorCode>().toEqualTypeOf<
      | "throttlekit_error"
      | "store_unavailable"
      | "not_implemented"
      | "rate_limit_exceeded"
      | "queue_full"
      | "config_invalid"
    >();
  });
});
