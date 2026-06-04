/**
 * `serveLens` — run the Lens as a standalone sidecar on Node's built-in `http` / `https`. Binds to
 * **loopback by default** (immediately usable locally, not externally reachable); exposing it on a real
 * host without TLS or a token logs a loud warning. Returns a handle with the bound port and a `close()`.
 */

import { readFileSync } from "node:fs";
import { type Server, createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { type LensHandlerOptions, lensHandler } from "./handler.js";
import type { LensHub } from "./hub.js";

/** TLS material for an HTTPS / mTLS Lens listener (paths read at startup). */
export interface LensTlsOptions {
  certPath: string;
  keyPath: string;
  /** A CA bundle ⇒ require + verify client certs (mTLS). */
  caPath?: string;
}

/** Options for {@link serveLens}. */
export interface ServeLensOptions extends LensHandlerOptions {
  /** Port to bind. Default 9090. Use 0 for an ephemeral port. */
  port?: number;
  /** Host to bind. Default `127.0.0.1` (loopback). */
  host?: string;
  /** Serve over HTTPS (and mTLS when `caPath` is set). */
  tls?: LensTlsOptions;
}

/** A running Lens sidecar. */
export interface RunningLens {
  port: number;
  host: string;
  url: string;
  close(): Promise<void>;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/** Start a standalone Lens HTTP(S) server backed by `hub`. */
export async function serveLens(
  hub: LensHub,
  options: ServeLensOptions = {},
): Promise<RunningLens> {
  const port = options.port ?? 9090;
  const host = options.host ?? "127.0.0.1";
  const tls = options.tls;
  const secure = tls !== undefined;
  const handler = lensHandler(hub, options);

  if (!secure && options.token === undefined && !LOOPBACK.has(host)) {
    console.warn(
      `warning: ThrottleKit Lens is serving on a NON-loopback host (${host}) with neither TLS nor a token. Anyone who can reach it sees your keys/tenants. Bind to loopback, or pass { tls } and/or { token }.`,
    );
  }

  const server: Server =
    tls !== undefined
      ? createHttpsServer(
          {
            cert: readFileSync(tls.certPath),
            key: readFileSync(tls.keyPath),
            ...(tls.caPath !== undefined
              ? { ca: readFileSync(tls.caPath), requestCert: true, rejectUnauthorized: true }
              : {}),
          },
          handler,
        )
      : createHttpServer(handler);

  await new Promise<void>((resolve) => server.listen(port, host, () => resolve()));
  const address = server.address();
  const boundPort = address !== null && typeof address === "object" ? address.port : port;
  const scheme = secure ? "https" : "http";

  return {
    port: boundPort,
    host,
    url: `${scheme}://${host}:${boundPort}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err === undefined || err === null ? resolve() : reject(err)));
      }),
  };
}
