import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSegmentStore } from "../src/capture/store.js";
import type { CaptureSegment, DurableConfig, RetentionConfig } from "../src/capture/types.js";

/**
 * #289 Replay P3 (Phase B) — P3.3: the durable AES-256-GCM segment store. The security-critical phase:
 * no plaintext on disk (the scope/key/spec never appear unencrypted), GCM tamper-detection (a modified
 * or wrong-key blob fails the read, never returns junk), TTL enforced at write AND read, and no PII in
 * filenames. Real filesystem I/O in a per-test temp dir.
 */

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

function sampleSegment(createdAt = 1000): CaptureSegment {
  return {
    policy: "api",
    policyKind: "rate",
    scope: "acme-corp", // a known plaintext we assert never lands on disk
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
        keyRef: "deadbeef".repeat(8),
        cost: 1,
        at: createdAt,
        decision: { allowed: true, limit: 3, remaining: 2, resetAt: 2000, retryAfterMs: 0 },
      },
    ],
  };
}

describe("#289 P3.3 — durable AES-256-GCM segment store", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tk-cap-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // A fixed clock at 1000 so the toy `createdAt`s below are "recent" (the real store clock is Date.now()).
  const FIXED = { now: () => 1000 };
  function makeStore(clock: { now(): number } = FIXED, ttlMs = 86_400_000) {
    const durable: DurableConfig = { dir, encryptionKeyHex: KEY_A, segmentMaxEvents: 1000 };
    const retention: RetentionConfig = { ttlMs, maxScopes: 100, ringSize: 100 };
    return createSegmentStore(durable, retention, { clock });
  }

  it("round-trips a segment through encryption", async () => {
    const s = makeStore();
    const id = await s.write(sampleSegment());
    expect(await s.read(id)).toEqual(sampleSegment());
  });

  it("writes only ciphertext — no plaintext scope / key / spec on disk", async () => {
    const s = makeStore();
    await s.write(sampleSegment());
    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^seg-1000-[0-9a-f]+\.bin$/); // no PII in the filename
    const bytes = await readFile(join(dir, files[0] as string));
    expect(bytes.includes(Buffer.from("acme-corp"))).toBe(false); // scope sealed
    expect(bytes.includes(Buffer.from("fixedWindow"))).toBe(false); // spec sealed
    expect(bytes.includes(Buffer.from("deadbeef"))).toBe(false); // keyRef sealed
  });

  it("detects tampering — a flipped ciphertext byte fails the GCM auth check", async () => {
    const s = makeStore();
    const id = await s.write(sampleSegment());
    const path = join(dir, id);
    const buf = await readFile(path);
    buf[buf.length - 1] = buf[buf.length - 1]! ^ 0xff; // corrupt one byte
    await writeFile(path, buf);
    await expect(s.read(id)).rejects.toThrow();
  });

  it("refuses a truncated blob with a clear error (before GCM, which would also catch it)", async () => {
    const s = makeStore();
    const id = await s.write(sampleSegment());
    await writeFile(join(dir, id), Buffer.from([1, 2, 3])); // shorter than iv+tag
    await expect(s.read(id)).rejects.toThrow(/corrupt/);
  });

  it("a wrong key cannot decrypt", async () => {
    const s = makeStore();
    const id = await s.write(sampleSegment());
    const wrong = createSegmentStore(
      { dir, encryptionKeyHex: KEY_B, segmentMaxEvents: 1000 },
      { ttlMs: 86_400_000, maxScopes: 100, ringSize: 100 },
      { clock: FIXED }, // same clock ⇒ the failure is decryption, not TTL
    );
    await expect(wrong.read(id)).rejects.toThrow();
  });

  it("refuses a past-TTL segment on read WITHOUT deleting it (only sweep deletes)", async () => {
    let now = 1000;
    const s = makeStore({ now: () => now }, 5000);
    const id = await s.write(sampleSegment(1000));
    now = 7000; // > 1000 + 5000 ⇒ expired
    await expect(s.read(id)).rejects.toThrow(/past its TTL/);
    expect(await s.list()).toHaveLength(1); // read did NOT purge — a read-only action never deletes
    expect(await s.sweep()).toBe(1); // sweep is the only deleter
    expect(await s.list()).toHaveLength(0);
  });

  it("sweep purges past-TTL segments; write sweeps first", async () => {
    let now = 1000;
    const s = makeStore({ now: () => now }, 5000);
    await s.write(sampleSegment(1000));
    expect(await s.list()).toHaveLength(1);
    now = 7000;
    expect(await s.sweep()).toBe(1);
    expect(await s.list()).toHaveLength(0);
  });

  it("list returns refs sorted by createdAt without decrypting", async () => {
    const s = makeStore();
    await s.write(sampleSegment(3000));
    await s.write(sampleSegment(1000));
    await s.write(sampleSegment(2000));
    expect((await s.list()).map((r) => r.createdAt)).toEqual([1000, 2000, 3000]);
  });
});
