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

/**
 * Emit one named SSE event with a JSON payload. Returns `false` when the socket is no longer writable (the
 * client went away) — the caller should then tear the subscription down. A failed write **never throws**,
 * so one dead client can neither break the fan-out to the other live dashboards nor (since the feed is
 * driven from a tap) perturb the control path.
 */
export function writeSseEvent(res: ServerResponse, event: string, data: unknown): boolean {
  if (res.writableEnded || res.destroyed) return false;
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

/** Emit an SSE comment line — a keep-alive ping. Returns `false` if the socket is gone (see above). */
export function writeSsePing(res: ServerResponse): boolean {
  if (res.writableEnded || res.destroyed) return false;
  try {
    res.write(": ping\n\n");
    return true;
  } catch {
    return false;
  }
}
