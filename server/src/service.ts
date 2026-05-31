/**
 * Transport-agnostic ThrottleKit **service core** — the heart of the service door.
 *
 * It is a *consumer of the published, frozen `throttlekit` 1.0 public API*: a **registry of named
 * policies** (each a `Limiter`, wrapped in the core's `createEnforcer` so a store outage resolves by its
 * `FailMode` instead of throwing) and a **dispatch** that runs a check/peek/forecast for a named policy
 * and returns the core domain objects. The gRPC binding (`grpc.ts`) is then a pure mapping from proto
 * messages to these calls — no decision logic lives there.
 *
 * Returning the core `Decision`/`Forecast` directly is what lets this be conformance-tested against the
 * golden vectors (`wire/`): the service must make *identical* decisions to an embedded library, which is
 * the load-bearing invariant of the polyglot design.
 */

import { type Enforcer, ThrottleKitError, createEnforcer } from "throttlekit";
import type { Decision, FailMode, Forecast, Limiter } from "throttlekit";
import { type ServerLoadOptions, buildLimitersFromConfig } from "./config.js";

/** Thrown when a request names a policy the service was not configured with (→ gRPC `NOT_FOUND`). */
export class PolicyNotFoundError extends ThrottleKitError {
  /** The unknown policy name that was requested. */
  readonly policy: string;
  constructor(policy: string, known: readonly string[]) {
    super(
      `unknown policy ${JSON.stringify(policy)}; configured policies: ${
        known.length ? known.map((p) => JSON.stringify(p)).join(", ") : "(none)"
      }`,
    );
    this.name = "PolicyNotFoundError";
    this.policy = policy;
  }
}

/** Thrown when a policy's strategy does not support a non-consuming op (→ gRPC `UNIMPLEMENTED`). */
export class OperationNotSupportedError extends ThrottleKitError {
  constructor(op: "peek" | "forecast", policy: string) {
    super(`policy ${JSON.stringify(policy)} does not support ${op}`, { code: "not_implemented" });
    this.name = "OperationNotSupportedError";
  }
}

/** Options for {@link createRateLimiterService}. */
export interface RateLimiterServiceOptions {
  /**
   * The named policies the service serves, each a prebuilt `Limiter` (e.g. from `loadConfig`). The name
   * is what a client puts in a request's `policy` field.
   */
  limiters: Record<string, Limiter>;
  /**
   * Store-outage policy applied to every policy's `check`/`checkMany`: `"open"` admits, `"closed"`
   * denies. Default `"open"`. (A returned `Decision` is always authoritative; this only governs what
   * happens when the backing store throws.)
   */
  fail?: FailMode;
}

/**
 * The service core: resolve a named policy and run the limiter for a key. Returns the core
 * `Decision`/`Forecast` — a transport binding maps those to its own message types.
 */
export interface RateLimiterService {
  /** The configured policy names, in registration order. */
  policies(): string[];
  /**
   * Consume `cost` units (default 1) against `policy` for `key`. Never throws on a store outage — the
   * configured `FailMode` settles admission and a best-effort `Decision` is returned. Throws
   * {@link PolicyNotFoundError} for an unknown policy.
   */
  check(policy: string, key: string, cost?: number): Promise<Decision>;
  /**
   * Consume `cost` units against `policy` for many independent keys at a single consistent instant,
   * returning a decision per key in input order. On a store outage every key resolves by the fail mode.
   */
  checkMany(policy: string, keys: readonly string[], cost?: number): Promise<Decision[]>;
  /**
   * Non-consuming peek for `key` under `policy`. Throws {@link OperationNotSupportedError} if the
   * policy's strategy has no `peek`, and {@link PolicyNotFoundError} for an unknown policy.
   */
  peek(policy: string, key: string): Promise<Decision>;
  /** Non-consuming capacity forecast for `key` under `policy`, for a request costing `cost` (default 1). */
  forecast(policy: string, key: string, cost?: number): Promise<Forecast>;
}

/** Synthesize the degenerate `Decision` returned when the store threw (no real decision exists). */
function storeErrorDecision(limiter: Limiter, allowed: boolean): Decision {
  const limit = limiter.strategy.limit;
  return { allowed, limit, remaining: allowed ? limit : 0, resetAt: 0, retryAfterMs: 0 };
}

/**
 * Build a {@link RateLimiterService} from a registry of named limiters. Each limiter is wrapped in the
 * core's `Enforcer` so the `FailMode` is applied inside `check`/`checkMany`.
 */
export function createRateLimiterService(options: RateLimiterServiceOptions): RateLimiterService {
  const fail: FailMode = options.fail ?? "open";
  const order: string[] = [];
  const enforcers = new Map<string, Enforcer>();
  for (const [name, limiter] of Object.entries(options.limiters)) {
    order.push(name);
    enforcers.set(name, createEnforcer({ limiter, fail, policyName: name }));
  }

  function resolve(policy: string): Enforcer {
    const enforcer = enforcers.get(policy);
    if (enforcer === undefined) throw new PolicyNotFoundError(policy, order);
    return enforcer;
  }

  return {
    policies(): string[] {
      return [...order];
    },

    async check(policy, key, cost = 1): Promise<Decision> {
      const enforcer = resolve(policy);
      const r = await enforcer.enforce(key, cost);
      // `decision` is present for "ok"/"limited"; undefined only when the store threw ("error").
      return r.decision ?? storeErrorDecision(enforcer.limiter, r.allowed);
    },

    async checkMany(policy, keys, cost = 1): Promise<Decision[]> {
      const enforcer = resolve(policy);
      try {
        // The batched path evaluates every key at one consistent instant (and pipelines on Redis).
        return await enforcer.limiter.checkMany(keys, cost);
      } catch {
        // Whole-batch store outage: resolve every key by the fail mode, mirroring `enforce`.
        const synthetic = storeErrorDecision(enforcer.limiter, fail === "open");
        return keys.map(() => synthetic);
      }
    },

    async peek(policy, key): Promise<Decision> {
      const enforcer = resolve(policy);
      const limiter = enforcer.limiter;
      // A store-backed limiter always exposes `peek`, but it throws unless the *strategy* implements it;
      // a composite limiter may omit the method entirely. Gate on both for a clean UNIMPLEMENTED.
      if (limiter.peek === undefined || limiter.strategy.peek === undefined)
        throw new OperationNotSupportedError("peek", policy);
      return limiter.peek(key);
    },

    async forecast(policy, key, cost = 1): Promise<Forecast> {
      const enforcer = resolve(policy);
      const limiter = enforcer.limiter;
      if (limiter.forecast === undefined || limiter.strategy.forecast === undefined)
        throw new OperationNotSupportedError("forecast", policy);
      return limiter.forecast(key, cost);
    },
  };
}

/** Options for {@link createRateLimiterServiceFromConfig}: the loader's options plus the fail mode. */
export type RateLimiterServiceConfigOptions = ServerLoadOptions &
  Pick<RateLimiterServiceOptions, "fail">;

/**
 * Convenience: build a service straight from `.throttlekit.yaml`/`.json` text. Inject the live `store`
 * (you can't serialise an `ioredis` client into YAML) via the loader options. A policy may carry a
 * `twoTier` block to be served as a two-tier leased limiter — see {@link buildLimitersFromConfig}.
 */
export function createRateLimiterServiceFromConfig(
  text: string,
  options: RateLimiterServiceConfigOptions = {},
): RateLimiterService {
  const { fail, ...loadOptions } = options;
  const limiters = buildLimitersFromConfig(text, loadOptions);
  return createRateLimiterService({ limiters, ...(fail !== undefined ? { fail } : {}) });
}
