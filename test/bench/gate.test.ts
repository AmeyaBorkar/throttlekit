import { describe, expect, it } from "vitest";
import { compareRows, formatTable, makeBaseline } from "../../bench/gate";

/**
 * Pure-function tests for the bench gate. We exercise the comparison + rendering with synthetic
 * rows so we don't pay for an actual ~5s micro-benchmark — and so the gate's regression-detection
 * logic is itself protected by a fast test that doesn't depend on hardware timing.
 */

describe("bench gate — compareRows", () => {
  const baseline = makeBaseline(
    [
      { label: "a", nsPerOp: 100 },
      { label: "b", nsPerOp: 200 },
    ],
    10,
    1_000_000,
  );

  it("marks rows within threshold as ok", () => {
    const out = compareRows(
      [
        { label: "a", nsPerOp: 105 }, // +5% — ok
        { label: "b", nsPerOp: 209 }, // +4.5% — ok
      ],
      baseline,
      1.1,
    );
    expect(out.map((r) => r.status)).toEqual(["ok", "ok"]);
  });

  it("marks a row > threshold as regressed", () => {
    const out = compareRows(
      [
        { label: "a", nsPerOp: 120 }, // +20% — regressed
        { label: "b", nsPerOp: 200 }, // ±0% — ok
      ],
      baseline,
      1.1,
    );
    expect(out[0]?.status).toBe("regressed");
    expect(out[1]?.status).toBe("ok");
  });

  it("marks a row >10% better as improved (ratio < 0.9)", () => {
    const out = compareRows(
      [
        { label: "a", nsPerOp: 80 }, // -20% — improved
        { label: "b", nsPerOp: 195 }, // -2.5% — ok
      ],
      baseline,
      1.1,
    );
    expect(out[0]?.status).toBe("improved");
    expect(out[1]?.status).toBe("ok");
  });

  it("marks a row missing from baseline as new (no false-regression)", () => {
    const out = compareRows(
      [
        { label: "a", nsPerOp: 100 },
        { label: "newRow", nsPerOp: 500 }, // not in baseline
      ],
      baseline,
      1.1,
    );
    expect(out[1]?.status).toBe("new");
    expect(out[1]?.ratio).toBeUndefined();
  });

  it("threshold is exclusive (= threshold counts as ok)", () => {
    const out = compareRows([{ label: "a", nsPerOp: 110 }], baseline, 1.1);
    // 110/100 = 1.1, which is NOT > 1.1, so stays ok.
    expect(out[0]?.status).toBe("ok");
  });
});

describe("bench gate — formatTable", () => {
  it("includes the OK/regressed/new markers and shows the delta sign", () => {
    const baseline = makeBaseline(
      [
        { label: "a", nsPerOp: 100 },
        { label: "b", nsPerOp: 200 },
      ],
      10,
      1_000_000,
    );
    const rows = compareRows(
      [
        { label: "a", nsPerOp: 120 }, // +20% — regressed
        { label: "b", nsPerOp: 170 }, // -15% — improved (ratio < 0.9)
        { label: "c", nsPerOp: 50 }, // new
      ],
      baseline,
      1.1,
    );
    const out = formatTable(rows);
    // The success/regression/new markers are stable; downstream CI can grep for ✗.
    expect(out).toContain("✗");
    expect(out).toContain("↓");
    expect(out).toContain("?");
    // Delta sign present + magnitude.
    expect(out).toContain("+20.0%");
    expect(out).toContain("-15.0%");
  });
});

describe("bench gate — makeBaseline shape", () => {
  it("captures provenance + the rows passed in", () => {
    const b = makeBaseline([{ label: "x", nsPerOp: 42 }], 5, 1_000_000);
    expect(b.schemaVersion).toBe(1);
    expect(b.rows).toEqual([{ label: "x", nsPerOp: 42 }]);
    expect(b.runs).toBe(5);
    expect(b.iters).toBe(1_000_000);
    expect(b.recorded.at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof b.recorded.node).toBe("string");
    expect(typeof b.recorded.platform).toBe("string");
  });
});
