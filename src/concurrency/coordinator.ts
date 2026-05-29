/** One node's heartbeat report to the {@link ConcurrencyCoordinator}. */
export interface ConcurrencyReport {
  /** Logical shared-backend key. Nodes sharing a backend MUST use the same key. */
  key: string;
  /** Unique-per-process node identity. */
  nodeId: string;
  /** This node's locally-inferred ceiling (its private adaptiveConcurrency `limit`). */
  lLocal: number;
  /** This node's current in-flight count (the demand signal; reserved for future
   *  demand-proportional allocation — equal-split ignores it in 0.10.0). */
  inflight: number;
  /** Lease expiry, epoch-ms. The coordinator MUST treat any node with
   *  `expiresAt < now` as departed and reclaim its share. */
  expiresAt: number;
  /**
   * ACKNOWLEDGED HANDOFF (D-DAC-19, opt-in). The node's strictly-increasing
   * heartbeat sequence (its private `heartbeatSeq`). Lets a handoff coordinator
   * IGNORE a reordered/stale heartbeat (one with `seq ≤` the freshest it has
   * processed for this node) so concurrent in-flight heartbeats can't regress its
   * committed-grant bookkeeping. Optional & additive (DR-14): a non-handoff
   * coordinator ignores it; a handoff coordinator treats `undefined` as "always
   * fresh". Sampled atomically with {@link inflight} and {@link appliedGen}.
   */
  seq?: number;
  /**
   * ACKNOWLEDGED HANDOFF (D-DAC-19, opt-in). The grant GENERATION the node's guard
   * is currently ENFORCING (the {@link ConcurrencyGrant.gen} it has applied). A
   * handoff coordinator uses it to detect "the peer has caught up to the current
   * value" and stop reserving a superseded higher grant. MUST be sampled at the
   * SAME instant as {@link inflight} (a torn snapshot — fresh gen, stale inflight —
   * is unsound; the guard reads both synchronously). Optional & additive: absent ⇒
   * the coordinator never resets its reserve floor for this peer (the SAFE,
   * over-reserving direction — used for a not-yet-upgraded guard).
   */
  appliedGen?: number;
}

/** The coordinator's grant back to one node for the next heartbeat window. */
export interface ConcurrencyGrant {
  /** This node's allocated ceiling. `acquire()` admits while `inflight < share`. */
  share: number;
  /** Current fleet-wide inferred limit (telemetry). */
  lGlobal: number;
  /** Count of live nodes the coordinator aggregated over (telemetry / equal-split transparency). */
  nodes: number;
  /**
   * ACKNOWLEDGED HANDOFF (D-DAC-19, opt-in). The GENERATION of this grant —
   * incremented by the coordinator ONLY when the granted {@link share} VALUE
   * changes (NOT once per heartbeat). The guard applies grants monotonically and
   * echoes the gen it enforces back as {@link ConcurrencyReport.appliedGen}, so the
   * coordinator learns when the peer has applied the current value and can release
   * the budget a now-superseded higher grant was reserving. Present only from a
   * coordinator running acknowledged handoff; the guard treats `undefined` as 0.
   */
  gen?: number;
}

/**
 * Owns the shared `L_global` and parcels it into per-node shares. The
 * event-release sibling of {@link GlobalCoordinator} (federation): same
 * "central authority leases sub-budgets to N participants" shape, but the
 * lease is renewed by heartbeat (liveness) and reclaimed by TTL, not reset by
 * a wall-clock window. See DESIGN §3 + §9.
 */
export interface ConcurrencyCoordinator {
  /**
   * Heartbeat + report + (re)lease in one round-trip. The coordinator:
   *   1. upserts this node's {lLocal, inflight, expiresAt};
   *   2. evicts every node whose `expiresAt < now`;
   *   3. recomputes `L_global = aggregate(live nodes' lLocal)`;
   *   4. equal-splits `L_global` across the live nodes (§6) and returns this
   *      node's share.
   * Idempotent per `nodeId` within a heartbeat. MAY reject with
   * `StoreUnavailableError` on unreachability.
   */
  heartbeat(report: ConcurrencyReport): Promise<ConcurrencyGrant>;
  /** Voluntary departure: drop `nodeId` and reclaim its share now (don't wait for TTL).
   *  Best-effort, idempotent. */
  leave(args: { key: string; nodeId: string }): Promise<void>;
  /** Optional liveness probe; defaults to always-healthy. */
  isHealthy?(): Promise<boolean>;
}
