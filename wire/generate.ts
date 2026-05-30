/**
 * Write `wire/vectors/golden-vectors.json` from the reference oracle.
 *
 *   npm run wire:vectors
 *
 * The committed JSON is the cross-language conformance artifact; `test/wire/conformance-vectors.test.ts`
 * regenerates in-memory and fails if the committed file has drifted, so this only needs running when a
 * *deliberate* wire-behavior change (or a new suite) is made — then the diff is reviewed like any code.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildDocument } from "./vectors/vectors";

const outPath = join(dirname(fileURLToPath(import.meta.url)), "vectors", "golden-vectors.json");
writeFileSync(outPath, `${JSON.stringify(buildDocument(), null, 2)}\n`);
console.log(`wrote ${outPath}`);
