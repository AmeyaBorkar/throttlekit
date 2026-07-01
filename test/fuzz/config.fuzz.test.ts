import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type ConfigFile,
  type LimiterSpec,
  YamlParseError,
  loadConfig,
  loadConfigObject,
  parseYaml,
} from "../../src/config";
import type { Decision } from "../../src/core/types";

/**
 * FUZZ — the config boundary (`throttlekit/config`). Untrusted surface: the raw text of a
 * `.throttlekit.yaml` / `.throttlekit.json` (the "rate-limit-as-code" file, which a multi-tenant
 * host may accept from users). Code under test lives in `src/config/yaml.ts` (`parseYaml`, the
 * zero-dep YAML subset) and `src/config/index.ts` (`loadConfig` / `loadConfigObject` / `buildStrategy`).
 *
 * SAFETY CONTRACT: any input string → a valid parsed object OR a clean typed throw (an `Error`
 * subclass — `YamlParseError` / `SyntaxError` / `ThrottleKitError` / `RangeError`). Never an
 * unhandled crash, never a hang, never a half-valid config that later misbehaves, and never
 * prototype pollution of `Object.prototype`.
 */

const NUM_RUNS = 1200;

/** Control-character and high-byte noise — the stuff quote/comment scanners trip on. */
const noisyChars = fc
  .array(fc.integer({ min: 0, max: 0x1f }), { maxLength: 24 })
  .map((codes) => String.fromCharCode(...codes));

/** Keys/values that lean on the parser's guards (proto keys, quotes, flow maps, comments, numbers). */
const token = fc.oneof(
  fc.constantFrom(
    "__proto__",
    "constructor",
    "prototype",
    "version",
    "limiters",
    "defaults",
    "strategy",
    "gcra",
    "limit",
    "period",
    "a",
    "b",
    "true",
    "null",
    "~",
  ),
  fc.string({ maxLength: 8 }),
  fc.fullUnicodeString({ maxLength: 6 }),
);

const scalar = fc.oneof(
  token,
  fc.integer().map(String),
  fc.constantFrom(
    '"quoted"',
    "'single'",
    '"unterminated',
    "'unterminated",
    "{ a: 1, b: 2 }",
    "{ __proto__: 1 }",
    "{ nested: { x: 1 } }",
    "1e999",
    "0x10",
    "[1, 2]",
    "# trailing",
    '"a # b"',
    "-.-",
    "",
  ),
);

/** One indented `key: value` line. Indentation is kept shallow so this stays clear of the
 * pathological deep-nesting case pinned separately as FINDING F2. */
const line = fc
  .tuple(fc.nat(6), token, scalar)
  .map(([indent, k, v]) => `${" ".repeat(indent)}${k}: ${v}`);

const document = fc.oneof(
  fc.array(line, { maxLength: 50 }).map((ls) => ls.join("\n")),
  fc.fullUnicodeString({ maxLength: 200 }),
  fc.string({ maxLength: 200 }),
  noisyChars,
);

function assertValidDecision(d: Decision): void {
  expect(typeof d.allowed).toBe("boolean");
  for (const v of [d.limit, d.remaining, d.resetAt, d.retryAfterMs]) {
    expect(Number.isFinite(v)).toBe(true);
  }
  expect(d.remaining).toBeGreaterThanOrEqual(0);
  expect(d.retryAfterMs).toBeGreaterThanOrEqual(0);
}

/** A fresh sentinel object each time; asserts the global prototype was not polluted by a parse. */
function assertNoPrototypePollution(): void {
  const sentinel = {} as Record<string, unknown>;
  expect(sentinel.polluted).toBeUndefined();
  expect(sentinel.__proto__polluted).toBeUndefined();
  expect(Object.getPrototypeOf({})).toBe(Object.prototype);
}

describe("fuzz: config parser boundary", () => {
  it("parseYaml: any string → plain object or a typed throw, deterministically", () => {
    fc.assert(
      fc.property(document, (text) => {
        let parsed: Record<string, unknown>;
        try {
          parsed = parseYaml(text);
        } catch (err) {
          // A deviation from the subset must be a typed YamlParseError — never an ad-hoc crash.
          expect(err).toBeInstanceOf(YamlParseError);
          assertNoPrototypePollution();
          return;
        }
        expect(typeof parsed).toBe("object");
        expect(parsed).not.toBeNull();
        expect(Array.isArray(parsed)).toBe(false);
        // Deterministic: the same bytes parse to the same tree.
        expect(parseYaml(text)).toStrictEqual(parsed);
        assertNoPrototypePollution();
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("loadConfig: any string → LoadedConfig or a typed throw, no pollution", () => {
    fc.assert(
      fc.property(
        document,
        fc.constantFrom<"yaml" | "json" | undefined>("yaml", "json", undefined),
        (text, format) => {
          try {
            const loaded = format === undefined ? loadConfig(text) : loadConfig(text, { format });
            expect(typeof loaded.limiters).toBe("object");
            expect(loaded.limiters).not.toBeNull();
          } catch (err) {
            expect(err).toBeInstanceOf(Error); // SyntaxError | YamlParseError | ThrottleKitError | RangeError
          }
          assertNoPrototypePollution();
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("loadConfigObject: adversarial-but-finite specs → a working limiter or a clean throw", () => {
    // Positive candidates are floored at 1e-3 to stay clear of the subnormal-`limit` overflow pinned
    // as FINDING F4; the invalid constants below still exercise the clean-throw path.
    // `buckets` sizes a slidingWindow ring at O(buckets), and the strategy has no upper bound on it
    // (FINDING F5 — a hostile `buckets: 1e6+` is a memory DoS, tracked for the abuse-guards pass). Keep
    // this generator's INTEGERS modest so the harness doesn't re-trigger that allocation every run; the
    // finite values below still exercise every build + validation path. (Large doubles are fine — a
    // non-integer `buckets` is rejected by requireInteger before it can allocate.)
    const numish = fc.oneof(
      fc.integer({ min: 1, max: 1000 }),
      fc.double({ min: 0.001, max: 1e9 }),
      fc.constantFrom(0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1000),
      fc.constant(undefined),
    );
    const period = fc.oneof(
      fc.constantFrom("1m", "30s", "1h", "1d", "0s", "-5s", "abc", "1e9ms", "10"),
      fc.integer({ min: -10, max: 1_000_000 }),
      fc.constant(undefined),
    );
    const spec: fc.Arbitrary<LimiterSpec> = fc.record(
      {
        strategy: fc.constantFrom(
          "gcra",
          "tokenBucket",
          "fixedWindow",
          "slidingWindow",
          "slidingWindowLog",
          "quota",
          // biome-ignore lint/suspicious/noExplicitAny: an intentionally-invalid strategy name
          "bogus" as any,
        ),
        limit: numish,
        period,
        burst: numish,
        capacity: numish,
        refillPerSec: numish,
        buckets: numish,
        resetCadence: fc.constantFrom(
          "calendar-month",
          "calendar-week",
          "fixed",
          "rolling",
          // biome-ignore lint/suspicious/noExplicitAny: exercise an invalid cadence too
          "nonsense" as any,
          undefined,
        ),
      },
      { requiredKeys: ["strategy"] },
    ) as fc.Arbitrary<LimiterSpec>;

    fc.assert(
      fc.property(spec, (s) => {
        const cfg: ConfigFile = { limiters: { a: s } };
        let loaded: ReturnType<typeof loadConfigObject>;
        try {
          loaded = loadConfigObject(cfg);
        } catch (err) {
          expect(err).toBeInstanceOf(Error); // misconfiguration is a clean typed throw
          return;
        }
        // A config that BUILDS must not later misbehave: a normal cost-1 check yields a finite,
        // well-formed decision on the private in-process store.
        for (const lim of Object.values(loaded.limiters)) {
          assertValidDecision(lim.checkSync("probe-key", 1));
        }
      }),
      { numRuns: 700 },
    );
  });

  /**
   * FINDING F2 (FIXED) — the YAML parser now bounds block-nesting depth (`MAX_NESTING_DEPTH` in
   * `src/config/yaml.ts`), so a deeply-nested document throws a typed `YamlParseError` instead of
   * recursing `parseBlock` until the call stack overflows with an uncatchable `RangeError` — a DoS on
   * untrusted config text. This test pins the fixed behavior with a small (~45 KB) doc: it nests well
   * past the cap but nowhere near a genuine stack overflow, so it is deterministic and cheap (the
   * original repro built a ~32 MB, 8000-level doc that really overflowed the stack and, under vitest's
   * parallel workers, could wedge a worker).
   */
  it("FINDING F2 (fixed): deeply-nested YAML throws YamlParseError, not a stack overflow", () => {
    const levels = 300; // > MAX_NESTING_DEPTH (64), yet only ~45 KB — no genuine stack overflow
    const lines: string[] = [];
    for (let i = 0; i < levels; i++) lines.push(`${" ".repeat(i)}k:`);
    lines.push(`${" ".repeat(levels)}v: 1`);
    const doc = lines.join("\n");
    expect(() => parseYaml(doc)).toThrow(YamlParseError);
  });

  /**
   * FINDING F4 (FIXED) — a subnormal `limit` is now rejected at build instead of producing a limiter
   * that emits NON-FINITE decision fields.
   *
   * `gcra` now checks that the derived emission interval `T = periodMs / limit` is finite, so a
   * subnormal `limit` like `Number.MIN_VALUE` (which overflowed `T` to `Infinity`) is a clean throw at
   * construction. The config text `{ strategy: gcra, limit: 5e-324, ... }` therefore fails to load.
   */
  it("FINDING F4 (fixed): a subnormal `limit` is rejected at build, not a non-finite-decision limiter", () => {
    expect(() =>
      loadConfigObject({
        limiters: { a: { strategy: "gcra", limit: Number.MIN_VALUE, period: "1m", burst: 1 } },
      }),
    ).toThrow();
  });

  /**
   * FINDING F5 (FIXED) — `slidingWindow` now bounds `buckets`. It holds an O(buckets) ring PER KEY, so
   * a hostile `buckets: 1e6+` config was an unbounded memory allocation (a DoS). The strategy caps
   * `buckets` at 100k and rejects anything larger with a RangeError.
   */
  it("FINDING F5 (fixed): an oversized slidingWindow `buckets` is rejected at build", () => {
    expect(() =>
      loadConfigObject({
        limiters: {
          a: { strategy: "slidingWindow", limit: 100, period: "1s", buckets: 1_000_000 },
        },
      }),
    ).toThrow();
  });
});
