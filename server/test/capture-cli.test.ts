import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuditLog } from "../src/capture/audit.js";
import { type CaptureCliDeps, runCaptureCli } from "../src/capture/cli.js";
import { createSegmentStore } from "../src/capture/store.js";
import type { CaptureConfig, CaptureSegment } from "../src/capture/types.js";

/**
 * #289 Replay P3 (Phase B) — P3.4: the append-only audit log + the fail-closed audited admin CLI. The
 * server has no auth to inherit, so the CLI BUILDS it: no credential configured ⇒ disabled; wrong
 * credential ⇒ unauthorized (no action, no audit); every authorized action appends one audit record.
 * `export` decrypts and projects a leaf-rate segment to the downstream-replayable trace.
 */

const KEY = "a".repeat(64);
const FIXED = { now: () => 5000 };

function leafSegment(scope: string, createdAt = 5000): CaptureSegment {
  return {
    policy: "api",
    policyKind: "rate",
    scope,
    createdAt,
    redactionMode: "hmac",
    clock: "system",
    count: 1,
    dropped: 0,
    spec: { strategy: "fixedWindow", limit: 3, windowMs: 1000 },
    strategy: { name: "fixedWindow", limit: 3, windowMs: 1000, ttlMs: 1000 },
    luaSha1: null,
    events: [
      {
        keyRef: "ab".repeat(32),
        cost: 1,
        at: createdAt,
        decision: { allowed: true, limit: 3, remaining: 2, resetAt: 6000, retryAfterMs: 0 },
      },
    ],
  };
}

function nonLeafSegment(): CaptureSegment {
  return {
    policy: "conc",
    policyKind: "admitter",
    scope: "beta",
    createdAt: 5000,
    redactionMode: "hmac",
    clock: "system",
    count: 1,
    dropped: 0,
    events: [
      {
        keyRef: "cd".repeat(32),
        cost: 1,
        at: 5000,
        decision: { allowed: false, limit: 5, remaining: 0, resetAt: 0, retryAfterMs: 100 },
      },
    ],
  };
}

describe("#289 P3.4 — audit log", () => {
  let path: string;
  beforeEach(async () => {
    path = join(await mkdtemp(join(tmpdir(), "tk-audit-")), "audit.jsonl");
  });
  afterEach(async () => {
    await rm(join(path, ".."), { recursive: true, force: true });
  });

  it("appends records and reads them back (oldest first); missing log ⇒ []", async () => {
    const a = createAuditLog(path);
    expect(await a.read()).toEqual([]);
    await a.append({ ts: 1, principal: "op", action: "list" });
    await a.append({ ts: 2, principal: "op", action: "export", policy: "api", tenant: "acme" });
    const records = await a.read();
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({ ts: 1, principal: "op", action: "list" });
    expect(records[1]?.action).toBe("export");
  });

  it("is append-only on disk (JSONL) and skips a corrupt tail line", async () => {
    const a = createAuditLog(path);
    await a.append({ ts: 1, principal: "op", action: "sweep" });
    const raw = await readFile(path, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.split("\n").filter(Boolean)).toHaveLength(1);
    const { appendFile } = await import("node:fs/promises");
    await appendFile(path, "{not json\n"); // a torn write
    expect(await a.read()).toHaveLength(1); // the good record survives, the corrupt line is skipped
  });

  it("creates a missing parent directory on the first append (audit can precede any segment write)", async () => {
    const nested = join(path, "..", "does-not-exist-yet", "audit.jsonl");
    const a = createAuditLog(nested);
    await a.append({ ts: 1, principal: "op", action: "list" }); // would ENOENT without the mkdir
    expect(await a.read()).toHaveLength(1);
  });
});

describe("#289 P3.4 — fail-closed audited CLI", () => {
  let dir: string;
  let deps: (config: CaptureConfig) => CaptureCliDeps;
  let auditPath: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tk-cli-"));
    auditPath = join(dir, "audit.jsonl");
    deps = (config: CaptureConfig) => ({
      config,
      store: createSegmentStore(
        { dir: join(dir, "seg"), encryptionKeyHex: KEY, segmentMaxEvents: 1000 },
        { ttlMs: 86_400_000, maxScopes: 100, ringSize: 100 },
        { clock: FIXED },
      ),
      audit: createAuditLog(auditPath),
      clock: FIXED,
    });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const enabled: CaptureConfig = {
    enabled: true,
    redaction: { mode: "hmac", secret: "k" },
    retention: { ttlMs: 86_400_000, maxScopes: 100, ringSize: 100 },
    auth: { operatorSecret: "s3cret-op" },
  };
  const noAuth: CaptureConfig = { ...enabled, auth: undefined };

  it("is disabled (fail-closed) when no operator credential is configured", async () => {
    const d = deps(noAuth);
    const res = await runCaptureCli({ action: "list", credential: "anything" }, d);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/disabled.*fail-closed/);
    expect(await d.audit.read()).toEqual([]); // no audit on a fail-closed attempt
  });

  it("rejects a missing or wrong credential (no action, no audit)", async () => {
    const d = deps(enabled);
    expect((await runCaptureCli({ action: "list" }, d)).error).toMatch(/credential is required/);
    const wrong = await runCaptureCli({ action: "list", credential: "wrong" }, d);
    expect(wrong.ok).toBe(false);
    expect(wrong.error).toMatch(/invalid operator credential/);
    expect(await d.audit.read()).toEqual([]);
  });

  it("lists segments with decrypted metadata and audits the action", async () => {
    const d = deps(enabled);
    const id = await d.store.write(leafSegment("acme"));
    const res = await runCaptureCli(
      { action: "list", credential: "s3cret-op", principal: "alice" },
      d,
    );
    expect(res.ok).toBe(true);
    const rows = res.output as Array<{ id: string; policy?: string; replayable?: boolean }>;
    expect(rows[0]?.id).toBe(id);
    expect(rows[0]?.policy).toBe("api");
    expect(rows[0]?.replayable).toBe(true);
    const audit = await d.audit.read();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ principal: "alice", action: "list" });
  });

  it("exports a leaf-rate segment as a downstream-replayable trace + audits policy/tenant", async () => {
    const d = deps(enabled);
    const id = await d.store.write(leafSegment("acme"));
    const res = await runCaptureCli({ action: "export", id, credential: "s3cret-op" }, d);
    expect(res.ok).toBe(true);
    const out = res.output as {
      kind: string;
      trace?: { version: number; fingerprint: { clock: string } };
    };
    expect(out.kind).toBe("replay-trace");
    expect(out.trace?.version).toBe(1);
    expect(out.trace?.fingerprint.clock).toBe("system");
    expect((await d.audit.read())[0]).toMatchObject({
      action: "export",
      policy: "api",
      tenant: "acme",
      redactionMode: "hmac",
    });
  });

  it("exports a non-leaf segment as forensic-only (not a replayable trace)", async () => {
    const d = deps(enabled);
    const id = await d.store.write(nonLeafSegment());
    const res = await runCaptureCli({ action: "export", id, credential: "s3cret-op" }, d);
    const out = res.output as { kind: string };
    expect(out.kind).toBe("forensic");
  });

  it("list flags a tampered/undecryptable segment as unreadable (metadata omitted)", async () => {
    const d = deps(enabled);
    const id = await d.store.write(leafSegment("acme"));
    const segPath = join(dir, "seg", id);
    const buf = await readFile(segPath);
    buf[buf.length - 1] = buf[buf.length - 1]! ^ 0xff; // corrupt the blob
    await writeFile(segPath, buf);
    const res = await runCaptureCli({ action: "list", credential: "s3cret-op" }, d);
    const rows = res.output as Array<{ id: string; unreadable?: boolean; policy?: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.unreadable).toBe(true);
    expect(rows[0]?.policy).toBeUndefined(); // decrypted metadata omitted
  });

  it("export without an id errors; sweep returns the purge count and audits", async () => {
    const d = deps(enabled);
    expect((await runCaptureCli({ action: "export", credential: "s3cret-op" }, d)).error).toMatch(
      /requires a segment id/,
    );
    const res = await runCaptureCli({ action: "sweep", credential: "s3cret-op" }, d);
    expect(res.output).toEqual({ purged: 0 });
    expect((await d.audit.read()).some((r) => r.action === "sweep")).toBe(true);
  });
});
