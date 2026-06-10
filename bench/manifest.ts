/**
 * Shared manifest writer for the benchmark harnesses. Each harness stamps the machine, the run parameters,
 * and the measured rows into `bench/manifests/<name>-<iso>.json`, so a run is reproducible and auditable —
 * the numbers quoted in BENCH.md trace back to a committed manifest rather than a screenshot. These are
 * pure data artifacts (committed), not docs.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** All harnesses write here regardless of which package they run from (`bench/manifest.ts` is the anchor). */
export const MANIFEST_DIR = resolve(HERE, "manifests");

export interface MachineMeta {
  capturedAt: string;
  node: string;
  platform: string;
  arch: string;
  cpu: string;
  cores: number;
  totalMemGB: number;
  /** Whether `--expose-gc` was passed (allocation rows are only meaningful when true). */
  gcExposed: boolean;
}

/** Capture the machine the numbers were produced on (the load-bearing provenance for a micro-benchmark). */
export function machineMeta(): MachineMeta {
  const c = cpus();
  return {
    capturedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: c[0]?.model?.trim() ?? "unknown",
    cores: c.length,
    totalMemGB: Math.round((totalmem() / 1e9) * 10) / 10,
    gcExposed: typeof (globalThis as { gc?: () => void }).gc === "function",
  };
}

/** Write a manifest under {@link MANIFEST_DIR} and return its path. `data` is merged next to `meta`. */
export function writeManifest(name: string, data: Record<string, unknown>): string {
  mkdirSync(MANIFEST_DIR, { recursive: true });
  // A filesystem-safe, sortable stamp: 2026-06-10T06-12-30 (drop ms + the offset).
  const stamp = new Date().toISOString().replace(/:/g, "-").replace(/\..+$/, "");
  const path = resolve(MANIFEST_DIR, `${name}-${stamp}.json`);
  writeFileSync(path, `${JSON.stringify({ meta: machineMeta(), ...data }, null, 2)}\n`, "utf8");
  return path;
}
