import { systemClock } from "../core/clock";
import { ThrottleKitError } from "../core/errors";
import { LUA_NOW } from "../core/lua";
import type {
  ApplyOutcome,
  Clock,
  LuaInvocation,
  LuaProgram,
  Store,
  Transform,
} from "../core/types";
import { requireAtLeast, requirePositive } from "../core/validate";
import { MemoryStore } from "../stores/memory";

export interface LeakyBucketOptions {
  /** Steady drain rate in units per second (the shaped output rate). */
  ratePerSec: number;
  /** Maximum time a request may wait in the queue before it is rejected instead of delayed. */
  maxQueueMs: number;
  /** Where the next-departure timestamp lives. Defaults to a fresh {@link MemoryStore}. */
  store?: Store;
  /** Injected clock. Defaults to the system clock. */
  clock?: Clock;
  /** Key namespace. */
  prefix?: string;
}

/** The outcome of reserving a slot in the leaky bucket. */
export interface Reservation {
  /** Whether a slot was granted (within `maxQueueMs`). */
  accepted: boolean;
  /**
   * When accepted, how long to wait before proceeding so output is paced to `ratePerSec`. When
   * rejected, an advisory hint for how long until the queue would have room.
   */
  delayMs: number;
}

/** Thrown by {@link Shaper.schedule} when the request would wait longer than `maxQueueMs`. */
export class QueueFullError extends ThrottleKitError {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super(`leaky-bucket queue is full; retry after ${retryAfterMs}ms`);
    this.name = "QueueFullError";
    this.retryAfterMs = retryAfterMs;
  }
}

/** A traffic shaper: paces accepted requests to a fixed rate, rejecting only when the queue is full. */
export interface Shaper {
  /** Reserve a slot. Resolves with the wait time; never sleeps. */
  reserve(key: string, cost?: number): Promise<Reservation>;
  /** Synchronous reserve (requires a synchronous store, e.g. {@link MemoryStore}). */
  reserveSync(key: string, cost?: number): Reservation;
  /** Reserve and wait: resolves after the paced delay, or rejects with {@link QueueFullError}. */
  schedule(key: string, cost?: number): Promise<void>;
  /** Forget a key's queue position. */
  reset(key: string): Promise<void>;
}

const sleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Atomic Redis form. Reply: `{accepted, delayMs}`. The next-departure timestamp is stored at full
 * `%.17g` precision so it round-trips exactly, matching the JS path bit-for-bit.
 */
const LEAKY_LUA = `${LUA_NOW}
local ratePerSec = tonumber(ARGV[2])
local maxQueueMs = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local T = 1000 / ratePerSec
local inc = T * cost
local departure = tonumber(redis.call('GET', KEYS[1]) or now)
if departure < now then departure = now end
local delay = departure - now
if delay > maxQueueMs then
  return {0, math.ceil(delay - maxQueueMs)}
end
local new_departure = departure + inc
redis.call('SET', KEYS[1], string.format('%.17g', new_departure), 'PX', math.ceil(new_departure - now))
return {1, math.ceil(delay)}`;

function decodeReservation(raw: unknown): Reservation {
  const a = raw as [number, number];
  return { accepted: a[0] === 1, delayMs: a[1] };
}

/**
 * Leaky bucket (shaper) — smooths bursty input to a steady `ratePerSec` by scheduling each
 * accepted request a little later, rejecting only when the wait would exceed `maxQueueMs`. Ideal
 * for pacing outbound calls to a third-party budget. The next-departure recurrence is the same as
 * GCRA's TAT; GCRA *rejects* past its tolerance, the shaper *waits*. See docs/DESIGN-NOTES.md.
 */
export function leakyBucket(options: LeakyBucketOptions): Shaper {
  requirePositive("leakyBucket.ratePerSec", options.ratePerSec);
  requireAtLeast("leakyBucket.maxQueueMs", options.maxQueueMs, 0);

  const clock = options.clock ?? systemClock;
  const store: Store =
    options.store ?? new MemoryStore(options.clock !== undefined ? { clock: options.clock } : {});
  const prefix = options.prefix;
  const keyFor =
    prefix !== undefined && prefix.length > 0
      ? (k: string): string => `${prefix}:${k}`
      : (k: string): string => k;

  const T = 1000 / options.ratePerSec;
  const maxQueueMs = options.maxQueueMs;
  const ratePerSec = options.ratePerSec;

  const program: LuaProgram = {
    script: LEAKY_LUA,
    buildKeys: (key) => [key],
    buildArgv: (nowArg, cost) => [nowArg, ratePerSec, maxQueueMs, cost],
  };

  const makeTransform = (now: number, cost: number): Transform<number, Reservation> => {
    const inc = T * cost;
    const fn = (state: number | undefined): ApplyOutcome<number, Reservation> => {
      const stored = state ?? now;
      const departure = stored > now ? stored : now;
      const delay = departure - now;
      if (delay > maxQueueMs) {
        return {
          state,
          result: { accepted: false, delayMs: Math.ceil(delay - maxQueueMs) },
          ttlMs: maxQueueMs,
          persist: false,
        };
      }
      const newDeparture = departure + inc;
      return {
        state: newDeparture,
        result: { accepted: true, delayMs: Math.ceil(delay) },
        ttlMs: Math.ceil(newDeparture - now),
        persist: true,
      };
    };
    const invocation: LuaInvocation<Reservation> = {
      program,
      now,
      cost,
      decode: decodeReservation,
    };
    (fn as { lua?: LuaInvocation<Reservation> }).lua = invocation;
    return fn as Transform<number, Reservation>;
  };

  function validateCost(cost: number): void {
    if (!Number.isFinite(cost) || cost <= 0) {
      throw new RangeError(`cost must be a positive finite number, got ${String(cost)}`);
    }
  }

  return {
    async reserve(key: string, cost = 1): Promise<Reservation> {
      validateCost(cost);
      return store.apply(keyFor(key), makeTransform(clock.now(), cost));
    },
    reserveSync(key: string, cost = 1): Reservation {
      validateCost(cost);
      if (store.applySync === undefined) {
        throw new ThrottleKitError(
          "reserveSync requires a synchronous store (e.g. MemoryStore); the configured store is async-only",
        );
      }
      return store.applySync(keyFor(key), makeTransform(clock.now(), cost));
    },
    async schedule(key: string, cost = 1): Promise<void> {
      const r = await this.reserve(key, cost);
      if (!r.accepted) throw new QueueFullError(r.delayMs);
      await sleep(r.delayMs);
    },
    async reset(key: string): Promise<void> {
      await store.reset(keyFor(key));
    },
  };
}
