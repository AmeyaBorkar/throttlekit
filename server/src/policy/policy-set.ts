/**
 * Build a {@link PolicySet} from a **server** `.throttlekit.yaml`/`.json` config — the server analog of the
 * core `policySetFromConfig`, which only understands core leaf-rate {@link LimiterSpec}s and throws on the
 * server-only blocks (`twoTier` / `concurrency` / `fairEscrow` / `federatedFairEscrow` / `federated` / cost
 * meters). This classifier reads the same extended config the live server serves and routes each policy to
 * the honest side of the Policy-Plans boundary (PP-04):
 *
 * - a **leaf-rate** policy (a plain `strategy`, no server block) → a replayable {@link Policy};
 * - every **non-rate axis** (cost meter, concurrency, two-tier, escrow, federated) → an
 *   {@link UnreplayablePolicy} carrying *why* it cannot be cold-replayed — surfaced in the plan as
 *   `not-replayable` ("observe live via attribution"), never scored as a fabricated zero.
 *
 * A leaf-rate spec that fails to build (a malformed strategy) is likewise carried as unreplayable with the
 * builder's error as its reason, so one bad policy never makes the whole plan throw (the plan stays a
 * never-throws artifact; a `requireAllReplayable` budget catches it if the operator wants strictness).
 */

import { type LimiterSpec, parseYaml } from "throttlekit/config";
import { type Policy, type UnreplayablePolicy, policy, policySet } from "throttlekit/policy";
import type { PolicySet } from "throttlekit/policy";
import type { ServerLimiterSpec } from "../config.js";

/** Options for {@link policySetFromServerConfig}. */
export interface ServerPolicySetOptions {
  /** Label carried on the set (e.g. `"current"` / `"candidate"`) — shown in the plan header. */
  readonly label?: string;
  /** Force a format. Default: auto-detect (text starting with `{`/`[` is JSON, else YAML). */
  readonly format?: "yaml" | "json";
}

/**
 * The server-only blocks that mark a policy non-replayable, each with the honest reason the plan surfaces.
 * Order is the dispatch precedence (mirrors {@link buildServiceConfig}); a policy matching any one is carried
 * as {@link UnreplayablePolicy}. Cost meters are out of scope because the plan replays `check` decisions, not
 * `debit`s; the rest are warm / cross-region / lifecycle state a cold replay cannot reconstruct.
 */
const NON_REPLAYABLE_BLOCKS: ReadonlyArray<readonly [keyof ServerLimiterSpec, string]> = [
  [
    "tokenBudget",
    "cost-budget (debit) axis — the plan replays check decisions, not debits; observe live",
  ],
  [
    "fleetBudget",
    "fleet cost-budget (debit) axis — the plan replays check decisions, not debits; observe live",
  ],
  [
    "concurrency",
    "concurrency axis — a release is not a decision a cold replay can reproduce; observe live via attribution",
  ],
  [
    "distributedConcurrency",
    "distributed-concurrency axis — a release is not a decision a cold replay can reproduce; observe live",
  ],
  ["twoTier", "two-tier leased axis — warm L1/L2 lease state a cold replay cannot reconstruct"],
  ["fairEscrow", "weighted-fair-escrow axis — warm per-window escrow state is not cold-replayable"],
  [
    "federatedFairEscrow",
    "cross-region fair-escrow axis — warm + cross-region pool state is not cold-replayable",
  ],
  [
    "federated",
    "cross-region federated axis — coordinator + window-coupled state is not cold-replayable",
  ],
];

/**
 * The non-rate / server-only block keys — the single source of truth for "this policy is NOT a
 * cold-replayable leaf rate". Anything that consumes a `LimiterSpec` and must distinguish a plain
 * rate limiter from a distributed/stateful axis (e.g. the replay shadow in ../replay/wire.ts) should
 * use THIS list, not a hand-maintained subset, so the two can never drift.
 */
export const NON_REPLAYABLE_BLOCK_KEYS: ReadonlyArray<keyof ServerLimiterSpec> =
  NON_REPLAYABLE_BLOCKS.map(([k]) => k);

/** Parse a config text (YAML or JSON, auto-detected) to its top-level object. */
function parseConfig(text: string, format: "yaml" | "json" | undefined): Record<string, unknown> {
  const trimmed = text.trim();
  const fmt = format ?? (trimmed.startsWith("{") || trimmed.startsWith("[") ? "json" : "yaml");
  const data: unknown = fmt === "json" ? JSON.parse(text) : parseYaml(text);
  if (data == null || typeof data !== "object" || Array.isArray(data))
    throw new Error("policy plan: config must be an object at the top level");
  return data as Record<string, unknown>;
}

/**
 * Classify a server config's `limiters` into replayable leaf-rate {@link Policy}s + the {@link
 * UnreplayablePolicy} axes, and assemble a content-addressed {@link PolicySet}. Never instantiates a live
 * limiter (no store needed), so it is safe in CI / a CLI.
 */
export function policySetFromServerConfig(
  text: string,
  options: ServerPolicySetOptions = {},
): PolicySet {
  const data = parseConfig(text, options.format);
  const limitersIn = data.limiters;
  if (limitersIn == null || typeof limitersIn !== "object" || Array.isArray(limitersIn))
    throw new Error("policy plan: config is missing a `limiters` map");
  const defaultPrefix = (data.defaults as { prefix?: string } | undefined)?.prefix;

  const policies: Policy[] = [];
  const unreplayable: UnreplayablePolicy[] = [];
  for (const [name, rawSpec] of Object.entries(limitersIn as Record<string, ServerLimiterSpec>)) {
    const spec = rawSpec ?? ({} as ServerLimiterSpec);
    const block = NON_REPLAYABLE_BLOCKS.find(([key]) => spec[key] !== undefined);
    if (block !== undefined) {
      unreplayable.push({ name, reason: block[1] });
      continue;
    }
    if (spec.strategy === undefined) {
      unreplayable.push({
        name,
        reason: "no leaf-rate strategy declared (not a check-replayable policy)",
      });
      continue;
    }
    // A leaf-rate policy: build it through the core `policy()` (which validates the strategy). A malformed
    // spec is carried as unreplayable with the builder's message — one bad policy never fails the whole plan.
    const prefix = spec.prefix ?? defaultPrefix ?? name;
    try {
      policies.push(policy(name, { ...(spec as LimiterSpec), prefix }));
    } catch (e) {
      unreplayable.push({ name, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return policySet(policies, {
    unreplayable,
    ...(options.label !== undefined ? { label: options.label } : {}),
  });
}
