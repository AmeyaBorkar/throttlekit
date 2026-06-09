/**
 * Build the gRPC service with every limiter + unified admitter tapped into an in-process telemetry
 * {@link LensHub}, so the `--tui` dashboard can render live traffic. Purely additive — the gRPC decisions
 * are unchanged; the taps are synchronous, exception-swallowing, and O(1).
 *
 * Note: token-budget **meters** are served untapped (they `debit` rather than `check`), so the dashboard
 * analyses the limiter + admitter policies; meter-only policies still serve over gRPC as usual.
 */

import { type FailMode, type Limiter, type UnifiedAdmitter, systemClock } from "throttlekit";
import { type ServerLoadOptions, buildServiceConfig } from "../config.js";
import type { FleetLeaseSource } from "../fleet/source.js";
import { type RateLimiterService, createRateLimiterService } from "../service.js";
import { costRoomSource } from "./burn.js";
import { type LensHub, createLensHub } from "./hub.js";

/** A gRPC service whose policies are tapped into a live telemetry hub. */
export interface TappedService {
  service: RateLimiterService;
  hub: LensHub;
  /** Tier-2 fleet-lease sources (one per `federated:` policy) for the `Fleet.Reserve` door. */
  fleetSources: Record<string, FleetLeaseSource>;
}

/**
 * Build the service from config, tapping each limiter + admitter into a fresh hub. `mode`/`fail` populate
 * the dashboard's store/health readout. Does no I/O — the caller serves the gRPC and (optionally) starts
 * the TUI against `hub`.
 */
export function wireMonitor(
  configText: string,
  loadOptions: ServerLoadOptions,
  fail: FailMode,
  mode: string,
  nodeId?: string,
): TappedService {
  const { limiters, meters, admitters, guards, fairness, costRooms, fleetSources } =
    buildServiceConfig(configText, loadOptions);
  // Keep the hub + cost-room sources on the same clock as the limiters (deterministic under an injected
  // clock in tests; the system clock in production).
  const clock = loadOptions.clock ?? systemClock;
  const hub = createLensHub({
    clock,
    ...(nodeId !== undefined ? { nodeId } : {}),
  });

  const tappedLimiters: Record<string, Limiter> = {};
  for (const [name, limiter] of Object.entries(limiters)) {
    tappedLimiters[name] = hub.trackLimiter(name, limiter);
  }
  const tappedAdmitters: Record<string, UnifiedAdmitter> = {};
  for (const [name, admitter] of Object.entries(admitters)) {
    tappedAdmitters[name] = hub.trackAdmitter(name, admitter);
  }
  // Each admitter encapsulates its concurrency guard; tracking the same instance surfaces it in the
  // Concurrency / Guarantee views (the tapped admitter still drives this very guard).
  for (const [name, guard] of Object.entries(guards)) hub.trackGuard(name, guard);
  // Weighted-fair-escrow policies report their per-tenant state for the Fairness view, and — unless the
  // policy opted out (`costRoom: false`) — feed a Cost Room burn-down source through the same door (#282).
  for (const [name, wfe] of Object.entries(fairness)) {
    hub.trackStats(name, "wfe", () => wfe.stats());
    const cr = costRooms[name];
    if (cr?.enabled) {
      hub.trackStats(
        name,
        "cost-room",
        costRoomSource(
          name,
          () => wfe.stats(),
          {
            windowMs: cr.windowMs,
            ...(cr.unit !== undefined ? { unit: cr.unit } : {}),
            ...(cr.maxKeys !== undefined ? { maxKeys: cr.maxKeys } : {}),
            ...(cr.ringSize !== undefined ? { ringSize: cr.ringSize } : {}),
          },
          clock,
        ),
      );
    }
  }
  hub.setHealth({ backend: mode, failMode: fail });

  const service = createRateLimiterService({
    limiters: tappedLimiters,
    meters,
    admitters: tappedAdmitters,
    guards, // the same guard instances the admitters drive — so service.close() can shut them down (SC-16)
    fairLimiters: fairness,
    fail,
  });
  return { service, hub, fleetSources };
}
