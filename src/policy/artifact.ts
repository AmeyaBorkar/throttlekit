import { createHash } from "node:crypto";
import { type LimiterSpec, buildStrategy, parseYaml } from "../config";
import { ThrottleKitError } from "../core/errors";
import { type ReplayFingerprint, fingerprint } from "../testkit/replay/spec";

/**
 * On-disk format for a serialized {@link PolicySet}. A serialized set from any other version is
 * refused on parse (fail-loud) — like {@link TRACE_FORMAT_VERSION}, a stored artifact must be
 * re-exported on a version bump rather than silently mis-read.
 */
export const POLICY_SET_FORMAT_VERSION = 1 as const;

/**
 * One named admission policy — a declarative leaf {@link LimiterSpec} plus the {@link ReplayFingerprint}
 * needed to rebuild and validate the exact limiter it describes. Immutable + content-addressed (via the
 * enclosing {@link PolicySet}'s `contentHash`): "which policy is running" is a hash, "did it change" is a
 * hash compare. Built only from a buildable leaf-rate spec — non-replayable axes (concurrency / escrow /
 * joint-LP) are carried on the set as {@link UnreplayablePolicy}, never as a `Policy`.
 */
export interface Policy {
  readonly name: string;
  readonly spec: LimiterSpec;
  readonly fingerprint: ReplayFingerprint;
}

/**
 * A policy that exists operationally but cannot be diffed by replay (a concurrency axis — releases are
 * not decisions; an escrow / leased / joint-LP path — warm or post-hoc state a cold replay can't
 * reconstruct). Listed on a {@link PolicySet} so a {@link Plan} can surface it honestly ("observe live")
 * rather than silently omit an axis.
 */
export interface UnreplayablePolicy {
  readonly name: string;
  readonly reason: string;
}

/**
 * A versioned, content-addressed set of admission policies — the unit a {@link plan} diffs. `contentHash`
 * is a SHA-256 over the canonical (name-sorted, key-sorted) policies + unreplayable list, so two sets
 * compare by hash and a serialized set's integrity is checkable on parse.
 */
export interface PolicySet {
  readonly label?: string;
  readonly policies: readonly Policy[];
  readonly unreplayable?: readonly UnreplayablePolicy[];
  readonly contentHash: string;
}

/**
 * Build one {@link Policy} from a declarative leaf {@link LimiterSpec}. Validates the spec eagerly via
 * {@link buildStrategy} (an incomplete or non-leaf spec throws here, not later at plan time) and captures
 * the rebuild fingerprint.
 *
 * @experimental Part of the opt-in Policy Plans surface (`throttlekit/policy`); see STABILITY.md.
 */
export function policy(name: string, spec: LimiterSpec): Policy {
  if (typeof name !== "string" || name.length === 0)
    throw new ThrottleKitError("policy: name must be a non-empty string", {
      code: "config_invalid",
    });
  // buildStrategy is the single source of truth for spec→strategy; it validates completeness and that the
  // strategy is constructible (fail-loud) — so an unbuildable leaf can never enter a PolicySet.
  const strategy = buildStrategy(name, spec);
  const fp = fingerprint({
    spec,
    strategy,
    clock: "manual",
    ...(spec.prefix !== undefined ? { prefix: spec.prefix } : {}),
  });
  return { name, spec, fingerprint: fp };
}

export interface PolicySetOptions {
  readonly label?: string;
  readonly unreplayable?: readonly UnreplayablePolicy[];
}

/** Assemble a content-addressed {@link PolicySet}. Refuses duplicate policy names (an ambiguous set). */
export function policySet(policies: readonly Policy[], options: PolicySetOptions = {}): PolicySet {
  const seen = new Set<string>();
  for (const p of policies) {
    if (seen.has(p.name))
      throw new ThrottleKitError(`policySet: duplicate policy name ${JSON.stringify(p.name)}`, {
        code: "config_invalid",
      });
    seen.add(p.name);
  }
  // A name in BOTH policies[] and unreplayable[] is ambiguous: plan() would emit two diff rows for it
  // and double-count it in the PlanSummary (and falsely trip the fail-closed all-replayable gate).
  for (const u of options.unreplayable ?? []) {
    if (seen.has(u.name))
      throw new ThrottleKitError(
        `policySet: name ${JSON.stringify(u.name)} is in both policies and unreplayable (ambiguous)`,
        { code: "config_invalid" },
      );
    seen.add(u.name);
  }
  const contentHash = hashPolicySet(policies, options.unreplayable);
  return {
    ...(options.label !== undefined ? { label: options.label } : {}),
    policies,
    ...(options.unreplayable !== undefined ? { unreplayable: options.unreplayable } : {}),
    contentHash,
  };
}

export interface PolicySetFromConfigOptions {
  readonly label?: string;
  /** Force a format. Default: auto-detect (text starting with `{`/`[` is JSON, else YAML). */
  readonly format?: "yaml" | "json";
}

/**
 * Build a {@link PolicySet} from `throttlekit/config` text (`.throttlekit.yaml` / `.json`). Reads the
 * `limiters` map as declarative specs — it never instantiates a live limiter (no `Store` needed), so it
 * is safe to run anywhere (CI, a CLI). Only leaf-rate limiters are read; a server config's non-replayable
 * axes are added separately as {@link UnreplayablePolicy}.
 *
 * @experimental Part of the opt-in Policy Plans surface; see STABILITY.md.
 */
export function policySetFromConfig(
  text: string,
  options: PolicySetFromConfigOptions = {},
): PolicySet {
  const trimmed = text.trim();
  const fmt =
    options.format ?? (trimmed.startsWith("{") || trimmed.startsWith("[") ? "json" : "yaml");
  const data: unknown = fmt === "json" ? JSON.parse(text) : parseYaml(text);
  if (data == null || typeof data !== "object" || Array.isArray(data))
    throw new ThrottleKitError("policySetFromConfig: expected an object at the top level", {
      code: "config_invalid",
    });
  const limitersIn = (data as { limiters?: unknown }).limiters;
  if (limitersIn == null || typeof limitersIn !== "object" || Array.isArray(limitersIn))
    throw new ThrottleKitError("policySetFromConfig: missing `limiters` map", {
      code: "config_invalid",
    });
  const defaultPrefix = (data as { defaults?: { prefix?: string } }).defaults?.prefix;
  const policies: Policy[] = [];
  for (const [name, rawSpec] of Object.entries(limitersIn as Record<string, LimiterSpec>)) {
    // Mirror loadConfig's prefix resolution (spec → defaults → name) so the fingerprint reflects the
    // store keyspace the live limiter would use.
    const prefix = rawSpec.prefix ?? defaultPrefix ?? name;
    policies.push(policy(name, { ...rawSpec, prefix }));
  }
  return policySet(policies, options.label !== undefined ? { label: options.label } : {});
}

interface SerializedPolicySet {
  readonly v: typeof POLICY_SET_FORMAT_VERSION;
  readonly label?: string;
  readonly contentHash: string;
  readonly policies: ReadonlyArray<{ readonly name: string; readonly spec: LimiterSpec }>;
  readonly unreplayable?: readonly UnreplayablePolicy[];
}

/** Serialize a {@link PolicySet} to JSON (the fingerprint is re-derived on parse, so it is not stored). */
export function serializePolicySet(set: PolicySet): string {
  const payload: SerializedPolicySet = {
    v: POLICY_SET_FORMAT_VERSION,
    ...(set.label !== undefined ? { label: set.label } : {}),
    contentHash: set.contentHash,
    policies: set.policies.map((p) => ({ name: p.name, spec: p.spec })),
    ...(set.unreplayable !== undefined ? { unreplayable: set.unreplayable } : {}),
  };
  return JSON.stringify(payload);
}

/**
 * Parse a serialized {@link PolicySet}, refusing an incompatible {@link POLICY_SET_FORMAT_VERSION} and a
 * `contentHash` that does not match the rebuilt set (tampered or version-skewed). Each policy's spec is
 * re-validated through {@link policy} (so a malformed spec is refused, not trusted).
 */
export function parsePolicySet(text: string): PolicySet {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ThrottleKitError(`parsePolicySet: not valid JSON: ${(e as Error).message}`, {
      code: "config_invalid",
    });
  }
  if (raw == null || typeof raw !== "object" || Array.isArray(raw))
    throw new ThrottleKitError("parsePolicySet: expected an object", { code: "config_invalid" });
  const r = raw as Record<string, unknown>;
  if (r.v !== POLICY_SET_FORMAT_VERSION)
    throw new ThrottleKitError(
      `parsePolicySet: unsupported format version ${JSON.stringify(r.v)} (this build reads ${POLICY_SET_FORMAT_VERSION}); re-export with the current version`,
      { code: "config_invalid" },
    );
  if (!Array.isArray(r.policies))
    throw new ThrottleKitError("parsePolicySet: `policies` must be an array", {
      code: "config_invalid",
    });
  const policies = r.policies.map((p) => {
    const pp = p as { name?: unknown; spec?: unknown };
    if (typeof pp.name !== "string" || pp.spec == null || typeof pp.spec !== "object")
      throw new ThrottleKitError(
        "parsePolicySet: each policy needs a string name and an object spec",
        {
          code: "config_invalid",
        },
      );
    return policy(pp.name, pp.spec as LimiterSpec);
  });
  const unreplayable = r.unreplayable as readonly UnreplayablePolicy[] | undefined;
  const rebuilt = policySet(policies, {
    ...(typeof r.label === "string" ? { label: r.label } : {}),
    ...(unreplayable !== undefined ? { unreplayable } : {}),
  });
  if (typeof r.contentHash === "string" && r.contentHash !== rebuilt.contentHash)
    throw new ThrottleKitError(
      `parsePolicySet: contentHash mismatch — serialized ${r.contentHash.slice(0, 12)} but rebuilt ${rebuilt.contentHash.slice(0, 12)} (tampered or version-skewed)`,
      { code: "config_invalid" },
    );
  return rebuilt;
}

function hashPolicySet(
  policies: readonly Policy[],
  unreplayable: readonly UnreplayablePolicy[] | undefined,
): string {
  const byName = (a: { name: string }, b: { name: string }): number =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  const canon = {
    policies: [...policies].sort(byName).map((p) => ({ name: p.name, spec: sortKeys(p.spec) })),
    unreplayable: (unreplayable ?? [])
      .slice()
      .sort(byName)
      .map((u) => ({ name: u.name, reason: u.reason })),
  };
  return createHash("sha256").update(JSON.stringify(canon)).digest("hex");
}

/** Canonicalize a spec to a key-sorted plain object (so hash is order-independent), dropping `undefined`. */
function sortKeys(obj: LimiterSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const rec = obj as unknown as Record<string, unknown>;
  for (const k of Object.keys(rec).sort()) {
    if (rec[k] !== undefined) out[k] = rec[k];
  }
  return out;
}
