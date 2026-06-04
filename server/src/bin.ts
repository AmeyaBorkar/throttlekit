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

import { serve } from "./grpc.js";
import type { LensHub } from "./monitor/hub.js";
import { wireMonitor } from "./monitor/wire.js";
import { createServerCredentials, createStore, isSecure } from "./runtime.js";
import type { StoreType } from "./runtime.js";
import { type RateLimiterService, createRateLimiterServiceFromConfig } from "./service.js";
import { type RunningTui, canRunTui, runTui } from "./tui.js";

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
  tlsCert?: string;
  tlsKey?: string;
  tlsCa?: string;
  tui: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    host: "0.0.0.0",
    port: 50051,
    fail: "open",
    help: false,
    tui: false,
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
      --tls-cert <path>   PEM server certificate  ┐ enable TLS
      --tls-key <path>    PEM server private key   ┘
      --tls-ca <path>     PEM CA bundle ⇒ require + verify client certs (mTLS)
      --tui               live terminal dashboard alongside gRPC (interactive TTY only; q to quit)
  -h, --help              show this help

Serves throttlekit.v1.RateLimiter. A denial is a normal Decision (allowed:false), not an RPC error.`;

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

async function main(): Promise<void> {
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
  const { store, mode, dispose } = await createStore({
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
  const loadOptions = store !== undefined ? { store } : {};

  // `--tui` taps every policy into a telemetry hub for the live dashboard. A TUI owns the terminal, so it
  // needs an interactive TTY — fall back to the plain (untapped) service otherwise.
  const tui = args.tui && canRunTui();
  if (args.tui && !tui) {
    console.warn("warning: --tui needs an interactive terminal; serving without the dashboard.");
  }
  let hub: LensHub | undefined;
  let service: RateLimiterService;
  if (tui) {
    const wired = wireMonitor(text, loadOptions, args.fail, mode, `${args.host}:${args.port}`);
    service = wired.service;
    hub = wired.hub;
  } else {
    service = createRateLimiterServiceFromConfig(text, { ...loadOptions, fail: args.fail });
  }

  const running = await serve({
    service,
    host: args.host,
    port: args.port,
    credentials: createServerCredentials(tls),
  });
  const security = args.tlsCa !== undefined ? "mTLS" : secure ? "TLS" : "insecure";

  let tuiHandle: RunningTui | undefined;
  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    if (tuiHandle !== undefined) tuiHandle.stop(); // restore the terminal before logging anything
    if (!tui) console.log(`\n${signal} received, draining…`);
    Promise.resolve()
      .then(() => running.close())
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
    });
  } else {
    console.log(
      `throttlekit-server listening on ${args.host}:${running.port} ` +
        `[${mode}, ${security}, fail=${args.fail}] ` +
        `(${service.policies().length} policies: ${service.policies().join(", ")})`,
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
