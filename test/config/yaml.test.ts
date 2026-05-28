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

  it("rejects unsupported constructs with a line number", () => {
    expect(() => parseYaml("  not-at-root: 1")).toThrow(YamlParseError);
    expect(() => parseYaml("missing-colon")).toThrow(YamlParseError);
    expect(() => parseYaml("emit: { draft: { nested: 1 } }")).toThrow(/nested flow maps/);
    expect(() => parseYaml(": value")).toThrow(/empty key/);
    // A stray over-indented line that no block could have opened is caught.
    expect(() => parseYaml("a: 1\n   stray: 2")).toThrow(YamlParseError);
  });
});
