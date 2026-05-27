import { systemClock } from "../core/clock";
import { ThrottleKitError } from "../core/errors";
import { prefixer } from "../core/key";
import { LUA_NOW } from "../core/lua";
import type {
  ApplyOutcome,
  Clock,
  LuaInvocation,
  LuaProgram,
  Store,
  Transform,
} from "../core/types";
import { requireAtLeast, requireCost, requirePositive } from "../core/validate";
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

/** setTimeout's maximum delay; a larger value silently clamps to 1ms and fires almost immediately. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** Sleep `ms`, chunking delays beyond setTimeout's 32-bit ceiling so long waits still pace correctly. */
const sleep = (ms: number): Promise<void> => {
  if (ms <= 0) return Promise.resolve();
  if (ms <= MAX_TIMEOUT_MS) return new Promise((resolve) => setTimeout(resolve, ms));
  return new Promise((resolve) => {
    let remaining = ms;
    const tick = (): void => {
      const slice = Math.min(remaining, MAX_TIMEOUT_MS);
      remaining -= slice;
      setTimeout(remaining > 0 ? tick : resolve, slice);
    };
    tick();
  });
};

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
local px = math.ceil(new_departure - now)
if px < 1 then px = 1 end
redis.call('SET', KEYS[1], string.format('%.17g', new_departure), 'PX', px)
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
  const keyFor = prefixer(options.prefix);

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
        ttlMs: Math.max(1, Math.ceil(newDeparture - now)),
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

  return {
    async reserve(key: string, cost = 1): Promise<Reservation> {
      requireCost(cost);
      return store.apply(keyFor(key), makeTransform(clock.now(), cost));
    },
    reserveSync(key: string, cost = 1): Reservation {
      requireCost(cost);
      if (store.applySync === undefined) {
        throw new ThrottleKitError(
          "reserveSync requires a synchronous store (e.g. MemoryStore); the configured store is async-only",
        );
      }
      const now = clock.now();
      return store.applySync(keyFor(key), makeTransform(now, cost), now);
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
