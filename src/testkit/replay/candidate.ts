import type { ConfigStrategy, LimiterSpec } from "../../config";
import { ReplayRefusedError } from "./errors";
import type { ReplayTrace } from "./trace";

/**
 * A field of the declarative {@link LimiterSpec} a candidate may change. A **closed union** over the real
 * spec keys: an unknown field is a *compile* error at the typed {@link set}/{@link scale} call sites, and
 * a *runtime* refusal (`candidate-invalid`) for an untyped/JS caller — never a silent no-op (design §7).
 */
export type SpecPath = keyof LimiterSpec;

/**
 * Every {@link SpecPath}, as a runtime set, to fail-fast an unknown field from an untyped caller. The
 * `Record<keyof LimiterSpec, true>` shape is **compile-checked to cover every key** — add a field to
 * {@link LimiterSpec} and this stops compiling until the field is listed here (so the guard never drifts).
 */
const SPEC_PATH_TABLE: Record<keyof LimiterSpec, true> = {
  strategy: true,
  limit: true,
  period: true,
  burst: true,
  capacity: true,
  refillPerSec: true,
  windowMs: true,
  buckets: true,
  resetCadence: true,
  offsetMinutes: true,
  weekStartsOn: true,
  anchor: true,
  periodMs: true,
  prefix: true,
};
const SPEC_PATHS: ReadonlySet<string> = new Set(Object.keys(SPEC_PATH_TABLE));

/**
 * Which {@link SpecPath}s each strategy's builder actually reads — the single source of truth is
 * `buildStrategy` (src/config/index.ts). A field outside its strategy's set is inert: a delta on it
 * would replay byte-identically and report a false zero-divergence, which the candidate guard exists
 * to prevent. `strategy` + `prefix` are read by every builder path (prefix wraps the store). Add a
 * field to a strategy's builder and it must be listed here, or a real delta is wrongly refused.
 */
const CONSUMED_BY_STRATEGY: Record<ConfigStrategy, ReadonlySet<SpecPath>> = {
  // window = periodMs ?? windowMs (or `period`), so all three are meaningful.
  gcra: new Set<SpecPath>([
    "strategy",
    "prefix",
    "limit",
    "period",
    "periodMs",
    "windowMs",
    "burst",
  ]),
  tokenBucket: new Set<SpecPath>(["strategy", "prefix", "capacity", "refillPerSec"]),
  fixedWindow: new Set<SpecPath>(["strategy", "prefix", "limit", "period", "windowMs"]),
  slidingWindow: new Set<SpecPath>([
    "strategy",
    "prefix",
    "limit",
    "period",
    "windowMs",
    "buckets",
  ]),
  slidingWindowLog: new Set<SpecPath>(["strategy", "prefix", "limit", "period", "windowMs"]),
  quota: new Set<SpecPath>([
    "strategy",
    "prefix",
    "limit",
    "period",
    "periodMs",
    "resetCadence",
    "anchor",
    "offsetMinutes",
    "weekStartsOn",
    "buckets",
  ]),
};

/** Override one field to an explicit value. */
export interface SetOp {
  readonly kind: "set";
  readonly path: SpecPath;
  readonly value: unknown;
}
/** Multiply one numeric field by `factor`, resolved against the **base** (recorded) spec value. */
export interface ScaleOp {
  readonly kind: "scale";
  readonly path: SpecPath;
  readonly factor: number;
}
/** Change the strategy (a cross-strategy candidate), supplying the new strategy's fields. */
export interface SwapOp {
  readonly kind: "swap";
  readonly strategy: ConfigStrategy;
  readonly fields: Partial<LimiterSpec>;
}
/** One delta against the recorded spec. */
export type CandidateOp = SetOp | ScaleOp | SwapOp;

/**
 * Override `path` to `value`. Type-checked: `value` must match the field's declared type, so an unknown
 * field or a wrong-typed value is a compile error.
 *
 * @example set("limit", 200)
 */
export function set<K extends keyof LimiterSpec>(path: K, value: LimiterSpec[K]): SetOp {
  return { kind: "set", path, value };
}

/**
 * Scale a numeric field by `factor`, resolved against the **base** value (so it never compounds off
 * another op). `scale("limit", 0.5)` halves the recorded limit. Exact multiplication — no silent
 * rounding; combine with {@link set} if you need an integer. A non-numeric base or non-finite factor is
 * refused (`candidate-invalid`) when the candidate is resolved.
 *
 * A fractional result (e.g. `limit 1.5`) is applied **verbatim** and replayed faithfully — `buildStrategy`
 * accepts a positive non-integer ceiling, so the candidate reflects exactly what that config would do in
 * production (the non-integer is honoured, not rounded). Use {@link set} for an explicit integer.
 *
 * @example scale("limit", 2)
 */
export function scale(path: SpecPath, factor: number): ScaleOp {
  return { kind: "scale", path, factor };
}

/**
 * Swap the strategy, supplying the new strategy's fields — a **cross-strategy** candidate (e.g.
 * `fixedWindow → tokenBucket`). The new strategy's required fields must be provided, or the candidate is
 * refused at rebuild (a `swap` to `tokenBucket` needs `capacity` + `refillPerSec`). Sugar for a `set` of
 * `strategy` plus the fields; classified `cross-strategy` because the resolved strategy differs.
 *
 * @example swap("slidingWindow", { buckets: 4 })
 */
export function swap(strategy: ConfigStrategy, fields: Partial<LimiterSpec> = {}): SwapOp {
  return { kind: "swap", strategy, fields };
}

/** A named bundle of deltas — one what-if the scorecard scores against the recorded trace. */
export interface Candidate {
  readonly name: string;
  readonly ops: readonly CandidateOp[];
}

/** Name a bundle of {@link CandidateOp}s. */
export function candidate(name: string, ...ops: CandidateOp[]): Candidate {
  return { name, ops };
}

/**
 * How a candidate compares to the baseline — which scorecard columns are rankable for it.
 *
 * - `comparable`     — same strategy; every column (incl. strategy-specific `retryAfterMs`/`remaining`)
 *                      is meaningfully comparable to the baseline.
 * - `cross-strategy` — the strategy changed; only the strategy-agnostic columns (admit/deny) compare,
 *                      because `retryAfterMs`/`remaining` have different meaning across algorithms.
 *
 * The comparability unit is the strategy **name**: two `quota` cadences (e.g. `rolling` vs `fixed`) are
 * classed `comparable` even though `rolling` delegates to `slidingWindow` internally — they expose the
 * same `Decision` units, so ranking their columns is meaningful.
 *
 * (A `cross-axis` class would require multi-axis admitters; that is the deferred composite/server tier,
 * not reachable from the flat library `LimiterSpec` — so v1 never emits it.)
 */
export type ComparabilityClass = "comparable" | "cross-strategy";

/** A candidate resolved into a concrete spec + its comparability class. */
export interface ResolvedCandidate {
  readonly spec: LimiterSpec;
  readonly class: ComparabilityClass;
}

function invalid(name: string, detail: string): ReplayRefusedError {
  return new ReplayRefusedError(
    "candidate-invalid",
    `candidate ${JSON.stringify(name)}: ${detail}`,
  );
}

function assertKnownPath(name: string, path: string): void {
  if (!SPEC_PATHS.has(path)) {
    throw invalid(
      name,
      `unknown field ${JSON.stringify(path)} (valid fields: ${[...SPEC_PATHS].join(", ")})`,
    );
  }
}

/**
 * Apply a candidate's deltas to the trace's recorded spec, returning the concrete candidate spec and its
 * {@link ComparabilityClass}. Fail-loud (`candidate-invalid`): an unknown field, more than one op on a
 * field (compounding is ambiguous), or a `scale` over a non-numeric base is refused — never silently
 * dropped. The resulting spec is still validated when {@link replay} rebuilds it (an unbuildable swap is
 * refused there).
 *
 * @experimental Part of the opt-in replay testkit (see STABILITY.md).
 */
export function resolveCandidate(trace: ReplayTrace, cand: Candidate): ResolvedCandidate {
  const base = trace.fingerprint.spec;
  const working: Record<string, unknown> = { ...base };
  const baseRec = base as unknown as Record<string, unknown>;

  // One op per field: a second write to a path is ambiguous (which delta wins?) — refuse it.
  const written = new Set<string>();
  const claim = (path: string): void => {
    if (written.has(path)) {
      throw invalid(
        cand.name,
        `more than one op targets ${JSON.stringify(path)} — at most one op per field`,
      );
    }
    written.add(path);
  };

  for (const op of cand.ops) {
    if (op.kind === "set") {
      assertKnownPath(cand.name, op.path);
      claim(op.path);
      working[op.path] = op.value;
    } else if (op.kind === "scale") {
      assertKnownPath(cand.name, op.path);
      claim(op.path);
      const baseVal = baseRec[op.path];
      if (typeof baseVal !== "number" || !Number.isFinite(baseVal)) {
        throw invalid(
          cand.name,
          `scale(${JSON.stringify(op.path)}) needs a finite numeric base value, got ${JSON.stringify(baseVal)}`,
        );
      }
      if (!Number.isFinite(op.factor)) {
        throw invalid(cand.name, `scale(${JSON.stringify(op.path)}) factor must be finite`);
      }
      working[op.path] = baseVal * op.factor;
    } else {
      // swap: writes `strategy` plus each supplied field.
      claim("strategy");
      working.strategy = op.strategy;
      for (const [k, v] of Object.entries(op.fields)) {
        assertKnownPath(cand.name, k);
        claim(k);
        working[k] = v;
      }
    }
  }

  // A `period` (duration) in the spec shadows `windowMs`/`periodMs` in every builder path — a delta that
  // targets those while `period` is set would silently NOT apply (the candidate would look unchanged).
  // Refuse it loudly: target `period`, or drop it from the base. When `period` is absent the ms field
  // applies, so this never refuses a delta that would have taken effect.
  if ((written.has("windowMs") || written.has("periodMs")) && working.period !== undefined) {
    throw invalid(
      cand.name,
      "targets windowMs/periodMs but the spec sets `period`, which takes precedence — the delta would not apply; target `period` instead",
    );
  }
  // gcra resolves its window as `periodMs ?? windowMs`, so a `windowMs` delta while the gcra spec still
  // carries `periodMs` is shadowed and would silently NOT apply (the candidate would look unchanged and
  // replay to a false zero-divergence). Refuse it loudly: target `periodMs` instead.
  if (
    written.has("windowMs") &&
    working.strategy === "gcra" &&
    (working as { periodMs?: unknown }).periodMs !== undefined
  ) {
    throw invalid(
      cand.name,
      "targets windowMs but the gcra spec sets `periodMs`, which takes precedence (periodMs ?? windowMs) — the delta would not apply; target `periodMs` instead",
    );
  }

  // General inert-field guard: a written field the resolved strategy's builder never reads would
  // replay byte-identically (a false zero-divergence). Refuse it loudly. (Strategy/prefix are always
  // read, so a swap's `strategy` write is never inert.) The two precedence guards above catch the
  // narrower case where the field IS read but is shadowed by another set field — they fire first
  // (more specific message); this catches everything else.
  const resolvedStrategy = working.strategy as ConfigStrategy;
  const consumed = CONSUMED_BY_STRATEGY[resolvedStrategy];
  if (consumed !== undefined) {
    for (const path of written) {
      if (!consumed.has(path as SpecPath)) {
        throw invalid(
          cand.name,
          `targets ${JSON.stringify(path)} but the resolved ${JSON.stringify(resolvedStrategy)} strategy never reads it — the delta would not apply; choose a field that strategy consumes (${[...consumed].join(", ")})`,
        );
      }
    }
  }

  const spec = working as unknown as LimiterSpec;
  const klass: ComparabilityClass =
    spec.strategy !== base.strategy ? "cross-strategy" : "comparable";
  return { spec, class: klass };
}
