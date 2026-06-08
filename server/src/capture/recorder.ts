/**
 * The in-memory capture **recorder** — a control-path-safe sink for the server's decision stream.
 *
 * `record(...)` is meant to be called from a decision tap, so it is **O(1), synchronous, and
 * exception-swallowing**: a capture fault (or a malformed input) can never block or break a decision.
 * Keys are redacted **at capture** (the raw key never enters a ring). Records are bounded two ways — a
 * per-`(scope,policy)` ring depth and a `maxScopes` FIFO over distinct tenants — and a drop is counted
 * (and surfaces as `truncated` on the projected trace), never silent.
 *
 * Two modes by the design's fail-closed posture:
 * - **tenant-scoped** (a `tenantOf` rule is configured): per-`(scope,policy)` event rings → segments.
 * - **counts-only** (no `tenantOf`): no per-key rows, no segments — only per-policy allow/deny tallies.
 */

import { createHash } from "node:crypto";
import type { Decision } from "throttlekit";
import { type Redactor, createRedactor } from "./redact.js";
import type {
  CaptureClock,
  CaptureConfig,
  CaptureCounts,
  CaptureEvent,
  CapturePolicyMeta,
  CaptureSegment,
  RedactionMode,
} from "./types.js";

/** One decision handed to the recorder (the raw key is redacted inside). */
export interface RecordInput {
  readonly policy: string;
  /** The **raw** key — redacted at capture before it enters any ring. */
  readonly key: string;
  readonly cost: number;
  readonly decision: Decision;
  /** Decision instant; defaults to the recorder clock's `now()`. */
  readonly at?: number;
}

/** Options for {@link createCaptureRecorder}. */
export interface CaptureRecorderOptions {
  /** Time source for `at` defaults (the live server's system clock by default). */
  readonly clock?: { now(): number };
  /** Clock source stamped on every segment — `"system"` for a live server (⇒ replay-refused). */
  readonly clockSource?: CaptureClock;
}

/** The recorder: register policies, `record` decisions, read `segments`/`counts`, `drain` for flush. */
export interface CaptureRecorder {
  /** Whether capture is on (from config). When false every method is an inert no-op. */
  readonly enabled: boolean;
  /** Whether this recorder is counts-only (no `tenantOf` rule ⇒ no per-key rows). */
  readonly countsOnly: boolean;
  /** Register a policy's metadata (spec redacted, Lua sha1'd) so its decisions scope + project correctly. */
  register(policy: string, meta: CapturePolicyMeta): void;
  /** Record one decision. O(1), synchronous, never throws (a fault drops the event, counted). */
  record(input: RecordInput): void;
  /** Snapshot the current segments (empty in counts-only mode). */
  segments(): CaptureSegment[];
  /** Per-policy allow/deny tallies. */
  counts(): CaptureCounts[];
  /** Snapshot the segments and clear the rings (for a flush) — tallies + registrations persist. */
  drain(): CaptureSegment[];
}

interface StoredMeta {
  policyKind: CapturePolicyMeta["policyKind"];
  spec?: CapturePolicyMeta["spec"];
  strategy?: CapturePolicyMeta["strategy"];
  luaSha1?: string | null;
}

interface Ring {
  scope: string;
  policy: string;
  createdAt: number;
  events: CaptureEvent[];
  dropped: number;
}

const NO_OP: CaptureRecorder = {
  enabled: false,
  countsOnly: true,
  register() {},
  record() {},
  segments: () => [],
  counts: () => [],
  drain: () => [],
};

/** Create a recorder for a resolved {@link CaptureConfig}. A disabled config yields an inert no-op. */
export function createCaptureRecorder(
  config: CaptureConfig,
  options: CaptureRecorderOptions = {},
): CaptureRecorder {
  if (!config.enabled) return NO_OP;

  const clock = options.clock ?? { now: () => Date.now() };
  const clockSource: CaptureClock = options.clockSource ?? "system";
  const redactionMode: RedactionMode = config.redaction.mode;
  const redactor: Redactor = createRedactor(config.redaction);
  const tenantOf = config.tenantOf;
  const countsOnly = tenantOf === undefined;
  const ringSize = config.retention.ringSize;
  const maxScopes = config.retention.maxScopes;

  const metas = new Map<string, StoredMeta>();
  const tallies = new Map<string, { allowed: number; denied: number }>();
  // scope → (policy → ring). A Map preserves insertion order, so the first scope is the oldest (FIFO).
  const scopes = new Map<string, Map<string, Ring>>();

  const tally = (policy: string, allowed: boolean): void => {
    let t = tallies.get(policy);
    if (t === undefined) {
      t = { allowed: 0, denied: 0 };
      tallies.set(policy, t);
    }
    if (allowed) t.allowed++;
    else t.denied++;
  };

  return {
    enabled: true,
    countsOnly,

    register(policy, meta) {
      const stored: StoredMeta = { policyKind: meta.policyKind };
      // Redact the spec's PII (prefix) at registration — the stored spec is already safe.
      if (meta.spec !== undefined) stored.spec = redactor.redactSpec(meta.spec);
      if (meta.strategy !== undefined) stored.strategy = meta.strategy;
      if (meta.luaScript !== undefined)
        stored.luaSha1 = createHash("sha1").update(meta.luaScript).digest("hex");
      else if (meta.strategy !== undefined) stored.luaSha1 = null;
      metas.set(policy, stored);
    },

    record(input) {
      // Control-path safety: this runs inside a decision tap. Any fault must drop the event, never throw.
      try {
        tally(input.policy, input.decision.allowed);
        if (countsOnly) return; // no per-key rows without a tenant rule (fail-closed)

        const rawScope = (tenantOf as NonNullable<typeof tenantOf>)(input.policy, input.key);
        if (rawScope === undefined) return; // a key with no derivable tenant is excluded, never lumped
        // Redact the tenant too — defense-in-depth, exactly like keyRef — so NO raw tenant/key reaches a
        // segment, the plaintext audit log, or CLI output. hmac ⇒ an operator hashes the tenant id with
        // the secret to locate it; per-trace-salt ⇒ opaque (maximal privacy); drop ⇒ all tenants collapse.
        const scope = redactor.redact(rawScope);

        const keyRef = redactor.redact(input.key);
        const at = input.at ?? clock.now();

        let policyMap = scopes.get(scope);
        if (policyMap === undefined) {
          // A new scope: FIFO-evict the oldest if we are at the cap (bounds memory on a public surface).
          if (scopes.size >= maxScopes) {
            const oldest = scopes.keys().next();
            if (!oldest.done) scopes.delete(oldest.value);
          }
          policyMap = new Map<string, Ring>();
          scopes.set(scope, policyMap);
        }
        let ring = policyMap.get(input.policy);
        if (ring === undefined) {
          ring = { scope, policy: input.policy, createdAt: at, events: [], dropped: 0 };
          policyMap.set(input.policy, ring);
        }
        // Tail-stop at the ring depth (keep the cold-start prefix a replay needs), counting the drop.
        if (ring.events.length >= ringSize) ring.dropped++;
        else ring.events.push({ keyRef, cost: input.cost, at, decision: input.decision });
      } catch {
        // Observer-only: swallow so a capture fault can never reach the decision path.
      }
    },

    segments(): CaptureSegment[] {
      const out: CaptureSegment[] = [];
      for (const policyMap of scopes.values()) {
        for (const ring of policyMap.values()) {
          out.push(buildSegment(ring, metas.get(ring.policy), redactionMode, clockSource));
        }
      }
      return out;
    },

    counts(): CaptureCounts[] {
      return [...tallies.entries()].map(([policy, t]) => ({
        policy,
        allowed: t.allowed,
        denied: t.denied,
      }));
    },

    drain(): CaptureSegment[] {
      const out = this.segments();
      scopes.clear(); // rings reset; tallies + registrations persist across a flush
      return out;
    },
  };
}

function buildSegment(
  ring: Ring,
  meta: StoredMeta | undefined,
  redactionMode: RedactionMode,
  clock: CaptureClock,
): CaptureSegment {
  return {
    policy: ring.policy,
    policyKind: meta?.policyKind ?? "rate",
    scope: ring.scope,
    createdAt: ring.createdAt,
    redactionMode,
    clock,
    count: ring.events.length,
    dropped: ring.dropped,
    ...(meta?.spec !== undefined ? { spec: meta.spec } : {}),
    ...(meta?.strategy !== undefined ? { strategy: meta.strategy } : {}),
    ...(meta?.luaSha1 !== undefined ? { luaSha1: meta.luaSha1 } : {}),
    events: ring.events.slice(),
  };
}
