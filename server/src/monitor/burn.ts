/**
 * The **Cost Room** burn accumulator (#282) — the one net-new, bounded, snapshot-time accumulation behind
 * the Token-Budget Control Room. It reads `WeightedFairEscrowStats` (the only server source with a real
 * per-tenant roster, #291 P0) once per frame and maintains a fixed-capacity per-tenant burn ring, from
 * which it derives a window-aware burn rate and a within-window ETA. Everything here runs inside
 * `hub.snapshot()` (~4Hz, off the decision path); P3 (#294) registers it via `wire.ts` against each
 * `fairEscrow` policy's `wfe.stats()`. The decision path is never touched.
 *
 * Correctness rests on the WFE stats contract pinned by the #291 P0 spike
 * (`server/test/cost-room-burn-source.test.ts`):
 *  - `used` is cumulative-this-window and resets to 0 at the window roll (`tenants.clear()`).
 *  - `stats()` does NOT roll the window — only a `check` does — so a passive read after the boundary is
 *    stale (`windowStart + windowMs <= now`). We handle that by sampling a 0-delta (no phantom burn) and
 *    by clamping every ETA to the window edge.
 *  - the initial `windowStart` is `-Infinity` (warming); a tenant can vanish mid-window (`reset`/eviction)
 *    without a roll.
 *
 * Design: `research/dashboard/designs/282-token-budget-control-room.md` §3-§4 + §11 decisions.
 */

import { RingBuffer } from "./ring.js";
import type { LensCostRoomSnapshot, LensTenantBurnRow } from "./types.js";

/**
 * The subset of `WeightedFairEscrowStats` the Cost Room reads — declared structurally so this module
 * stays decoupled from the core type's exact name (duck-typed; the read thunk passes `() => wfe.stats()`).
 */
export interface CostRoomStats {
  readonly windowStart: number;
  readonly limit: number;
  readonly effectiveLimit: number;
  readonly pool: number;
  readonly totalUsed: number;
  readonly tenants: ReadonlyArray<{
    readonly tenant: string;
    readonly weight: number;
    readonly used: number;
  }>;
}

/** Options for a registered Cost Room source. Defaults applied in {@link costRoomSource}. */
export interface CostRoomSourceOptions {
  /** The WFE policy's window width (ms) — the window edge for the ETA clamp + the too-short check. */
  windowMs: number;
  /** Declared unit label, echoed verbatim. Default `"units (cost)"` (never hard-coded "tokens"). */
  unit?: string;
  /** Minimum retained sample span (ms) before a burn rate is reported. Default 1000. */
  minSpanMs?: number;
  /** Per-tenant burn-ring capacity. Default 16. */
  ringSize?: number;
  /** Accumulator tenant cap (how many get a ring), ranked by activity. Default 64. */
  maxKeys?: number;
  /** Max tenant rows emitted in the snapshot (the render candidate set). Default 12. */
  renderCap?: number;
  /** PII seam: applied to every tenant key at the single point it enters a row. Default identity. */
  redactKey?: (key: string) => string;
}

interface ResolvedOptions {
  windowMs: number;
  unit: string;
  minSpanMs: number;
  ringSize: number;
  maxKeys: number;
  renderCap: number;
  redactKey: (key: string) => string;
}

/** A burn-ring sample: the time it was taken, and the non-negative `used` increment since the last. */
interface BurnSample {
  at: number;
  deltaUsed: number;
}

/** One tenant's time-series: a fixed-capacity ring of increments + the last `used` we saw. */
interface TenantSeries {
  ring: RingBuffer<BurnSample>;
  lastUsed: number;
}

/** A validated, fully-coerced tenant reading: a usable key plus finite, non-negative metrics. */
export interface TenantReading {
  key: string;
  used: number;
  weight: number;
}

/**
 * Finite, non-negative coercion. Unlike `Number(x) || 0`, this also maps `Infinity`/`-Infinity` to 0 (a
 * non-finite metric is corrupt, not a real burn), so a hostile/broken stats source can never push an
 * `Infinity` rate or pool into the snapshot.
 */
function num(x: unknown): number {
  const n = Number(x);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

/**
 * Read one tenant element defensively (the stats roster is untrusted at this boundary — `asStats` only
 * checks the array shape). Returns `null` for a missing/empty key so the element is dropped rather than
 * surfacing an `undefined`/blank tenant row; numerics are finite-coerced.
 */
function readTenant(t: { tenant: string; weight: number; used: number }): TenantReading | null {
  const key = (t as { tenant?: unknown }).tenant;
  if (typeof key !== "string" || key.length === 0) return null;
  return {
    key,
    used: num((t as { used?: unknown }).used),
    weight: num((t as { weight?: unknown }).weight),
  };
}

/** Validate + finite-coerce the roster (drop missing/empty keys, finite-coerce metrics), in roster order. */
function collectValid(stats: CostRoomStats): TenantReading[] {
  const valid: TenantReading[] = [];
  for (const t of stats.tenants) {
    const r = readTenant(t);
    if (r !== null) valid.push(r);
  }
  return valid;
}

/**
 * One snapshot frame's validated roster — computed ONCE in {@link costRoomSource} and shared by the
 * accumulator and the renderer, so a frame validates + sorts the roster once rather than once in
 * `sample()` and again in `buildCostRoom()`. It carries the FULL validated set in roster order
 * (`buildCostRoom` needs all of it for `totalWeight` + `activeTenants`, not just the top-N) plus a single
 * used-descending stable sort (the shared comparator) for the top-N selection both consumers do.
 */
export interface ValidatedRoster {
  /** Every usable tenant reading, in roster order (the order `stats.tenants` arrived in). */
  readonly valid: TenantReading[];
  /** {@link ValidatedRoster.valid} sorted by `used` descending — one stable sort with the shared comparator. */
  readonly sorted: TenantReading[];
}

/** Validate + finite-coerce the roster once, then sort it once — the shared per-frame projection. */
function validateRoster(stats: CostRoomStats): ValidatedRoster {
  const valid = collectValid(stats);
  return { valid, sorted: [...valid].sort((a, b) => b.used - a.used) };
}

/**
 * A bounded per-tenant burn accumulator. `sample()` is called once per frame with the live WFE stats;
 * `rate()` derives a Prometheus-style span rate. Peak state is bounded at `maxKeys` rings × `ringSize`
 * samples (~`maxKeys × ringSize × 24B`) — `sample()` rings only the hottest `maxKeys` tenants, so a
 * 100k-tenant roster never allocates 100k rings.
 */
export class BurnAccumulator {
  readonly #ringSize: number;
  readonly #maxKeys: number;
  readonly #series = new Map<string, TenantSeries>();
  /** The last `windowStart` we sampled, so we can detect a roll (advance) vs a stale/jump-back read. */
  #lastWindowStart = Number.NEGATIVE_INFINITY;

  constructor(ringSize: number, maxKeys: number) {
    this.#ringSize = Math.max(2, Math.floor(ringSize));
    this.#maxKeys = Math.max(1, Math.floor(maxKeys));
  }

  /**
   * Fold one frame's stats into the rings. Handles, in order: a window roll (reset every ring — `used`
   * reset to 0 globally), a backwards jump (`reset()` → `-Infinity`; drop everything), a non-finite
   * window (warming; nothing to sample), per-tenant increment sampling with negative-delta discard,
   * dropping vanished tenants, and activity-ranked eviction down to `maxKeys`.
   */
  sample(stats: CostRoomStats, now: number, roster?: ValidatedRoster): void {
    // Coerce a corrupt windowStart (NaN / +Infinity) to the warming sentinel so it can't poison the math.
    const ws = Number.isFinite(stats.windowStart) ? stats.windowStart : Number.NEGATIVE_INFINITY;

    if (ws > this.#lastWindowStart) {
      // Window advanced (a check rolled it): `used` reset to 0 across all tenants. Discard the
      // cross-boundary delta by clearing every ring and zeroing the baseline — never read as burn.
      for (const series of this.#series.values()) {
        series.ring.clear();
        series.lastUsed = 0;
      }
      this.#lastWindowStart = ws;
    } else if (ws < this.#lastWindowStart) {
      // Backwards jump (whole-window `reset()` sets windowStart to -Infinity, or the clock was set back):
      // the prior series no longer describe anything — drop them.
      this.#series.clear();
      this.#lastWindowStart = ws;
    }

    // Before the first check `windowStart` is -Infinity: there is nothing to sample (warming).
    if (!Number.isFinite(ws)) return;

    // Ring only the hottest `maxKeys` tenants this frame (by `used`), ranked by activity — so a
    // 100k-tenant flood never allocates 100k rings (peak state is bounded to `maxKeys`), and the tenants
    // actually rendered always keep a warm ring (no arbitrary-FIFO "warming flap" pathology). The
    // validation + sort is shared with `buildCostRoom` via `roster` (one per frame from costRoomSource);
    // a standalone caller (no `roster`) validates internally and sorts only when selection requires it —
    // identical `selected` either way (`roster.sorted === [...valid].sort(cmp)`).
    const valid = roster?.valid ?? collectValid(stats);
    const selected =
      valid.length > this.#maxKeys
        ? (roster?.sorted ?? [...valid].sort((a, b) => b.used - a.used)).slice(0, this.#maxKeys)
        : valid;

    const present = new Set<string>();
    for (const r of selected) {
      present.add(r.key);
      let series = this.#series.get(r.key);
      if (series === undefined) {
        series = { ring: new RingBuffer<BurnSample>(this.#ringSize), lastUsed: 0 };
        this.#series.set(r.key, series);
      }
      // A same-window decrease (a tenant reset, never a roll — the roll path cleared above) is discarded
      // so it is never read as negative burn.
      const deltaUsed = Math.max(0, r.used - series.lastUsed);
      series.ring.push({ at: now, deltaUsed });
      series.lastUsed = r.used;
    }

    // Drop every tenant not selected this frame (vanished, or fell out of the hot set) so a stale ring
    // never produces a ghost burn series. `selected.length <= maxKeys`, so this also enforces the bound.
    for (const tenant of [...this.#series.keys()]) {
      if (!present.has(tenant)) this.#series.delete(tenant);
    }
  }

  /**
   * Burn rate in units/second for `tenant` over its retained span (Prometheus `rate()`): the total
   * increment strictly within `[oldest.at, newest.at]` over that real span. `null` when `< 2` samples or
   * the span is below `minSpanMs` (warming); `0` for an idle tenant (samples present, no increment).
   */
  rate(tenant: string, minSpanMs: number): number | null {
    const series = this.#series.get(tenant);
    if (series === undefined) return null;
    const s = series.ring.toArray();
    if (s.length < 2) return null;
    const first = s[0];
    const last = s[s.length - 1];
    if (first === undefined || last === undefined) return null;
    const spanMs = last.at - first.at;
    // Guard a zero (same-instant samples) or negative (backwards clock) span regardless of minSpanMs —
    // otherwise `inc / 0` would yield Infinity, breaking the `number | null` contract.
    if (spanMs <= 0 || spanMs < minSpanMs) return null;
    // Sum increments AFTER the oldest sample — the oldest's own delta accrued before the span and is the
    // baseline, so including it would over-count. Self-correcting under eviction (span is the real span).
    let inc = 0;
    for (let i = 1; i < s.length; i++) {
      const e = s[i];
      if (e !== undefined) inc += e.deltaUsed;
    }
    return inc / (spanMs / 1000);
  }
}

/** Coerce + validate a raw read into {@link CostRoomStats}; throws if it is not a usable stats object. */
function asStats(raw: unknown): CostRoomStats {
  if (raw === null || typeof raw !== "object" || "error" in (raw as Record<string, unknown>)) {
    // safeRead's `{error}` shape, or a non-object: skip this frame honestly (the hub drops it).
    throw new Error("cost-room: stats source unavailable");
  }
  const r = raw as { tenants?: unknown };
  if (!Array.isArray(r.tenants)) throw new Error("cost-room: stats has no tenant roster");
  return raw as CostRoomStats;
}

/**
 * Build one policy's Cost Room snapshot — a pure projection over the live stats + the accumulator. Renders
 * the top `renderCap` tenants by `used`; every divide and window-roll is guarded. ETAs are absolute
 * epoch-ms and clamped to the window edge (`etaCappedByWindow`), the load-bearing honesty guard.
 */
export function buildCostRoom(
  policy: string,
  stats: CostRoomStats,
  acc: BurnAccumulator,
  now: number,
  opts: ResolvedOptions,
  roster?: ValidatedRoster,
): LensCostRoomSnapshot {
  // A corrupt windowStart (NaN / +Infinity) is treated as the warming sentinel; -Infinity stays warming.
  const windowStart = Number.isFinite(stats.windowStart)
    ? Number(stats.windowStart)
    : Number.NEGATIVE_INFINITY;
  const limit = num(stats.limit);
  const effectiveLimit = num(stats.effectiveLimit);
  const totalUsed = num(stats.totalUsed);
  const pool = num(stats.pool);
  const windowEdge = windowStart + opts.windowMs; // -Infinity if windowStart is -Infinity (warming)
  // A window narrower than the span we need can never accrue a clean rate within one window.
  const windowTooShort = opts.windowMs < opts.minSpanMs * 1.3;

  // Validate + coerce the roster (drop missing/empty keys; finite-coerce metrics). Shared with the
  // accumulator via `roster` (one validation + sort per frame from costRoomSource); a standalone caller
  // validates internally. `totalWeight` + `activeTenants` need the FULL roster — summed in roster order so
  // the floating-point total is byte-identical to the pre-share path.
  const valid = roster?.valid ?? collectValid(stats);
  let totalWeight = 0;
  for (const r of valid) totalWeight += r.weight;

  // Render candidates: the hottest `renderCap` tenants by `used` (the accumulator tracks ≥ these). The
  // shared `roster.sorted` is `[...valid].sort(cmp)`, so the sliced candidates are identical to before.
  const candidates = (roster?.sorted ?? [...valid].sort((a, b) => b.used - a.used)).slice(
    0,
    opts.renderCap,
  );

  const tenants: LensTenantBurnRow[] = [];
  let sumRate = 0;
  for (const r of candidates) {
    const used = r.used;
    const weight = r.weight;
    const guaranteed = totalWeight > 0 ? Math.floor((weight * effectiveLimit) / totalWeight) : 0;
    const borrowed = Math.max(0, used - guaranteed);

    const rate = acc.rate(r.key, opts.minSpanMs);
    let burnReason: LensTenantBurnRow["burnReason"];
    if (rate === null) burnReason = windowTooShort ? "window-too-short" : "warming";
    else if (rate === 0) burnReason = "idle";

    // ETA to this tenant's guarantee FLOOR at the current burn, borrowing not counted (WFE is
    // work-conserving — past the floor a tenant borrows surplus; the only true exhaustion is the pool).
    let etaToExhaustAt: number | null = null;
    let etaCappedByWindow = false;
    if (rate !== null && rate > 0) {
      sumRate += rate;
      if (used < guaranteed) {
        etaToExhaustAt = now + ((guaranteed - used) / rate) * 1000;
        etaCappedByWindow = Number.isFinite(windowEdge) && etaToExhaustAt > windowEdge;
      }
    }

    const row: LensTenantBurnRow = {
      tenant: opts.redactKey(r.key),
      weight,
      used,
      guaranteed,
      borrowed,
      burnPerSec: rate,
      etaToExhaustAt,
      etaCappedByWindow,
    };
    if (burnReason !== undefined) row.burnReason = burnReason;
    tenants.push(row);
  }

  const snap: LensCostRoomSnapshot = {
    policy,
    windowStart,
    windowMs: opts.windowMs,
    limit,
    effectiveLimit,
    pool,
    totalUsed,
    unit: opts.unit,
    scope: "single-node",
    fairShareReliable: false, // L1-only on the server today (no `l2`); the L2 seam.
    enforced: true, // a fairEscrow policy denies on its own check → it IS enforcing on cost.
    activeTenants: valid.length,
    tenants,
  };

  // Pool ETA = the ONLY true exhaustion number (the shared budget genuinely empties). Present only when
  // it lands within the window; beyond the edge the pool refills first, so we omit it (the renderer shows
  // the window reset from `windowStart` instead).
  if (sumRate > 0 && pool > 0) {
    const poolEta = now + (pool / sumRate) * 1000;
    if (Number.isFinite(windowEdge) && poolEta <= windowEdge) snap.poolEtaToExhaustAt = poolEta;
  }

  // costDenied / topCostKeys are intentionally absent: the server wires no cost axis (#291 P0). Rendered
  // as "cost lane not configured", never a zeroed panel.
  return snap;
}

/**
 * A stateful Cost Room source for the hub's existing `trackStats` door: it owns a {@link BurnAccumulator}
 * and returns a thunk that samples the WFE stats and builds the snapshot each frame. Register with
 * `hub.trackStats(name, "cost-room", costRoomSource(name, () => wfe.stats(), opts, clock))` — no new hub
 * method. The thunk throws (→ the hub's `safeRead` → an honest skip) when the source is unavailable.
 */
export function costRoomSource(
  policy: string,
  read: () => unknown,
  options: CostRoomSourceOptions,
  clock: { now: () => number },
): () => LensCostRoomSnapshot {
  const renderCap = options.renderCap ?? 12;
  const opts: ResolvedOptions = {
    // The WFE policy validates windowMs > 0 upstream; guard defensively so a bad value can't make the
    // window edge run backwards (which would invert the ETA clamp).
    windowMs: Number.isFinite(options.windowMs) && options.windowMs > 0 ? options.windowMs : 1,
    unit: options.unit ?? "units (cost)",
    minSpanMs: options.minSpanMs ?? 1000,
    ringSize: options.ringSize ?? 16,
    // Track at least as many tenants as we render, so every rendered row always has a warm ring.
    maxKeys: Math.max(options.maxKeys ?? 64, renderCap),
    renderCap,
    redactKey: options.redactKey ?? ((k) => k),
  };
  const acc = new BurnAccumulator(opts.ringSize, opts.maxKeys);
  return (): LensCostRoomSnapshot => {
    const stats = asStats(read());
    const now = clock.now();
    // Validate + sort the roster ONCE per frame, then share it with both the accumulator and the renderer
    // (each previously re-validated + re-sorted the full roster independently — twice the work per frame).
    const roster = validateRoster(stats);
    acc.sample(stats, now, roster);
    return buildCostRoom(policy, stats, acc, now, opts, roster);
  };
}

/** Structural guard the hub uses to route a cost-room read into `costRooms` (vs the generic stats feed). */
export function isCostRoomSnapshot(v: unknown): v is LensCostRoomSnapshot {
  return (
    v !== null &&
    typeof v === "object" &&
    !("error" in (v as Record<string, unknown>)) &&
    typeof (v as { policy?: unknown }).policy === "string" &&
    Array.isArray((v as { tenants?: unknown }).tenants)
  );
}
