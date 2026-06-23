import type { LimiterSpec } from "../../config";
import { ManualClock } from "../../core/clock";
import { ThrottleKitError } from "../../core/errors";
import type { Decision, Limiter } from "../../core/types";
import { ReplayRefusedError } from "./errors";
import { rebuildLimiter } from "./rebuild";
import { type ReplayFingerprint, fingerprint } from "./spec";
import { type ReplayStep, type ReplayTrace, TRACE_FORMAT_VERSION } from "./trace";

/** Default recording cap — generous; a real what-if trace is far smaller. */
const DEFAULT_MAX_STEPS = 1_000_000;

export interface RecordOptions {
  /**
   * The {@link ManualClock} the recording is driven by — you advance it between checks to simulate
   * arrivals. Default: a fresh `ManualClock(0)`, exposed as {@link Recording.clock}. Must be a
   * `ManualClock`: a system/server clock records non-reproducible instants.
   */
  readonly clock?: ManualClock;
  /** Key prefix for the underlying limiter (default: the config name). */
  readonly prefix?: string;
  /** Config name — `buildStrategy` error context + labelling. Default `"recorded"`. */
  readonly name?: string;
  /**
   * Cap on recorded steps. At the cap recording stops appending: the kept **prefix** stays a faithful
   * recording, but the trace is flagged `truncated` and replay refuses it (re-record larger). The cap
   * is a tail-stop, deliberately **not** a drop-oldest ring — dropping the oldest steps would lose the
   * cold-start prefix replay needs to rebuild state. Default 1,000,000.
   */
  readonly maxSteps?: number;
  /**
   * OFF by default (identity). Redact each key **at capture**, so the trace stores only redacted keys
   * and replay (which rebuilds from them) stays faithful. A redaction that maps two distinct keys to
   * the same value is refused (`keyref-collision`) — silently merging their state would corrupt the
   * replay. Supply e.g. a salted hash; mind that a hash trades a small collision risk for privacy.
   */
  readonly redactKey?: (key: string) => string;
}

export interface Recording {
  /**
   * The recording limiter. Call `checkSync` / `checkManySync`; each decision appends a step at the
   * clock's current instant. The async `check` / `checkMany` and `reset` are refused: recording is
   * synchronous-only (an async check would not be captured deterministically) and a reset would
   * desynchronize the decision trace from replay.
   */
  readonly limiter: Limiter;
  /** The {@link ManualClock} the recording is driven by — advance it to simulate arrivals. */
  readonly clock: ManualClock;
  /** Snapshot the immutable trace recorded so far. */
  trace(): ReplayTrace;
}

/**
 * Wrap a leaf limiter — built from `spec`, so the trace's fingerprint provably rebuilds it — and
 * record every synchronous decision into a bounded {@link ReplayTrace}. The recording limiter is
 * constructed by {@link rebuildLimiter}, the exact deterministic construction replay uses
 * (`MemoryStore`, `sweepIntervalMs: 0`, shared `ManualClock`), so a recording and its replay start
 * from the same cold state and evolve identically.
 *
 * @experimental Part of the opt-in replay testkit (see STABILITY.md).
 */
export function recordLimiter(spec: LimiterSpec, options: RecordOptions = {}): Recording {
  const clock = options.clock ?? new ManualClock(0);
  if (!(clock instanceof ManualClock)) {
    throw new ReplayRefusedError(
      "non-manual-clock",
      "recordLimiter: clock must be a ManualClock so the recording is deterministically replayable",
    );
  }
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const redactKey = options.redactKey ?? ((k: string) => k);
  const name = options.name ?? "recorded";

  // The inner leaf limiter we record over — built from the SAME spec the trace carries.
  const inner = rebuildLimiter(spec, {
    clock,
    name,
    ...(options.prefix !== undefined ? { prefix: options.prefix } : {}),
  });
  const fp: ReplayFingerprint = fingerprint({
    spec,
    strategy: inner.strategy,
    clock: "manual",
    ...(options.prefix !== undefined ? { prefix: options.prefix } : {}),
  });

  const steps: ReplayStep[] = [];
  let dropped = 0;

  // Redaction-collision guard: a redacted key that maps back to a DIFFERENT original is a silent
  // state-merge hazard; refuse it loudly. Populated for each distinct key recorded under the cap
  // (the identity default writes here too); bounded by maxSteps via the at-cap short-circuit below.
  const originalOf = new Map<string, string>();
  const redact = (key: string): string => {
    const r = redactKey(key);
    const prev = originalOf.get(r);
    if (prev !== undefined && prev !== key) {
      // Name only the redacted value (which the trace already stores) — never the raw keys, which
      // are the PII the redaction hook was configured to strip; echoing them into Error.message
      // (a log-/serialize-exposed field) would defeat the privacy contract.
      throw new ReplayRefusedError(
        "keyref-collision",
        `recordLimiter: redactKey mapped two distinct keys to the same redacted value ${JSON.stringify(r)} — replay would merge their state (raw keys omitted: they are the PII the redaction hook strips)`,
      );
    }
    if (prev === undefined) originalOf.set(r, key);
    return r;
  };

  const atCap = (): boolean => steps.length >= maxSteps;
  // Once truncated, the trace is flagged and replay refuses it, so post-cap decisions are
  // meaningless. Return a fixed sentinel WITHOUT redacting, writing the inner store, or recording —
  // so the keyref map and the inner store stay bounded by maxSteps, not by distinct-key cardinality.
  const droppedDecision: Decision = {
    allowed: false,
    limit: 0,
    remaining: 0,
    resetAt: 0,
    retryAfterMs: 0,
  };

  const record = (key: string, cost: number, at: number, decision: Decision): void => {
    steps.push({ key, cost, at, decision });
  };

  const innerPeek = inner.peekSync;
  const innerForecast = inner.forecastSync;
  const innerClose = inner.close;

  const limiter: Limiter = {
    strategy: inner.strategy,

    checkSync(key: string, cost = 1): Decision {
      if (atCap()) {
        dropped++;
        return droppedDecision;
      }
      const k = redact(key);
      const at = clock.now();
      const decision = inner.checkSync(k, cost);
      record(k, cost, at, decision);
      return decision;
    },

    checkManySync(keys: readonly string[], cost = 1): Decision[] {
      // Each key is its OWN step at the shared instant — a batch is N coincident-`at` steps, never
      // one merged step. (Decisions are identical to N ordered checkSync calls at the same instant.)
      const at = clock.now();
      const out: Decision[] = new Array(keys.length);
      for (let i = 0; i < keys.length; i++) {
        if (atCap()) {
          dropped++;
          out[i] = droppedDecision;
          continue;
        }
        const k = redact(keys[i] as string);
        const decision = inner.checkSync(k, cost);
        record(k, cost, at, decision);
        out[i] = decision;
      }
      return out;
    },

    check(): Promise<Decision> {
      return Promise.reject(
        new ThrottleKitError(
          "recordLimiter: recording is synchronous-only; use checkSync (an async check would not be captured deterministically)",
          { code: "not_implemented" },
        ),
      );
    },

    checkMany(): Promise<Decision[]> {
      return Promise.reject(
        new ThrottleKitError("recordLimiter: recording is synchronous-only; use checkManySync", {
          code: "not_implemented",
        }),
      );
    },

    reset(): Promise<void> {
      return Promise.reject(
        new ThrottleKitError(
          "recordLimiter: reset() is not supported during recording — a reset desynchronizes the decision trace from replay; record over a fresh limiter instead",
          { code: "not_implemented" },
        ),
      );
    },

    // Non-consuming introspection is safe to forward: it never mutates state and so never affects the
    // recorded decision stream or replay. It is not recorded.
    ...(innerPeek ? { peekSync: (key: string): Decision => innerPeek(redactKey(key)) } : {}),
    ...(innerForecast
      ? { forecastSync: (key: string, cost?: number) => innerForecast(redactKey(key), cost) }
      : {}),
    ...(innerClose ? { close: (): Promise<void> => innerClose() } : {}),
  };

  return {
    limiter,
    clock,
    trace(): ReplayTrace {
      return {
        version: TRACE_FORMAT_VERSION,
        fingerprint: fp,
        redacted: options.redactKey !== undefined,
        truncated: dropped > 0,
        dropped,
        steps: steps.slice(),
      };
    },
  };
}
