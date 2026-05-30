import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import tsupConfig from "../tsup.config";

/**
 * The package's `exports` map IS its public entry-point contract — every documented
 * subpath (`throttlekit/redis`, `throttlekit/twotier`, …) must actually be built, and
 * every built library module must be reachable. Drift between the two is invisible until
 * a consumer's `import "throttlekit/<x>"` fails at install time.
 *
 * This pins `package.json#exports` ⇆ `tsup.config#entry` agreement from the two static
 * files (no build required): the build PLAN and the published CONTRACT can't diverge.
 *
 * Regression origin: in 0.12.0 the `twotier` family was documented as
 * `throttlekit/twotier` but never wired into `exports`/tsup — reachable only via the root
 * barrel. 0.13.0 (#205) wired the real subpath; this test keeps it (and its siblings) honest.
 */

interface SubpathTarget {
  import: { types: string; default: string };
  require: { types: string; default: string };
}
interface PackageJson {
  exports: Record<string, SubpathTarget | string>;
  bin: Record<string, string>;
}

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(here, "../package.json"), "utf8")) as PackageJson;
const entryNames = new Set(
  Object.keys((tsupConfig as unknown as { entry: Record<string, string> }).entry),
);

/** Built modules that are intentionally NOT subpath exports. `cli` backs `bin`; `index` backs `.`. */
const NON_SUBPATH_ENTRIES = new Set(["index", "cli"]);

const subpathExports = Object.entries(pkg.exports).filter(
  ([key]) => key !== "." && key !== "./package.json",
);

describe("package exports ⇆ tsup entries", () => {
  it('root "." export is backed by the index entry', () => {
    expect(entryNames.has("index")).toBe(true);
    const root = pkg.exports["."] as SubpathTarget;
    expect(root.import.default).toBe("./dist/index.js");
    expect(root.require.default).toBe("./dist/index.cjs");
  });

  it("cli entry backs the bin and is deliberately not a subpath export", () => {
    expect(entryNames.has("cli")).toBe(true);
    expect(pkg.bin.throttlekit).toBe("./dist/cli.js");
    expect(pkg.exports["./cli"]).toBeUndefined();
  });

  it('exposes the "./twotier" subpath (regression: documented but unwired before 0.13.0)', () => {
    expect(pkg.exports["./twotier"]).toBeDefined();
    expect(entryNames.has("twotier")).toBe(true);
  });

  // Every declared subpath must be built by tsup, with dist paths derived from the entry name.
  for (const [key, target] of subpathExports) {
    const name = key.slice(2); // strip "./"
    it(`subpath "${key}" is built and its dist paths match entry "${name}"`, () => {
      expect(entryNames.has(name)).toBe(true);
      const t = target as SubpathTarget;
      expect(t.import.default).toBe(`./dist/${name}.js`);
      expect(t.import.types).toBe(`./dist/${name}.d.ts`);
      expect(t.require.default).toBe(`./dist/${name}.cjs`);
      expect(t.require.types).toBe(`./dist/${name}.d.cts`);
    });
  }

  // Every built library module must be reachable as a subpath (so nothing is built-but-orphaned).
  for (const name of entryNames) {
    if (NON_SUBPATH_ENTRIES.has(name)) continue;
    it(`tsup entry "${name}" is exposed as subpath "./${name}"`, () => {
      expect(pkg.exports[`./${name}`]).toBeDefined();
    });
  }
});
