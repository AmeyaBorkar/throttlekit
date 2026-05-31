/**
 * Single-sources the atomic Redis Lua a polyglot `RedisBackend` vendors. The reference Node library
 * is the one place these scripts are authored (as TS template strings); this module reads the
 * *resolved* `.script` straight off the constructed strategy objects — so the extracted `.lua` files
 * cannot drift from what the library actually `EVAL`s. `test/wire/conformance-scripts.test.ts` is the
 * lock: it re-derives here and fails if a committed `.lua` or the manifest no longer matches.
 *
 * Scope: exactly the five strategies that carry a language-neutral golden-vector conformance proof
 * (`wire/vectors/`). The fused-admission, distributed-token-budget, and federation/concurrency
 * coordination scripts are deliberately *not* extracted yet — they have no neutral vector contract a
 * port could check against. See `wire/WIRE-PROTOCOL.md` for that boundary.
 *
 * Pure (no filesystem); `generate-scripts.ts` is the thin writer.
 */
import { createHash } from "node:crypto";

import { fixedWindow } from "../../src/algorithms/fixed-window";
import { gcra } from "../../src/algorithms/gcra";
import { slidingWindow } from "../../src/algorithms/sliding-window";
import { slidingWindowLog } from "../../src/algorithms/sliding-window-log";
import { tokenBucket } from "../../src/algorithms/token-bucket";
import type { Strategy } from "../../src/core/types";
import { version } from "../../src/version";

/** One vendorable Lua program with the metadata a port needs to call and pin it. */
export interface ExtractedScript {
  /** File stem, e.g. `"gcra.check"`. The committed file is `<name>.lua`. */
  name: string;
  /** The strategy this Lua implements. */
  strategy: string;
  /** `"check"` = the consuming decision script (returns the reply tuple); `"read"` = non-consuming peek. */
  role: "check" | "read";
  /** The committed filename, relative to `wire/scripts/`. */
  file: string;
  /** `KEYS` the script touches, by name (always the single limiter key today). */
  keys: string[];
  /**
   * The full `ARGV` layout, in order. `ARGV[1]` is always `now` (epoch-ms; `0` ⇒ use the Redis server
   * clock). A `read` script takes no ARGV.
   */
  argv: string[];
  /** The resolved Lua source — the `LUA_NOW` preamble already inlined, byte-identical to what ships. */
  source: string;
  /** `sha256(source)` hex — the checksum a port pins so the two repos can never silently diverge. */
  sha256: string;
}

/** The pinned manifest a port vendors alongside the `.lua` files. */
export interface ScriptManifest {
  /** The wire-contract version a port pins to (shared with the golden vectors). Bumps only on a break. */
  contractVersion: string;
  /** Provenance: the package version the scripts were extracted from. Informational, not the contract. */
  generatedFrom: string;
  /** `false` until the raw Lua wire is formally frozen (bet #78). See `wire/WIRE-PROTOCOL.md`. */
  frozen: boolean;
  /** The integer reply array every `check` script returns, in order — a port self-checks its decoding. */
  replyTuple: ["allowed", "limit", "remaining", "resetAt", "retryAfterMs"];
  /** How `ARGV[1]` is interpreted across every script. */
  nowArgv: string;
  /** The extracted scripts, with their per-script sha256 pins. */
  scripts: Omit<ExtractedScript, "source">[];
}

/** The ARGV layout for each strategy's `check` script (after `ARGV[1] = now`), part of the wire. */
const CHECK_ARGV: Record<string, string[]> = {
  gcra: ["now", "periodMs", "limit", "burst", "cost"],
  tokenBucket: ["now", "capacity", "refillPerSec", "cost"],
  fixedWindow: ["now", "limit", "windowMs", "cost"],
  slidingWindow: ["now", "windowMs", "limit", "cost", "buckets"],
  slidingWindowLog: ["now", "windowMs", "limit", "cost"],
};

/** Construct each strategy once (the script is option-independent) and read its resolved Lua. */
const STRATEGIES: Strategy[] = [
  gcra({ limit: 10, periodMs: 1000, burst: 5 }) as Strategy,
  tokenBucket({ capacity: 10, refillPerSec: 5 }) as Strategy,
  fixedWindow({ limit: 5, windowMs: 1000 }) as Strategy,
  slidingWindow({ limit: 10, windowMs: 1000, buckets: 10 }) as Strategy,
  slidingWindowLog({ limit: 5, windowMs: 1000 }) as Strategy,
];

function sha256(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

function scriptsFor(strategy: Strategy): ExtractedScript[] {
  const name = strategy.name;
  const out: ExtractedScript[] = [];

  const check = strategy.lua;
  if (check) {
    out.push({
      name: `${name}.check`,
      strategy: name,
      role: "check",
      file: `${name}.check.lua`,
      keys: ["key"],
      argv: CHECK_ARGV[name] ?? [],
      source: check.script,
      sha256: sha256(check.script),
    });
  }

  const read = strategy.readState?.lua;
  if (read) {
    out.push({
      name: `${name}.read`,
      strategy: name,
      role: "read",
      file: `${name}.read.lua`,
      keys: ["key"],
      argv: [],
      source: read.script,
      sha256: sha256(read.script),
    });
  }

  return out;
}

/** Every extracted script, with its source. Pure — safe to call from tests. */
export function extractScripts(): ExtractedScript[] {
  return STRATEGIES.flatMap(scriptsFor);
}

/** The pinned manifest (no sources — those live in the `.lua` files). Pure. */
export function buildManifest(): ScriptManifest {
  const scripts = extractScripts().map(({ source: _source, ...meta }) => meta);
  return {
    contractVersion: "1",
    generatedFrom: `throttlekit@${version}`,
    frozen: false,
    replyTuple: ["allowed", "limit", "remaining", "resetAt", "retryAfterMs"],
    nowArgv: "ARGV[1] = now (epoch-ms); the sentinel 0 means use the Redis server TIME clock",
    scripts,
  };
}
