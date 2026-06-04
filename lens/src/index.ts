/**
 * **ThrottleKit Lens** — a zero-dependency, read-only monitoring dashboard for ThrottleKit.
 *
 * Register your limiters / unified admitters / concurrency guards with a {@link createLensHub} hub, then
 * either mount {@link lensHandler} in your own app (no extra port) or run {@link serveLens} as a sidecar.
 * The board works for **every** ThrottleKit user; a `unifiedAdmission` additionally lights up the live
 * **binding-axis** breakdown (which of rate / concurrency / cost — or the joint-LP policy filter — is
 * throttling you right now) that no other rate-limiter dashboard can render.
 *
 * @packageDocumentation
 */

export { LENS_VERSION, createLensHub } from "./hub.js";
export type { LensHub, LensHubOptions, LensListener } from "./hub.js";
export { lensHandler } from "./handler.js";
export type { LensHandlerOptions, LensRequestHandler } from "./handler.js";
export { serveLens } from "./serve.js";
export type { LensTlsOptions, RunningLens, ServeLensOptions } from "./serve.js";
export { renderLensHtml } from "./ui.js";
export type {
  LensDenialRow,
  LensFenceRow,
  LensGuardSnapshot,
  LensHealth,
  LensMeta,
  LensMode,
  LensPolicySnapshot,
  LensSnapshot,
  LensStatsSnapshot,
} from "./types.js";
