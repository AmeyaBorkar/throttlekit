import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type ScriptManifest, buildManifest, extractScripts } from "../../wire/scripts/extract";

/**
 * The extracted-Lua lock. `wire/scripts/*.lua` + `manifest.json` are the atomic Redis scripts a
 * polyglot `RedisBackend` vendors verbatim. This test re-derives them from the shipped strategy
 * objects and asserts every committed file is byte-identical and every manifest `sha256` still
 * matches — so the raw Lua wire cannot drift from what the library actually `EVAL`s without a
 * deliberate `npm run wire:scripts` + a reviewed diff. The behavioral half of the contract lives in
 * `conformance-vectors.test.ts`; together they guarantee a port runs the *same script* producing the
 * *same decisions* as the reference core.
 *
 * `generatedFrom` (the package version) is normalised out — a version bump must NOT force a regen.
 */
const SCRIPTS_DIR = join(__dirname, "../../wire/scripts");

function normalize(m: ScriptManifest): Omit<ScriptManifest, "generatedFrom"> {
  const { generatedFrom: _ignored, ...rest } = m;
  return rest;
}

describe("wire extracted Lua scripts", () => {
  const committed = JSON.parse(
    readFileSync(join(SCRIPTS_DIR, "manifest.json"), "utf8"),
  ) as ScriptManifest;
  const fresh = buildManifest();
  const scripts = extractScripts();

  it("the committed manifest matches the current core (run `npm run wire:scripts` if intentional)", () => {
    expect(normalize(fresh)).toEqual(normalize(committed));
  });

  it("every committed .lua file is byte-identical to what the library EVALs", () => {
    for (const script of scripts) {
      const onDisk = readFileSync(join(SCRIPTS_DIR, script.file), "utf8");
      expect(onDisk, `${script.file} drifted — run \`npm run wire:scripts\``).toBe(script.source);
    }
  });

  it("each manifest sha256 is the checksum of the on-disk file a port pins", () => {
    const byName = new Map(scripts.map((s) => [s.name, s]));
    for (const entry of committed.scripts) {
      const script = byName.get(entry.name);
      expect(script, `manifest lists ${entry.name} but the core does not extract it`).toBeDefined();
      expect(entry.sha256).toBe(script?.sha256);
    }
  });

  it("declares an unfrozen v1 contract aligned with the golden vectors (bet #78)", () => {
    expect(committed.contractVersion).toBe("1");
    expect(committed.frozen).toBe(false);
    expect(committed.replyTuple).toEqual([
      "allowed",
      "limit",
      "remaining",
      "resetAt",
      "retryAfterMs",
    ]);
  });

  it("extracts exactly the five vectored strategies, each with a check + read script", () => {
    const names = scripts.map((s) => s.name).sort();
    expect(names).toEqual(
      [
        "fixedWindow.check",
        "fixedWindow.read",
        "gcra.check",
        "gcra.read",
        "slidingWindow.check",
        "slidingWindow.read",
        "slidingWindowLog.check",
        "slidingWindowLog.read",
        "tokenBucket.check",
        "tokenBucket.read",
      ].sort(),
    );
  });

  it("every check script's ARGV[1] is `now` (the shared-clock sentinel slot)", () => {
    for (const s of scripts.filter((s) => s.role === "check")) {
      expect(s.argv[0], `${s.name} ARGV[1]`).toBe("now");
    }
  });
});
