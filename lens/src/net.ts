/** Shared listener helpers for the Lens HTTP servers: loud-failing bind + IPv6-safe URL authority. */

import type { Server } from "node:net";

/**
 * Bind `server` to `port`/`host`, resolving the actually-bound port. Unlike a bare
 * `server.listen(port, host, cb)` — whose callback simply never fires on a bind failure — this **rejects**
 * if the bind fails (e.g. `EADDRINUSE` when the default Lens port is already taken) instead of hanging
 * forever. The on-by-default server colocates the Lens, so a port clash must surface as an error, not a
 * silent never-resolving boot.
 */
export function listenServer(server: Server, port: number, host: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const cleanup = (): void => {
      server.removeListener("error", onError);
      server.removeListener("listening", onListening);
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const onListening = (): void => {
      cleanup();
      const address = server.address();
      resolve(address !== null && typeof address === "object" ? address.port : port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

/** Bracket an IPv6 literal so it is a valid URL authority (`::1` → `[::1]`); pass other hosts through. */
export function hostForUrl(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}
