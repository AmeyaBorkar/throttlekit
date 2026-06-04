/**
 * `lensHandler` — a framework-agnostic `(req, res)` request handler that serves the Lens over plain Node
 * `http`. **Strictly read-only**: only `GET` is allowed, there are no mutation endpoints, and an optional
 * bearer token gates every request. Mount it in your own app at any base path (e.g. `/__throttlekit`) or
 * hand it to {@link serveLens} for a standalone sidecar.
 *
 * Routes (under `basePath`):
 * - `GET /api/snapshot` → the current {@link LensSnapshot} as JSON (the always-works poll).
 * - `GET /api/stream`   → Server-Sent Events: an initial `snapshot`, then `denial` / `fence` as they
 *                         happen and a periodic `snapshot` push.
 * - `GET /` (or `/index.html`) → the static UI.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { LensHub } from "./hub.js";
import { writeSseEvent, writeSseHeaders, writeSsePing } from "./sse.js";
import { renderLensHtml } from "./ui.js";

/** Options for {@link lensHandler}. */
export interface LensHandlerOptions {
  /** Full-snapshot SSE push interval (ms). Default 2000. */
  intervalMs?: number;
  /** SSE keep-alive ping interval (ms). Default 15000. */
  pingMs?: number;
  /** If set, every request must carry `Authorization: Bearer <token>`. */
  token?: string;
  /** The base path the handler is mounted under (e.g. `/__throttlekit`). Default `""`. */
  basePath?: string;
}

/** A plain Node request handler `(req, res) => void`. */
export type LensRequestHandler = (req: IncomingMessage, res: ServerResponse) => void;

/** Build a read-only Lens request handler over `hub`. */
export function lensHandler(hub: LensHub, options: LensHandlerOptions = {}): LensRequestHandler {
  const intervalMs = options.intervalMs ?? 2000;
  const pingMs = options.pingMs ?? 15000;
  const token = options.token;
  const basePath = options.basePath ?? "";
  const html = renderLensHtml(basePath);

  return (req, res) => {
    // Read-only surface: reject anything that isn't a GET before doing any work.
    if (req.method !== "GET") {
      res.writeHead(405, { Allow: "GET", "Content-Type": "text/plain" }).end("Method Not Allowed");
      return;
    }
    if (token !== undefined && req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { "Content-Type": "text/plain" }).end("Unauthorized");
      return;
    }

    const rawPath = (req.url ?? "/").split("?", 1)[0] ?? "/";
    const path =
      basePath && rawPath.startsWith(basePath) ? rawPath.slice(basePath.length) || "/" : rawPath;

    if (path === "/api/snapshot") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(hub.snapshot()));
      return;
    }

    if (path === "/api/stream") {
      writeSseHeaders(res);
      writeSseEvent(res, "snapshot", hub.snapshot());
      const unsubscribe = hub.subscribe({
        onDenial: (row) => writeSseEvent(res, "denial", row),
        onFence: (row) => writeSseEvent(res, "fence", row),
      });
      const snapTimer = setInterval(
        () => writeSseEvent(res, "snapshot", hub.snapshot()),
        intervalMs,
      );
      const pingTimer = setInterval(() => writeSsePing(res), pingMs);
      const cleanup = (): void => {
        clearInterval(snapTimer);
        clearInterval(pingTimer);
        unsubscribe();
      };
      req.on("close", cleanup);
      res.on("close", cleanup);
      return;
    }

    if (path === "/" || path === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(html);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not Found");
  };
}
