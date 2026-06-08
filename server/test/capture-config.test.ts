import { describe, expect, it } from "vitest";
import { resolveCaptureConfig } from "../src/capture/config.js";
import { DROP_PLACEHOLDER, createRedactor } from "../src/capture/redact.js";

/**
 * #289 Replay P3 (Phase B) — P3.1: the capture config resolver + the redactor.
 *
 * Capture records PII, so it is **opt-in default-OFF** (the documented exception to available-by-default),
 * a redaction mode is mandatory when enabled, and a durable store mandates AES-256-GCM encryption. These
 * tests pin those fail-fast guarantees and that redaction is deterministic + collision-aware at capture.
 */

const KEY32 = "a".repeat(64); // a 64-hex (32-byte) AES-256 key

describe("#289 P3.1 — capture config resolver", () => {
  it("is OFF unless explicitly enabled (a typo'd flag never silently captures PII)", () => {
    expect(resolveCaptureConfig(undefined).enabled).toBe(false);
    expect(resolveCaptureConfig(null).enabled).toBe(false);
    expect(resolveCaptureConfig({}).enabled).toBe(false);
    expect(resolveCaptureConfig({ enabled: "true" }).enabled).toBe(false); // not the boolean true
    expect(resolveCaptureConfig({ enabled: 1 }).enabled).toBe(false);
  });

  it("requires a redaction mode when enabled", () => {
    expect(() => resolveCaptureConfig({ enabled: true })).toThrow(/redaction: required/);
    expect(() => resolveCaptureConfig({ enabled: true, redaction: { mode: "rot13" } })).toThrow(
      /redaction\.mode: must be one of/,
    );
  });

  it("hmac mode requires a secret (direct or from env)", () => {
    expect(() => resolveCaptureConfig({ enabled: true, redaction: { mode: "hmac" } })).toThrow(
      /hmac mode requires/,
    );
    const direct = resolveCaptureConfig({
      enabled: true,
      redaction: { mode: "hmac", secret: "s3cret" },
    });
    expect(direct.redaction).toEqual({ mode: "hmac", secret: "s3cret" });
    const fromEnv = resolveCaptureConfig(
      { enabled: true, redaction: { mode: "hmac", secretEnv: "TK_CAP_SECRET" } },
      { env: { TK_CAP_SECRET: "envsecret" } },
    );
    expect(fromEnv.redaction.secret).toBe("envsecret");
    expect(() =>
      resolveCaptureConfig(
        { enabled: true, redaction: { mode: "hmac", secretEnv: "TK_CAP_SECRET" } },
        { env: {} },
      ),
    ).toThrow(/env var "TK_CAP_SECRET" is not set/);
  });

  it("per-trace-salt and drop need no secret", () => {
    expect(
      resolveCaptureConfig({ enabled: true, redaction: { mode: "per-trace-salt" } }).enabled,
    ).toBe(true);
    expect(
      resolveCaptureConfig({ enabled: true, redaction: { mode: "drop" } }).redaction.mode,
    ).toBe("drop");
  });

  it("a durable store mandates a valid AES-256 key (no plaintext-on-disk)", () => {
    const base = { enabled: true, redaction: { mode: "drop" } };
    expect(() => resolveCaptureConfig({ ...base, durable: { dir: "/tmp/caps" } })).toThrow(
      /encryption is mandatory/,
    );
    expect(() =>
      resolveCaptureConfig({
        ...base,
        durable: { dir: "/tmp/caps", encryptionKeyHex: "tooshort" },
      }),
    ).toThrow(/64 hex characters/);
    expect(() => resolveCaptureConfig({ ...base, durable: { encryptionKeyHex: KEY32 } })).toThrow(
      /durable\.dir: required/,
    );
    const ok = resolveCaptureConfig({
      ...base,
      durable: { dir: "/tmp/caps", encryptionKeyHex: KEY32.toUpperCase() },
    });
    expect(ok.durable).toEqual({
      dir: "/tmp/caps",
      encryptionKeyHex: KEY32,
      segmentMaxEvents: 10_000,
    });
  });

  it("retention defaults apply and reject non-positive integers", () => {
    const def = resolveCaptureConfig({ enabled: true, redaction: { mode: "drop" } }).retention;
    expect(def).toEqual({ ttlMs: 86_400_000, maxScopes: 1000, ringSize: 10_000 });
    expect(() =>
      resolveCaptureConfig({
        enabled: true,
        redaction: { mode: "drop" },
        retention: { ringSize: 0 },
      }),
    ).toThrow(/ringSize: must be a positive integer/);
  });

  it("tenant rule: declarative whole-key / key-prefix, absent ⇒ counts-only, programmatic overrides", () => {
    const counts = resolveCaptureConfig({ enabled: true, redaction: { mode: "drop" } });
    expect(counts.tenantOf).toBeUndefined(); // counts-only (fail-closed)

    const whole = resolveCaptureConfig({
      enabled: true,
      redaction: { mode: "drop" },
      tenant: { from: "key" },
    });
    expect(whole.tenantOf?.("p", "tenant-7")).toBe("tenant-7");

    const prefix = resolveCaptureConfig({
      enabled: true,
      redaction: { mode: "drop" },
      tenant: { from: "key-prefix", delimiter: ":" },
    });
    expect(prefix.tenantOf?.("p", "acme:user:42")).toBe("acme");
    expect(prefix.tenantOf?.("p", "no-delim")).toBe("no-delim");

    const prog = resolveCaptureConfig(
      { enabled: true, redaction: { mode: "drop" }, tenant: { from: "key" } },
      { tenantOf: () => "fixed" },
    );
    expect(prog.tenantOf?.("p", "anything")).toBe("fixed"); // programmatic wins

    expect(() =>
      resolveCaptureConfig({
        enabled: true,
        redaction: { mode: "drop" },
        tenant: { from: "nope" },
      }),
    ).toThrow(/tenant\.from/);
  });

  it("auth operator secret resolves from env; absent ⇒ no auth (CLI fails closed downstream)", () => {
    const none = resolveCaptureConfig({ enabled: true, redaction: { mode: "drop" } });
    expect(none.auth).toBeUndefined();
    const withAuth = resolveCaptureConfig(
      { enabled: true, redaction: { mode: "drop" }, auth: { operatorSecretEnv: "TK_OP" } },
      { env: { TK_OP: "opcred" } },
    );
    expect(withAuth.auth).toEqual({ operatorSecret: "opcred" });
  });
});

describe("#289 P3.1 — redactor (PII-safe at capture)", () => {
  it("hmac is deterministic, distinct per key, and a full 64-hex digest", () => {
    const r = createRedactor({ mode: "hmac", secret: "k" });
    const a1 = r.redact("1.2.3.4");
    const a2 = r.redact("1.2.3.4");
    const b = r.redact("5.6.7.8");
    expect(a1).toBe(a2); // deterministic
    expect(a1).not.toBe(b); // distinct keys ⇒ distinct refs
    expect(a1).toMatch(/^[0-9a-f]{64}$/); // full digest, never truncated
  });

  it("per-trace-salt is consistent within a redactor but uncorrelated across redactors", () => {
    const r1 = createRedactor({ mode: "per-trace-salt" });
    const r2 = createRedactor({ mode: "per-trace-salt" });
    expect(r1.redact("ip")).toBe(r1.redact("ip")); // stable within the segment
    expect(r1.redact("ip")).not.toBe(r2.redact("ip")); // different salt ⇒ no cross-segment correlation
  });

  it("drop erases identity (every key ⇒ one placeholder) and never trips the collision guard", () => {
    const r = createRedactor({ mode: "drop" });
    expect(r.redact("a")).toBe(DROP_PLACEHOLDER);
    expect(r.redact("b")).toBe(DROP_PLACEHOLDER); // intended merge, no throw
  });

  it("redactSpec redacts the prefix (often a tenant id) and leaves a prefix-less spec untouched", () => {
    const r = createRedactor({ mode: "hmac", secret: "k" });
    const out = r.redactSpec({ strategy: "fixedWindow", limit: 3, windowMs: 1000, prefix: "acme" });
    expect(out.prefix).toBe(r.redact("acme")); // same redactor ⇒ same ref
    expect(out.limit).toBe(3);
    const noPrefix = { strategy: "gcra" as const, limit: 5, periodMs: 1000 };
    expect(r.redactSpec(noPrefix)).toBe(noPrefix); // unchanged (returns the same object)
  });

  it("hmac requires a non-empty secret at construction", () => {
    expect(() => createRedactor({ mode: "hmac" })).toThrow(/requires a non-empty secret/);
    expect(() => createRedactor({ mode: "hmac", secret: "" })).toThrow(
      /requires a non-empty secret/,
    );
  });
});
