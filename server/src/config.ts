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

import {
  MemoryStore,
  ThrottleKitError,
  adaptiveConcurrency,
  tokenBudget,
  unifiedAdmission,
} from "throttlekit";
import type {
  AdaptiveConcurrencyOptions,
  Clock,
  ConcurrencyGuard,
  Limiter,
  Strategy,
  TokenBudgetMeter,
  UnifiedAdmitter,
} from "throttlekit";
import {
  type ConfigFile,
  type LimiterSpec,
  type LoadConfigOptions,
  loadConfigObject,
  parseYaml,
} from "throttlekit/config";
import {
  type LeaseOptions,
  type TwoTierMode,
  type WeightedFairEscrowLimiter,
  twoTier,
  weightedFairEscrow,
} from "throttlekit/twotier";

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

/** The optional `tokenBudget` block — turns a policy into a windowed token-budget meter (the cost axis). */
export interface TokenBudgetConfig {
  /** Token budget enforced over each window (positive integer). */
  budget: number;
  /** Window width in ms (epoch-aligned). */
  windowMs: number;
  /** Max distinct keys to keep a live meter for; the oldest is dropped past this (default 100_000). */
  maxKeys?: number;
}

/**
 * The optional `concurrency` block — turns a policy into an **admission** policy served by the stateful
 * `Admit`/`Release`/`Heartbeat` lifecycle (the GALE concurrency axis). On its own it is a concurrency-only
 * admitter; alongside the policy's `strategy`/`limit`/`period` it is a **unified** rate×concurrency
 * admitter. The decision is the core's `adaptiveConcurrency`/`unifiedAdmission` (one oracle); this only
 * wires the config so a polyglot client's `admit` reaches it. A subset of `AdaptiveConcurrencyOptions`.
 */
export interface ConcurrencyConfig {
  /** Hard floor on the inferred ceiling. Default 4. Set `minLimit === maxLimit` to pin a fixed limit. */
  minLimit?: number;
  /** Hard ceiling on the inferred ceiling. Default 512. */
  maxLimit?: number;
  /** Where the estimate starts. Default `minLimit`. */
  initialLimit?: number;
  /** Inference law: `"gradient2"` (default) or `"aimd"`. */
  algorithm?: "gradient2" | "aimd";
  /** Sample count for the rolling-min no-load RTT. Default 100. */
  rttWindow?: number;
  /** Gradient2 EMA factor in (0,1]. Default 0.2. */
  smoothing?: number;
  /** Headroom factor on the no-load RTT. Default 2.0. */
  tolerance?: number;
  /** AIMD multiplicative decrease in [0.5,1). Default 0.9. */
  backoffRatio?: number;
}

/**
 * The optional `fairEscrow` block — turns a policy into a **weighted-fair-escrow** limiter: one shared
 * per-window budget split across tenants in proportion to weight, idle tenants' surplus reclaimed by
 * backlogged ones. The request `key` IS the tenant. The decision is the core's `weightedFairEscrow` (one
 * oracle). Single-process (L1-only) on the server today; a fleet-shared (L2) fair budget is a follow-up.
 */
export interface FairEscrowConfig {
  /** Global per-window budget `L` (> 0). */
  limit: number;
  /** Window width in ms (epoch-aligned). */
  windowMs: number;
  /** Per-tenant weights (each must be > 0); a tenant not listed defaults to weight 1. */
  weights?: Record<string, number>;
  /**
   * Max distinct tenants to keep per-window state for, FIFO-evicting beyond it. The request `key` is the
   * tenant and comes off the wire untrusted, so this bounds memory growth on a public surface. Default
   * 100_000 (mirrors the token-budget meter), per the core's "set on public surfaces" guidance.
   */
  maxKeys?: number;
  /**
   * **Cost Room** (the `--tui` cost-axis burn-down view, #282). Default **on** for every `fairEscrow`
   * policy — set `false` to opt out. Pure monitoring: a snapshot-time per-tenant burn ring read off this
   * policy's `stats()`; no decision-path cost, no wire change.
   */
  costRoom?: boolean;
  /** Cost Room: max tenants to keep a burn time-series for (independent of `maxKeys`). Default 64. */
  costRoomMaxKeys?: number;
  /** Cost Room: per-tenant burn-ring capacity. Default 16. */
  costRoomRingSize?: number;
  /**
   * Cost Room: the declared unit label, echoed verbatim in the view (default `"units (cost)"`). Free-form
   * so a policy metering tokens / requests / credits / USD labels it honestly — never assumed "tokens".
   */
  unit?: string;
}

/** A policy spec, extended with the optional server-only `twoTier` / `tokenBudget` / `concurrency` / `fairEscrow` blocks. */
export type ServerLimiterSpec = LimiterSpec & {
  twoTier?: TwoTierConfig;
  tokenBudget?: TokenBudgetConfig;
  concurrency?: ConcurrencyConfig;
  fairEscrow?: FairEscrowConfig;
};

/**
 * A token-budget (cost-axis) policy. The service keeps one {@link TokenBudgetMeter} per key (made by
 * `create`, bounded by `maxKeys`). The meter is single-instance by nature (per the core primitive) — a
 * fleet-shared budget is a future enhancement via the core's `DistributedTokenBudgetMeter`.
 */
export interface MeterPolicy {
  /** Make a fresh meter for one key. */
  create(): TokenBudgetMeter;
  /** Max distinct keys to retain meters for (FIFO-evict beyond this). */
  maxKeys: number;
}

/**
 * Resolved Cost Room options for one `fairEscrow` policy (#282 P3) — what the monitor needs to register a
 * burn-down source. Carried alongside {@link ServiceConfig.fairness} so the (config-free) wire layer can
 * honor the per-policy opt-out + declared labels without re-parsing the config.
 */
export interface CostRoomConfig {
  /** This policy's window width (ms) — the cost-room source's window edge. */
  windowMs: number;
  /** Whether the Cost Room is enabled for this policy (default on; `costRoom: false` opts out). */
  enabled: boolean;
  /** Declared unit label (echoed verbatim; default applied downstream). */
  unit?: string;
  /** Accumulator tenant cap (burn time-series). */
  maxKeys?: number;
  /** Per-tenant burn-ring capacity. */
  ringSize?: number;
}

/**
 * The resolved policies a service serves: rate/two-tier {@link Limiter}s, token-budget
 * {@link MeterPolicy}s, and concurrency/unified {@link UnifiedAdmitter}s (the stateful admission axis).
 */
export interface ServiceConfig {
  limiters: Record<string, Limiter>;
  meters: Record<string, MeterPolicy>;
  admitters: Record<string, UnifiedAdmitter>;
  /** The concurrency guard inside each admitter, exposed for monitoring (the admitter encapsulates it). */
  guards: Record<string, ConcurrencyGuard>;
  /** Weighted-fair-escrow policies (served by `check`, key = tenant; not `Limiter`s). */
  fairness: Record<string, WeightedFairEscrowLimiter>;
  /** Per-`fairEscrow`-policy Cost Room options (monitoring only); one entry per fairness policy. */
  costRooms: Record<string, CostRoomConfig>;
}

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
 * Build the service's policies from `.throttlekit.yaml`/`.json` text: rate-limit and `twoTier` policies as
 * {@link Limiter}s, and `tokenBudget` policies as {@link MeterPolicy}s. Plain rate-limit policies are
 * delegated to the core `loadConfig` unchanged.
 */
export function buildServiceConfig(text: string, options: ServerLoadOptions = {}): ServiceConfig {
  const data = parseConfigText(text, options.format);
  if (data == null || typeof data !== "object" || Array.isArray(data))
    throw new ThrottleKitError("config: expected an object at the top level");
  const limitersIn = data.limiters;
  if (limitersIn == null || typeof limitersIn !== "object" || Array.isArray(limitersIn))
    throw new ThrottleKitError("config: missing `limiters` map");

  const defaultPrefix = data.defaults?.prefix;
  const meters: Record<string, MeterPolicy> = {};
  const twoTierLimiters: Record<string, Limiter> = {};
  const admitters: Record<string, UnifiedAdmitter> = {};
  const guards: Record<string, ConcurrencyGuard> = {};
  const fairness: Record<string, WeightedFairEscrowLimiter> = {};
  const costRooms: Record<string, CostRoomConfig> = {};
  const rateLimitOnly: Record<string, LimiterSpec> = {};

  for (const [name, rawSpec] of Object.entries(limitersIn)) {
    const spec = rawSpec as ServerLimiterSpec;
    // The kind blocks are mutually exclusive — a policy is one of them. Reject a spec that declares more
    // than one loudly (the dispatch below is first-match-wins, which would otherwise silently drop the rest).
    if (spec != null && typeof spec === "object") {
      const kinds = [spec.tokenBudget, spec.fairEscrow, spec.concurrency, spec.twoTier].filter(
        (b) => b !== undefined,
      ).length;
      if (kinds > 1)
        throw new ThrottleKitError(
          `config.limiters[${name}]: a policy may declare at most one of tokenBudget / fairEscrow / concurrency / twoTier`,
        );
    }
    if (spec != null && typeof spec === "object" && spec.tokenBudget !== undefined) {
      meters[name] = buildMeter(name, spec, options);
    } else if (spec != null && typeof spec === "object" && spec.fairEscrow !== undefined) {
      fairness[name] = buildFairEscrow(name, spec, options);
      costRooms[name] = resolveCostRoom(name, spec.fairEscrow as FairEscrowConfig);
    } else if (spec != null && typeof spec === "object" && spec.concurrency !== undefined) {
      const built = buildAdmitter(name, spec, options, data);
      admitters[name] = built.admitter;
      guards[name] = built.guard; // expose the encapsulated guard for the Concurrency / Guarantee views
    } else if (spec != null && typeof spec === "object" && spec.twoTier !== undefined) {
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

  return {
    limiters: { ...rest, ...twoTierLimiters },
    meters,
    admitters,
    guards,
    fairness,
    costRooms,
  };
}

/**
 * Resolve a `fairEscrow` policy's Cost Room options (#282 P3). Default-on; `costRoom: false` opts out.
 * Validates the optional bounds so a bad config fails fast with a clear message rather than being silently
 * clamped downstream.
 */
function resolveCostRoom(name: string, fe: FairEscrowConfig): CostRoomConfig {
  const positiveInt = (label: string, v: number | undefined): number | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0)
      throw new ThrottleKitError(
        `config.limiters[${name}].fairEscrow.${label}: must be a positive integer`,
      );
    return v;
  };
  const cr: CostRoomConfig = { windowMs: fe.windowMs, enabled: fe.costRoom !== false };
  if (fe.unit !== undefined) cr.unit = fe.unit;
  const maxKeys = positiveInt("costRoomMaxKeys", fe.costRoomMaxKeys);
  if (maxKeys !== undefined) cr.maxKeys = maxKeys;
  const ringSize = positiveInt("costRoomRingSize", fe.costRoomRingSize);
  if (ringSize !== undefined) cr.ringSize = ringSize;
  return cr;
}

/**
 * Build just the named limiters (rate-limit + two-tier) — a thin wrapper over {@link buildServiceConfig}
 * for callers that don't serve token-budget policies.
 */
export function buildLimitersFromConfig(
  text: string,
  options: ServerLoadOptions = {},
): Record<string, Limiter> {
  return buildServiceConfig(text, options).limiters;
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

function buildMeter(
  name: string,
  spec: ServerLimiterSpec,
  options: ServerLoadOptions,
): MeterPolicy {
  const tb = spec.tokenBudget as TokenBudgetConfig;
  if (tb.budget === undefined || tb.windowMs === undefined)
    throw new ThrottleKitError(
      `config.limiters[${name}].tokenBudget: both \`budget\` and \`windowMs\` are required`,
    );
  const { budget, windowMs } = tb;
  const clock = options.clock;
  return {
    create: (): TokenBudgetMeter =>
      tokenBudget({ budget, windowMs, ...(clock !== undefined ? { clock } : {}) }),
    maxKeys: tb.maxKeys ?? 100_000,
  };
}

/**
 * Build a concurrency / unified admitter. The `concurrency` block configures the core's
 * `adaptiveConcurrency` guard; if the policy also names a rate `strategy`, that limiter (built by the core
 * loader, so it shares the injected store + prefix defaults) becomes the rate axis of a `unifiedAdmission`.
 * The decision is the core's — this only assembles the axes the policy declared.
 */
function buildAdmitter(
  name: string,
  spec: ServerLimiterSpec,
  options: ServerLoadOptions,
  data: ConfigFile,
): { admitter: UnifiedAdmitter; guard: ConcurrencyGuard } {
  const cc = spec.concurrency ?? {};
  const clock = options.clock;
  const guard = adaptiveConcurrency({ ...cc, ...(clock !== undefined ? { clock } : {}) });

  // Optional rate axis (→ unified). Built like a plain policy so it gets the store + prefix defaults;
  // the core loader ignores the extra `concurrency` field (as it does `twoTier`).
  let rate: Limiter | undefined;
  if (spec.strategy !== undefined) {
    const coreOptions: LoadConfigOptions = {
      ...(options.store !== undefined ? { store: options.store } : {}),
    };
    const built = loadConfigObject(
      {
        ...(data.defaults !== undefined ? { defaults: data.defaults } : {}),
        limiters: { [name]: spec },
      },
      coreOptions,
    ).limiters[name];
    if (built === undefined)
      throw new ThrottleKitError(`config.limiters[${name}]: could not build the rate axis`);
    rate = built;
  }

  const admitter = unifiedAdmission({
    concurrency: guard,
    ...(rate !== undefined ? { rate } : {}),
    ...(clock !== undefined ? { clock } : {}),
  });
  return { admitter, guard };
}

/**
 * Build a weighted-fair-escrow limiter from a policy's `fairEscrow` block. The request key is the tenant;
 * a tenant not in `weights` gets weight 1. Single-process (L1-only) — no `l2`, so `check` never throws.
 */
function buildFairEscrow(
  name: string,
  spec: ServerLimiterSpec,
  options: ServerLoadOptions,
): WeightedFairEscrowLimiter {
  const fe = spec.fairEscrow as FairEscrowConfig;
  if (fe.limit === undefined || fe.windowMs === undefined)
    throw new ThrottleKitError(
      `config.limiters[${name}].fairEscrow: both \`limit\` and \`windowMs\` are required`,
    );
  const weights = fe.weights ?? {};
  // The core validates weights > 0 lazily inside `check` and throws — but on this L1-only path that throw
  // would be swallowed by the service's fail-mode catch, masking the config bug. Reject it up front instead.
  for (const [tenant, w] of Object.entries(weights)) {
    if (typeof w !== "number" || !(w > 0))
      throw new ThrottleKitError(
        `config.limiters[${name}].fairEscrow.weights[${tenant}]: weight must be a positive number`,
      );
  }
  const clock = options.clock;
  return weightedFairEscrow({
    limit: fe.limit,
    windowMs: fe.windowMs,
    weightOf: (tenant) => weights[tenant] ?? 1,
    // Bound untrusted per-tenant growth (the request key is the tenant) — mirrors the meter's maxKeys.
    l1: { maxKeys: fe.maxKeys ?? 100_000 },
    ...(clock !== undefined ? { clock } : {}),
  });
}
