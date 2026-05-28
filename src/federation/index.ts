/**
 * Cross-cluster federation — public entry point.
 *
 * Design: `research/bigger-bets/federation/DESIGN.md`.
 * Spec:   `spec/GaleFederatedLeasing.tla` (BFS twin in TK-905).
 *
 * Usage (after TK-904 lands the impl):
 *
 *     import { FederatedStore, TestCoordinator } from "throttlekit/federation";
 *     import { twoTier } from "throttlekit";
 *
 *     const coordinator = new TestCoordinator({ budgetPerWindow: 1000 });
 *     const federated = new FederatedStore({
 *       regional: regionalRedisStore,
 *       coordinator,
 *       region: "us-east",
 *       batch: 16,
 *     });
 *     const limiter = twoTier({ strategy, l2: federated, mode: "leased",
 *                                lease: { batch: 8, windowCoupled: true } });
 */

export { FederatedStore } from "./store";
export { staticPartition } from "./static-partition";
export type { StaticPartitionOptions, StaticPartitionResult } from "./static-partition";
export { TestCoordinator } from "./test-coordinator";
export type { TestCoordinatorOptions } from "./test-coordinator";
export type {
  CoordinatorOutageMode,
  FederatedStoreOptions,
  GlobalCoordinator,
  Region,
} from "./types";
