import { describe, expect, it } from "vitest";
import { compareRows, formatTable, makeBaseline, referenceOp } from "../../bench/gate";

/**
 * Pure-function tests for the bench gate. We exercise the comparison + rendering with synthetic
 * rows so we don't pay for an actual micro-benchmark — and so the gate's regression-detection
 * logic is itself protected by a fast test that doesn't depend on hardware timing.
 *
 * The v2 gate compares the machine-independent `relative` metric (nsPerOp / referenceNsPerOp),
 * NOT absolute ns. The two load-bearing tests below pin that property: a row stays "ok" when only
 * the machine speed changed, and flips to "regressed" when the *relative* cost grew even if the
 * absolute ns fell. `nsPerOp` is carried for humans only and set independently of `relative` here
 * to prove the gate never reads it.
 */

const baseline = makeBaseline(
  [
    { label: "a", nsPerOp: 100, relative: 2.0 },
    { label: "b", nsPerOp: 200, relative: 4.0 },
  ],
  50, // referenceNsPerOp on the recording machine
  10,
  1_000_000,
);

describe("bench gate — compareRows (relative metric)", () => {
  it("marks rows within threshold as ok", () => {
    const out = compareRows(
      [
        { label: "a", nsPerOp: 105, relative: 2.1 }, // +5% relative — ok
        { label: "b", nsPerOp: 209, relative: 4.18 }, // +4.5% — ok
      ],
      baseline,
      1.1,
    );
    expect(out.map((r) => r.status)).toEqual(["ok", "ok"]);
  });

  it("marks a row > threshold as regressed", () => {
    const out = compareRows(
      [
        { label: "a", nsPerOp: 120, relative: 2.4 }, // +20% relative — regressed
        { label: "b", nsPerOp: 200, relative: 4.0 }, // ±0% — ok
      ],
      baseline,
      1.1,
    );
    expect(out[0]?.status).toBe("regressed");
    expect(out[1]?.status).toBe("ok");
  });

  it("marks a row >10% better as improved (relative ratio < 0.9)", () => {
    const out = compareRows(
      [{ label: "a", nsPerOp: 80, relative: 1.6 }], // -20% relative — improved
      baseline,
      1.1,
    );
    expect(out[0]?.status).toBe("improved");
  });

  it("marks a row missing from baseline as new (no false-regression)", () => {
    const out = compareRows(
      [
        { label: "a", nsPerOp: 100, relative: 2.0 },
        { label: "newRow", nsPerOp: 500, relative: 10 }, // not in baseline
      ],
      baseline,
      1.1,
    );
    expect(out[1]?.status).toBe("new");
    expect(out[1]?.ratio).toBeUndefined();
  });

  it("threshold is exclusive (= threshold counts as ok)", () => {
    const out = compareRows([{ label: "a", nsPerOp: 110, relative: 2.2 }], baseline, 1.1);
    // 2.2/2.0 = 1.1, which is NOT > 1.1, so stays ok.
    expect(out[0]?.status).toBe("ok");
  });

  it("is machine-independent: a 2× slower runner with identical relative cost stays ok", () => {
    const out = compareRows(
      [
        { label: "a", nsPerOp: 200, relative: 2.0 }, // 2× the absolute ns, SAME relative cost
        { label: "b", nsPerOp: 400, relative: 4.0 },
      ],
      baseline,
      1.1,
    );
    expect(out.map((r) => r.status)).toEqual(["ok", "ok"]);
    expect(out[0]?.ratio).toBeCloseTo(1.0);
  });

  it("catches a relative regression even when the machine got faster in absolute ns", () => {
    const out = compareRows(
      [{ label: "a", nsPerOp: 90, relative: 2.6 }], // fewer ns than baseline's 100, but +30% relative
      baseline,
      1.1,
    );
    expect(out[0]?.status).toBe("regressed");
  });
});

describe("bench gate — formatTable", () => {
  it("includes the OK/regressed/new markers and shows the relative delta sign", () => {
    const rows = compareRows(
      [
        { label: "a", nsPerOp: 120, relative: 2.4 }, // +20% — regressed
        { label: "b", nsPerOp: 170, relative: 3.4 }, // -15% — improved (ratio < 0.9)
        { label: "c", nsPerOp: 50, relative: 1.0 }, // new
      ],
      baseline,
      1.1,
    );
    const out = formatTable(rows);
    // The success/regression/new markers are stable; downstream CI can grep for ✗.
    expect(out).toContain("✗");
    expect(out).toContain("↓");
    expect(out).toContain("?");
    // Relative delta sign present + magnitude.
    expect(out).toContain("+20.0%");
    expect(out).toContain("-15.0%");
  });
});

describe("bench gate — makeBaseline shape", () => {
  it("captures provenance, the reference denominator + the rows passed in", () => {
    const b = makeBaseline([{ label: "x", nsPerOp: 42, relative: 1.5 }], 28, 5, 1_000_000);
    expect(b.schemaVersion).toBe(2);
    expect(b.rows).toEqual([{ label: "x", nsPerOp: 42, relative: 1.5 }]);
    expect(b.referenceNsPerOp).toBe(28);
    expect(b.runs).toBe(5);
    expect(b.iters).toBe(1_000_000);
    expect(b.recorded.at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof b.recorded.node).toBe("string");
    expect(typeof b.recorded.platform).toBe("string");
  });
});

describe("bench gate — referenceOp", () => {
  it("returns a callable that mutates state and yields a number (anti-DCE)", () => {
    const op = referenceOp();
    expect(typeof op()).toBe("number");
    expect(typeof op()).toBe("number");
  });
});
