#!/usr/bin/env node
/**
 * `throttlekit-server` CLI. Loads a `.throttlekit.yaml`/`.json` policy file and serves it over gRPC.
 *
 * Point multiple instances at one shared store — `--redis <url>`, `--postgres-url <url>`, or
 * `--dynamodb-table <name>` — to run a coordinated fleet (one shared limit); omit all for a
 * single-instance in-process memory store. Front anything non-loopback with `--tls-cert/--tls-key`
 * (add `--tls-ca` for mTLS) so nothing can poison a shared budget.
 */

import { readFileSync } from "node:fs";

import type { FailMode } from "throttlekit";

import { runCaptureCli } from "./capture/cli.js";
import { type WiredCapture, captureConfigFromText, wireCapture } from "./capture/wire.js";
import type { ServerLoadOptions } from "./config.js";
import { serve } from "./grpc.js";
import type { LensHub } from "./monitor/hub.js";
import { type RunningMetricsServer, startMetricsServer } from "./monitor/metrics.js";
import { wireMonitor } from "./monitor/wire.js";
import { replayService } from "./replay/tap.js";
import { type WiredReplay, replayConfigFromText, wireReplay } from "./replay/wire.js";
import { createServerCredentials, createStore, isSecure } from "./runtime.js";
import type { StoreType } from "./runtime.js";
import type { RateLimiterService } from "./service.js";
import { type RunningTui, canRunTui, runTui } from "./tui.js";

/** How often the flush loop drains captured segments to the durable store (ms). */
const CAPTURE_FLUSH_MS = 5000;

interface Args {
  config?: string;
  host: string;
  port: number;
  fail: FailMode;
  store?: StoreType;
  redis?: string;
  redisPrefix?: string;
  postgresUrl?: string;
  postgresTable?: string;
  postgresPrefix?: string;
  dynamodbTable?: string;
  dynamodbRegion?: string;
  dynamodbEndpoint?: string;
  dynamodbPrefix?: string;
  dynamodbCreateTable?: boolean;
  region?: string;
  tlsCert?: string;
  tlsKey?: string;
  tlsCa?: string;
  tui: boolean;
  monitor: "on" | "off";
  monitorSecret?: string;
  metricsPort?: number;
  metricsHost?: string;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    host: "0.0.0.0",
    port: 50051,
    fail: "open",
    help: false,
    tui: false,
    monitor: "on",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "-c":
      case "--config":
        args.config = argv[++i];
        break;
      case "--host":
        args.host = argv[++i] ?? args.host;
        break;
      case "-p":
      case "--port":
        args.port = Number(argv[++i]);
        break;
      case "--fail": {
        const v = argv[++i];
        if (v !== "open" && v !== "closed") throw new Error(`--fail must be open|closed, got ${v}`);
        args.fail = v;
        break;
      }
      case "--store": {
        const v = argv[++i];
        if (v !== "memory" && v !== "redis" && v !== "postgres" && v !== "dynamodb") {
          throw new Error(`--store must be memory|redis|postgres|dynamodb, got ${v}`);
        }
        args.store = v;
        break;
      }
      case "--redis":
        args.redis = argv[++i];
        break;
      case "--redis-prefix":
        args.redisPrefix = argv[++i];
        break;
      case "--postgres-url":
        args.postgresUrl = argv[++i];
        break;
      case "--postgres-table":
        args.postgresTable = argv[++i];
        break;
      case "--postgres-prefix":
        args.postgresPrefix = argv[++i];
        break;
      case "--dynamodb-table":
        args.dynamodbTable = argv[++i];
        break;
      case "--dynamodb-region":
        args.dynamodbRegion = argv[++i];
        break;
      case "--dynamodb-endpoint":
        args.dynamodbEndpoint = argv[++i];
        break;
      case "--dynamodb-prefix":
        args.dynamodbPrefix = argv[++i];
        break;
      case "--dynamodb-create-table":
        args.dynamodbCreateTable = true;
        break;
      case "--region":
        args.region = argv[++i];
        break;
      case "--tls-cert":
        args.tlsCert = argv[++i];
        break;
      case "--tls-key":
        args.tlsKey = argv[++i];
        break;
      case "--tls-ca":
        args.tlsCa = argv[++i];
        break;
      case "--tui":
        args.tui = true;
        break;
      case "--monitor": {
        const v = argv[++i];
        if (v !== "on" && v !== "off") throw new Error(`--monitor must be on|off, got ${v}`);
        args.monitor = v;
        break;
      }
      case "--monitor-secret":
        args.monitorSecret = argv[++i];
        break;
      case "--metrics-port":
        args.metricsPort = Number(argv[++i]);
        break;
      case "--metrics-host":
        args.metricsHost = argv[++i];
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

const USAGE = `throttlekit-server — gRPC service door for ThrottleKit

Usage:
  throttlekit-server --config <path> [options]

Options:
  -c, --config <path>     .throttlekit.yaml / .throttlekit.json policy file (required)
      --host <host>       bind host (default 0.0.0.0)
  -p, --port <port>       bind port (default 50051)
      --fail open|closed  store-outage policy (default open)
      --store <backend>   backing store: memory|redis|postgres|dynamodb (inferred from the URL flags if omitted)
      --redis <url>       share a Redis store across instances (fleet mode); omit for in-process memory
      --redis-prefix <p>  key prefix for the shared Redis store
      --postgres-url <url>   share a Postgres store across instances (no Redis required)
      --postgres-table <t>   table holding limiter state (default throttlekit)
      --postgres-prefix <p>  key prefix for the shared Postgres store
      --dynamodb-table <t>      back the fleet with a DynamoDB table (no Redis required)
      --dynamodb-region <r>     AWS region (else AWS_REGION / the default credential chain)
      --dynamodb-endpoint <url> override the endpoint (e.g. http://localhost:8000 for dynamodb-local)
      --dynamodb-prefix <p>     key prefix for the shared DynamoDB store
      --dynamodb-create-table   create the table if absent (dev convenience), then wait for it
      --region <id>       this instance's region for federated: policies (or TK_REGION; default "default")
      --tls-cert <path>   PEM server certificate  ┐ enable TLS
      --tls-key <path>    PEM server private key   ┘
      --tls-ca <path>     PEM CA bundle ⇒ require + verify client certs (mTLS)
      --tui               live terminal dashboard alongside gRPC (interactive TTY only; q to quit)
      --monitor on|off    read-only Monitor gRPC door on the same port (default on; loopback-only w/o a secret)
      --monitor-secret <s>  secret to read Monitor beyond loopback (call metadata; or THROTTLEKIT_MONITOR_SECRET)
      --metrics-port <n>  serve Prometheus /metrics + /healthz on this HTTP port (needs monitoring on)
      --metrics-host <h>  bind the metrics port (default 127.0.0.1; aggregate + PII-free, set to expose)
  -h, --help              show this help

Subcommands:
  capture <list|export|sweep>   admin for the opt-in decision-capture store (try \`capture --help\`)

Serves throttlekit.v1.RateLimiter. A denial is a normal Decision (allowed:false), not an RPC error.
Capture is opt-in via the config \`capture:\` block (default OFF) and active in this (non-TUI) serve path.
Deterministic What-If Replay is opt-in via the \`replay:\` block (default OFF) and active with --tui — the
Replay tab shows shadow status; press \`r\` to run the configured candidate what-if over recorded traffic.`;

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

const CAPTURE_USAGE = `throttlekit-server capture — admin for the opt-in decision-capture store

Usage:
  throttlekit-server capture <list|export|sweep> --config <path> [--id <id>] [--credential <cred>] [--principal <who>]

The operator credential may also come from THROTTLEKIT_CAPTURE_CREDENTIAL. Capture must be enabled with a
durable store (a \`capture.durable\` block) in the config. \`export <id>\` prints a ReplayTrace JSON for a
leaf-rate segment (replay it downstream) or the forensic segment otherwise. Every action is audited.`;

interface CaptureArgs {
  action?: string;
  config?: string;
  id?: string;
  credential?: string;
  principal?: string;
  help: boolean;
}

function parseCaptureArgs(argv: string[]): CaptureArgs {
  const a: CaptureArgs = { help: false };
  const first = argv[0];
  if (first !== undefined && !first.startsWith("-")) a.action = first;
  for (let i = a.action !== undefined ? 1 : 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "-h":
      case "--help":
        a.help = true;
        break;
      case "-c":
      case "--config":
        a.config = argv[++i];
        break;
      case "--id":
        a.id = argv[++i];
        break;
      case "--credential":
        a.credential = argv[++i];
        break;
      case "--principal":
        a.principal = argv[++i];
        break;
      default:
        throw new Error(`unknown capture argument: ${argv[i]}`);
    }
  }
  return a;
}

/** The `capture` admin subcommand: run the fail-closed CLI against the config's durable store. */
async function runCaptureSubcommand(argv: string[]): Promise<void> {
  const a = parseCaptureArgs(argv);
  if (a.help || a.action === undefined) {
    console.log(CAPTURE_USAGE);
    if (a.action === undefined && !a.help) process.exitCode = 1;
    return;
  }
  if (a.action !== "list" && a.action !== "export" && a.action !== "sweep") {
    console.error(`error: unknown capture action ${JSON.stringify(a.action)} (list|export|sweep)`);
    process.exitCode = 1;
    return;
  }
  if (a.config === undefined) {
    console.error("error: --config is required for capture");
    process.exitCode = 1;
    return;
  }
  const wired = wireCapture(readFileSync(a.config, "utf8"), {}, "open");
  if (!wired.config.enabled) {
    console.error("error: capture is not enabled in this config (set capture.enabled: true)");
    process.exitCode = 1;
    return;
  }
  if (wired.store === undefined || wired.audit === undefined) {
    console.error("error: capture admin requires a durable store (set a capture.durable block)");
    process.exitCode = 1;
    return;
  }
  if (a.credential !== undefined) {
    console.warn(
      "warning: --credential is visible in process listings (ps / Task Manager); prefer the THROTTLEKIT_CAPTURE_CREDENTIAL env var.",
    );
  }
  const credential = a.credential ?? process.env.THROTTLEKIT_CAPTURE_CREDENTIAL;
  const res = await runCaptureCli(
    {
      action: a.action,
      ...(a.id !== undefined ? { id: a.id } : {}),
      ...(credential !== undefined ? { credential } : {}),
      ...(a.principal !== undefined ? { principal: a.principal } : {}),
    },
    { config: wired.config, store: wired.store, audit: wired.audit },
  );
  if (!res.ok) {
    console.error(`error: ${res.error}`);
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(res.output, null, 2));
}

async function main(): Promise<void> {
  if (process.argv[2] === "capture") {
    await runCaptureSubcommand(process.argv.slice(3));
    return;
  }
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (args.config === undefined) {
    console.error("error: --config is required\n");
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  if (!Number.isInteger(args.port) || args.port < 0) {
    throw new Error(`--port must be a non-negative integer, got ${args.port}`);
  }

  const tls = { certPath: args.tlsCert, keyPath: args.tlsKey, caPath: args.tlsCa };
  const secure = isSecure(tls);
  if (!secure && !LOOPBACK.has(args.host)) {
    console.warn(
      `warning: serving INSECURE gRPC on a non-loopback host (${args.host}). Pass --tls-cert/--tls-key (and --tls-ca for mTLS) before exposing this.`,
    );
  }

  const text = readFileSync(args.config, "utf8");
  const { store, mode, dispose, makeCoordinator } = await createStore({
    store: args.store,
    redisUrl: args.redis,
    redisPrefix: args.redisPrefix,
    postgresUrl: args.postgresUrl,
    postgresTable: args.postgresTable,
    postgresPrefix: args.postgresPrefix,
    dynamodbTable: args.dynamodbTable,
    dynamodbRegion: args.dynamodbRegion,
    dynamodbEndpoint: args.dynamodbEndpoint,
    dynamodbPrefix: args.dynamodbPrefix,
    dynamodbCreateTable: args.dynamodbCreateTable,
  });
  // Region identity for `federated:` policies (a policy's own `region` overrides this); `makeCoordinator`
  // is how the config layer builds a cross-region coordinator over the shared store (redis/postgres only).
  const region = args.region ?? process.env.TK_REGION ?? "default";
  const loadOptions: ServerLoadOptions = {
    ...(store !== undefined ? { store } : {}),
    ...(makeCoordinator !== undefined ? { makeCoordinator } : {}),
    region,
  };

  // `--tui` taps every policy into a telemetry hub for the live dashboard. A TUI owns the terminal, so it
  // needs an interactive TTY — fall back to the plain (untapped) service otherwise.
  const tui = args.tui && canRunTui();
  if (args.tui && !tui) {
    console.warn("warning: --tui needs an interactive terminal; serving without the dashboard.");
  }
  // The Monitor door is available by default (loopback-bound); `--monitor off` opts out.
  const monitorOn = args.monitor !== "off";
  let hub: LensHub | undefined;
  let service: RateLimiterService;
  let capture: WiredCapture | undefined;
  let replay: WiredReplay | undefined;
  if (tui) {
    // Capture is not composed with the live dashboard in this version — warn (best-effort) so an operator
    // who enabled both isn't silently left without capture. A malformed capture block surfaces non-TUI.
    let captureWanted = false;
    try {
      captureWanted = captureConfigFromText(text).enabled;
    } catch {
      /* ignore here — the non-TUI path reports a bad capture block */
    }
    if (captureWanted) {
      console.warn(
        "warning: capture is configured but is NOT active alongside --tui in this version; run without --tui to capture.",
      );
    }
    const wired = wireMonitor(text, loadOptions, args.fail, mode, `${args.host}:${args.port}`);
    hub = wired.hub;
    // Deterministic What-If Replay (#290/#299): build the shadows + feed tap, compose them around the
    // monitored service (post-decision, over the shadow's own store — production decisions are untouched),
    // and hand the wired machinery to the TUI for the Replay tab + the `r` trigger. Off ⇒ a no-op wrap.
    replay = wireReplay(text);
    service = replayService(wired.service, replay);
  } else {
    // Replay is a --tui feature (the what-if is a keybind); warn if it's configured without the dashboard.
    let replayWanted = false;
    try {
      replayWanted = replayConfigFromText(text).enabled;
    } catch {
      /* a malformed replay block becomes fatal on the --tui path (where it's used) */
    }
    if (replayWanted) {
      console.warn(
        "warning: `replay:` (deterministic capture) is configured but needs --tui; run with --tui for the Replay tab.",
      );
    }
    // Capture and the Monitor door aren't composed in this version (mirroring capture×--tui): if capture
    // is configured it owns the service wiring; otherwise, when monitoring is on (the default), tap each
    // policy into a hub so the Monitor door serves a live snapshot over gRPC.
    let captureWanted = false;
    try {
      captureWanted = captureConfigFromText(text).enabled;
    } catch {
      /* a malformed capture block surfaces in wireCapture below */
    }
    if (monitorOn && !captureWanted) {
      const wired = wireMonitor(text, loadOptions, args.fail, mode, `${args.host}:${args.port}`);
      hub = wired.hub;
      service = wired.service;
    } else {
      if (monitorOn && captureWanted) {
        console.warn(
          "warning: the Monitor door is NOT served alongside capture in this version; run without capture for the Monitor door, or pass --monitor off to silence this.",
        );
      }
      // wireCapture returns the plain service when capture is disabled (the default) — zero overhead.
      capture = wireCapture(text, loadOptions, args.fail);
      service = capture.service;
    }
  }

  const monitorSecret = args.monitorSecret ?? process.env.THROTTLEKIT_MONITOR_SECRET;
  // `hub` is set iff the Monitor door is being served (the --tui or non-capture monitor path above).
  const monitorOption =
    hub !== undefined
      ? { monitor: { hub, ...(monitorSecret !== undefined ? { secret: monitorSecret } : {}) } }
      : {};
  const running = await serve({
    service,
    host: args.host,
    port: args.port,
    credentials: createServerCredentials(tls),
    ...monitorOption,
  });
  const security = args.tlsCa !== undefined ? "mTLS" : secure ? "TLS" : "insecure";

  // The Monitor snapshot carries traffic keys (PII). Without a secret it is loopback-only, so warn loudly
  // when the server is bound somewhere remote can reach it — remote Monitor calls will be rejected.
  if (hub !== undefined && monitorSecret === undefined && !LOOPBACK.has(args.host)) {
    console.warn(
      `⚠ Monitor door is loopback-only (no --monitor-secret) but bound to ${args.host}; remote Monitor calls are rejected UNAUTHENTICATED. Set --monitor-secret (or THROTTLEKIT_MONITOR_SECRET) to expose it.`,
    );
  }

  if (capture?.config.enabled) {
    capture.flush?.start(CAPTURE_FLUSH_MS);
    const c = capture.config;
    console.warn(
      `⚠ capture ON — recording decisions (PII): redaction=${c.redaction.mode}, ` +
        `${c.durable !== undefined ? `durable=${c.durable.dir}` : "in-memory only"}, ` +
        `${c.tenantOf !== undefined ? "tenant-scoped" : "counts-only"}, ttl=${c.retention.ttlMs}ms`,
    );
  }

  // Optional Prometheus `/metrics` + `/healthz` over a separate HTTP port (needs the telemetry hub). The
  // series are aggregate + PII-free, so it defaults to loopback and needs no auth; a host flag exposes it.
  let metrics: RunningMetricsServer | undefined;
  if (args.metricsPort !== undefined) {
    if (hub === undefined) {
      console.warn(
        "warning: --metrics-port needs the in-process telemetry hub, which is off (monitoring disabled or the capture path is active); not serving /metrics.",
      );
    } else {
      const metricsHost = args.metricsHost ?? "127.0.0.1";
      metrics = await startMetricsServer({ hub, host: metricsHost, port: args.metricsPort });
      if (!LOOPBACK.has(metricsHost)) {
        console.warn(
          `⚠ /metrics is exposed on ${metricsHost}:${metrics.port} (aggregate + PII-free, but unauthenticated); front it with a network policy if unintended.`,
        );
      }
    }
  }

  let tuiHandle: RunningTui | undefined;
  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    if (tuiHandle !== undefined) tuiHandle.stop(); // restore the terminal before logging anything
    if (!tui) console.log(`\n${signal} received, draining…`);
    Promise.resolve()
      .then(() => {
        if (capture?.flush === undefined) return undefined;
        capture.flush.stop();
        return capture.flush.flushOnce().then(() => undefined); // a final drain on the way out
      })
      .then(() => running.close())
      .then(() => (metrics !== undefined ? metrics.close() : undefined))
      .then(() => dispose())
      .then(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  if (tui && hub !== undefined) {
    // The dashboard owns the screen; its header carries the listening status, so don't log over it.
    tuiHandle = runTui(hub, {
      nodeId: `${args.host}:${args.port}`,
      onQuit: () => shutdown("quit"),
      ...(replay?.enabled ? { replay } : {}),
    });
  } else {
    const monitorTag =
      hub !== undefined
        ? `monitor:${monitorSecret !== undefined ? "secret" : "loopback"}`
        : "monitor:off";
    const metricsTag = metrics !== undefined ? `, metrics:${metrics.port}` : "";
    console.log(
      `throttlekit-server listening on ${args.host}:${running.port} ` +
        `[${mode}, ${security}, fail=${args.fail}, ${monitorTag}${metricsTag}] ` +
        `(${service.policies().length} policies: ${service.policies().join(", ")})`,
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
