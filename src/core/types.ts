/**
 * Core domain model. Three cleanly separated concerns meet here: strategies (pure
 * algorithms), stores (one atomic primitive), and the limiter that wires them together.
 */

/** Injected time source. Epoch-ms. Nothing in the core ever reads the clock directly. */
export interface Clock {
  /** Current time in epoch milliseconds. */
  now(): number;
}

/**
 * The immutable result of one rate-limit check.
 *
 * All numeric fields are integers so the JavaScript and Redis-Lua execution paths can
 * produce bit-identical values (Redis truncates Lua numbers to integers on reply).
 *
 * **Frozen + evolvable (SemVer 1.x).** The fields below are stable. As a *producer* type, `Decision`
 * grows only by appending **optional readonly** fields — so consumers must not reject unknown keys
 * (e.g. don't `zod.strict()` a Decision). See STABILITY.md.
 */
export interface Decision {
  /** Whether the request is permitted. */
  readonly allowed: boolean;
  /** Effective ceiling: burst capacity (GCRA/token bucket) or window quota. */
  readonly limit: number;
  /** Whole units remaining before the next rejection. Never negative. */
  readonly remaining: number;
  /** Epoch-ms at which the limiter is fully replenished. */
  readonly resetAt: number;
  /** Milliseconds to wait before retrying. `0` when {@link Decision.allowed}. */
  readonly retryAfterMs: number;
}

/**
 * What a {@link Strategy} returns from a single transition: exactly the {@link ApplyOutcome} a store
 * consumes, with `result` being the {@link Decision}. Unifying the two shapes lets the limiter pass a
 * strategy's output straight to the store with no per-check re-wrap allocation. Kept as a named alias
 * for strategy authors. (Custom strategies return `result`, not `decision`.)
 */
export type StrategyOutcome<S> = ApplyOutcome<S, Decision>;

/**
 * A pure rate-limiting algorithm over serializable state `S`.
 *
 * `check` is a pure function of `(state, now, cost)` — no I/O, no clock reads — which makes
 * it deterministic, trivially testable, and portable to an atomic Redis Lua form.
 */
export interface Strategy<S = unknown> {
  /** Stable identifier surfaced in `RateLimit-Policy` and metrics (e.g. `"gcra"`). */
  readonly name: string;
  /** Effective ceiling reported to clients (burst capacity or window quota). */
  readonly limit: number;
  /** Effective window length in ms, surfaced as the `w` of `RateLimit-Policy`. Optional. */
  readonly windowMs?: number;
  /** Upper bound on how long state stays relevant; used as the store TTL hint. */
  readonly ttlMs: number;
  /** The pure transition. */
  check(state: S | undefined, now: number, cost: number): StrategyOutcome<S>;
  /** Optional atomic Redis form. When present, a Lua-capable store runs it in one round trip. */
  readonly lua?: LuaProgram;
  /**
   * Pure, non-mutating introspection: the {@link Decision} for the current `state` at `now`
   * **without consuming**. Unlike {@link Strategy.check}, `remaining`/`resetAt`/`retryAfterMs`
   * describe the *current* capacity, not a post-consume projection, and no state is advanced.
   * Optional; the built-in strategies implement it — it is the basis of {@link Limiter.peek}.
   */
  peek?(state: S | undefined, now: number): Decision;
  /**
   * Pure capacity forecast for the current `state` at `now`, for a request costing `cost`.
   * Optional; the basis of {@link Limiter.forecast}.
   */
  forecast?(state: S | undefined, now: number, cost: number): Forecast;
  /**
   * Read-only access to this strategy's stored state for a **Lua-capable** store, which keeps state
   * in a strategy-specific encoding (HASH / ZSET / string) the generic OCC read path cannot parse.
   * The Lua reads and returns the raw value; `decode` maps it to `S`. Used by the non-consuming
   * introspection methods ({@link Limiter.peek} / {@link Limiter.forecast}) so they never write.
   * Optional; required for those methods to work over a Lua store.
   */
  readonly readState?: ReadState<S>;
}

/** A non-consuming projection of a key's near-future capacity (see {@link Limiter.forecast}). */
export interface Forecast {
  /** Whole units of the given `cost` admissible **right now** before the next denial. */
  readonly spendableNow: number;
  /** Epoch-ms when capacity next increases by at least one unit (a window reset, or the next token). */
  readonly nextReplenishAt: number;
  /** Epoch-ms when the limiter is **fully** replenished to its ceiling from the current state. */
  readonly fullAt: number;
}

/** How a {@link Strategy} exposes its stored state to a Lua-capable store for a read-only peek. */
export interface ReadState<S> {
  /** A read-only Lua program returning the raw stored value (no writes). */
  readonly lua: LuaProgram;
  /** Decode the raw Redis reply into the strategy's state (`undefined` when the key is absent). */
  decode(raw: unknown): S | undefined;
}

/**
 * An atomic Redis Lua program implementing a strategy in a single round trip.
 *
 * Every ThrottleKit script returns the standard reply array
 * `[allowed, limit, remaining, resetAt, retryAfterMs]` (all integers), decoded by
 * {@link decodeDecision}, so decoding is shared across strategies.
 */
export interface LuaProgram {
  /** The Lua source. */
  readonly script: string;
  /** Derive the `KEYS` the script touches from the limiter key (for Cluster hash tags). */
  buildKeys(key: string): string[];
  /**
   * Build `ARGV`. `ARGV[1]` is always `now` (epoch-ms), or `0` to mean "use the Redis server
   * clock"; the rest are the strategy's parameters derived from `cost`.
   */
  buildArgv(nowArg: number, cost: number): (string | number)[];
}

/** The outcome of a store {@link Store.apply}: new state + the caller's result + persistence info. */
export interface ApplyOutcome<S, R> {
  /** Next state (written when {@link ApplyOutcome.persist}). */
  state: S | undefined;
  /** Value returned to the caller (a {@link Decision} for rate-limit checks). */
  result: R;
  /** TTL for the persisted state, in ms. */
  ttlMs: number;
  /** Whether state must be written. */
  persist: boolean;
}

/**
 * A pure read-modify-write run atomically by a store. Closes over `now` and `cost`.
 *
 * For Lua-capable stores, the optional {@link LuaInvocation} rides along so built-in strategies
 * collapse to a single atomic round trip; stores that ignore it remain correct via the
 * function body (optimistic concurrency or single-threaded RMW).
 */
export type Transform<S, R> = ((state: S | undefined) => ApplyOutcome<S, R>) & {
  /** Optional atomic acceleration for Lua-capable stores. */
  readonly lua?: LuaInvocation<R>;
};

/** Everything a Lua-capable store needs to run and decode an atomic script for one check. */
export interface LuaInvocation<R> {
  /** The program to run. */
  readonly program: LuaProgram;
  /** The limiter's `now` (used unless the store substitutes the server clock). */
  readonly now: number;
  /** The request cost. */
  readonly cost: number;
  /** Decode the raw Redis reply into the caller's result type. */
  decode(raw: unknown): R;
}

/**
 * Storage exposes exactly one mutating primitive: an atomic {@link Store.apply}. Adding a
 * backend is implementing one method; adding an algorithm never touches a store.
 */
export interface Store {
  /** Run `transform` atomically with respect to other applies on the same key. */
  apply<S, R>(key: string, transform: Transform<S, R>): Promise<R>;
  /**
   * Synchronous, allocation-light variant for stores that can guarantee atomicity without
   * awaiting (e.g. the single-threaded in-memory store). Absent on async-only stores.
   *
   * `now` (epoch-ms) lets the caller pass the single timestamp it already read so the store doesn't
   * read the clock a second time (and so the strategy and the store's expiry math see the exact same
   * instant); when omitted the store reads its own clock.
   */
  applySync?<S, R>(key: string, transform: Transform<S, R>, now?: number): R;
  /** Forget a key. */
  reset(key: string): Promise<void>;
  /** Synchronous reset, when supported. */
  resetSync?(key: string): void;
  /** Release resources (timers, connections). */
  close?(): Promise<void>;
}

/** Behavior when the backing store is unreachable. */
export type FailMode = "open" | "closed";

/** A constructed limiter: a strategy + store + key namespace + clock. */
export interface Limiter {
  /** The active strategy (for headers/policy and introspection). */
  readonly strategy: Strategy;
  /** Check `key` with the given `cost` (default 1). */
  check(key: string, cost?: number): Promise<Decision>;
  /**
   * Synchronous, zero-`await` check. Only available when the configured store supports it
   * (e.g. {@link MemoryStore}); throws otherwise.
   */
  checkSync(key: string, cost?: number): Decision;
  /**
   * Check many independent keys in one call, each with the same `cost` (default 1), returning a
   * decision per key in input order. Every key is evaluated at a **single consistent timestamp**.
   *
   * On a synchronous store the checks run in an ordered loop with no per-key promise overhead. On an
   * async store (e.g. Redis) they are issued **concurrently**; on a client that pipelines commands
   * queued in the same tick (node-redis, or `ioredis` with `enableAutoPipelining`) that collapses to
   * a single round trip. Decisions are identical to calling {@link Limiter.check} per key.
   *
   * Intended for **distinct** keys (the usual case: N different identities). If a key repeats within
   * one batch, the async path lets those applies race — each stays atomic, so the totals are still
   * correct, but their relative allow/deny order is unspecified; the sync path processes them in
   * order.
   */
  checkMany(keys: readonly string[], cost?: number): Promise<Decision[]>;
  /**
   * Synchronous {@link Limiter.checkMany}: one consistent timestamp, no promises. Only available on
   * a synchronous store (e.g. {@link MemoryStore}); throws otherwise.
   */
  checkManySync(keys: readonly string[], cost?: number): Decision[];
  /**
   * Non-consuming introspection: the current {@link Decision} for `key` **without spending** —
   * `remaining` is what's left now, `resetAt` when it refills. The basis of good client retry/UX.
   * Optional: present on store-backed limiters (`rateLimit`); may be absent on composite limiters
   * where a non-consuming read isn't well-defined. Requires the strategy to implement `peek`.
   */
  peek?(key: string): Promise<Decision>;
  /** Synchronous {@link Limiter.peek}; only on a synchronous store (e.g. {@link MemoryStore}). */
  peekSync?(key: string): Decision;
  /**
   * Non-consuming capacity forecast for `key`: how many `cost`-sized requests are spendable now,
   * when capacity next returns, and when it is fully replenished. Optional, like {@link Limiter.peek}.
   */
  forecast?(key: string, cost?: number): Promise<Forecast>;
  /** Synchronous {@link Limiter.forecast}; only on a synchronous store. */
  forecastSync?(key: string, cost?: number): Forecast;
  /** Forget a key's state. */
  reset(key: string): Promise<void>;
  /**
   * Release resources this limiter *owns* — e.g. a default in-process store's sweep timer, or the
   * two-tier `returnIdleAfterMs` timer. A no-op for limiters that own none. A store you passed in is
   * yours to close (call its own `close()`); this never closes a caller-provided store. Optional, so
   * existing code that never disposes a limiter keeps working.
   */
  close?(): Promise<void>;
}
