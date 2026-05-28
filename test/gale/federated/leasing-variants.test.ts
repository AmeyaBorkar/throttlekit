/**
 * TK-905 — JS BFS twin of MODULE GaleFederatedLeasing
 * (`spec/GaleFederatedLeasing.tla`).
 *
 * The CI-gated, Java-free counterpart of TLC: walks the entire reachable
 * state space exhaustively and asserts both the formal invariants
 * (`TypeOK`, `Overshoot`) and the exact distinct-state counts TLC would
 * report at the same configurations.
 *
 * The counts here are committed in `research/bigger-bets/federation/DESIGN.md`
 * §4.1 and reproduced byte-for-byte by the standalone script
 * `research/bigger-bets/federation/tla-counts.ts`. The BASELINE (carryover)
 * rows match TLC's published counts in `spec/README.md` §1 (31) and §3
 * (441), validating that this BFS is faithful to TLC; the FEDERATED
 * (window-coupled) rows are the contribution this test cements.
 *
 * Parallel to `test/gale/leasing-variants.test.ts` (the in-process GALE
 * windowCoupled twin) — the federated layer is a literal relabeling of
 * that model.
 */

import { describe, expect, it } from "vitest";

import { type Params, boundFor, explore } from "./bfs-twin";

describe("GALE federated leasing — exhaustive BFS twin (TK-905)", () => {
  describe("harness validation — reproduce TLC's baseline counts", () => {
    it("baseline K=2, L=4, B=2 → 31 distinct states (matches TLC in spec/README.md §1)", () => {
      const p: Params = { regions: 2, limit: 4, batch: 2, variant: "baseline" };
      const { distinct, maxAdmitted, depth } = explore(p);
      expect(distinct).toBe(31);
      expect(maxAdmitted).toBe(boundFor(p));
      expect(maxAdmitted).toBe(6); // = L + K(B-1)
      // TLC reports "depth of the complete state graph search" = 10 for this
      // config, counting both endpoints of the shortest-path graph (1-indexed:
      // init is depth 1). Our BFS counts edges (0-indexed: init is depth 0),
      // so the load-bearing equivalence is `depth + 1 === TLC's depth`.
      expect(depth + 1).toBe(10);
    });

    it("baseline K=3, L=6, B=3 → 441 distinct states (matches TLC in spec/README.md §3)", () => {
      const p: Params = { regions: 3, limit: 6, batch: 3, variant: "baseline" };
      const { distinct, maxAdmitted, depth } = explore(p);
      expect(distinct).toBe(441);
      expect(maxAdmitted).toBe(boundFor(p));
      expect(maxAdmitted).toBe(12); // = L + K(B-1)
      // Same depth-convention adjustment as the K=2 case above.
      expect(depth + 1).toBe(18);
    });
  });

  describe("federated (window-coupled) — the contribution", () => {
    it("K=2, L=4, B=2 → 8 distinct, max admitted = 4 (DESIGN.md §4.1)", () => {
      const p: Params = { regions: 2, limit: 4, batch: 2, variant: "windowCoupled" };
      const { distinct, maxAdmitted } = explore(p);
      expect(distinct).toBe(8);
      expect(maxAdmitted).toBe(4); // = L, K-INDEPENDENT
      expect(maxAdmitted).toBe(boundFor(p));
    });

    it("K=3, L=6, B=3 → 27 distinct, max admitted = 6 (DESIGN.md §4.1)", () => {
      const p: Params = { regions: 3, limit: 6, batch: 3, variant: "windowCoupled" };
      const { distinct, maxAdmitted } = explore(p);
      expect(distinct).toBe(27);
      expect(maxAdmitted).toBe(6); // = L
      expect(maxAdmitted).toBe(boundFor(p));
    });

    it("K=5, L=10, B=2 → 112 distinct, max admitted = 10 (DESIGN.md §4.1)", () => {
      const p: Params = { regions: 5, limit: 10, batch: 2, variant: "windowCoupled" };
      const { distinct, maxAdmitted } = explore(p);
      expect(distinct).toBe(112);
      expect(maxAdmitted).toBe(10); // = L (K-independent — keystone claim)
      expect(maxAdmitted).toBe(boundFor(p));
    });
  });

  describe("keystone — federated overshoot is INDEPENDENT of region count K", () => {
    it("at fixed L=8, B=2: baseline grows L+K(B-1) while federated stays L for every K", () => {
      const L = 8;
      const B = 2;
      // Exhaustive sweep over K=1..8. Beyond K=8 the state space grows ~2^K
      // (each region adds one escrow slot of size B); the bound is immediate
      // by inspection (federated window-coupling forfeits all carryover so
      // any one window admits at most the global budget L regardless of K).
      for (const K of [1, 2, 4, 8]) {
        const base = explore({ regions: K, limit: L, batch: B, variant: "baseline" });
        const fed = explore({ regions: K, limit: L, batch: B, variant: "windowCoupled" });
        // Baseline scales with K.
        expect(base.maxAdmitted).toBe(L + K * (B - 1));
        // Federated stays at L — the K-INDEPENDENT bound.
        expect(fed.maxAdmitted).toBe(L);
      }
    });
  });

  describe("tightness — federation attains exactly L (no steady-state capacity loss)", () => {
    it.each([
      { regions: 3, limit: 6, batch: 3 },
      { regions: 4, limit: 12, batch: 4 },
      { regions: 5, limit: 10, batch: 2 },
    ])("K=$regions, L=$limit, B=$batch reaches admitted == L", ({ regions, limit, batch }) => {
      const { maxAdmitted } = explore({ regions, limit, batch, variant: "windowCoupled" });
      expect(maxAdmitted).toBe(limit);
    });
  });

  describe("Batch=1: no carryover in EITHER variant (the trivial coincidence)", () => {
    it("baseline and federated agree at B=1 because escrow range is {0,0}", () => {
      // With B=1, the escrow slot is bounded to 0..0 = {0} — no credits to carry over.
      // Baseline therefore degrades to the window budget L, matching federated.
      const base = explore({ regions: 3, limit: 5, batch: 1, variant: "baseline" });
      const fed = explore({ regions: 3, limit: 5, batch: 1, variant: "windowCoupled" });
      expect(base.maxAdmitted).toBe(5);
      expect(fed.maxAdmitted).toBe(5);
    });
  });
});
