# @throttlekit/lens

A **zero-dependency, read-only monitoring dashboard** for [ThrottleKit](https://github.com/AmeyaBorkar/throttlekit) — the full ops board for *every* limiter, plus the one view no other rate-limiter dashboard can render: **live binding-axis attribution**.

> `@experimental` — outside ThrottleKit's 1.x SemVer freeze; shapes may change in a minor.

## Why

Most rate-limit dashboards can tell you *that* requests were denied. Because ThrottleKit composes **rate × concurrency × cost** in one `unifiedAdmission`, the Lens can tell you **which axis is actually throttling you right now** — and click a denial to see the exact per-axis `Decision`. Plain `rateLimit()` users still get the full board (throughput, deny rate, top keys, concurrency health, live denial feed) attributed by policy/limiter + key.

## Use

Register what you already use; the hub returns *tapped* wrappers to use in their place. The taps are synchronous, exception-swallowing, and O(1) — the dashboard can never perturb your control path.

### Mount in your own app (no extra port)

```ts
import { createLensHub, lensHandler } from "@throttlekit/lens";
import { rateLimit, gcra, unifiedAdmission } from "throttlekit";

const hub = createLensHub();
const api = hub.trackLimiter("api", rateLimit({ strategy: gcra({ limit: 100, periodMs: 60_000 }) }));
const checkout = hub.trackAdmitter("checkout", unifiedAdmission({ rate, concurrency, cost }));

// Express example — mount the read-only handler at a private path:
const handler = lensHandler(hub, { basePath: "/__throttlekit", token: process.env.LENS_TOKEN });
app.use("/__throttlekit", (req, res) => handler(req, res));

// ...then use `api` / `checkout` exactly like the originals.
```

### Or run a standalone sidecar

```ts
import { createLensHub, serveLens } from "@throttlekit/lens";

const hub = createLensHub();
// ...track your limiters/admitters/guards...
const lens = await serveLens(hub, { port: 9090 }); // loopback by default
console.log(`Lens at ${lens.url}`);
```

## Endpoints (all `GET`, read-only)

| Route | What |
|---|---|
| `/` | the static UI (single self-contained page, no build/CDN) |
| `/api/snapshot` | the current `LensSnapshot` as JSON (poll) |
| `/api/stream` | Server-Sent Events: `snapshot`, then live `denial` / `fence` |

## Security

Off-by-default in your app (you choose where to mount it); the sidecar **binds to loopback by default**. Exposing it beyond loopback without `tls` or a `token` logs a loud warning. There are **no mutation endpoints** — the surface is strictly read-only, and it exposes keys/tenants, so gate it behind auth/mTLS before exposing it.

## Honest scope

Per-process: each instance serves its own Lens (fleet-global aggregation is a separate aggregator). The numbers are eventually-consistent and per-window; top-K is Space-Saving (over-estimates, never misses a true heavy hitter). The binding-axis lane requires `unifiedAdmission`; a single-axis `rateLimit()` has nothing to decompose.
