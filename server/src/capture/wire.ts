/**
 * `wireCapture` — the one-call composition that turns a config + the capture block into a ready service.
 *
 * When capture is **disabled** (the default) it returns the plain service untouched (zero overhead). When
 * **enabled** it builds the service, registers each policy with the recorder (so decisions scope + project
 * correctly), wraps the service with the capture tap, and — when a durable store is configured — creates
 * the encrypted segment store, the audit log, and the flush loop. The caller (the bin) starts the flush
 * timer and logs the capture-ON banner.
 *
 * Leaf-rate policies are registered with a **minimal forensic** strategy identity (name + limit): a live
 * capture is `clock:"system"` and therefore replay-refused downstream regardless, so the exact ttl/Lua are
 * not needed; the deterministic-capture follow-on would enrich this.
 */

import type { FailMode } from "throttlekit";
import { parseYaml } from "throttlekit/config";
import { type ServerLoadOptions, buildServiceConfig } from "../config.js";
import {
  type RateLimiterService,
  createRateLimiterService,
  createRateLimiterServiceFromConfig,
} from "../service.js";
import { type AuditLog, createAuditLog } from "./audit.js";
import { resolveCaptureConfig } from "./config.js";
import { type FlushLoop, createFlushLoop } from "./flush.js";
import { type CaptureRecorder, createCaptureRecorder } from "./recorder.js";
import { type SegmentStore, createSegmentStore } from "./store.js";
import { captureService } from "./tap.js";
import type { CaptureConfig, TenantRule } from "./types.js";

/** Options for {@link wireCapture}. */
export interface WireCaptureOptions {
  /** Env source for secret/key resolution (default `process.env`, via the config resolver). */
  readonly env?: Record<string, string | undefined>;
  /** Programmatic tenant rule (overrides the declarative `tenant:` config block). */
  readonly tenantOf?: TenantRule;
}

/** The wired result: the (possibly capture-wrapped) service plus the capture machinery (if enabled). */
export interface WiredCapture {
  readonly service: RateLimiterService;
  readonly recorder: CaptureRecorder;
  readonly config: CaptureConfig;
  /** Present when a durable store is configured. */
  readonly store?: SegmentStore;
  /** Present when a durable store is configured (segments live under `durable.dir`). */
  readonly audit?: AuditLog;
  /** Present when a durable store is configured — the bin starts/stops this timer. */
  readonly flush?: FlushLoop;
}

/** Parse a config text to read its top-level `capture:` block (YAML or JSON, mirroring the core loader). */
function parseCaptureBlock(text: string): unknown {
  const trimmed = text.trim();
  const data = (
    trimmed.startsWith("{") || trimmed.startsWith("[") ? JSON.parse(text) : parseYaml(text)
  ) as { capture?: unknown };
  return data?.capture;
}

/** The path the durable audit log lives at, under the segment directory. */
export function auditPath(dir: string): string {
  return `${dir.replace(/[/\\]+$/, "")}/audit.jsonl`;
}

/** Compose a config into a capture-ready service. Disabled ⇒ the plain service, untouched. */
export function wireCapture(
  text: string,
  loadOptions: ServerLoadOptions,
  fail: FailMode,
  options: WireCaptureOptions = {},
): WiredCapture {
  const config = resolveCaptureConfig(parseCaptureBlock(text), {
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.tenantOf !== undefined ? { tenantOf: options.tenantOf } : {}),
  });
  const recorder = createCaptureRecorder(config, { clockSource: "system" });

  if (!config.enabled) {
    return {
      service: createRateLimiterServiceFromConfig(text, { ...loadOptions, fail }),
      recorder,
      config,
    };
  }

  const sc = buildServiceConfig(text, loadOptions);
  // Register each policy so its decisions scope + project. Leaf-rate carries a minimal forensic identity.
  for (const [name, limiter] of Object.entries(sc.limiters)) {
    const strategyName = limiter.strategy.name;
    const limit = limiter.strategy.limit;
    recorder.register(name, {
      policyKind: "rate",
      spec: { strategy: strategyName as never, limit },
      strategy: { name: strategyName, limit, ttlMs: 0 },
    });
  }
  for (const name of Object.keys(sc.meters)) recorder.register(name, { policyKind: "meter" });
  for (const name of Object.keys(sc.admitters)) recorder.register(name, { policyKind: "admitter" });
  for (const name of Object.keys(sc.fairness))
    recorder.register(name, { policyKind: "fairEscrow" });

  const inner = createRateLimiterService({
    limiters: sc.limiters,
    meters: sc.meters,
    admitters: sc.admitters,
    fairLimiters: sc.fairness,
    fail,
  });
  const service = captureService(inner, recorder);

  if (config.durable === undefined) return { service, recorder, config };

  const store = createSegmentStore(config.durable, config.retention);
  return {
    service,
    recorder,
    config,
    store,
    audit: createAuditLog(auditPath(config.durable.dir)),
    flush: createFlushLoop(recorder, store),
  };
}
