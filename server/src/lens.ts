/**
 * Optional ThrottleKit **Lens** wiring for the server. When `--lens` is on (the default), the server
 * builds its policies, taps each limiter + unified admitter into an in-process Lens hub, and serves the
 * read-only dashboard alongside the gRPC service (loopback by default). Purely additive — the gRPC
 * decisions are unchanged; the taps are synchronous, exception-swallowing, and O(1).
 */

import type { FailMode, Limiter, UnifiedAdmitter } from "throttlekit";
import {
  type LensHub,
  type RunningLens,
  createLensHub,
  pushSnapshots,
  serveLens,
} from "throttlekit-lens";
import { type ServerLoadOptions, buildServiceConfig } from "./config.js";
import { type RateLimiterService, createRateLimiterService } from "./service.js";

/** Resolved Lens settings from the CLI. */
export interface LensServerOptions {
  /** Bind host for the dashboard. Loopback by default. */
  host: string;
  /** Bind port for the dashboard. */
  port: number;
  /** Optional bearer token required on every dashboard request. */
  token?: string;
  /** If set, push this node's snapshot to a fleet aggregator at this URL. */
  aggregatorUrl?: string;
  /** Stable node id for the fleet view. */
  nodeId?: string;
}

/** A service whose policies are tapped into a live Lens dashboard. */
export interface LensWiredServer {
  service: RateLimiterService;
  lens: RunningLens;
  hub: LensHub;
  /** Stop pushing snapshots to a fleet aggregator (a no-op when none is configured). */
  stopPush(): void;
}

/**
 * Build the service from config with every limiter + admitter tapped into a Lens hub, and serve the
 * dashboard. `mode`/`fail` populate the dashboard's store/health panel.
 *
 * Note: token-budget **meters** are served untapped (they `debit` rather than `check`), so the dashboard
 * analyses the limiter + admitter policies; meter-only policies still serve over gRPC as usual.
 */
export async function serveWithLens(
  configText: string,
  loadOptions: ServerLoadOptions,
  fail: FailMode,
  mode: string,
  opts: LensServerOptions,
): Promise<LensWiredServer> {
  const { limiters, meters, admitters } = buildServiceConfig(configText, loadOptions);
  const hub = createLensHub(opts.nodeId !== undefined ? { nodeId: opts.nodeId } : {});

  const tappedLimiters: Record<string, Limiter> = {};
  for (const [name, limiter] of Object.entries(limiters)) {
    tappedLimiters[name] = hub.trackLimiter(name, limiter);
  }
  const tappedAdmitters: Record<string, UnifiedAdmitter> = {};
  for (const [name, admitter] of Object.entries(admitters)) {
    tappedAdmitters[name] = hub.trackAdmitter(name, admitter);
  }
  hub.setHealth({ backend: mode, failMode: fail });

  const service = createRateLimiterService({
    limiters: tappedLimiters,
    meters,
    admitters: tappedAdmitters,
    fail,
  });

  const lens = await serveLens(hub, {
    host: opts.host,
    port: opts.port,
    ...(opts.token !== undefined ? { token: opts.token } : {}),
  });

  const stopPush =
    opts.aggregatorUrl !== undefined
      ? pushSnapshots(hub, {
          url: opts.aggregatorUrl,
          ...(opts.token !== undefined ? { token: opts.token } : {}),
        })
      : (): void => {};

  return { service, lens, hub, stopPush };
}
