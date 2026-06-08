import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRedactor } from "../src/capture/redact.js";
import { wireCapture } from "../src/capture/wire.js";

/**
 * #289 Replay P3 (Phase B) — P3.5 (wire): the one-call composition. Disabled by default (the plain
 * service, untouched). Enabled ⇒ the service is capture-wrapped, every policy is registered (leaf-rate
 * carries a forensic spec), decisions are recorded, and a durable block additionally yields the encrypted
 * store + audit + flush loop. JSON configs (parsed by the same loader the server uses).
 */

const plainCfg = JSON.stringify({
  limiters: { api: { strategy: "fixedWindow", limit: 3, period: "1s" } },
});

const enabledCfg = JSON.stringify({
  limiters: { api: { strategy: "fixedWindow", limit: 3, period: "1s" } },
  capture: {
    enabled: true,
    redaction: { mode: "hmac", secret: "s" },
    tenant: { from: "key-prefix", delimiter: ":" },
  },
});

describe("#289 P3.5 — wireCapture", () => {
  it("is disabled by default: the plain service, recorder inert, no flush", async () => {
    const w = wireCapture(plainCfg, {}, "open");
    expect(w.config.enabled).toBe(false);
    expect(w.recorder.enabled).toBe(false);
    expect(w.flush).toBeUndefined();
    expect(await w.service.check("api", "acme:u1")).toMatchObject({ allowed: true });
    expect(w.recorder.segments()).toEqual([]);
  });

  it("enabled: wraps the service, registers leaf-rate policies, records decisions", async () => {
    const w = wireCapture(enabledCfg, {}, "open");
    expect(w.recorder.enabled).toBe(true);
    await w.service.check("api", "acme:u1");
    await w.service.check("api", "acme:u2");
    await w.service.check("api", "beta:u1");

    const segs = w.recorder.segments();
    const acme = segs.find(
      (s) => s.scope === createRedactor({ mode: "hmac", secret: "s" }).redact("acme"),
    );
    expect(acme?.scope).not.toBe("acme"); // tenant redacted
    expect(acme?.policy).toBe("api");
    expect(acme?.policyKind).toBe("rate"); // registered as leaf-rate
    expect(acme?.count).toBe(2);
    expect(acme?.spec?.strategy).toBe("fixedWindow"); // registered forensic spec
    expect(acme?.clock).toBe("system"); // live capture ⇒ forensic
    expect(w.flush).toBeUndefined(); // no durable block
  });

  it("the wrapped service still enforces the real limit (capture is a tail, not a filter)", async () => {
    const w = wireCapture(enabledCfg, {}, "open");
    // fixedWindow limit 3 on one key ⇒ 3 allow then deny
    const outcomes: boolean[] = [];
    for (let i = 0; i < 5; i++) outcomes.push((await w.service.check("api", "x:u")).allowed);
    expect(outcomes).toEqual([true, true, true, false, false]);
  });
});

describe("#289 P3.5 — wireCapture durable composition", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tk-wire-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("a durable block yields store + audit + flush, and flush persists segments", async () => {
    const cfg = JSON.stringify({
      limiters: { api: { strategy: "fixedWindow", limit: 3, period: "1s" } },
      capture: {
        enabled: true,
        redaction: { mode: "drop" },
        tenant: { from: "key" },
        durable: { dir: join(dir, "seg"), encryptionKeyHex: "a".repeat(64) },
      },
    });
    const w = wireCapture(cfg, {}, "open");
    expect(w.store).toBeDefined();
    expect(w.audit).toBeDefined();
    expect(w.flush).toBeDefined();

    await w.service.check("api", "tenant-1");
    const result = await w.flush?.flushOnce();
    expect(result?.written).toBe(1);
    expect((await w.store?.list())?.length).toBe(1);
  });
});
