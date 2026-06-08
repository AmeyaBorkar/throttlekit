/**
 * Shared types for the server **opt-in capture** subsystem (#289 / Replay P3, the design's Phase B).
 *
 * Capture records the server's live `Decision` stream into a bounded, **redacted**, optionally durable +
 * encrypted **forensic** store. Because live server decisions run over a system/server clock, a captured
 * segment is stamped `clock: "system"` (or `"server"`) and is therefore **replay-refused** by the P1
 * guards — the value is the durable, PII-safe, tenant-scoped, audited *record*; what-if replay works only
 * on the leaf-rate deterministic subset (a documented follow-on adds a deterministic-capture mode).
 */

import type { Decision } from "throttlekit";
import type { LimiterSpec } from "throttlekit/config";

/**
 * Clock a segment's decisions were made over. Mirrors the P1 replay clock-source enum, but defined
 * **locally** so the server depends only on the published-stable core (the replay testkit is not in the
 * server's `throttlekit` dependency). A non-`"manual"` value is replay-refused downstream — and a live
 * server is always `"system"`/`"server"`, which is why captures are forensic, not directly replayable.
 */
export type CaptureClock = "manual" | "system" | "server";

/** How a captured key (PII) is redacted **at capture**, before it ever enters a ring or segment. */
export type RedactionMode =
  /** HMAC-SHA-256 with a server secret — stable across segments (cross-incident grouping). */
  | "hmac"
  /** HMAC with a per-segment random salt — privacy-maximal, no cross-segment correlation. */
  | "per-trace-salt"
  /** Replace every key with a constant placeholder — erases per-key identity entirely. */
  | "drop";

/**
 * Which kind of policy produced a segment. Only `"rate"` (a leaf rate limiter) projects to a P1
 * `ReplayTrace`; the rest are **forensic-only** (admitters/meters/fair-escrow are not leaf-rate, so they
 * carry no rebuildable `LimiterSpec`).
 */
export type PolicyKind = "rate" | "twoTier" | "admitter" | "meter" | "fairEscrow";

/** One captured decision. `durationMs` is **deliberately absent** — it is wall-clock, non-replayable. */
export interface CaptureEvent {
  /** Redacted key handle — the raw key never enters a segment. */
  readonly keyRef: string;
  /** Rate/cost units of the request. */
  readonly cost: number;
  /** `clock.now()` at the decision (the server's system clock on a live node). */
  readonly at: number;
  /** The decision the policy produced. */
  readonly decision: Decision;
}

/**
 * A bounded, redacted record of one policy's decisions for one scope (tenant) — the durable unit. A
 * leaf-rate segment additionally carries the `spec` so it projects exactly to a P1 `ReplayTrace`
 * (`clock` stamps the projection's fingerprint; a non-`"manual"` clock is replay-refused).
 */
export interface CaptureSegment {
  /** Policy (config name) that produced these decisions. */
  readonly policy: string;
  /** Policy kind — gates the `ReplayTrace` projection (`"rate"` only). */
  readonly policyKind: PolicyKind;
  /** Tenant scope; `"__counts__"` when no `tenantOf` rule is configured (counts-only, fail-closed). */
  readonly scope: string;
  /** Epoch-ms the segment was opened. */
  readonly createdAt: number;
  /** Redaction mode applied to every `keyRef` (honest disclosure on the stored record). */
  readonly redactionMode: RedactionMode;
  /** Clock the decisions were made over; a non-`"manual"` value is replay-refused downstream. */
  readonly clock: CaptureClock;
  /** Events recorded in this segment. */
  readonly count: number;
  /** Events dropped at the ring/segment cap (`>0` ⇒ the projected trace is truncated → replay-refused). */
  readonly dropped: number;
  /** Present for a leaf-rate policy: the redacted spec, enabling the `ReplayTrace` projection. */
  readonly spec?: LimiterSpec;
  /** Present for a leaf-rate policy: the strategy identity, for the projected fingerprint. */
  readonly strategy?: ReplayStrategyIdentity;
  /** Present for a leaf-rate policy: sha1 of the strategy's Lua (moot for a system-clock trace). */
  readonly luaSha1?: string | null;
  /** The captured decisions, in recording order. */
  readonly events: readonly CaptureEvent[];
}

/** Strategy identity in a projected trace — mirrors the P1 `ReplayFingerprint.strategy`. */
export interface ReplayStrategyIdentity {
  readonly name: string;
  readonly limit: number;
  readonly windowMs?: number;
  readonly ttlMs: number;
}

/**
 * A projected `ReplayTrace` — the **documented P1 interchange format** (`version: 1`). The server emits
 * this JSON so a testkit-capable core can replay it **downstream**; the server never imports the testkit
 * or replays in-process. A live capture stamps `clock: "system"`, so P1 refuses replay (forensic-only)
 * until the deterministic-capture mode (a follow-on) records under `"manual"`-equivalent conditions.
 *
 * Pinned to `TRACE_FORMAT_VERSION = 1` and the shipped `ReplayTrace` shape — kept in sync deliberately
 * (the server's core dependency has no testkit type to import).
 */
export interface ReplayTraceJSON {
  readonly version: 1;
  readonly fingerprint: {
    readonly spec: LimiterSpec;
    readonly strategy: ReplayStrategyIdentity;
    readonly clock: CaptureClock;
    readonly axis: "rate";
    readonly policy: null;
    readonly luaSha1: string | null;
    readonly prefix?: string;
  };
  readonly redacted: boolean;
  readonly truncated: boolean;
  readonly dropped: number;
  readonly steps: ReadonlyArray<{
    readonly key: string;
    readonly cost: number;
    readonly at: number;
    readonly decision: Decision;
  }>;
}

/** Per-policy tally kept in **counts-only** mode (no `tenantOf` rule ⇒ no per-key rows, fail-closed). */
export interface CaptureCounts {
  readonly policy: string;
  readonly allowed: number;
  readonly denied: number;
}

/** Metadata registered for one policy, so the recorder can scope, stamp, and project its decisions. */
export interface CapturePolicyMeta {
  readonly policyKind: PolicyKind;
  /** Leaf-rate only: the declarative spec (redacted before storage). */
  readonly spec?: LimiterSpec;
  /** Leaf-rate only: the strategy identity, for the projection's fingerprint. */
  readonly strategy?: ReplayStrategyIdentity;
  /** Leaf-rate only: the strategy's Lua source — sha1'd into the projection (correct for the future
   *  deterministic mode; moot for a system-clock forensic trace, which is refused before the Lua check). */
  readonly luaScript?: string;
}

/** Resolved redaction config (mandatory when capture is enabled). */
export interface RedactionConfig {
  readonly mode: RedactionMode;
  /** Required for `"hmac"`; the HMAC secret (resolved from config/env). */
  readonly secret?: string;
}

/** Resolved durable-store config. Present ⇒ durable segments; encryption is then **mandatory**. */
export interface DurableConfig {
  /** Directory the encrypted segments are written under. */
  readonly dir: string;
  /** 64-hex (32-byte) AES-256-GCM key, resolved from config/env. No plaintext-on-disk mode exists. */
  readonly encryptionKeyHex: string;
  /** Max events per segment before it rotates to a new immutable file. */
  readonly segmentMaxEvents: number;
}

/** Resolved retention bounds (all positive integers). */
export interface RetentionConfig {
  /** Time-to-live (ms) for a durable segment — enforced at write (a past-TTL segment is purged). */
  readonly ttlMs: number;
  /** Max distinct scopes (tenants) tracked at once; FIFO-evicted beyond it. */
  readonly maxScopes: number;
  /** Per-`(scope,policy)` ring depth before a recording drops-with-counter. */
  readonly ringSize: number;
}

/**
 * Derive the tenant (scope) from a `(policy, key)`. **Absent ⇒ counts-only** (no per-key rows, no durable
 * segments) — fail-closed, never an `__untenanted__` catch-all. A wrong rule is a cross-tenant disclosure,
 * not a silent best-effort grouping (stated in the docs).
 */
export type TenantRule = (policy: string, key: string) => string | undefined;

/** Resolved CLI operator auth. The admin CLI **fails closed** when this is absent. */
export interface AuthConfig {
  /** Operator credential the CLI checks before any list/replay/export. */
  readonly operatorSecret: string;
}

/** The fully-resolved, validated capture configuration. `enabled:false` ⇒ no capture (the default). */
export interface CaptureConfig {
  readonly enabled: boolean;
  readonly redaction: RedactionConfig;
  readonly retention: RetentionConfig;
  /** Present ⇒ durable encrypted segments; absent ⇒ in-memory rings only. */
  readonly durable?: DurableConfig;
  /** Absent ⇒ counts-only (fail-closed). */
  readonly tenantOf?: TenantRule;
  /** Absent ⇒ the admin CLI is unavailable (fail-closed). */
  readonly auth?: AuthConfig;
}

/** One append-only audit record: who did what to which scope/policy, when, under which redaction. */
export interface AuditRecord {
  readonly ts: number;
  readonly principal: string;
  readonly action: "enable" | "flush" | "list" | "export" | "sweep";
  readonly policy?: string;
  readonly tenant?: string;
  readonly window?: string;
  readonly redactionMode?: RedactionMode;
}
