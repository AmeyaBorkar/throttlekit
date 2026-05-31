#!/usr/bin/env node
/**
 * `throttlekit-server` CLI. Loads a `.throttlekit.yaml`/`.json` policy file and serves it over gRPC.
 *
 * This first cut uses the in-process **memory** store (each policy its own), which is correct for a
 * single server instance. A distributed deployment shares one Redis/Postgres store across instances —
 * that needs a store client and is wired programmatically via `serve({ service })` with a
 * `createRateLimiterServiceFromConfig(text, { store })` for now; a `--redis` flag follows.
 */

import { readFileSync } from "node:fs";

import type { FailMode } from "throttlekit";

import { serve } from "./grpc.js";
import { createRateLimiterServiceFromConfig } from "./service.js";

interface Args {
  config?: string;
  host: string;
  port: number;
  fail: FailMode;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { host: "0.0.0.0", port: 50051, fail: "open", help: false };
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
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

const USAGE = `throttlekit-server — gRPC service door for ThrottleKit

Usage:
  throttlekit-server --config <path> [--host <host>] [--port <port>] [--fail open|closed]

Options:
  -c, --config <path>   .throttlekit.yaml / .throttlekit.json policy file (required)
      --host <host>     bind host (default 0.0.0.0)
  -p, --port <port>     bind port (default 50051)
      --fail open|closed  store-outage policy (default open)
  -h, --help            show this help

Serves throttlekit.v1.RateLimiter over (insecure) gRPC. Front with mTLS/TLS for anything exposed.`;

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

  const text = readFileSync(args.config, "utf8");
  const service = createRateLimiterServiceFromConfig(text, { fail: args.fail });
  const running = await serve({ service, host: args.host, port: args.port });

  console.log(
    `throttlekit-server listening on ${args.host}:${running.port} ` +
      `(${service.policies().length} policies: ${service.policies().join(", ")}; fail=${args.fail})`,
  );

  const shutdown = (signal: string): void => {
    console.log(`\n${signal} received, draining…`);
    running.close().then(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
