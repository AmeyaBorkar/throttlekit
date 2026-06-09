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
  distributedAdaptiveConcurrency,
  distributedTokenBudget,
  tokenBudget,
  unifiedAdmission,
} from "throttlekit";
import type {
  AdaptiveConcurrencyOptions,
  Clock,
  ConcurrencyCoordinator,
  ConcurrencyGuard,
  DistributedTokenBudgetMeter,
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
import { type GlobalCoordinator, federate } from "throttlekit/federation";
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
 * The optional `fleetBudget` block — the **fleet-shared** face of {@link TokenBudgetConfig}. The same
 * windowed token-budget (cost axis), but enforced across every server instance pointed at one shared store
 * (`--redis` / `--postgres` / …) via the core's atomic `distributedTokenBudget`. So a polyglot client's
 * plain `debit` (no client change, no wire change) is now metered against ONE fleet-wide budget per key.
 *
 * **Key-semantics (honest boundary):** the request `key` selects *which* budget — each distinct key gets
 * its own atomic counter at store key `"<prefix>:<key>"`, and every instance sharing the store + that key
 * forms one global budget. A `fleetBudget` policy's `key` therefore means something subtly different from a
 * single-instance {@link TokenBudgetConfig} policy's (which is process-local). Without a shared store this
 * is process-local — equivalent to a plain `tokenBudget` — so a `fleetBudget` policy is correct on one
 * instance and becomes fleet-coordinated the moment a shared store is configured (available-by-default).
 */
export interface FleetBudgetConfig {
  /** Token budget enforced over each window, shared across the whole fleet (positive integer). */
  budget: number;
  /** Window width in ms (epoch-aligned). On Redis the window is rolled by the server clock (skew-proof). */
  windowMs: number;
  /** Max distinct keys to keep a live meter for; the oldest is dropped past this (default 100_000). */
  maxKeys?: number;
  /**
   * Store-key prefix for this policy's budgets (default the policy name). The request `key` is appended as
   * `"<prefix>:<key>"`. Two instances coordinate iff they resolve the same store key, so the default — the
   * shared policy name — makes instances running the same config share a budget automatically; override it
   * only to deliberately share a budget across differently-named policies or to namespace further.
   */
  prefix?: string;
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
 * The optional `distributedConcurrency` block — the **fleet-shared** face of {@link ConcurrencyConfig}. The
 * same adaptive concurrency axis, but the in-flight ceiling is held **across every server instance** pointed
 * at one shared store (`--redis` / `--postgres`) via the core's `distributedAdaptiveConcurrency`: each node
 * periodically heartbeats its locally-inferred limit to a {@link ConcurrencyCoordinator}, which folds the
 * fleet's views into one `L_global` and hands each node its share — so a polyglot client's plain `admit` (no
 * client change, no wire change) is now capped against ONE fleet-wide ceiling, not `Σ` per-instance ceilings.
 *
 * Carries every {@link ConcurrencyConfig} tuning field (forwarded verbatim as each node's *local* adaptive
 * guard) plus the coordinator knobs below. Like the existing `concurrency` block it admits over the stateful
 * `Admit`/`Release`/`Heartbeat` lifecycle, and a co-declared rate `strategy` makes it a **unified**
 * rate×concurrency admitter. The decision is the core's (one oracle); this only wires the config.
 *
 * **Requires a coordinator store** (`--redis` / `--postgres`); `memory` / `dynamodb` cannot coordinate, so a
 * `distributedConcurrency` policy errors there at config time. **Requires a unique server node id**
 * (`--node-id` / `TK_NODE_ID`, defaulting to `host#pid`) — a collision across instances corrupts the
 * fleet aggregate, so identity is mandatory.
 */
export interface DistributedConcurrencyConfig extends ConcurrencyConfig {
  /**
   * Fleet-wide rule folding live nodes' local limits into `L_global`: `"median"` (default) is the lower
   * median; `"min"` the most-stressed node's view. Every instance on a policy MUST agree — so it is set
   * once here and applied to the coordinator the runtime builds.
   */
  aggregate?: "min" | "median";
  /** Coordinator key prefix in the shared store (default the core's `"tk:fed"`). */
  prefix?: string;
  /** Heartbeat / lease-renewal period in ms (the cross-node sync cadence). Default 1000 (the core default). */
  heartbeatMs?: number;
  /**
   * Behaviour when the coordinator is unreachable: `"fail-closed"` (default) stops admitting beyond the
   * last-known share (and self-fences on lease expiry); `"local-only"` serves through the outage against
   * the node's local limit (trading the global bound for availability).
   */
  onCoordinatorOutage?: "fail-closed" | "local-only";
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

/**
 * The optional `federated` block — turns a policy into a **cross-region federated** rate limit: one global
 * per-window budget shared across regions through a {@link GlobalCoordinator} over the shared store, served
 * over the **EXISTING** `Check` RPC (no client change, no wire change). The decision is the core's
 * `federate()` (one oracle); this only wires the config + the server-resolved coordinator.
 *
 * **Requires a window-based strategy** (`fixedWindow` / `slidingWindow` / a windowed quota) — the
 * window-coupling rule needs a discrete window boundary, so a pure-rate strategy (`gcra` / `tokenBucket`)
 * is rejected at config time. **Requires a coordinator store** (`--redis` / `--postgres`); `memory` /
 * `dynamodb` cannot federate. `Peek` / `Forecast` are `UNIMPLEMENTED` on a federated policy (it is async +
 * window-based). Multi-instance correctness comes from the coordinator (L3): every instance leases from one
 * global budget, so the fleet admits at most the strategy's `limit` per window regardless of instance count.
 */
export interface FederatedConfig {
  /**
   * This instance's region identity (used in coordinator keys + telemetry). Falls back to the server-wide
   * `--region` / `TK_REGION`, then `"default"`. Instances in the same region share a global-budget slice;
   * the cross-region global bound holds across all regions.
   */
  region?: string;
  /**
   * Escrow lease size per global window per region (default 16). A larger batch means fewer cross-region
   * round-trips at the cost of some unused capacity under skew — which does NOT contribute to overshoot
   * under window-coupling (Δ = 0), only to utilization.
   */
  batch?: number;
  /** Coordinator key prefix in the shared store (default the core's `"tk:fed"`). */
  prefix?: string;
}

/** A policy spec, extended with the optional server-only `twoTier` / `tokenBudget` / `fleetBudget` / `concurrency` / `distributedConcurrency` / `fairEscrow` / `federated` blocks. */
export type ServerLimiterSpec = LimiterSpec & {
  twoTier?: TwoTierConfig;
  tokenBudget?: TokenBudgetConfig;
  fleetBudget?: FleetBudgetConfig;
  concurrency?: ConcurrencyConfig;
  distributedConcurrency?: DistributedConcurrencyConfig;
  fairEscrow?: FairEscrowConfig;
  federated?: FederatedConfig;
};

/**
 * A cost-axis meter as the service holds it: a process-local {@link TokenBudgetMeter} (`tokenBudget`) or a
 * fleet-shared {@link DistributedTokenBudgetMeter} (`fleetBudget`). The service uses only the common async
 * `debit(tokens)` — identical decision logic, the distributed one reaching the shared store atomically.
 */
export type ServerMeter = TokenBudgetMeter | DistributedTokenBudgetMeter;

/**
 * A token-budget (cost-axis) policy. The service keeps one {@link ServerMeter} per key (made by `create`,
 * bounded by `maxKeys`). A `tokenBudget` policy makes process-local meters (the request `key` is ignored —
 * each key is independent in-process); a `fleetBudget` policy bakes the request `key` into the meter's
 * shared store key, so every instance sharing the store enforces one global budget per key.
 */
export interface MeterPolicy {
  /** Make a fresh meter for one `key`. (Process-local meters ignore `key`; fleet meters key the store.) */
  create(key: string): ServerMeter;
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

/** What a {@link CoordinatorFactory} needs to build a federation coordinator sized to one federated policy. */
export interface CoordinatorSpec {
  /** Window length (ms) — MUST equal the federated strategy's `windowMs`. */
  windowMs: number;
  /** Global per-window budget — the federated strategy's `limit`. */
  budgetPerWindow: number;
  /** Coordinator key prefix (optional; the core defaults to `"tk:fed"`). */
  prefix?: string;
}

/**
 * Builds a cross-region {@link GlobalCoordinator} over the resolved shared store. Provided by the runtime
 * for `redis`/`postgres` backends (the store resolver owns the raw client + the coordinator's lifecycle);
 * absent for `memory`/`dynamodb`, which cannot federate. Injected via {@link ServerLoadOptions}.
 */
export type CoordinatorFactory = (spec: CoordinatorSpec) => GlobalCoordinator;

/** What a {@link ConcurrencyCoordinatorFactory} needs to build a fleet concurrency coordinator. */
export interface ConcurrencyCoordinatorSpec {
  /** Fleet-wide aggregation rule (`"min"` | `"median"`); every instance on a policy MUST agree. */
  aggregate?: "min" | "median";
  /** Coordinator key prefix in the shared store (the core defaults to `"tk:fed"`). */
  prefix?: string;
}

/**
 * Builds a fleet {@link ConcurrencyCoordinator} over the resolved shared store — `redis` →
 * `RedisConcurrencyCoordinator`, `postgres` → `PostgresConcurrencyCoordinator`. `undefined` for
 * `memory` / `dynamodb`, which cannot coordinate (a `distributedConcurrency:` policy errors there).
 * Injected via {@link ServerLoadOptions}; any coordinator built is closed by the store's disposer.
 */
export type ConcurrencyCoordinatorFactory = (
  spec: ConcurrencyCoordinatorSpec,
) => ConcurrencyCoordinator;

/** Options for {@link buildLimitersFromConfig}: the core loader options plus an injectable clock. */
export interface ServerLoadOptions extends LoadConfigOptions {
  /** Clock for the two-tier / federated / distributed-concurrency limiters (mainly tests); else system. */
  clock?: Clock;
  /**
   * Factory for a cross-region federation coordinator over the resolved store. Required to serve a
   * `federated:` policy; the runtime supplies it for `redis`/`postgres` and omits it for `memory`/`dynamodb`.
   */
  makeCoordinator?: CoordinatorFactory;
  /**
   * Factory for a fleet concurrency coordinator over the resolved store. Required to serve a
   * `distributedConcurrency:` policy; supplied for `redis`/`postgres`, omitted for `memory`/`dynamodb`.
   */
  makeConcurrencyCoordinator?: ConcurrencyCoordinatorFactory;
  /** This instance's region identity for `federated:` policies (a policy's own `region` wins; else this). */
  region?: string;
  /**
   * This process's unique fleet node id, required to serve a `distributedConcurrency:` policy (a collision
   * across instances corrupts the fleet aggregate). The runtime defaults it to `host#pid`; `--node-id`
   * overrides. Distinct from `region` (a region groups many nodes; a node id identifies exactly one process).
   */
  nodeId?: string;
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
  const federatedLimiters: Record<string, Limiter> = {};
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
      const kinds = [
        spec.tokenBudget,
        spec.fleetBudget,
        spec.fairEscrow,
        spec.concurrency,
        spec.distributedConcurrency,
        spec.twoTier,
        spec.federated,
      ].filter((b) => b !== undefined).length;
      if (kinds > 1)
        throw new ThrottleKitError(
          `config.limiters[${name}]: a policy may declare at most one of tokenBudget / fleetBudget / fairEscrow / concurrency / distributedConcurrency / twoTier / federated`,
        );
    }
    if (spec != null && typeof spec === "object" && spec.tokenBudget !== undefined) {
      meters[name] = buildMeter(name, spec, options);
    } else if (spec != null && typeof spec === "object" && spec.fleetBudget !== undefined) {
      meters[name] = buildFleetMeter(name, spec, options, defaultPrefix);
    } else if (spec != null && typeof spec === "object" && spec.federated !== undefined) {
      federatedLimiters[name] = buildFederated(name, spec, options);
    } else if (spec != null && typeof spec === "object" && spec.fairEscrow !== undefined) {
      fairness[name] = buildFairEscrow(name, spec, options);
      costRooms[name] = resolveCostRoom(name, spec.fairEscrow as FairEscrowConfig);
    } else if (
      spec != null &&
      typeof spec === "object" &&
      (spec.concurrency !== undefined || spec.distributedConcurrency !== undefined)
    ) {
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
    limiters: { ...rest, ...twoTierLimiters, ...federatedLimiters },
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
 * Build a fleet-shared cost-axis meter from a policy's `fleetBudget` block. Same decision as `tokenBudget`
 * (the core's `distributedTokenBudget` is the atomic, fleet-wide face of `tokenBudget` — one oracle), but
 * each per-key meter targets the shared store so every instance enforces one global budget. The request
 * key is baked into the store key (`"<prefix>:<key>"`); without a shared store this falls back to a private
 * `MemoryStore` (process-local, exactly like `tokenBudget`), so the policy is correct single-instance and
 * fleet-coordinated the moment `--redis`/`--postgres`/… is configured — no client and no wire change.
 */
function buildFleetMeter(
  name: string,
  spec: ServerLimiterSpec,
  options: ServerLoadOptions,
  defaultPrefix: string | undefined,
): MeterPolicy {
  const fb = spec.fleetBudget as FleetBudgetConfig;
  if (fb.budget === undefined || fb.windowMs === undefined)
    throw new ThrottleKitError(
      `config.limiters[${name}].fleetBudget: both \`budget\` and \`windowMs\` are required`,
    );
  const { budget, windowMs } = fb;
  // The shared store makes this ONE fleet budget; without one it is process-local (a private MemoryStore).
  const store = options.store ?? new MemoryStore();
  const clock = options.clock;
  // The request key selects WHICH budget; instances sharing this store key share the budget. Default the
  // prefix to the policy name so same-config instances coordinate automatically (see FleetBudgetConfig).
  const keyPrefix = fb.prefix ?? defaultPrefix ?? name;
  return {
    create: (key: string): DistributedTokenBudgetMeter =>
      distributedTokenBudget({
        budget,
        windowMs,
        store,
        key: `${keyPrefix}:${key}`,
        ...(clock !== undefined ? { clock } : {}),
      }),
    maxKeys: fb.maxKeys ?? 100_000,
  };
}

/**
 * Strategies `federate()` supports — window-coupled with a DISCRETE window boundary (the core-documented
 * scope). A continuous-rate strategy (`gcra` / `tokenBucket`) HAS a `windowMs` (its period) but no discrete
 * window, so it is intentionally excluded: window-coupling would silently mis-admit. `slidingWindowLog` is
 * also excluded (outside the documented federatable scope) — over-restricting is safe; it errors clearly.
 */
const FEDERATABLE_STRATEGIES = new Set(["fixedWindow", "slidingWindow", "quota"]);

/**
 * Build a cross-region federated limiter from a policy's `federated` block. Same decision as the core's
 * `federate()` (one oracle): its global per-window budget is the strategy's `limit`, coupled to the
 * strategy's window. The strategy is built by the core loader (the server-only fields are ignored); a
 * {@link GlobalCoordinator} over the shared store is resolved via `options.makeCoordinator`. Returns a
 * `Limiter`, so it slots into the service's `limiters` map and is served by `check` exactly like a plain
 * rate limit — and because `federate()`'s limiter has no `peek`/`forecast` (federation is async +
 * window-based), those ops resolve to `UNIMPLEMENTED` through the service's existing gate, no extra wiring.
 */
function buildFederated(
  name: string,
  spec: ServerLimiterSpec,
  options: ServerLoadOptions,
): Limiter {
  const fed = spec.federated as FederatedConfig;
  // Build the strategy via the core loader (the same indirection buildTwoTier uses) — `federated` and the
  // other server-only fields are ignored by the core's strategy builder.
  const built = loadConfigObject({ limiters: { [name]: spec } }).limiters[name];
  if (built === undefined)
    throw new ThrottleKitError(`config.limiters[${name}]: could not build a strategy`);
  const strategy: Strategy = built.strategy;
  // federate() needs a strategy with a DISCRETE window boundary and does NOT validate this itself: a
  // continuous-rate strategy (gcra / tokenBucket) HAS a `windowMs` (its period) yet has no discrete window,
  // so window-coupling would silently mis-admit. Allowlist the core-documented federatable strategies AND
  // require a fixed window (a calendar-cadence quota has `windowMs` undefined → also correctly rejected).
  const windowMs = strategy.windowMs;
  if (!FEDERATABLE_STRATEGIES.has(strategy.name) || typeof windowMs !== "number" || !(windowMs > 0))
    throw new ThrottleKitError(
      `config.limiters[${name}].federated: requires a window-coupled strategy with a fixed window (fixedWindow / slidingWindow / a fixed-cadence quota); ${JSON.stringify(strategy.name)} cannot be federated (a continuous-rate strategy like gcra / tokenBucket has no discrete window boundary)`,
    );
  if (options.makeCoordinator === undefined)
    throw new ThrottleKitError(
      `config.limiters[${name}].federated: needs a shared coordinator store — run with --redis or --postgres (memory / dynamodb cannot federate)`,
    );
  // The coordinator's global budget IS the strategy's `limit` (the per-window ceiling enforced fleet-wide).
  const coordinator = options.makeCoordinator({
    windowMs,
    budgetPerWindow: strategy.limit,
    ...(fed.prefix !== undefined ? { prefix: fed.prefix } : {}),
  });
  const region = fed.region ?? options.region ?? "default";
  const clock = options.clock;
  return federate({
    strategy,
    coordinator,
    region,
    ...(fed.batch !== undefined ? { batch: fed.batch } : {}),
    ...(clock !== undefined ? { clock } : {}),
  });
}

/**
 * Build the fleet concurrency guard for a `distributedConcurrency` policy: the core's
 * `distributedAdaptiveConcurrency` over a {@link ConcurrencyCoordinator} the runtime resolved from the
 * shared store. Each {@link ConcurrencyConfig} tuning field rides into the node's *local* adaptive guard;
 * the coordinator knobs (`aggregate`/`prefix`/`heartbeatMs`/`onCoordinatorOutage`) configure the fleet
 * sync. `key` is the policy name, so each policy gets its own global ceiling on the shared coordinator.
 * Errors clearly (config time) when no coordinator store or no node id is configured.
 */
function buildDistributedGuard(
  name: string,
  dc: DistributedConcurrencyConfig,
  options: ServerLoadOptions,
): ConcurrencyGuard {
  if (options.makeConcurrencyCoordinator === undefined)
    throw new ThrottleKitError(
      `config.limiters[${name}].distributedConcurrency: needs a shared coordinator store — run with --redis or --postgres (memory / dynamodb cannot coordinate concurrency)`,
    );
  if (options.nodeId === undefined || options.nodeId === "")
    throw new ThrottleKitError(
      `config.limiters[${name}].distributedConcurrency: needs a unique server node id (set --node-id / TK_NODE_ID; the runtime defaults it to host#pid) — a collision across instances corrupts the fleet aggregate`,
    );
  // Split the coordinator knobs from the per-node adaptive tuning (the rest IS a ConcurrencyConfig, which is
  // a subset of AdaptiveConcurrencyOptions → forwarded verbatim as each node's local guard).
  const { aggregate, prefix, heartbeatMs, onCoordinatorOutage, ...local } = dc;
  const coordinator = options.makeConcurrencyCoordinator({
    ...(aggregate !== undefined ? { aggregate } : {}),
    ...(prefix !== undefined ? { prefix } : {}),
  });
  const clock = options.clock;
  return distributedAdaptiveConcurrency({
    coordinator,
    nodeId: options.nodeId,
    key: name,
    local,
    ...(heartbeatMs !== undefined ? { heartbeatMs } : {}),
    ...(onCoordinatorOutage !== undefined ? { onCoordinatorOutage } : {}),
    ...(clock !== undefined ? { clock } : {}),
  });
}

/**
 * Build a concurrency / unified admitter. The `concurrency` block configures the core's in-process
 * `adaptiveConcurrency` guard; `distributedConcurrency` instead builds a fleet-shared guard (see
 * {@link buildDistributedGuard}). Either way, if the policy also names a rate `strategy`, that limiter
 * (built by the core loader, so it shares the injected store + prefix defaults) becomes the rate axis of a
 * `unifiedAdmission`. The decision is the core's — this only assembles the axes the policy declared.
 */
function buildAdmitter(
  name: string,
  spec: ServerLimiterSpec,
  options: ServerLoadOptions,
  data: ConfigFile,
): { admitter: UnifiedAdmitter; guard: ConcurrencyGuard } {
  const clock = options.clock;
  // The concurrency axis is either the in-process guard (`concurrency`) or the fleet-shared one
  // (`distributedConcurrency`); the dispatcher guarantees exactly one of the two blocks is present.
  const guard: ConcurrencyGuard =
    spec.distributedConcurrency !== undefined
      ? buildDistributedGuard(name, spec.distributedConcurrency, options)
      : adaptiveConcurrency({
          ...(spec.concurrency ?? {}),
          ...(clock !== undefined ? { clock } : {}),
        });

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
