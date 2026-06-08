/**
 * Server-side **deterministic What-If Replay** (#299 + #290) — the in-process, opt-in, default-OFF
 * deterministic-capture mode and its on-demand what-if. Built entirely on the published `throttlekit/testkit`
 * (zero core change): a per-leaf-rate-policy {@link Shadow} produces a replayable trace, and {@link runWhatIf}
 * replays it against an operator-configured candidate into a render-ready divergence snapshot.
 */

export { type Shadow, type ShadowOptions, createShadow } from "./shadow.js";
export {
  type ReplayDivergenceSnapshot,
  type WhatIfState,
  describeCandidate,
  runWhatIf,
} from "./whatif.js";
export {
  type ConfiguredCandidate,
  type ReplayConfig,
  type ResolveReplayOptions,
  DEFAULT_MAX_STEPS,
  resolveReplayConfig,
} from "./config.js";
export {
  type WiredReplay,
  type WireReplayOptions,
  replayConfigFromText,
  wireReplay,
} from "./wire.js";
export { replayService } from "./tap.js";
