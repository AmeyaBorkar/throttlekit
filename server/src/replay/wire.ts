/**
 * `wireReplay` — compose a config text + its `replay:` block into the deterministic-capture machinery: one
 * {@link Shadow} per selected **leaf-rate** policy (built from that policy's full `LimiterSpec`, so the
 * trace rebuilds and replays — unlike the forensic capture's lossy `{strategy, limit}` identity), a `feed`
 * that routes a live decision to its shadow, and a `runConfiguredWhatIf` the TUI trigger calls.
 *
 * A policy is leaf-rate iff it names a `strategy` and declares none of the server-only kind blocks
 * (`twoTier` / `tokenBudget` / `concurrency` / `fairEscrow`) — exactly the policies the testkit can rebuild.
 * A leaf-rate spec the testkit can't rebuild (e.g. `leakyBucket`, a `Shaper`) is **skipped**, not fatal.
 */

import { parseYaml } from "throttlekit/config";
import type { LimiterSpec } from "throttlekit/config";
import { createRedactor } from "../capture/redact.js";
import { type ReplayConfig, resolveReplayConfig } from "./config.js";
import { type Shadow, createShadow } from "./shadow.js";
import { type ReplayDivergenceSnapshot, runWhatIf } from "./whatif.js";

/** The server-only kind blocks that make a policy NOT a plain leaf-rate limiter. */
const KIND_BLOCKS = ["twoTier", "tokenBudget", "concurrency", "fairEscrow"] as const;

interface ParsedConfig {
  limiters?: Record<string, unknown>;
  replay?: unknown;
}

/** Parse a config text (YAML or JSON, mirroring the core/capture loaders) for its `limiters` + `replay`. */
function parseConfig(text: string): ParsedConfig {
  const trimmed = text.trim();
  const data = (
    trimmed.startsWith("{") || trimmed.startsWith("[") ? JSON.parse(text) : parseYaml(text)
  ) as ParsedConfig;
  return data ?? {};
}

/** A policy is leaf-rate iff it names a strategy and declares no server-only kind block. */
function isLeafRate(spec: unknown): spec is LimiterSpec {
  if (spec === null || typeof spec !== "object") return false;
  const s = spec as Record<string, unknown>;
  if (typeof s.strategy !== "string") return false;
  return KIND_BLOCKS.every((b) => s[b] === undefined);
}

/** The wired result: the shadows + the feed/what-if entry points (all no-ops when replay is disabled). */
export interface WiredReplay {
  readonly enabled: boolean;
  readonly config: ReplayConfig;
  readonly shadows: ReadonlyMap<string, Shadow>;
  /** Leaf-rate policies that matched but couldn't be rebuilt by the testkit (e.g. `leakyBucket`) — skipped. */
  readonly skipped: readonly string[];
  /** Record one live leaf-rate decision into its shadow (no-op if the policy isn't shadowed). O(1), never throws. */
  feed(policy: string, key: string, cost?: number): void;
  /** Run the configured what-if → a render-ready snapshot, or `undefined` when none is configured/shadowed. */
  runConfiguredWhatIf(): ReplayDivergenceSnapshot | undefined;
}

/** Options for {@link wireReplay}. */
export interface WireReplayOptions {
  /** Env source for the hmac redaction secret (default `process.env`). */
  env?: Record<string, string | undefined>;
  /** Wall-clock source for the shadows (epoch-ms), injected for deterministic tests. Default `Date.now`. */
  now?: () => number;
}

const DISABLED_FEED = (): void => {};

/** Compose a config text into the deterministic-capture machinery. Disabled ⇒ inert no-ops. */
export function wireReplay(text: string, options: WireReplayOptions = {}): WiredReplay {
  const parsed = parseConfig(text);
  const config = resolveReplayConfig(parsed.replay, {
    ...(options.env !== undefined ? { env: options.env } : {}),
  });

  if (!config.enabled) {
    return {
      enabled: false,
      config,
      shadows: new Map(),
      skipped: [],
      feed: DISABLED_FEED,
      runConfiguredWhatIf: () => undefined,
    };
  }

  const redactor = createRedactor(config.redaction);
  const shadows = new Map<string, Shadow>();
  const skipped: string[] = [];
  for (const [name, rawSpec] of Object.entries(parsed.limiters ?? {})) {
    if (!isLeafRate(rawSpec)) continue;
    if (config.policies !== undefined && !config.policies.includes(name)) continue;
    try {
      shadows.set(
        name,
        createShadow(rawSpec, {
          redactor,
          maxSteps: config.maxSteps,
          ...(options.now !== undefined ? { now: options.now } : {}),
        }),
      );
    } catch {
      // A leaf-rate strategy the testkit can't rebuild (e.g. leakyBucket) is skipped, not fatal.
      skipped.push(name);
    }
  }

  const feed = (policy: string, key: string, cost = 1): void => {
    shadows.get(policy)?.feed(key, cost);
  };

  const runConfiguredWhatIf = (): ReplayDivergenceSnapshot | undefined => {
    const cc = config.candidate;
    if (cc === undefined) return undefined;
    const shadow = shadows.get(cc.policy);
    if (shadow === undefined) return undefined; // configured policy isn't a shadowed leaf-rate policy
    return runWhatIf(cc.policy, shadow, cc.candidate);
  };

  return { enabled: true, config, shadows, skipped, feed, runConfiguredWhatIf };
}
