/**
 * `FleetLeaseSource` — the SERVER side of a Tier-2 fleet lease (`Fleet.Reserve`). For a policy configured
 * for fleet leasing, this hands a client a chunk of the policy's global per-window budget, computed by the
 * policy's federation {@link GlobalCoordinator}. The server is the one oracle for the grant SIZE; the client
 * (the core `LeaseSpender`, or its Python port) only spends what it's granted.
 *
 * The grant is `coordinator.lease(key, wants, windowEnd)` — the core's window-coupled, partial-grant
 * primitive (a partial grant is legitimate; other clients raced the budget down). The window boundary is
 * derived from the strategy's `windowMs` exactly as the core does, so the lease expires with the window and
 * the per-window global total stays bounded independent of how many clients lease.
 */

import { type Clock, systemClock } from "throttlekit";
import type { GlobalCoordinator } from "throttlekit/federation";

/**
 * The axis a fleet lease draws from. v1 leases windowed-credit budgets (a federated rate/quota policy ⇒
 * `"rate"`); the concurrency axis is not leasable (the Reserve handler raises UNIMPLEMENTED for it).
 */
export type FleetAxis = "rate" | "tokenBudget";

/** The outcome of one {@link FleetLeaseSource.lease}: a window-coupled grant (capacity may be 0 = refused). */
export interface LeaseGrantOutcome {
  /** GRANTED units in `[0, wants]` — a partial grant is legitimate; 0 means none available now (a denial). */
  capacity: number;
  /** Epoch-ms window boundary the grant is coupled to; the client discards leftover credits at this instant. */
  expiresAt: number;
  /** Time remaining to `expiresAt` (the re-lease hint); always `>= 1`. */
  refreshIntervalMs: number;
  /** When `capacity === 0`: ms until the budget refreshes (the window reset); else 0. */
  retryAfterMs: number;
  /** The global per-window ceiling (echoed for the client's synthesized Decision). */
  limit: number;
}

/**
 * A per-policy source of Tier-2 fleet leases. `Fleet.Reserve` resolves the named policy to one of these and
 * leases from it. Never throws for an exhausted budget — it returns `capacity: 0`, which the client surfaces
 * as a denial (the server stays the one oracle; the client never invents a deny).
 */
export interface FleetLeaseSource {
  /** The budget axis this source leases (a federated windowed budget ⇒ `"rate"`). */
  readonly axis: FleetAxis;
  /** Lease up to `wants` units of the policy's global per-window budget for `key`, at the source's clock. */
  lease(key: string, wants: number): Promise<LeaseGrantOutcome>;
}

/** Options for {@link makeFederatedFleetSource}. */
export interface FederatedFleetSourceOptions {
  /** The federated strategy's window width (ms) — the grant's window boundary. */
  windowMs: number;
  /** The federated strategy's `limit` — the global per-window budget (echoed on the grant). */
  limit: number;
  /** Clock driving the window roll (mainly tests; else the system clock). MUST match the policy's clock. */
  clock?: Clock;
}

/**
 * Build a {@link FleetLeaseSource} over a federation {@link GlobalCoordinator} — the SAME coordinator the
 * `federated:` policy's limiter draws from, so a Tier-2 lease and the policy's Tier-1 `Check` share one
 * global per-window budget. The grant is `coordinator.lease(key, wants, windowEnd)`; the window boundary is
 * the epoch-aligned `windowMs` edge, matching the core's fixed-window math.
 */
export function makeFederatedFleetSource(
  coordinator: GlobalCoordinator,
  options: FederatedFleetSourceOptions,
): FleetLeaseSource {
  const clock = options.clock ?? systemClock;
  const { windowMs, limit } = options;
  return {
    axis: "rate",
    async lease(key: string, wants: number): Promise<LeaseGrantOutcome> {
      const now = clock.now();
      // NOTE (FLA-1): `now` is the SERVER NODE clock; the window boundary we return to the client (its
      // leftover-discard instant) is derived from it. The production Redis/Postgres coordinators, however,
      // window the budget on the STORE clock (they IGNORE the `expiresAt` we pass to `lease()`), so under
      // node↔store clock skew the boundary the client discards at can differ from the window the budget was
      // actually drained against — reintroducing skew-bounded cross-window carryover. The GLOBAL per-window
      // safety bound still holds (the coordinator caps each window at `budgetPerWindow`); only the per-window
      // byte-identity is skew-soft. Deploy the node and coordinator store on a shared / NTP-synced clock. The
      // exact fix (the coordinator returning the authoritative boundary it drained against, so the client
      // discards at that instant) is a tracked follow-up for the next core release — see fleet-skew.test.ts.
      const windowStart = Math.floor(now / windowMs) * windowMs;
      const expiresAt = Math.ceil(windowStart + windowMs);
      const want = Math.max(1, Math.floor(wants));
      const capacity = Math.max(0, await coordinator.lease(key, want, expiresAt));
      return {
        capacity,
        expiresAt,
        refreshIntervalMs: Math.max(1, expiresAt - now),
        retryAfterMs: capacity === 0 ? Math.max(0, expiresAt - now) : 0,
        limit,
      };
    },
  };
}
