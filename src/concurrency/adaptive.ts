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
  /** Injectable time source. Default {@link systemClock}. */
  clock?: Clock;
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

  const window = Math.floor(rttWindow);

  /** Fractional estimate; the public `limit` is its integer floor. */
  let estimate = initialLimit;
  let inflight = 0;
  /** Best (minimum) RTT observed over the last `window` samples; 0 until the first sample. */
  let rttNoload = 0;
  let lastRtt = 0;
  /** Monotonically increasing index of the next RTT sample (also the count seen so far). */
  let nextSeq = 0;

  // Windowed rolling-minimum via a monotonic deque (ascending by value): the front is always the
  // min over the last `window` samples. Each sample is pushed/popped at most once, so updates are
  // O(1) amortized regardless of how large `window` is. Storing the sample sequence number lets
  // stale entries (older than `window`) expire off the front. Old minima thus age out and the
  // baseline can drift back up after a load shift — "best recently observed", not all-time min.
  // Capacity is `window + 1` so a push transiently overlapping a not-yet-expired front never
  // overwrites a live slot.
  const cap = window + 1;
  const dqSeq = new Float64Array(cap); // sequence number of each retained sample
  const dqVal = new Float64Array(cap); // its RTT value
  let dqHead = 0; // index of the current minimum (inclusive)
  let dqTail = 0; // one past the last retained entry (exclusive); empty when head === tail

  /** Push `rtt` as sample `seq` into the deque and refresh `rttNoload` to the windowed min. */
  function recordRtt(rtt: number): void {
    const seq = nextSeq++;
    if (seq === 0) rttNoload = rtt; // first sample is the initial baseline

    // Expire the front if it has fallen out of the trailing `window` samples.
    if (dqTail > dqHead && dqSeq[dqHead % cap]! <= seq - window) dqHead++;

    // Drop entries no smaller than the incoming value: they can never be the min while it lives.
    while (dqTail > dqHead && dqVal[(dqTail - 1) % cap]! >= rtt) dqTail--;

    dqVal[dqTail % cap] = rtt;
    dqSeq[dqTail % cap] = seq;
    dqTail++;

    rttNoload = dqVal[dqHead % cap]!;
  }

  /** Apply the Gradient2 law for one completed request. */
  function updateGradient2(rtt: number, dropped: boolean, inflightAtAcquire: number): void {
    let gradient: number;
    if (dropped) {
      // A drop is strong evidence of overload: pin the gradient to its floor.
      gradient = 0.5;
    } else if (rtt <= 0) {
      // No measurable latency => no queueing signal; treat as fully healthy.
      gradient = 1;
    } else {
      gradient = clamp((tolerance * rttNoload) / rtt, 0.5, 1.0);
    }

    // Don't grow the limit while the system is under-utilized: a healthy sample taken when we
    // were nowhere near the ceiling carries no information that we *could* go higher.
    if (!dropped && inflightAtAcquire * 2 < estimate) return;

    const queueSize = Math.sqrt(estimate);
    let newLimit = estimate * gradient + queueSize;
    newLimit = estimate * (1 - smoothing) + newLimit * smoothing;
    estimate = clamp(newLimit, minLimit, maxLimit);
  }

  /** Apply the AIMD law for one completed request. */
  function updateAimd(rtt: number, dropped: boolean, inflightAtAcquire: number): void {
    if (dropped || rtt > rttNoload * tolerance) {
      // Multiplicative decrease on overload.
      estimate = Math.max(minLimit, Math.floor(estimate * backoffRatio));
    } else if (inflightAtAcquire * 2 >= estimate) {
      // Additive increase, but only while we are actually pushing the ceiling.
      estimate = Math.min(maxLimit, estimate + 1);
    }
  }

  function acquire(): Lease {
    const ceiling = Math.floor(estimate);
    if (inflight >= ceiling) {
      // Over the inferred ceiling: hand back a rejected lease that holds no slot.
      return { ok: false, release: NOOP_RELEASE };
    }

    inflight++;
    const startTime = clock.now();
    const inflightAtAcquire = inflight; // utilization at the moment we granted the slot
    let released = false;

    const release = (opts?: { dropped?: boolean }): void => {
      if (released) return; // idempotent: ignore double-release
      released = true;
      inflight--;

      const rtt = Math.max(0, clock.now() - startTime);
      recordRtt(rtt);
      lastRtt = rtt;

      const dropped = opts?.dropped ?? false;
      if (algorithm === "gradient2") {
        updateGradient2(rtt, dropped, inflightAtAcquire);
      } else {
        updateAimd(rtt, dropped, inflightAtAcquire);
      }
    };

    return { ok: true, release };
  }

  return {
    acquire,
    get limit(): number {
      return Math.floor(estimate);
    },
    get inflight(): number {
      return inflight;
    },
    stats() {
      return {
        limit: Math.floor(estimate),
        inflight,
        rttNoload,
        lastRtt,
      };
    },
  };
}
