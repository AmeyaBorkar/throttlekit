/**
 * Write the extracted Lua + `manifest.json` from the reference library.
 *
 *   npm run wire:scripts
 *
 * The committed `.lua` files + `manifest.json` are the artifacts a polyglot `RedisBackend` vendors;
 * `test/wire/conformance-scripts.test.ts` re-derives them in-memory and fails if the committed files
 * have drifted, so this only needs running when the atomic Lua deliberately changes — then the diff is
 * reviewed like any code (and a real behavioral change also forces a golden-vector regenerate).
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildManifest, extractScripts } from "./extract";

const here = dirname(fileURLToPath(import.meta.url));

for (const script of extractScripts()) {
  const out = join(here, script.file);
  // The library stores each script without a trailing newline; mirror that exactly so the on-disk
  // bytes equal `sha256(source)` and a port checksums the same string the library `EVAL`s.
  writeFileSync(out, script.source);
  console.log(`wrote ${out}`);
}

const manifestPath = join(here, "manifest.json");
writeFileSync(manifestPath, `${JSON.stringify(buildManifest(), null, 2)}\n`);
console.log(`wrote ${manifestPath}`);
