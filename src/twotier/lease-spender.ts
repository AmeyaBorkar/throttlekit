import { ThrottleKitError } from "../core/errors";
import type { Decision } from "../core/types";
import { requireCost } from "../core/validate";

/**
 * `LeaseSpender` — the **Tier-2 client-side spend** of a window-coupled lease, extracted verbatim from
 * the `twoTier(mode: "leased", lease: { windowCoupled: true })` L1 path (see `src/twotier/index.ts`:
 * `synthAllow` + the window-coupled discard + the local credit decrement).
 *
 * **The one-oracle line.** A high-throughput client leases a chunk of a global budget from the service
 * (the gRPC `Fleet.Reserve` door) and serves requests locally, round-tripping only to refresh — killing
 * the per-request network hop. The **server** (the core, behind the door) computes the grant *size* via
 * its coordinator/pool; the client may only **subtract from the granted balance and synthesize an
 * allow**. It never invents a denial: when local credits run short it returns {@link LeaseSpend.needsRefresh},
 * and the *server's* authoritative `Decision` is surfaced verbatim when a refresh can't be granted. One
 * oracle therefore holds **iff** this local spend is byte-identical to the core's L1 spend — which the
 * golden lease vectors (`wire/vectors`) pin, and which the `lease-spender` conformance test proves against
 * the shipped `twoTier` leased path.
 *
 * **Why window-coupled.** Cross-window carryover of leased-but-unspent credits is the sole source of
 * leased overshoot. Coupling a credit's lifetime to the window that granted it — discarding the remainder
 * once `now >= expiresAt` — removes that source, holding the per-window global total to exactly the limit,
 * independent of how many clients lease concurrently. The grant's `expiresAt` is the **server/store**
 * window boundary; a client treats it as authoritative and never extends it (the clock-skew safety line).
 *
 * The spend is pure and synchronous — `now` is injected per call, like every core algorithm — so it is
 * deterministic and portable to any language a polyglot client is written in.
 */

/** Options for a {@link LeaseSpender}. Language-neutral: a port maps these to its own constructor. */
export interface LeaseSpenderOptions {
  /**
   * The effective ceiling reported on a synthesized allow (the strategy's `limit` — the global
   * per-window budget). Surfaced as `Decision.limit`; does not bound local spend (the granted
   * `capacity` does that).
   */
  limit: number;
  /**
   * Fallback for a synthesized allow's `resetAt` when no lease has been applied yet (mirrors the core
   * `synthAllow`'s `e.lastDecision?.resetAt ?? now + strategy.ttlMs`). In normal use a lease is always
   * applied before a credit is spent, so `expiresAt` drives `resetAt` and this is never read. Default 0.
   */
  ttlMs?: number;
  /**
   * Discard a key's remaining credits once the window that granted them has rolled (`now >= expiresAt`),
   * rather than carrying them across the boundary. Default **true** — the safe, bound-tightening posture
   * the Tier-2 lease is designed around. Set false only to reproduce the legacy carry-over behaviour.
   */
  windowCoupled?: boolean;
}

/** A grant the service door returned: `capacity` units valid until the `expiresAt` window boundary (epoch-ms). */
export interface LeaseGrant {
  /** The **granted** units (may be `< wants` — a partial grant is legitimate). Never the requested amount. */
  readonly capacity: number;
  /** Epoch-ms window boundary the grant is coupled to; the grant is invalid after this instant. */
  readonly expiresAt: number;
}

/** A refusal the service door returned: its authoritative `Decision` (surfaced verbatim — never synthesized). */
export interface LeaseDenied {
  readonly denied: Decision;
}

/** The outcome of a {@link LeaseSpender.spend}. */
export type LeaseSpend =
  /** Served from local credits — a client-synthesized allow byte-identical to the core L1 path. */
  | { readonly needsRefresh: false; readonly decision: Decision }
  /** Out of local credits — the caller must `Reserve` a refresh (or surface the server's denial). */
  | { readonly needsRefresh: true };

/** What the caller's refresh round-trip (`Fleet.Reserve`) yields: a grant, or the server's denial. */
export type ReserveResult = LeaseGrant | LeaseDenied;

/** A refresh round-trip: ask the service for up to `wants` units; resolve to a grant or the server's denial. */
export type ReserveFn = (wants: number) => Promise<ReserveResult>;

/** Type guard: a {@link ReserveResult} that is the server's denial rather than a grant. */
function isDenied(r: ReserveResult): r is LeaseDenied {
  return (r as LeaseDenied).denied !== undefined;
}

/**
 * Spends a window-coupled lease locally, synthesizing an allow per request and signalling when a refresh
 * is needed. One instance tracks one key's lease state (credits + the window they are coupled to).
 *
 * @example
 * ```ts
 * const spender = new LeaseSpender({ limit: 1000, ttlMs: 60_000 }); // windowCoupled defaults to true
 * // `reserve` performs the gRPC Fleet.Reserve round-trip (transport lives in the client, not here):
 * const decision = await spender.spendOrRefresh(now, 1, reserve);
 * if (!decision.allowed) backOff(decision.retryAfterMs);
 * ```
 */
export class LeaseSpender {
  private readonly limit: number;
  private readonly ttlMs: number;
  private readonly windowCoupled: boolean;
  /** Local leased credits available to spend without a round trip. */
  private _credits = 0;
  /** Epoch-ms window boundary the current credits are coupled to; undefined until the first grant. */
  private _expiresAt: number | undefined;

  constructor(options: LeaseSpenderOptions) {
    this.limit = options.limit;
    this.ttlMs = options.ttlMs ?? 0;
    this.windowCoupled = options.windowCoupled ?? true;
  }

  /** Local leased credits currently available (post-discard is applied lazily on the next {@link spend}). */
  get credits(): number {
    return this._credits;
  }

  /** Epoch-ms window boundary the current credits are coupled to, or undefined before the first grant. */
  get expiresAt(): number | undefined {
    return this._expiresAt;
  }

  /**
   * Apply a granted lease: add its `capacity` to local credits and couple them to its `expiresAt` window.
   * Mirrors the core leased path's `credits += leaseAmount; lastDecision = d` on an admitted lease.
   */
  applyLease(grant: LeaseGrant): void {
    this._credits += grant.capacity;
    this._expiresAt = grant.expiresAt;
  }

  /**
   * Discard credits whose granting window has rolled (`now >= expiresAt`). Idempotent; folded into every
   * {@link spend}, exposed for a caller that wants to reclaim eagerly.
   */
  private expireIfRolled(now: number): void {
    if (
      this.windowCoupled &&
      this._expiresAt !== undefined &&
      now >= this._expiresAt &&
      this._credits > 0
    ) {
      this._credits = 0;
    }
  }

  /**
   * Try to serve one request of `cost` (default 1) from local credits at `now`.
   *
   * Returns a client-synthesized allow when credits suffice (byte-identical to the core L1 `synthAllow`),
   * else `{ needsRefresh: true }` — the caller must `Reserve` more budget (and surface the server's denial
   * if none is granted). Never synthesizes a denial; never performs I/O.
   */
  spend(now: number, cost = 1): LeaseSpend {
    requireCost(cost);
    this.expireIfRolled(now);
    if (this._credits >= cost) {
      this._credits -= cost;
      return {
        needsRefresh: false,
        decision: {
          allowed: true,
          limit: this.limit,
          remaining: Math.max(0, Math.floor(this._credits)),
          resetAt: this._expiresAt ?? now + this.ttlMs,
          retryAfterMs: 0,
        },
      };
    }
    return { needsRefresh: true };
  }

  /**
   * The full client loop: spend locally, and on a shortfall `Reserve` a refresh and retry. Returns a
   * `Decision` — a local allow, or the **server's** denial verbatim when the global budget is spent. The
   * `reserve` callback owns the transport (gRPC `Fleet.Reserve`); this method owns only the spend.
   *
   * A grant always makes progress (the server grants `>= 1` or denies), so the loop converges within a
   * window; `maxRounds` is a defensive backstop against a misbehaving `reserve` that neither grants nor denies.
   */
  async spendOrRefresh(
    now: number,
    cost: number,
    reserve: ReserveFn,
    maxRounds = 1024,
  ): Promise<Decision> {
    for (let round = 0; round < maxRounds; round++) {
      const r = this.spend(now, cost);
      if (!r.needsRefresh) return r.decision;
      const res = await reserve(cost);
      if (isDenied(res)) return res.denied;
      this.applyLease(res);
      if (res.capacity <= 0) {
        // No progress and no denial — a contract violation by `reserve`; fail loudly rather than spin.
        throw new ThrottleKitError(
          "Fleet.Reserve returned a zero-capacity grant without a denial; reserve() must grant >= 1 or deny",
        );
      }
    }
    throw new ThrottleKitError(
      `LeaseSpender.spendOrRefresh exceeded ${maxRounds} refresh rounds for one request (cost=${cost})`,
    );
  }

  /** Forget all local credits and the current window coupling (e.g. on a hard reset / reconnect). */
  reset(): void {
    this._credits = 0;
    this._expiresAt = undefined;
  }
}
