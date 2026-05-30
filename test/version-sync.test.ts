import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { version } from "../src/version";

/**
 * The version lives in exactly one place — `src/version.ts` — re-exported as the public `version`
 * and read by the CLI's `--version`. The only thing that can drift from it is `package.json#version`
 * (npm's source of truth), which a release bumps by hand. Pin them together so a forgotten bump fails
 * the suite instead of shipping a wrong version.
 */
const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(here, "../package.json"), "utf8")) as {
  version: string;
};

describe("version single-sourcing", () => {
  it("package.json#version matches src/version.ts", () => {
    expect(version).toBe(pkg.version);
  });

  it("is a semver string", () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
