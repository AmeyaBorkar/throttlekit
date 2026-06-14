/**
 * The package version — the single source of truth. `src/index.ts` re-exports it as the public
 * `version`, and the CLI's `--version` reads it, so there is exactly one literal to bump per release.
 * `test/version-sync.test.ts` asserts `package.json#version` matches it, so the two can't drift.
 */
export const version = "1.5.1";
