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

import { randomBytes } from "node:crypto";
import { type Enforcer, ThrottleKitError, createEnforcer } from "throttlekit";
import type {
  Clock,
  ConcurrencyGuard,
  Decision,
  FailMode,
  Forecast,
  Limiter,
  UnifiedAdmitter,
} from "throttlekit";
import type { WeightedFairEscrowLimiter } from "throttlekit/twotier";
import {
  type MeterPolicy,
  type ServerLoadOptions,
  type ServerMeter,
  buildServiceConfig,
} from "./config.js";

/** Per-call options for {@link RateLimiterService.admit} (the concurrency / unified axes). */
export interface AdmitOptions {
  /**
   * Cost-axis weight (default 1). NOTE: the rate axis always consumes exactly 1 per Admit; `cost`
   * weights only a configured cost axis. Server Admit policies (concurrency + optional rate strategy)
   * configure no cost axis today, so `cost` is currently inert on Admit — use Debit/Check for weighted
   * consumption.
   */
  cost?: number;
  /** Expected hold/service time for the 3-axis joint-LP concurrency term (default 0; experimental). */
  hold?: number;
  /** Joint-LP bid value (default 1; experimental). */
  value?: number;
}

/** The outcome of an {@link RateLimiterService.admit}: the decision plus the lease lifecycle handle. */
export interface AdmitResult {
  /** The combined decision across the policy's configured axes. */
  decision: Decision;
  /** Opaque, server-minted lease id; `""` when no slot is held (a deny, or a no-concurrency policy). */
  leaseId: string;
  /** Epoch-ms after which the server reclaims the slot (Release `dropped`) if unheart-beaten; 0 if no lease. */
  leaseExpiresAt: number;
  /** `"rate"`/`"concurrency"`/`"cost"` axis that bound a deny, or `""`. On the wrapper (core 1.0 D1). */
  bindingAxis: string;
  /** True iff a joint-LP bid-price filter denied while every per-axis budget had slack. */
  policyDenied: boolean;
}

/** The outcome of a {@link RateLimiterService.heartbeat}: which leases survived and the next deadline. */
export interface HeartbeatResult {
  /** Lease ids still held; their deadline was extended. */
  liveIds: string[];
  /** Lease ids already reclaimed (the client was too slow) — the caller should treat them as dropped. */
  reclaimedIds: string[];
  /** Epoch-ms by which the next beat must arrive to keep the live leases. */
  nextDeadline: number;
}

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

/**
 * Thrown when a policy does not support the requested op (→ gRPC `UNIMPLEMENTED`): a strategy without
 * `peek`/`forecast`, a `check` on a token-budget meter, or a `debit` on a rate limiter.
 */
export class OperationNotSupportedError extends ThrottleKitError {
  constructor(op: string, policy: string) {
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
   * Token-budget (cost-axis) policies, each a {@link MeterPolicy}; the service keeps one meter per key.
   * A policy name is a limiter **or** a meter, never both — they share one namespace.
   */
  meters?: Record<string, MeterPolicy>;
  /**
   * Concurrency / unified admission policies, each a prebuilt {@link UnifiedAdmitter}, served by the
   * stateful `admit`/`release`/`heartbeat` lifecycle. A policy name is a limiter, a meter, **or** an
   * admitter — the three share one namespace.
   */
  admitters?: Record<string, UnifiedAdmitter>;
  /**
   * The concurrency guards encapsulated by `admitters`, by policy name — held only so {@link
   * RateLimiterService.close} can shut down the **distributed** ones (their node↔coordinator heartbeat
   * timers + a graceful `leave()`); in-process guards have no `close()` and are skipped. Passing them is
   * optional and never affects a decision (the admitter already owns the live guard, SC-16).
   */
  guards?: Record<string, ConcurrencyGuard>;
  /**
   * Weighted-fair-escrow policies, each a prebuilt {@link WeightedFairEscrowLimiter}, served by `check`
   * with the request `key` as the tenant. A policy name is a limiter, meter, admitter, **or** a fair
   * limiter — they share one namespace.
   */
  fairLimiters?: Record<string, WeightedFairEscrowLimiter>;
  /**
   * Store-outage policy applied to every policy's `check`/`checkMany`: `"open"` admits, `"closed"`
   * denies. Default `"open"`. (A returned `Decision` is always authoritative; this only governs what
   * happens when the backing store throws.)
   */
  fail?: FailMode;
  /** Time source for lease expiry + {@link RateLimiterService.sweep} (mainly tests). Default system clock. */
  clock?: Clock;
  /**
   * How long a held lease survives without a heartbeat before the {@link RateLimiterService.sweep}
   * reclaims it (ms). Default 2000 — twice the core node↔coordinator heartbeat default, so one missed
   * beat is tolerated.
   */
  leaseTtlMs?: number;
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
  /**
   * Debit `tokens` (default 1) of post-hoc cost against a token-budget `policy` for `key`. Throws
   * {@link OperationNotSupportedError} if `policy` is a rate limiter (use `check`), and
   * {@link PolicyNotFoundError} for an unknown policy.
   */
  debit(policy: string, key: string, tokens?: number): Promise<Decision>;
  /**
   * Admit one unit of work against a concurrency / unified `policy`. When the admission holds a slot the
   * result carries a non-empty `leaseId` the caller MUST {@link RateLimiterService.release} (the service
   * reclaims it on lease expiry if the caller crashes). Throws {@link OperationNotSupportedError} if
   * `policy` is a rate limiter / meter (use `check`/`debit`) and {@link PolicyNotFoundError} if unknown.
   */
  admit(policy: string, key: string, opts?: AdmitOptions): Promise<AdmitResult>;
  /** Return a held slot. `dropped: true` signals an overload (timeout/error). Idempotent on an unknown id. */
  release(leaseId: string, dropped?: boolean): void;
  /** Renew the given leases in one beat; reports which survived vs were already reclaimed. */
  heartbeat(leaseIds: readonly string[]): HeartbeatResult;
  /**
   * Reclaim every lease whose deadline has passed (release with `dropped: true`). Called periodically by
   * the transport (e.g. {@link serve}); exposed so tests can drive reclaim deterministically with a clock.
   */
  sweep(): void;
  /**
   * Release any fleet resources the served policies hold — today, the heartbeat timers of
   * `distributedConcurrency` guards (each is stopped and `leave()`s the coordinator so the fleet reclaims
   * its share immediately rather than waiting out the lease TTL). Idempotent + never-throw; a no-op when no
   * distributed policy is configured. Optional so a hand-built service / test mock need not implement it.
   */
  close?(): Promise<void>;
}

/** Synthesize the degenerate `Decision` returned when the store threw (no real decision exists). */
function storeErrorDecision(limiter: Limiter, allowed: boolean): Decision {
  const limit = limiter.strategy.limit;
  return { allowed, limit, remaining: allowed ? limit : 0, resetAt: 0, retryAfterMs: 0 };
}

/** Synthesize a fail-mode `Decision` for a fair-escrow policy whose `check` threw (only possible L2-backed). */
function fairErrorDecision(wfe: WeightedFairEscrowLimiter, allowed: boolean): Decision {
  const limit = wfe.stats().limit;
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
    // `emit: false` short-circuits the gate's `headersFor` to `{}` (no RateLimit header Record, no
    // String() formatting, no clock read) — the service door returns only the core `Decision` over gRPC
    // and never reads `r.headers`, so HTTP-style headers are pure dead work here. The Decision is wholly
    // independent of `emit`, so this is byte-identical over the wire.
    enforcers.set(name, createEnforcer({ limiter, fail, policyName: name, emit: false }));
  }
  // Token-budget (cost-axis) policies: one meter per key, lazily created and FIFO-bounded by `maxKeys`.
  const meters = new Map<string, { policy: MeterPolicy; cache: Map<string, ServerMeter> }>();
  for (const [name, policy] of Object.entries(options.meters ?? {})) {
    if (enforcers.has(name))
      throw new ThrottleKitError(`policy ${JSON.stringify(name)} is both a limiter and a meter`);
    order.push(name);
    meters.set(name, { policy, cache: new Map() });
  }
  // Concurrency / unified admission policies — and the lease table they need (the first stateful surface).
  const admitters = new Map<string, UnifiedAdmitter>();
  for (const [name, admitter] of Object.entries(options.admitters ?? {})) {
    if (enforcers.has(name) || meters.has(name))
      throw new ThrottleKitError(
        `policy ${JSON.stringify(name)} is declared as more than one of limiter / meter / admitter`,
      );
    order.push(name);
    admitters.set(name, admitter);
  }
  // Weighted-fair-escrow policies — served by `check` (key = tenant). Not `Limiter`s, so they bypass the
  // enforcer path: an L1-only WFE never throws, and the fail mode covers an L2-backed one.
  const fairLimiters = new Map<string, WeightedFairEscrowLimiter>();
  for (const [name, wfe] of Object.entries(options.fairLimiters ?? {})) {
    if (enforcers.has(name) || meters.has(name) || admitters.has(name))
      throw new ThrottleKitError(
        `policy ${JSON.stringify(name)} is declared as more than one of limiter / meter / admitter / fairEscrow`,
      );
    order.push(name);
    fairLimiters.set(name, wfe);
  }
  const clock: Clock = options.clock ?? { now: () => Date.now() };
  const leaseTtlMs = options.leaseTtlMs ?? 2000;
  /** Held concurrency slots keyed by opaque lease id; `release` is the core admission's lifecycle hook. */
  const leases = new Map<
    string,
    { release(opts?: { dropped?: boolean }): void; expiresAt: number }
  >();
  // Guards that may need shutdown (distributed ones have a `close()`; in-process ones don't). The same
  // instances the admitters drive — closing them stops the heartbeat timers + leaves the fleet (SC-16).
  const closeableGuards = Object.values(options.guards ?? {});

  /** Resolve a limiter for a consuming/introspection op; a meter/admitter policy can't serve these. */
  function resolveLimiter(policy: string, op: string): Enforcer {
    const enforcer = enforcers.get(policy);
    if (enforcer !== undefined) return enforcer;
    if (meters.has(policy) || admitters.has(policy) || fairLimiters.has(policy))
      throw new OperationNotSupportedError(op, policy);
    throw new PolicyNotFoundError(policy, order);
  }

  /** Resolve the admitter for an `admit`; a limiter/meter/fair policy can't serve it. */
  function resolveAdmitter(policy: string): UnifiedAdmitter {
    const admitter = admitters.get(policy);
    if (admitter !== undefined) return admitter;
    if (enforcers.has(policy) || meters.has(policy) || fairLimiters.has(policy))
      throw new OperationNotSupportedError("admit", policy);
    throw new PolicyNotFoundError(policy, order);
  }

  /** Resolve (lazily creating) the per-key meter for a token-budget / fleet-budget policy. */
  function resolveMeter(policy: string, key: string): ServerMeter {
    const entry = meters.get(policy);
    if (entry === undefined) {
      if (enforcers.has(policy) || admitters.has(policy) || fairLimiters.has(policy))
        throw new OperationNotSupportedError("debit", policy);
      throw new PolicyNotFoundError(policy, order);
    }
    let meter = entry.cache.get(key);
    if (meter === undefined) {
      if (entry.cache.size >= entry.policy.maxKeys) {
        const oldest = entry.cache.keys().next(); // FIFO eviction by insertion order
        if (!oldest.done) entry.cache.delete(oldest.value);
      }
      // The key is baked into a fleet meter's shared store key; an in-process meter ignores it. Evicting
      // a fleet meter is safe — the budget lives in the shared store, so rebuilding re-attaches to it.
      meter = entry.policy.create(key);
      entry.cache.set(key, meter);
    }
    return meter;
  }

  return {
    policies(): string[] {
      return [...order];
    },

    async check(policy, key, cost = 1): Promise<Decision> {
      const fair = fairLimiters.get(policy);
      if (fair !== undefined) {
        // The fair-escrow decision is the core's `weightedFairEscrow` (one oracle); the key is the tenant.
        try {
          return await fair.check(key, cost);
        } catch {
          return fairErrorDecision(fair, fail === "open");
        }
      }
      const enforcer = resolveLimiter(policy, "check");
      const r = await enforcer.enforce(key, cost);
      // `decision` is present for "ok"/"limited"; undefined only when the store threw ("error").
      return r.decision ?? storeErrorDecision(enforcer.limiter, r.allowed);
    },

    async checkMany(policy, keys, cost = 1): Promise<Decision[]> {
      const enforcer = resolveLimiter(policy, "checkMany");
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
      const enforcer = resolveLimiter(policy, "peek");
      const limiter = enforcer.limiter;
      // A store-backed limiter always exposes `peek`, but it throws unless the *strategy* implements it;
      // a composite limiter may omit the method entirely. Gate on both for a clean UNIMPLEMENTED.
      if (limiter.peek === undefined || limiter.strategy.peek === undefined)
        throw new OperationNotSupportedError("peek", policy);
      return limiter.peek(key);
    },

    async forecast(policy, key, cost = 1): Promise<Forecast> {
      const enforcer = resolveLimiter(policy, "forecast");
      const limiter = enforcer.limiter;
      if (limiter.forecast === undefined || limiter.strategy.forecast === undefined)
        throw new OperationNotSupportedError("forecast", policy);
      return limiter.forecast(key, cost);
    },

    async debit(policy, key, tokens = 1): Promise<Decision> {
      // The meter is the core's `tokenBudget` (process-local) or `distributedTokenBudget` (fleet-shared)
      // primitive — the debit decision is computed by the core (one oracle). `debit()` resolves
      // synchronously for an in-process meter and runs one atomic read-modify-write against the shared
      // store for a fleet meter; `debitSync()` would throw on an async (Redis/Postgres/Dynamo) store.
      return resolveMeter(policy, key).debit(tokens);
    },

    async admit(policy, key, opts): Promise<AdmitResult> {
      const admitter = resolveAdmitter(policy);
      // The decision (and binding axis / policy-denial) is the core's unifiedAdmission — one oracle.
      const a = await admitter.admit({
        key,
        ...(opts?.cost !== undefined ? { cost: opts.cost } : {}),
        ...(opts?.hold !== undefined ? { hold: opts.hold } : {}),
        ...(opts?.value !== undefined ? { value: opts.value } : {}),
      });
      const bindingAxis = a.bindingAxis ?? "";
      const policyDenied = a.policyDenied ?? false;
      if (a.decision.allowed) {
        // A granted admission holds the concurrency slot: mint a lease and keep its release closure so
        // a later Release (or the reclaim sweep) can free it. The id IS the capability — Release/Heartbeat
        // key only on it and do no per-caller ownership check — so it must be UNGUESSABLE (128-bit random),
        // never a sequential counter a peer could enumerate to free/renew another client's slot.
        let leaseId = randomBytes(16).toString("hex");
        while (leases.has(leaseId)) leaseId = randomBytes(16).toString("hex");
        const leaseExpiresAt = clock.now() + leaseTtlMs;
        leases.set(leaseId, { release: a.release, expiresAt: leaseExpiresAt });
        return { decision: a.decision, leaseId, leaseExpiresAt, bindingAxis, policyDenied };
      }
      // Denied: no slot is held (unifiedAdmission already released any transiently-acquired one). The
      // returned release is a no-op; call it for symmetry, mint no lease.
      a.release();
      return { decision: a.decision, leaseId: "", leaseExpiresAt: 0, bindingAxis, policyDenied };
    },

    release(leaseId, dropped = false): void {
      const lease = leases.get(leaseId);
      if (lease !== undefined) {
        lease.release({ dropped }); // the core lease release is idempotent
        leases.delete(leaseId);
      }
      // Unknown id (already released or reclaimed) ⇒ no-op: Release is idempotent.
    },

    heartbeat(leaseIds): HeartbeatResult {
      const now = clock.now();
      const liveIds: string[] = [];
      const reclaimedIds: string[] = [];
      for (const id of leaseIds) {
        const lease = leases.get(id);
        if (lease !== undefined) {
          lease.expiresAt = now + leaseTtlMs; // renew
          liveIds.push(id);
        } else {
          reclaimedIds.push(id); // already swept/released — the client must treat it as dropped
        }
      }
      return { liveIds, reclaimedIds, nextDeadline: now + leaseTtlMs };
    },

    sweep(): void {
      const now = clock.now();
      // Deleting the current entry during Map iteration is well-defined; a crashed client's slot is
      // released as `dropped` (the overload signal), exactly as a lost node is to the core coordinator.
      for (const [id, lease] of leases) {
        if (lease.expiresAt <= now) {
          lease.release({ dropped: true });
          leases.delete(id);
        }
      }
    },

    async close(): Promise<void> {
      // Shut down the distributed concurrency guards: stop each heartbeat timer + `leave()` the coordinator
      // so peers reclaim this node's share now (not after the lease TTL). In-process guards have no close().
      // Never-throw — a coordinator already unreachable just falls back to TTL reclaim — so shutdown drains.
      await Promise.all(
        closeableGuards.map(async (g) => {
          const maybe = g as { close?: () => Promise<void> | void };
          if (typeof maybe.close !== "function") return;
          try {
            await maybe.close();
          } catch {
            /* already down ⇒ the coordinator reclaims this node's share on lease expiry regardless */
          }
        }),
      );
    },
  };
}

/** Options for {@link createRateLimiterServiceFromConfig}: the loader's options plus the fail mode + lease TTL. */
export type RateLimiterServiceConfigOptions = ServerLoadOptions &
  Pick<RateLimiterServiceOptions, "fail" | "leaseTtlMs">;

/**
 * Convenience: build a service straight from `.throttlekit.yaml`/`.json` text. Inject the live `store`
 * (you can't serialise an `ioredis` client into YAML) via the loader options. A policy may carry a
 * `twoTier` block (two-tier leased limiter), a `tokenBudget` block (cost-axis meter), or a `concurrency`
 * block (concurrency / unified admission) — see {@link buildServiceConfig}.
 */
export function createRateLimiterServiceFromConfig(
  text: string,
  options: RateLimiterServiceConfigOptions = {},
): RateLimiterService {
  const { fail, leaseTtlMs, ...loadOptions } = options;
  const { limiters, meters, admitters, guards, fairness } = buildServiceConfig(text, loadOptions);
  return createRateLimiterService({
    limiters,
    meters,
    admitters,
    guards, // so service.close() can shut down any distributed-concurrency guard heartbeat timers (SC-16)
    fairLimiters: fairness,
    ...(fail !== undefined ? { fail } : {}),
    // The admitters' guards already got `clock` via loadOptions; the lease table needs it too so a
    // test's ManualClock drives both the admission decision and the reclaim sweep.
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
    ...(leaseTtlMs !== undefined ? { leaseTtlMs } : {}),
  });
}
