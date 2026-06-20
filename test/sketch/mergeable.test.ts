import { describe, expect, it } from "vitest";
import { mergeableSketch, sketchSnapshotFromBytes } from "../../src/sketch";

/**
 * The mergeable sketch's defining property: because plain Count-Min Sketch counters are linear,
 * summing per-node sketches yields *exactly* the sketch of the union of their streams. These tests
 * pin that exactness, the byte round-trip, the never-underestimate guarantee, and the error bound.
 */

function build(adds: Array<[string, number]>) {
  const s = mergeableSketch({ epsilon: 0.05, delta: 0.01 });
  for (const [k, n] of adds) s.add(k, n);
  return s;
}

describe("mergeableSketch", () => {
  it("merge is exact: per-node sketches sum to the union sketch, counter-for-counter", () => {
    const a = build([
      ["x", 3],
      ["y", 1],
      ["z", 5],
    ]);
    const b = build([
      ["x", 2],
      ["w", 4],
      ["y", 7],
    ]);
    // A single sketch over the concatenation of both streams.
    const union = build([
      ["x", 3],
      ["y", 1],
      ["z", 5],
      ["x", 2],
      ["w", 4],
      ["y", 7],
    ]);

    a.merge(b.snapshot());

    expect(Array.from(a.snapshot().counters)).toEqual(Array.from(union.snapshot().counters));
    expect(a.total).toBe(union.total);
    for (const k of ["x", "y", "z", "w"]) expect(a.estimate(k)).toBe(union.estimate(k));
  });

  it("never underestimates the true global count", () => {
    const a = build([
      ["hot", 100],
      ["mid", 10],
    ]);
    const b = build([
      ["hot", 50],
      ["cold", 1],
    ]);
    a.merge(b.snapshot());
    expect(a.estimate("hot")).toBeGreaterThanOrEqual(150);
    expect(a.estimate("mid")).toBeGreaterThanOrEqual(10);
    expect(a.estimate("cold")).toBeGreaterThanOrEqual(1);
    expect(a.estimate("never-seen")).toBeGreaterThanOrEqual(0);
  });

  it("serializes to bytes and back, preserving the merge", () => {
    const a = build([
      ["x", 3],
      ["y", 9],
    ]);
    const b = build([
      ["x", 2],
      ["z", 4],
    ]);

    const snap = sketchSnapshotFromBytes(b.toBytes());
    expect(Array.from(snap.counters)).toEqual(Array.from(b.snapshot().counters));
    expect(snap.total).toBe(b.total);

    // Merging the decoded snapshot is identical to merging the live one.
    const viaBytes = build([
      ["x", 3],
      ["y", 9],
    ]);
    viaBytes.merge(snap);
    a.merge(b.snapshot());
    expect(Array.from(viaBytes.snapshot().counters)).toEqual(Array.from(a.snapshot().counters));
  });

  it("keeps a merged estimate within the epsilon*N bound", () => {
    const a = mergeableSketch({ epsilon: 0.01, delta: 0.001 });
    const b = mergeableSketch({ epsilon: 0.01, delta: 0.001 });
    for (let i = 0; i < 500; i++) a.add(`a-${i}`, 1);
    for (let i = 0; i < 500; i++) b.add(`b-${i}`, 1);
    a.add("heavy", 50);
    b.add("heavy", 50);
    a.merge(b.snapshot());

    const est = a.estimate("heavy");
    expect(est).toBeGreaterThanOrEqual(100); // never underestimates the true 100
    expect(est).toBeLessThanOrEqual(100 + 0.01 * a.total); // within epsilon*N
  });

  it("refuses to merge sketches of different dimensions", () => {
    const a = mergeableSketch({ epsilon: 0.01 });
    const b = mergeableSketch({ epsilon: 0.2 }); // a different width
    expect(() => a.merge(b.snapshot())).toThrow(/cannot merge/);
  });

  it("refuses to merge a snapshot whose counters array is shorter than width*depth (regression)", () => {
    // The dimension guard checked only the width/depth scalar fields, so a snapshot with matching
    // fields but a too-short counters array slipped through; the merge loop then dereferenced b[i]
    // past the source's end (undefined), and a[i]+undefined = NaN stored into a Uint32Array silently
    // zeroed every tail counter — collapsing a heavy hitter's estimate below its true count (an
    // underestimate, the unsafe direction). Fail closed instead.
    const s = mergeableSketch();
    s.add("heavy", 50);
    const before = s.estimate("heavy");
    const { width, depth } = s.snapshot();
    expect(() => s.merge({ width, depth, total: 0, counters: new Uint32Array(2) })).toThrow(
      /counters|length/,
    );
    // The target sketch must be untouched (no silent corruption of the heavy hitter).
    expect(s.estimate("heavy")).toBe(before);
  });

  it("rejects malformed bytes", () => {
    expect(() => sketchSnapshotFromBytes(new Uint8Array(4))).toThrow(/too short/);
    const ok = mergeableSketch({ epsilon: 0.1 }).toBytes();
    expect(() => sketchSnapshotFromBytes(ok.subarray(0, ok.length - 4))).toThrow(/length mismatch/);
  });

  it("saturates a counter at 2^32-1 on add instead of wrapping below the true count (regression)", () => {
    const s = mergeableSketch();
    s.add("k", 2_000_000_000);
    expect(s.estimate("k")).toBe(2_000_000_000);
    s.add("k", 3_000_000_000); // 5e9 > 2^32-1 → must saturate, not wrap to ~705M
    expect(s.estimate("k")).toBe(0xffffffff); // never underestimates (was 1_705_032_704 when it wrapped)
  });

  it("saturates on merge instead of wrapping below the true union count (regression)", () => {
    const n1 = mergeableSketch();
    const n2 = mergeableSketch();
    n1.add("attacker", 2_500_000_000);
    n2.add("attacker", 2_500_000_000);
    const g = mergeableSketch();
    g.merge(n1.snapshot());
    g.merge(n2.snapshot()); // 5e9 > 2^32-1 → saturate, so a heavy hitter stays detectable
    expect(g.estimate("attacker")).toBe(0xffffffff); // not wrapped down to ~705M
  });

  it("rejects a fractional or negative add count instead of corrupting the sketch (regression)", () => {
    const s = mergeableSketch();
    // Fractional used to truncate the counter (2) while `total` carried 2.7 — table/total desync.
    expect(() => s.add("b", 2.7)).toThrow(RangeError);
    // Negative used to wrap the Uint32 counter to ~2^32 and drive `total` negative.
    expect(() => s.add("c", -10)).toThrow(RangeError);
    expect(s.total).toBe(0); // nothing was applied
  });
});
