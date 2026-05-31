/**
 * Server-side config loading.
 *
 * The core `loadConfig` (`throttlekit/config`) understands rate-limit strategies only. This thin layer
 * adds an optional `twoTier:` block to a policy so it can be a **two-tier leased** limiter — L1-local
 * credits drawn in batches from a shared L2 store — built from the core's exported `twoTier()`. Every
 * policy *without* a `twoTier` block is delegated to the core loader unchanged, so the rate-limit path is
 * byte-for-byte what it was before. The two-tier decision is still computed by the core (one oracle);
 * this only wires the config so a polyglot client's plain `check` reaches a leased policy.
 *
 * @example
 * ```yaml
 * limiters:
 *   api:                                   # plain rate limit (delegated to the core loader, unchanged)
 *     { strategy: gcra, limit: 100, period: 1m, burst: 20 }
 *   leased-api:                            # two-tier: the same strategy enforced at L2, leased to L1
 *     strategy: gcra
 *     limit: 100
 *     period: 1m
 *     twoTier: { mode: leased, batch: 20, windowCoupled: true }
 * ```
 */

import { MemoryStore, ThrottleKitError } from "throttlekit";
import type { Clock, Limiter, Strategy } from "throttlekit";
import {
  type ConfigFile,
  type LimiterSpec,
  type LoadConfigOptions,
  loadConfigObject,
  parseYaml,
} from "throttlekit/config";
import { type LeaseOptions, type TwoTierMode, twoTier } from "throttlekit/twotier";

/** The optional `twoTier` block on a policy spec — turns a rate-limit policy into a two-tier limiter. */
export interface TwoTierConfig {
  /** `"strict"` | `"cached-deny"` | `"leased"`. Default `"leased"`. */
  mode?: TwoTierMode;
  /** Tokens leased from L2 per refill (required for `leased` mode). */
  batch?: number;
  /** Refill asynchronously when local credits fall to/below this (default 0 = lease on demand). */
  lowWater?: number;
  /** Couple credit lifetime to the L2 window so per-window overshoot is exactly `Limit`, independent of fleet size. */
  windowCoupled?: boolean;
  /** Drop a key's idle local credits after this many ms. */
  returnIdleAfterMs?: number;
}

/** A policy spec, extended with the optional server-only `twoTier` block. */
export type ServerLimiterSpec = LimiterSpec & { twoTier?: TwoTierConfig };

/** Options for {@link buildLimitersFromConfig}: the core loader options plus an injectable clock. */
export interface ServerLoadOptions extends LoadConfigOptions {
  /** Clock for the two-tier limiters (mainly tests); the runtime uses the system clock. */
  clock?: Clock;
}

function parseConfigText(text: string, format: "yaml" | "json" | undefined): ConfigFile {
  const trimmed = text.trim();
  const fmt = format ?? (trimmed.startsWith("{") || trimmed.startsWith("[") ? "json" : "yaml");
  return (fmt === "json" ? JSON.parse(text) : parseYaml(text)) as ConfigFile;
}

/**
 * Build the named limiters from `.throttlekit.yaml`/`.json` text, honouring an optional `twoTier` block
 * per policy. Policies without a `twoTier` block are delegated to the core `loadConfig` unchanged.
 */
export function buildLimitersFromConfig(
  text: string,
  options: ServerLoadOptions = {},
): Record<string, Limiter> {
  const data = parseConfigText(text, options.format);
  if (data == null || typeof data !== "object" || Array.isArray(data))
    throw new ThrottleKitError("config: expected an object at the top level");
  const limitersIn = data.limiters;
  if (limitersIn == null || typeof limitersIn !== "object" || Array.isArray(limitersIn))
    throw new ThrottleKitError("config: missing `limiters` map");

  const defaultPrefix = data.defaults?.prefix;
  const twoTierLimiters: Record<string, Limiter> = {};
  const rateLimitOnly: Record<string, LimiterSpec> = {};

  for (const [name, rawSpec] of Object.entries(limitersIn)) {
    const spec = rawSpec as ServerLimiterSpec;
    if (spec != null && typeof spec === "object" && spec.twoTier !== undefined) {
      twoTierLimiters[name] = buildTwoTier(name, spec, options, defaultPrefix);
    } else {
      rateLimitOnly[name] = rawSpec as LimiterSpec;
    }
  }

  // Delegate every plain rate-limit policy to the core loader, untouched.
  const coreOptions: LoadConfigOptions = {
    ...(options.store !== undefined ? { store: options.store } : {}),
    ...(options.format !== undefined ? { format: options.format } : {}),
  };
  const rest = loadConfigObject({ ...data, limiters: rateLimitOnly }, coreOptions).limiters;

  return { ...rest, ...twoTierLimiters };
}

function buildTwoTier(
  name: string,
  spec: ServerLimiterSpec,
  options: ServerLoadOptions,
  defaultPrefix: string | undefined,
): Limiter {
  const tt = spec.twoTier ?? {};
  const mode: TwoTierMode = tt.mode ?? "leased";
  // L2 is the shared store when one is configured (`--redis` → a coordinated fleet). Without one, fall
  // back to a private in-process store — single-instance two-tier, the same default a plain limiter gets.
  const store = options.store ?? new MemoryStore();

  // `buildStrategy` is private to the core loader, so reuse it indirectly: have the core build a
  // throwaway limiter from this policy's strategy fields and take its `.strategy` (never invoked — only
  // read). Extra fields (`twoTier`, `prefix`) are ignored by the core's strategy builder.
  const built = loadConfigObject({ limiters: { [name]: spec } }).limiters[name];
  if (built === undefined)
    throw new ThrottleKitError(`config.limiters[${name}]: could not build a strategy`);
  const strategy: Strategy = built.strategy;

  const prefix = spec.prefix ?? defaultPrefix ?? name;
  return twoTier({
    strategy,
    l2: store,
    mode,
    ...(mode === "leased" ? { lease: buildLease(tt) } : {}),
    prefix,
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
  });
}

function buildLease(tt: TwoTierConfig): LeaseOptions {
  return {
    ...(tt.batch !== undefined ? { batch: tt.batch } : {}),
    ...(tt.lowWater !== undefined ? { lowWater: tt.lowWater } : {}),
    ...(tt.windowCoupled !== undefined ? { windowCoupled: tt.windowCoupled } : {}),
    ...(tt.returnIdleAfterMs !== undefined ? { returnIdleAfterMs: tt.returnIdleAfterMs } : {}),
  };
}
