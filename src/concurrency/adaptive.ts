import { systemClock } from "../core/clock";
import { clamp } from "../core/math";
import type { Clock } from "../core/types";
import { requireAtLeast, requirePositive } from "../core/validate";

export interface AdaptiveConcurrencyOptions {
  /** Hard floor on the inferred ceiling. Default 4. */
  minLimit?: number;
  /** Hard ceiling on the inferred ceiling. Default 512. */
  maxLimit?: number;
  /** Where the estimate starts. Default = `minLimit`. */
  initialLimit?: number;
  /** Which inference law drives the limit. Default `"gradient2"`. */
  algorithm?: "gradient2" | "aimd";
  /** Sample count for the rolling-min "no-load" RTT. Default 100. */
  rttWindow?: number;
  /** Gradient2 EMA factor in (0,1]; larger reacts faster. Default 0.2. */
  smoothing?: number;
  /** Headroom factor applied to the no-load RTT. Default 2.0. */
  tolerance?: number;
  /** AIMD multiplicative decrease, in `[0.5, 1)`. Default 0.9. */
  backoffRatio?: number;
  /**
   * **Opt-in Envoy-style forced minRTT recalibration.** The windowed rolling-min no-load baseline
   * can stay inflated under *sustained* load — every sample in the window carries queuing delay, so
   * the system never observes a true no-load RTT. When set, the guard periodically *drains* by
   * clamping its effective ceiling to `probeLimit`, measures the true no-load RTT from the resulting
   * low-concurrency samples, and adopts it as the fresh baseline. Off by default (today's
   * Netflix-style windowed min, which only re-baselines if load happens to let up). The probe is
   * disruptive (throughput dips while it drains), so it runs infrequently. See
   * `research/bigger-bets/unified/DESIGN.md` §11.
   */
  recalibration?: {
    /** Re-probe the no-load RTT at most this often (ms). Default `60_000` (Envoy's 60s). Must be > 0. */
    intervalMs?: number;
    /** Effective ceiling to clamp to during a probe so queues drain. Default `minLimit`. Must be ≥ 1. */
    probeLimit?: number;
    /** Clean low-concurrency samples to collect before adopting the fresh baseline. Default 5. Must be ≥ 1. */
    probeSamples?: number;
  };
  /** Injectable time source. Default {@link systemClock}. */
  clock?: Clock;
}

/** Internal, fully-defaulted recalibration config (undefined when the feature is off). */
interface RecalibrationConfig {
  intervalMs: number;
  probeLimit: number;
  probeSamples: number;
}

/**
 * A single admission grant from a {@link ConcurrencyGuard}. Returned by every
 * {@link ConcurrencyGuard.acquire}; the caller must {@link Lease.release} it exactly once when
 * the work finishes (the second and later calls are no-ops).
 */
export interface Lease {
  /** `false` means the request is over the inferred ceiling and the caller should shed it (503). */
  readonly ok: boolean;
  /**
   * Return the slot and record the request's latency. Pass `dropped: true` for a request that
   * failed/timed out (treated as an overload signal). Idempotent: a second call does nothing.
   * Safe to call detached (e.g. `const r = lease.release; r()`).
   */
  release(opts?: { dropped?: boolean }): void;
}

/**
 * A dynamically inferred ceiling on in-flight requests. Each completed request feeds its latency
 * back into the estimate, which rises while the system stays fast and contracts when latency
 * climbs (queueing) or requests drop.
 */
export interface ConcurrencyGuard {
  /** Try to take a slot. The returned {@link Lease} is rejected (`ok === false`) when full. */
  acquire(): Lease;
  /** The current inferred ceiling (integer floor of the internal estimate). */
  readonly limit: number;
  /** How many leases are currently outstanding. */
  readonly inflight: number;
  /** A point-in-time snapshot for metrics/introspection. */
  stats(): { limit: number; inflight: number; rttNoload: number; lastRtt: number };
}

/** A no-op release shared by every rejected lease (rejected leases hold no slot). */
const NOOP_RELEASE = (): void => {};

/**
 * The single shared rejected lease — over the inferred ceiling, holds no slot.
 * Immutable and reused so a rejection allocates nothing; its `release` is a plain
 * no-op (no `this`), safe to call detached.
 */
const REJECTED_LEASE: Lease = Object.freeze({ ok: false, release: NOOP_RELEASE });

/**
 * One granted slot.
 *
 * **Why this shape.** `release` must be callable detached — the lease-shim,
 * `unifiedAdmission`, and the framework adapters all do `const r = lease.release; r()`.
 * It must also be *fast*: a fresh per-acquire `release` closure (the prior design) ran the
 * deque + gradient math in V8's unoptimized tier (~14× slower on the logic, ~3× end-to-end).
 * The resolution is a class whose `release` is a single shared method **bound once in the
 * constructor**: shared ⇒ V8 optimizes it; bound ⇒ detach-safe. The heavy work lives in the
 * guard's optimized {@link AdaptiveGuard.settle}. The per-lease internal state is `#private`, so
 * the lease's enumerable shape is exactly `{ ok, release }`. Benchmarked in `bench/run.ts`
 * ("Concurrency — acquire + release").
 */
class GrantedLease implements Lease {
  readonly ok = true;
  readonly release: (opts?: { dropped?: boolean }) => void;
  #guard: AdaptiveGuard;
  #startTime: number;
  #inflightAtAcquire: number;
  #released = false;

  constructor(guard: AdaptiveGuard, startTime: number, inflightAtAcquire: number) {
    this.#guard = guard;
    this.#startTime = startTime;
    this.#inflightAtAcquire = inflightAtAcquire;
    // Bind the shared method once per lease: detach-safe stable `this`, while the body stays a
    // single optimized function (not a per-acquire closure).
    this.release = this.#doRelease.bind(this);
  }

  #doRelease(opts?: { dropped?: boolean }): void {
    if (this.#released) return; // idempotent: ignore double-release
    this.#released = true;
    this.#guard.settle(this.#startTime, this.#inflightAtAcquire, opts?.dropped ?? false);
  }
}

/**
 * Adaptive concurrency limiter — a TCP-congestion-control-style ceiling on concurrent requests,
 * modeled on Netflix's concurrency-limits. Two laws are available:
 *
 * - **gradient2** (default): compares the best-observed ("no-load") RTT to the current RTT; while
 *   the ratio stays near 1 the limit grows by `√limit` of headroom, and as the current RTT climbs
 *   above no-load the gradient drives the limit multiplicatively down. An EMA (`smoothing`) keeps
 *   the estimate from oscillating.
 * - **aimd**: additive-increase (+1 while fully utilized and healthy) / multiplicative-decrease
 *   (`×backoffRatio` on a drop or when RTT exceeds `tolerance × noload`).
 *
 * The no-load RTT is a *windowed* rolling minimum (over the last `rttWindow` samples) so it can
 * rise again after a deploy or load shift, avoiding the all-time-min low bias. See
 * docs/DESIGN-NOTES.md ("Adaptive concurrency (Gradient2 + AIMD)") for the verified math and
 * citations.
 *
 * State lives in instance fields and the per-request work ({@link AdaptiveGuard.settle} →
 * `#recordRtt`/`#updateGradient2`) in shared methods, so V8 keeps the hot path optimized; see
 * {@link GrantedLease} for the detach-safe lease.
 */
class AdaptiveGuard implements ConcurrencyGuard {
  // Config (immutable after construction).
  readonly #minLimit: number;
  readonly #maxLimit: number;
  readonly #algorithm: "gradient2" | "aimd";
  readonly #smoothing: number;
  readonly #tolerance: number;
  readonly #backoffRatio: number;
  readonly #window: number;
  readonly #cap: number;
  readonly #clock: Clock;

  // State (mutated each request).
  /** Fractional estimate; the public `limit` is its integer floor. */
  #estimate: number;
  #inflightCount = 0;
  /** Best (minimum) RTT observed over the last `window` samples; 0 until the first sample. */
  #rttNoload = 0;
  #lastRtt = 0;
  /** Monotonically increasing index of the next RTT sample (also the count seen so far). */
  #nextSeq = 0;

  // Windowed rolling-minimum via a monotonic deque (ascending by value): the front is always the
  // min over the last `window` samples. Each sample is pushed/popped at most once, so updates are
  // O(1) amortized regardless of how large `window` is. Storing the sample sequence number lets
  // stale entries (older than `window`) expire off the front. Old minima thus age out and the
  // baseline can drift back up after a load shift — "best recently observed", not all-time min.
  // Capacity is `window + 1` so a push transiently overlapping a not-yet-expired front never
  // overwrites a live slot.
  readonly #dqSeq: Float64Array;
  readonly #dqVal: Float64Array;
  #dqHead = 0; // index of the current minimum (inclusive)
  #dqTail = 0; // one past the last retained entry (exclusive); empty when head === tail

  // Envoy-style forced minRTT recalibration (off unless `recalibration` is configured).
  readonly #recalEnabled: boolean;
  readonly #recalIntervalMs: number;
  readonly #probeLimit: number;
  readonly #probeSamples: number;
  /** True while draining + re-measuring the no-load baseline. */
  #probing = false;
  /** Min RTT seen among clean (low-concurrency) samples in the current probe. */
  #probeMin = Number.POSITIVE_INFINITY;
  /** Clean samples collected in the current probe. */
  #probeCount = 0;
  /** Clock time the last probe finished (probes start `intervalMs` after this). */
  #lastRecalEnd: number;

  constructor(cfg: {
    minLimit: number;
    maxLimit: number;
    initialLimit: number;
    algorithm: "gradient2" | "aimd";
    window: number;
    smoothing: number;
    tolerance: number;
    backoffRatio: number;
    recal: RecalibrationConfig | undefined;
    clock: Clock;
  }) {
    this.#minLimit = cfg.minLimit;
    this.#maxLimit = cfg.maxLimit;
    this.#algorithm = cfg.algorithm;
    this.#smoothing = cfg.smoothing;
    this.#tolerance = cfg.tolerance;
    this.#backoffRatio = cfg.backoffRatio;
    this.#window = cfg.window;
    this.#cap = cfg.window + 1;
    this.#clock = cfg.clock;
    this.#estimate = cfg.initialLimit;
    this.#dqSeq = new Float64Array(this.#cap);
    this.#dqVal = new Float64Array(this.#cap);
    this.#recalEnabled = cfg.recal !== undefined;
    this.#recalIntervalMs = cfg.recal?.intervalMs ?? 0;
    this.#probeLimit = cfg.recal?.probeLimit ?? cfg.minLimit;
    this.#probeSamples = cfg.recal?.probeSamples ?? 0;
    this.#lastRecalEnd = cfg.recal !== undefined ? cfg.clock.now() : 0;
  }

  get limit(): number {
    return Math.floor(this.#estimate);
  }

  get inflight(): number {
    return this.#inflightCount;
  }

  acquire(): Lease {
    let ceiling = Math.floor(this.#estimate);
    // While re-probing the no-load baseline, hold the effective ceiling down so queues drain.
    if (this.#probing && this.#probeLimit < ceiling) ceiling = this.#probeLimit;
    if (this.#inflightCount >= ceiling) {
      // Over the inferred ceiling: hand back the shared rejected lease (no slot, no alloc).
      return REJECTED_LEASE;
    }
    this.#inflightCount++;
    // `inflightAtAcquire` is the post-increment count (utilization at grant time).
    return new GrantedLease(this, this.#clock.now(), this.#inflightCount);
  }

  /**
   * Settle one granted lease: drop the slot, record its RTT, feed the inference law. Called
   * exactly once by {@link GrantedLease} (idempotency is enforced there). Public so the lease can
   * reach it; intentionally absent from {@link ConcurrencyGuard}, so callers don't see it.
   * @internal
   */
  settle(startTime: number, inflightAtAcquire: number, dropped: boolean): void {
    this.#inflightCount--;

    const now = this.#clock.now();
    const rtt = Math.max(0, now - startTime);
    this.#lastRtt = rtt;

    if (this.#probing) {
      // Probe samples re-measure the no-load RTT; they don't feed the windowed min or the inference
      // law (the learned estimate is preserved across the probe). Only clean low-concurrency samples
      // count — a request that overlapped the not-yet-drained queue still carries queuing delay.
      if (!dropped && inflightAtAcquire <= this.#probeLimit) {
        if (rtt < this.#probeMin) this.#probeMin = rtt;
        if (++this.#probeCount >= this.#probeSamples) this.#finishProbe(now);
      }
      return;
    }

    this.#recordRtt(rtt);
    if (this.#algorithm === "gradient2") {
      this.#updateGradient2(rtt, dropped, inflightAtAcquire);
    } else {
      this.#updateAimd(rtt, dropped, inflightAtAcquire);
    }

    // Re-probe the no-load baseline once the interval has elapsed (sustained load otherwise keeps the
    // windowed minimum inflated). Checked here, on a real sample, so there is no background timer.
    if (this.#recalEnabled && now - this.#lastRecalEnd >= this.#recalIntervalMs) this.#startProbe();
  }

  /** Begin draining to re-measure the no-load RTT (see {@link AdaptiveConcurrencyOptions.recalibration}). */
  #startProbe(): void {
    this.#probing = true;
    this.#probeMin = Number.POSITIVE_INFINITY;
    this.#probeCount = 0;
  }

  /** Adopt the freshly-measured no-load RTT and resume normal operation with the preserved estimate. */
  #finishProbe(now: number): void {
    const fresh = Number.isFinite(this.#probeMin) ? this.#probeMin : this.#rttNoload;
    // Re-seed the windowed-min deque around the fresh baseline so it takes effect immediately
    // (otherwise the pre-probe inflated samples would dominate the min for up to `window` more).
    this.#dqHead = 0;
    this.#dqTail = 0;
    const seq = this.#nextSeq++;
    this.#dqVal[0] = fresh;
    this.#dqSeq[0] = seq;
    this.#dqTail = 1;
    this.#rttNoload = fresh;
    this.#probing = false;
    this.#lastRecalEnd = now;
  }

  stats(): { limit: number; inflight: number; rttNoload: number; lastRtt: number } {
    return {
      limit: Math.floor(this.#estimate),
      inflight: this.#inflightCount,
      rttNoload: this.#rttNoload,
      lastRtt: this.#lastRtt,
    };
  }

  /** Push `rtt` as the next sample into the deque and refresh `rttNoload` to the windowed min. */
  #recordRtt(rtt: number): void {
    const cap = this.#cap;
    const window = this.#window;
    const dqSeq = this.#dqSeq;
    const dqVal = this.#dqVal;
    const seq = this.#nextSeq++;
    if (seq === 0) this.#rttNoload = rtt; // first sample is the initial baseline

    // Expire the front if it has fallen out of the trailing `window` samples.
    if (this.#dqTail > this.#dqHead && dqSeq[this.#dqHead % cap]! <= seq - window) this.#dqHead++;

    // Drop entries no smaller than the incoming value: they can never be the min while it lives.
    while (this.#dqTail > this.#dqHead && dqVal[(this.#dqTail - 1) % cap]! >= rtt) this.#dqTail--;

    dqVal[this.#dqTail % cap] = rtt;
    dqSeq[this.#dqTail % cap] = seq;
    this.#dqTail++;

    this.#rttNoload = dqVal[this.#dqHead % cap]!;
  }

  /** Apply the Gradient2 law for one completed request. */
  #updateGradient2(rtt: number, dropped: boolean, inflightAtAcquire: number): void {
    let gradient: number;
    if (dropped) {
      // A drop is strong evidence of overload: pin the gradient to its floor.
      gradient = 0.5;
    } else if (rtt <= 0) {
      // No measurable latency => no queueing signal; treat as fully healthy.
      gradient = 1;
    } else {
      gradient = clamp((this.#tolerance * this.#rttNoload) / rtt, 0.5, 1.0);
    }

    // Don't grow the limit while the system is under-utilized: a healthy sample taken when we
    // were nowhere near the ceiling carries no information that we *could* go higher.
    if (!dropped && inflightAtAcquire * 2 < this.#estimate) return;

    const queueSize = Math.sqrt(this.#estimate);
    let newLimit = this.#estimate * gradient + queueSize;
    newLimit = this.#estimate * (1 - this.#smoothing) + newLimit * this.#smoothing;
    this.#estimate = clamp(newLimit, this.#minLimit, this.#maxLimit);
  }

  /** Apply the AIMD law for one completed request. */
  #updateAimd(rtt: number, dropped: boolean, inflightAtAcquire: number): void {
    if (dropped || rtt > this.#rttNoload * this.#tolerance) {
      // Multiplicative decrease on overload.
      this.#estimate = Math.max(this.#minLimit, Math.floor(this.#estimate * this.#backoffRatio));
    } else if (inflightAtAcquire * 2 >= this.#estimate) {
      // Additive increase, but only while we are actually pushing the ceiling.
      this.#estimate = Math.min(this.#maxLimit, this.#estimate + 1);
    }
  }
}

/**
 * Construct an adaptive concurrency limiter. The factory keeps the call-site API identical to the
 * prior implementation; see {@link AdaptiveGuard} for the algorithm and the hot-path rationale.
 */
export function adaptiveConcurrency(options: AdaptiveConcurrencyOptions = {}): ConcurrencyGuard {
  const minLimit = options.minLimit ?? 4;
  const maxLimit = options.maxLimit ?? 512;
  const initialLimit = options.initialLimit ?? minLimit;
  const algorithm = options.algorithm ?? "gradient2";
  const rttWindow = options.rttWindow ?? 100;
  const smoothing = options.smoothing ?? 0.2;
  const tolerance = options.tolerance ?? 2.0;
  const backoffRatio = options.backoffRatio ?? 0.9;
  const clock = options.clock ?? systemClock;

  requireAtLeast("adaptiveConcurrency.minLimit", minLimit, 1);
  requireAtLeast("adaptiveConcurrency.maxLimit", maxLimit, minLimit);
  requireAtLeast("adaptiveConcurrency.initialLimit", initialLimit, minLimit);
  if (initialLimit > maxLimit) {
    throw new RangeError(
      `adaptiveConcurrency.initialLimit must be <= maxLimit (${maxLimit}), got ${initialLimit}`,
    );
  }
  requirePositive("adaptiveConcurrency.rttWindow", rttWindow);
  // smoothing is an EMA weight in (0, 1].
  requirePositive("adaptiveConcurrency.smoothing", smoothing);
  if (smoothing > 1) {
    throw new RangeError(
      `adaptiveConcurrency.smoothing must be in (0, 1], got ${String(smoothing)}`,
    );
  }
  requireAtLeast("adaptiveConcurrency.tolerance", tolerance, 1);
  // backoffRatio must be in [0.5, 1): a decrease that is neither too gentle nor a full collapse.
  if (
    typeof backoffRatio !== "number" ||
    !Number.isFinite(backoffRatio) ||
    backoffRatio < 0.5 ||
    backoffRatio >= 1
  ) {
    throw new RangeError(
      `adaptiveConcurrency.backoffRatio must be in [0.5, 1), got ${String(backoffRatio)}`,
    );
  }

  let recal: RecalibrationConfig | undefined;
  if (options.recalibration !== undefined) {
    const intervalMs = options.recalibration.intervalMs ?? 60_000;
    const probeLimit = options.recalibration.probeLimit ?? minLimit;
    const probeSamples = Math.floor(options.recalibration.probeSamples ?? 5);
    requirePositive("adaptiveConcurrency.recalibration.intervalMs", intervalMs);
    requireAtLeast("adaptiveConcurrency.recalibration.probeLimit", probeLimit, 1);
    if (probeLimit > maxLimit) {
      throw new RangeError(
        `adaptiveConcurrency.recalibration.probeLimit must be <= maxLimit (${maxLimit}), got ${probeLimit}`,
      );
    }
    requireAtLeast("adaptiveConcurrency.recalibration.probeSamples", probeSamples, 1);
    recal = { intervalMs, probeLimit, probeSamples };
  }

  return new AdaptiveGuard({
    minLimit,
    maxLimit,
    initialLimit,
    algorithm,
    window: Math.floor(rttWindow),
    smoothing,
    tolerance,
    backoffRatio,
    recal,
    clock,
  });
}
