/** Minimal Server-Sent-Events helpers (dependency-free; SSE over WebSockets to stay proxy-friendly). */

import type { ServerResponse } from "node:http";

/** Write the SSE response headers (text/event-stream, no buffering). */
export function writeSseHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Defeat proxy buffering (nginx) so events flush immediately.
    "X-Accel-Buffering": "no",
  });
}

/** Emit one named SSE event with a JSON payload. */
export function writeSseEvent(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/** Emit an SSE comment line — a keep-alive ping that some proxies need to hold the connection open. */
export function writeSsePing(res: ServerResponse): void {
  res.write(": ping\n\n");
}
