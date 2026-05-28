/**
 * TK-903 unit tests — `staticPartition()` correctness + end-to-end behavior.
 *
 * Verifies:
 * - Sum-preservation: Σ slices === globalLimit (the remainder-distribution rule)
 * - Input validation: empty regions, globalLimit < K, duplicate regions
 * - Deterministic ordering: earlier regions get the remainder
 * - End-to-end: K=3 independent rate limiters with uniform load admit the
 *   global budget; each region is isolated (DoS in one doesn't affect another)
 *
 * Skew degradation (the headline baseline number) is captured in the
 * companion `static-skew.test.ts` so this file stays focused on correctness.
 */

import { describe, expect, it } from "vitest";

import { fixedWindow } from "../../src/algorithms/fixed-window";
import { gcra } from "../../src/algorithms/gcra";
import { tokenBucket } from "../../src/algorithms/token-bucket";
import { ManualClock } from "../../src/core/clock";
import { rateLimit } from "../../src/core/limiter";
import { staticPartition } from "../../src/federation";
import { MemoryStore } from "../../src/stores/memory";

describe("federation/static-partition (TK-903)", () => {
  describe("partition arithmetic", () => {
    it("divides evenly when globalLimit % K === 0", () => {
      const { strategies, slices } = staticPartition({
        globalLimit: 999,
        regions: ["us-east", "eu-west", "ap-south"],
        strategyFactory: (limit) => gcra({ limit, periodMs: 1000 }),
      });
      expect(slices["us-east"]).toBe(333);
      expect(slices["eu-west"]).toBe(333);
      expect(slices["ap-south"]).toBe(333);
      // Strategies were actually built with the slice as their limit.
      expect(strategies["us-east"]?.limit).toBe(333);
      expect(strategies["eu-west"]?.limit).toBe(333);
      expect(strategies["ap-south"]?.limit).toBe(333);
    });

    it("distributes remainder to earlier-indexed regions (sum-preserving)", () => {
      const { slices } = staticPartition({
        globalLimit: 1000,
        regions: ["us-east", "eu-west", "ap-south"],
        strategyFactory: (limit) => gcra({ limit, periodMs: 1000 }),
      });
      expect(slices["us-east"]).toBe(334); // gets +1 from remainder
      expect(slices["eu-west"]).toBe(333);
      expect(slices["ap-south"]).toBe(333);
      // Sum is preserved exactly (the load-bearing property).
      expect(slices["us-east"]! + slices["eu-west"]! + slices["ap-south"]!).toBe(1000);
    });

    it("distributes 2-unit remainder across the first TWO regions", () => {
      const { slices } = staticPartition({
        globalLimit: 11,
        regions: ["a", "b", "c"],
        strategyFactory: (limit) => gcra({ limit, periodMs: 1000 }),
      });
      // 11 = 3 + (4 + 4 + 3): floor(11/3)=3, remainder=2 → regions[0..1] each get +1
      expect(slices.a).toBe(4);
      expect(slices.b).toBe(4);
      expect(slices.c).toBe(3);
      expect(slices.a! + slices.b! + slices.c!).toBe(11);
    });

    it("preserves regions ordering in the returned record", () => {
      const { strategies } = staticPartition({
        globalLimit: 100,
        regions: ["c", "b", "a"], // intentionally not alphabetical
        strategyFactory: (limit) => gcra({ limit, periodMs: 1000 }),
      });
      expect(Object.keys(strategies)).toEqual(["c", "b", "a"]);
    });

    it("calls the factory once per region with the per-region slice", () => {
      const calls: number[] = [];
      staticPartition({
        globalLimit: 10,
        regions: ["a", "b", "c"],
        strategyFactory: (limit) => {
          calls.push(limit);
          return gcra({ limit, periodMs: 1000 });
        },
      });
      // K=3, base=3, remainder=1, so calls = [4, 3, 3].
      expect(calls).toEqual([4, 3, 3]);
    });

    it("works with all built-in strategy factories", () => {
      const regions = ["a", "b"] as const;
      const gcraPart = staticPartition({
        globalLimit: 100,
        regions,
        strategyFactory: (limit) => gcra({ limit, periodMs: 1000 }),
      });
      expect(gcraPart.strategies.a?.name).toBe("gcra");

      const fwPart = staticPartition({
        globalLimit: 100,
        regions,
        strategyFactory: (limit) => fixedWindow({ limit, windowMs: 1000 }),
      });
      expect(fwPart.strategies.a?.name).toBe("fixedWindow");

      const tbPart = staticPartition({
        globalLimit: 100,
        regions,
        strategyFactory: (limit) => tokenBucket({ capacity: limit, refillPerSec: limit }),
      });
      expect(tbPart.strategies.a?.name).toBe("tokenBucket");
    });
  });

  describe("input validation", () => {
    const ok = (limit: number) => gcra({ limit, periodMs: 1000 });

    it("rejects empty regions", () => {
      expect(() => staticPartition({ globalLimit: 100, regions: [], strategyFactory: ok })).toThrow(
        /regions must be non-empty/,
      );
    });

    it("rejects non-finite / non-positive globalLimit", () => {
      const base = { regions: ["a", "b"], strategyFactory: ok } as const;
      expect(() => staticPartition({ globalLimit: 0, ...base })).toThrow(RangeError);
      expect(() => staticPartition({ globalLimit: -1, ...base })).toThrow(RangeError);
      expect(() => staticPartition({ globalLimit: Number.NaN, ...base })).toThrow(RangeError);
      expect(() => staticPartition({ globalLimit: Number.POSITIVE_INFINITY, ...base })).toThrow(
        RangeError,
      );
    });

    it("rejects globalLimit < K (would produce a 0-slice region)", () => {
      expect(() =>
        staticPartition({ globalLimit: 2, regions: ["a", "b", "c"], strategyFactory: ok }),
      ).toThrow(/>= regions\.length/);
    });

    it("rejects duplicate regions", () => {
      expect(() =>
        staticPartition({
          globalLimit: 100,
          regions: ["us-east", "eu-west", "us-east"],
          strategyFactory: ok,
        }),
      ).toThrow(/duplicate region/);
    });
  });

  describe("end-to-end: K independent regions", () => {
    it("uniform load: each region admits exactly its slice per window", async () => {
      const clock = new ManualClock(0);
      const { strategies, slices } = staticPartition({
        globalLimit: 300,
        regions: ["us-east", "eu-west", "ap-south"],
        strategyFactory: (limit) => fixedWindow({ limit, windowMs: 60_000 }),
      });

      // Each region runs an independent limiter (no coordination — static partition).
      const limiters = Object.fromEntries(
        Object.entries(strategies).map(([region, strategy]) => [
          region,
          rateLimit({ strategy, store: new MemoryStore({ clock }), clock }),
        ]),
      );

      // Drive each region at its slice; all should admit fully.
      let admittedTotal = 0;
      for (const [region, limiter] of Object.entries(limiters)) {
        const slice = slices[region]!;
        let admitted = 0;
        for (let i = 0; i < slice; i++) {
          const d = await limiter.check("k");
          if (d.allowed) admitted++;
        }
        expect(admitted).toBe(slice);
        admittedTotal += admitted;
      }
      expect(admittedTotal).toBe(300); // pooled equivalent under no skew
    });

    it("regional isolation: saturation in one region does NOT affect others", async () => {
      const clock = new ManualClock(0);
      const { strategies, slices } = staticPartition({
        globalLimit: 300,
        regions: ["us-east", "eu-west", "ap-south"],
        strategyFactory: (limit) => fixedWindow({ limit, windowMs: 60_000 }),
      });
      const limiters = Object.fromEntries(
        Object.entries(strategies).map(([region, strategy]) => [
          region,
          rateLimit({ strategy, store: new MemoryStore({ clock }), clock }),
        ]),
      );

      // Saturate us-east by spending 10× its slice.
      const usSlice = slices["us-east"]!;
      let usAdmitted = 0;
      for (let i = 0; i < usSlice * 10; i++) {
        const d = await limiters["us-east"]!.check("k");
        if (d.allowed) usAdmitted++;
      }
      expect(usAdmitted).toBe(usSlice); // hot region binds at its slice

      // eu-west must still be at full capacity — proves no coordination leaks.
      const euAdmitted = (
        await Promise.all(
          Array.from({ length: slices["eu-west"]! }, () => limiters["eu-west"]!.check("k")),
        )
      ).filter((d) => d.allowed).length;
      expect(euAdmitted).toBe(slices["eu-west"]!);
    });

    it("window rollover: each region resets independently at its window boundary", async () => {
      const clock = new ManualClock(0);
      const { strategies } = staticPartition({
        globalLimit: 30,
        regions: ["a", "b", "c"],
        strategyFactory: (limit) => fixedWindow({ limit, windowMs: 1000 }),
      });
      const a = rateLimit({
        strategy: strategies.a!,
        store: new MemoryStore({ clock }),
        clock,
      });

      // Spend region-a's slice (10).
      for (let i = 0; i < 10; i++) await a.check("k");
      expect((await a.check("k")).allowed).toBe(false);

      // Roll the window — capacity returns.
      clock.advance(1001);
      expect((await a.check("k")).allowed).toBe(true);
    });
  });
});
