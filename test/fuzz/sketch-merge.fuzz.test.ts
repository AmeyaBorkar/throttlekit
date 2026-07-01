import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type SketchSnapshot, mergeableSketch, sketchSnapshotFromBytes } from "../../src/sketch";

/**
 * FUZZ — the cross-node sketch-merge boundary (`src/sketch/index.ts`). Untrusted surface: the bytes
 * a PEER ships for a cluster-wide Count-Min Sketch merge. A malicious peer controls those bytes, so
 * `sketchSnapshotFromBytes` (the wire decoder) and `MergeableSketch.merge` (the folder) are a
 * poisoning vector.
 *
 * SAFETY CONTRACT: random/corrupt snapshot bytes → a bounded merge with no crash and no unbounded
 * allocation; the decode either yields a structurally-valid snapshot or throws; and after any
 * accepted merge the sketch stays valid — counters remain in `[0, 2^32-1]`, the never-underestimate
 * guarantee holds (no previously-seen key's estimate DECREASES), and the reported `total` stays a
 * finite, non-negative number.
 */

const MAX_U32 = 0xffffffff;
const HEADER_BYTES = 16;

/** Build a well-formed byte buffer for a `width x depth` sketch with the given counters + total. */
function encode(width: number, depth: number, total: number, counters: number[]): Uint8Array {
  const buf = new ArrayBuffer(HEADER_BYTES + width * depth * 4);
  const dv = new DataView(buf);
  dv.setUint32(0, width, true);
  dv.setUint32(4, depth, true);
  dv.setFloat64(8, total, true);
  for (let i = 0; i < counters.length; i++)
    dv.setUint32(HEADER_BYTES + i * 4, counters[i]! >>> 0, true);
  return new Uint8Array(buf);
}

describe("fuzz: cross-node sketch merge boundary", () => {
  it("sketchSnapshotFromBytes: random bytes → a structurally-valid snapshot or a clean throw", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 512 }), (bytes) => {
        let snap: SketchSnapshot;
        try {
          snap = sketchSnapshotFromBytes(bytes);
        } catch (err) {
          expect(err).toBeInstanceOf(Error); // "too short" / "length mismatch"
          return;
        }
        // A returned snapshot must be internally consistent and bounded by the input length.
        expect(snap.counters).toBeInstanceOf(Uint32Array);
        expect(snap.counters.length).toBe(snap.width * snap.depth);
        expect(snap.counters.length).toBeLessThanOrEqual((bytes.byteLength - HEADER_BYTES) / 4);
        for (const c of snap.counters) expect(c).toBeLessThanOrEqual(MAX_U32);
        // Deterministic decode.
        const again = sketchSnapshotFromBytes(bytes);
        expect(Array.from(again.counters)).toEqual(Array.from(snap.counters));
      }),
      { numRuns: 1500 },
    );
  });

  it("merging a peer's arbitrary COUNTERS never underestimates and keeps counters valid", () => {
    // Small explicit dims keep each run cheap; the receiver shares them so the merge is accepted.
    const opts = { epsilon: 0.2, delta: 0.1 };
    const template = mergeableSketch(opts).toBytes();
    const nCounters = (template.byteLength - HEADER_BYTES) / 4;
    const dv0 = new DataView(template.buffer, template.byteOffset, template.byteLength);
    const width = dv0.getUint32(0, true);
    const depth = dv0.getUint32(4, true);

    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: MAX_U32 }), {
          minLength: nCounters,
          maxLength: nCounters,
        }),
        fc.array(fc.tuple(fc.string({ maxLength: 8 }), fc.integer({ min: 1, max: 1_000_000 })), {
          maxLength: 8,
        }),
        (peerCounters, seed) => {
          const recv = mergeableSketch(opts);
          for (const [k, n] of seed) recv.add(k, n);
          const before = seed.map(([k]) => recv.estimate(k));

          const snap = sketchSnapshotFromBytes(encode(width, depth, 0, peerCounters));
          recv.merge(snap);

          for (const c of recv.snapshot().counters) expect(c).toBeLessThanOrEqual(MAX_U32);
          // Never-underestimate: a merge only ADDS mass, so no known key's estimate may drop.
          seed.forEach(([k], i) => expect(recv.estimate(k)).toBeGreaterThanOrEqual(before[i]!));
        },
      ),
      { numRuns: 400 },
    );
  });

  it("a well-formed snapshot with mismatched dims fails closed on merge", () => {
    const recv = mergeableSketch();
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 6 }), fc.integer({ min: 1, max: 4 }), (w, d) => {
        const snap = sketchSnapshotFromBytes(encode(w, d, 0, new Array(w * d).fill(0)));
        const recvDims = recv.snapshot();
        if (w === recvDims.width && d === recvDims.depth) {
          expect(() => recv.merge(snap)).not.toThrow();
        } else {
          expect(() => recv.merge(snap)).toThrow(/cannot merge|counters|length/);
        }
      }),
      { numRuns: 300 },
    );
  });

  /**
   * FINDING F1 (marked, NOT fixed) — a peer's poisoned float64 `total` corrupts the merged total.
   *
   * `sketchSnapshotFromBytes` reads `total` with `DataView.getFloat64` and performs NO validation, and
   * `CountMinSketch.mergeSnapshot` folds it in with an unguarded `this.#total += snap.total`. A
   * malicious peer can therefore set `total` to `NaN`, `-1e18`, or `Infinity` and drive the receiver's
   * cluster-wide `total` (the `N` in the sketch's `epsilon·N` accuracy bound) to a non-finite or
   * negative value. Counters and per-key estimates stay safe (the merge saturates and never
   * underestimates), so this is not an over-admit — but any consumer that sheds on a
   * `threshold = epsilon * total` computation gets a poisoned threshold. Fix belongs in the abuse-guards
   * follow-up (validate `total` is a finite non-negative number on decode/merge).
   *
   * `it.fails` keeps the suite green while pinning the bug; it flips to RED once `total` is validated.
   *
   * Minimal deterministic reproduction (assertion states the DESIRED finite, non-negative total):
   */
  it.fails(
    "FINDING F1: a peer's poisoned float64 `total` (NaN) corrupts the merged sketch total",
    () => {
      const recv = mergeableSketch();
      recv.add("legit", 10);
      const template = mergeableSketch().toBytes(); // matching dims so the merge is accepted
      const poisoned = template.slice();
      new DataView(poisoned.buffer, poisoned.byteOffset, poisoned.byteLength).setFloat64(
        8,
        Number.NaN,
        true,
      );

      const snap = sketchSnapshotFromBytes(poisoned);
      recv.merge(snap);

      // DESIRED: total stays a finite, non-negative number. ACTUAL: NaN — so these assertions fail.
      expect(Number.isFinite(recv.total)).toBe(true);
      expect(recv.total).toBeGreaterThanOrEqual(0);
    },
  );
});
