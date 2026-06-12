import { describe, expect, it } from "vitest";
import { YamlParseError, parseYaml } from "../../src/config/yaml";

describe("parseYaml (zero-dep subset)", () => {
  it("parses a nested block map with scalars of every kind", () => {
    const out = parseYaml(`
version: 1
defaults:
  prefix: "tk"
  enabled: true
  retries: 3
  note: null
limiters:
  api:
    strategy: gcra
    limit: 100
    period: 1m
`);
    expect(out).toEqual({
      version: 1,
      defaults: { prefix: "tk", enabled: true, retries: 3, note: null },
      limiters: { api: { strategy: "gcra", limit: 100, period: "1m" } },
    });
  });

  it("parses inline flow maps and treats bare strings as strings", () => {
    expect(parseYaml("emit: { draft: true, structured: false }")).toEqual({
      emit: { draft: true, structured: false },
    });
    // A bare token with a non-numeric tail stays a string (so "1m" survives).
    expect(parseYaml("period: 1m")).toEqual({ period: "1m" });
  });

  it("supports single- and double-quoted strings and integer/float numbers", () => {
    expect(parseYaml(`a: "with: colon"\nb: 'q'\nc: 1.5\nd: -7\ne: 1e3`)).toEqual({
      a: "with: colon",
      b: "q",
      c: 1.5,
      d: -7,
      e: 1000,
    });
  });

  it("strips `#` comments — whole-line and end-of-line", () => {
    const out = parseYaml(`
# top comment
limiters:    # inline
  api:
    limit: 5 # trailing
    # detached
`);
    expect(out).toEqual({ limiters: { api: { limit: 5 } } });
  });

  it("preserves `#` inside quoted scalars and still strips real trailing comments (regression)", () => {
    // Comment stripping used to run a blind indexOf(" #") before scalar parsing, truncating
    // `prefix: "a #b"` to `"a`. It is now quote-aware.
    expect(parseYaml('prefix: "a #b"')).toEqual({ prefix: "a #b" });
    expect(parseYaml("prefix: 'a #b'")).toEqual({ prefix: "a #b" });
    expect(parseYaml('cfg: { prefix: "a #b" }')).toEqual({ cfg: { prefix: "a #b" } });
    // A real comment after a closing quote is still stripped…
    expect(parseYaml('prefix: "ok" # note')).toEqual({ prefix: "ok" });
    // …and a bare-value trailing comment still works.
    expect(parseYaml("prefix: bare # note")).toEqual({ prefix: "bare" });
  });

  it("rejects unsupported constructs with a line number", () => {
    expect(() => parseYaml("  not-at-root: 1")).toThrow(YamlParseError);
    expect(() => parseYaml("missing-colon")).toThrow(YamlParseError);
    expect(() => parseYaml("emit: { draft: { nested: 1 } }")).toThrow(/nested flow maps/);
    expect(() => parseYaml(": value")).toThrow(/empty key/);
    // A stray over-indented line that no block could have opened is caught.
    expect(() => parseYaml("a: 1\n   stray: 2")).toThrow(YamlParseError);
  });

  it("rejects prototype-polluting keys instead of mutating the object's prototype (regression)", () => {
    // `__proto__:` with a nested block used to re-parent the parsed object: its fields then resolved
    // through the prototype chain and slipped past own-property guards (loadConfigObject's missing-
    // `limiters` check returned a phantom limiter). The parser now rejects the key outright.
    expect(() => parseYaml("__proto__:\n  limiters:\n    ghost: 1")).toThrow(/unsafe key/);
    expect(() => parseYaml("constructor: 1")).toThrow(/unsafe key/);
    expect(() => parseYaml("cfg: { __proto__: 1 }")).toThrow(/unsafe key/);
    // A normal document is unaffected and is not re-parented.
    const out = parseYaml("version: 1\nlimiters:\n  api:\n    limit: 5");
    expect(Object.prototype.hasOwnProperty.call(out, "limiters")).toBe(true);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });
});
