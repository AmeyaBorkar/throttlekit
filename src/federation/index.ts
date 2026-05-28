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

export { PostgresCoordinator } from "./postgres-coordinator";
export type { PostgresCoordinatorOptions } from "./postgres-coordinator";
export { RedisCoordinator } from "./redis-coordinator";
export type { RedisCoordinatorOptions } from "./redis-coordinator";
export { RedisRegionalEscrow } from "./redis-regional-escrow";
export type { RedisRegionalEscrowOptions } from "./redis-regional-escrow";
export { FederatedStore } from "./store";
export { staticPartition } from "./static-partition";
export type { StaticPartitionOptions, StaticPartitionResult } from "./static-partition";
export { TestCoordinator } from "./test-coordinator";
export type { TestCoordinatorOptions } from "./test-coordinator";
export { TestRegionalEscrow } from "./test-regional-escrow";
export type { TestRegionalEscrowOptions } from "./test-regional-escrow";
export type {
  CoordinatorOutageMode,
  FederatedStoreOptions,
  GlobalCoordinator,
  Region,
  RegionalEscrow,
} from "./types";
export { federate } from "./window-coupled";
export type { FederateOptions } from "./window-coupled";
