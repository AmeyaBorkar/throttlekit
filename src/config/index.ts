/**
 * Rate-limit-as-code: load a `.throttlekit.yaml` (or `.throttlekit.json`) into ready-to-use
 * {@link Limiter} instances. The config declares **strategies and policies**, not live clients —
 * the {@link Store} is injected at load time (you can't serialise an `ioredis` client into YAML).
 *
 * @example
 * ```yaml
 * # .throttlekit.yaml
 * version: 1
 * limiters:
 *   api:        { strategy: gcra,         limit: 100, period: 1m, burst: 20 }
 *   uploads:    { strategy: fixedWindow,  limit: 10,  period: 1h }
 *   monthly:    { strategy: quota,        limit: 1000000, resetCadence: calendar-month }
 * ```
 * ```ts
 * import { loadConfig } from "throttlekit/config";
 * import { RedisStore } from "throttlekit/redis";
 * const { limiters } = loadConfig(readFileSync(".throttlekit.yaml", "utf8"), { store: new RedisStore({ client }) });
 * app.use("/api",     expressRateLimit({ limiter: limiters.api }));
 * app.use("/uploads", expressRateLimit({ limiter: limiters.uploads }));
 * ```
 */

import { fixedWindow } from "../algorithms/fixed-window";
import { gcra } from "../algorithms/gcra";
import { type QuotaCadence, quota } from "../algorithms/quota";
import { slidingWindow } from "../algorithms/sliding-window";
import { slidingWindowLog } from "../algorithms/sliding-window-log";
import { tokenBucket } from "../algorithms/token-bucket";
import { parseDuration } from "../core/duration";
import { ThrottleKitError } from "../core/errors";
import { rateLimit } from "../core/limiter";
import type { Limiter, Store, Strategy } from "../core/types";
import { parseYaml } from "./yaml";

/** Strategy name a {@link LimiterSpec} can pick. */
export type ConfigStrategy =
  | "gcra"
  | "tokenBucket"
  | "fixedWindow"
  | "slidingWindow"
  | "slidingWindowLog"
  | "quota";

/** One named limiter in the config — declares its strategy and policy. */
export interface LimiterSpec {
  /** Which algorithm to use. */
  strategy: ConfigStrategy;
  /** Sustained ceiling (gcra/fixedWindow/slidingWindow/slidingWindowLog/quota). */
  limit?: number;
  /** Window/period — `"1m"`, `"30s"`, `"1h"`, `"1d"`, or a number of ms. */
  period?: string | number;
  /** GCRA burst allowance (default = `limit`). */
  burst?: number;
  /** Token-bucket capacity. */
  capacity?: number;
  /** Token-bucket refill rate (tokens per second; may be fractional). */
  refillPerSec?: number;
  /** Explicit `windowMs` if you'd rather not use `period`. */
  windowMs?: number;
  /** Sub-buckets for `slidingWindow` (default 10). */
  buckets?: number;
  /** Quota reset cadence — `"calendar-month"` etc. (required for `quota`). */
  resetCadence?: QuotaCadence;
  /** Fixed offset (minutes) for calendar cadences. */
  offsetMinutes?: number;
  /** Day the week starts on for `calendar-week` (0=Sun … 6=Sat). */
  weekStartsOn?: number;
  /** Anchor for `quota({ resetCadence: "fixed" })`. */
  anchor?: number;
  /** Period (ms) for `quota` `"fixed"` / `"rolling"` if you prefer ms over `period`. */
  periodMs?: number;
  /** Key prefix override for this limiter (defaults to the entry name). */
  prefix?: string;
}

/** The top-level shape of `.throttlekit.yaml` / `.throttlekit.json`. */
export interface ConfigFile {
  /** Schema version (current: 1). */
  version?: number;
  /** Defaults applied where a limiter doesn't override. */
  defaults?: { prefix?: string };
  /** Named limiters keyed by their human label. */
  limiters: Record<string, LimiterSpec>;
}

export interface LoadConfigOptions {
  /** Shared store for every built limiter (default: a private in-process store per limiter). */
  store?: Store;
  /** Force a format. Default: auto-detect (text starting with `{` or `[` is JSON, else YAML). */
  format?: "yaml" | "json";
}

export interface LoadedConfig {
  /** Limiters keyed by config name, ready to pass into any adapter. */
  limiters: Record<string, Limiter>;
}

/** Parse and build limiters from raw config text. */
export function loadConfig(text: string, options: LoadConfigOptions = {}): LoadedConfig {
  const trimmed = text.trim();
  const fmt =
    options.format ?? (trimmed.startsWith("{") || trimmed.startsWith("[") ? "json" : "yaml");
  const data: unknown = fmt === "json" ? JSON.parse(text) : parseYaml(text);
  return loadConfigObject(data as ConfigFile, options);
}

/** Build limiters from an already-parsed config object (use when your app brings its own parser). */
export function loadConfigObject(data: ConfigFile, options: LoadConfigOptions = {}): LoadedConfig {
  if (data == null || typeof data !== "object" || Array.isArray(data))
    throw new ThrottleKitError("config: expected an object at the top level");
  const limitersIn = data.limiters;
  if (limitersIn == null || typeof limitersIn !== "object" || Array.isArray(limitersIn))
    throw new ThrottleKitError("config: missing `limiters` map");

  const defaultPrefix = data.defaults?.prefix;
  const limiters: Record<string, Limiter> = {};
  for (const [name, spec] of Object.entries(limitersIn)) {
    limiters[name] = buildLimiter(name, spec as LimiterSpec, options, defaultPrefix);
  }
  return { limiters };
}

function buildLimiter(
  name: string,
  spec: LimiterSpec,
  options: LoadConfigOptions,
  defaultPrefix: string | undefined,
): Limiter {
  if (spec == null || typeof spec !== "object")
    throw new ThrottleKitError(`config.limiters[${name}]: expected an object`);
  const strategy = buildStrategy(name, spec);
  const prefix = spec.prefix ?? defaultPrefix ?? name;
  return rateLimit({
    strategy,
    ...(options.store !== undefined ? { store: options.store } : {}),
    prefix,
  });
}

function buildStrategy(name: string, spec: LimiterSpec): Strategy {
  const where = `config.limiters[${name}]`;
  // Resolve a window in ms from either `period` (duration string|ms) or an explicit ms field.
  const periodOrMs = (msField: number | undefined, label: string): number => {
    if (spec.period !== undefined) return parseDuration(spec.period);
    if (msField !== undefined) return msField;
    throw new ThrottleKitError(`${where}.${label}: required`);
  };

  switch (spec.strategy) {
    case "gcra":
      return gcra({
        limit: required(`${where}.limit`, spec.limit),
        periodMs: periodOrMs(spec.periodMs ?? spec.windowMs, "period"),
        ...(spec.burst !== undefined ? { burst: spec.burst } : {}),
      });
    case "tokenBucket":
      return tokenBucket({
        capacity: required(`${where}.capacity`, spec.capacity),
        refillPerSec: required(`${where}.refillPerSec`, spec.refillPerSec),
      });
    case "fixedWindow":
      return fixedWindow({
        limit: required(`${where}.limit`, spec.limit),
        windowMs: periodOrMs(spec.windowMs, "period"),
      });
    case "slidingWindow":
      return slidingWindow({
        limit: required(`${where}.limit`, spec.limit),
        windowMs: periodOrMs(spec.windowMs, "period"),
        ...(spec.buckets !== undefined ? { buckets: spec.buckets } : {}),
      });
    case "slidingWindowLog":
      return slidingWindowLog({
        limit: required(`${where}.limit`, spec.limit),
        windowMs: periodOrMs(spec.windowMs, "period"),
      });
    case "quota": {
      const resetCadence = spec.resetCadence;
      if (resetCadence === undefined)
        throw new ThrottleKitError(`${where}.resetCadence: required for quota`);
      const periodMs = spec.period !== undefined ? parseDuration(spec.period) : spec.periodMs;
      return quota({
        limit: required(`${where}.limit`, spec.limit),
        resetCadence,
        ...(periodMs !== undefined ? { periodMs } : {}),
        ...(spec.anchor !== undefined ? { anchor: spec.anchor } : {}),
        ...(spec.offsetMinutes !== undefined ? { offsetMinutes: spec.offsetMinutes } : {}),
        ...(spec.weekStartsOn !== undefined ? { weekStartsOn: spec.weekStartsOn } : {}),
        ...(spec.buckets !== undefined ? { buckets: spec.buckets } : {}),
      });
    }
    default:
      throw new ThrottleKitError(
        `${where}.strategy: unknown strategy ${JSON.stringify(spec.strategy)}`,
      );
  }
}

function required<T>(field: string, value: T | undefined): T {
  if (value === undefined || value === null) throw new ThrottleKitError(`${field}: required`);
  return value;
}

export { parseYaml, YamlParseError } from "./yaml";
