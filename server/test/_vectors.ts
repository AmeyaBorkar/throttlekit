/**
 * Shared test fixture: the committed golden vectors + a strategy builder. The server is a *consumer* of
 * `wire/vectors/golden-vectors.json` (exactly like a polyglot port), so the tests read that artifact
 * rather than the oracle TS. Not a test file itself (no `.test` suffix), so vitest won't collect it.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fixedWindow, gcra, slidingWindow, slidingWindowLog, tokenBucket } from "throttlekit";
import type { Strategy } from "throttlekit";

export interface DecisionVector {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterMs: number;
}

export interface VectorOp {
  now: number;
  cost: number;
  expect: DecisionVector;
}

export interface VectorSuite {
  primitive: string;
  name: string;
  strategy: { kind: string; options: any };
  key: string;
  ops: VectorOp[];
}

const vectorsPath = fileURLToPath(
  new URL("../../wire/vectors/golden-vectors.json", import.meta.url),
);
const doc = JSON.parse(readFileSync(vectorsPath, "utf8")) as { suites: VectorSuite[] };

/** Every rateLimit suite (the decision-returning primitives the service exposes). */
export const rateLimitSuites: VectorSuite[] = doc.suites.filter((s) => s.primitive === "rateLimit");

/** Map a golden-vector strategy spec to its public `throttlekit` factory. */
export function buildStrategy(spec: { kind: string; options: any }): Strategy {
  switch (spec.kind) {
    case "gcra":
      return gcra(spec.options);
    case "tokenBucket":
      return tokenBucket(spec.options);
    case "fixedWindow":
      return fixedWindow(spec.options);
    case "slidingWindow":
      return slidingWindow(spec.options);
    case "slidingWindowLog":
      return slidingWindowLog(spec.options);
    default:
      throw new Error(`unknown strategy kind ${spec.kind}`);
  }
}

/** Pull the five decision fields off a returned object (core Decision or proto message) for comparison. */
export function decisionFields(d: DecisionVector): DecisionVector {
  return {
    allowed: d.allowed,
    limit: d.limit,
    remaining: d.remaining,
    resetAt: d.resetAt,
    retryAfterMs: d.retryAfterMs,
  };
}
