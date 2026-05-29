/**
 * Distributed adaptive concurrency — the 0.10.0 primitive (bet #80, TK-1315).
 *
 * `adaptiveConcurrency()` infers a concurrency ceiling **per process** from
 * locally observed RTT. When N processes front one shared backend, N
 * independent limiters each infer a ceiling for the *whole* backend and
 * collectively admit up to `Σ Lᵢ` — N× the backend's true capacity. The
 * adaptive limiter that was supposed to *prevent* overload now *causes* it
 * under fan-out.
 *
 * `distributedAdaptiveConcurrency()` closes that gap: a drop-in
 * {@link ConcurrencyGuard} (so every 0.9.2 adapter picks it up unchanged) that
 * keeps the fleet's total in-flight count under one cooperatively-inferred
 * global ceiling. It is a **composition** of two already-shipped ideas:
 *
 * - a PRIVATE in-process `adaptiveConcurrency` owns RTT, `L_local`, in-flight
 *   tracking, and release idempotency (Mechanism 1 — capacity estimation); and
 * - a {@link ConcurrencyCoordinator} folds every live node's `L_local` into one
 *   `L_global` and equal-splits it into per-node `share`s (Mechanism 2 —
 *   capacity allocation, federation relabeled).
 *
 * The guard delegates `acquire()`/`release()` to the private guard and only
 * *tightens the gate* by the coordinator-supplied `share`: the effective
 * ceiling is `min(share, local.limit)` (D-DAC-5 / D-DAC-6). Because both terms
 * are `≤ local.limit`, whenever the outer gate admits, `local.acquire()` is
 * guaranteed to return `ok: true` (§4.2 proof).
 *
 * See `research/bigger-bets/distributed-adaptive-concurrency/DESIGN.md`
 * (§4.2, §5.2, §6, §8) — this file transcribes that locked design.
 */

import { systemClock } from "../core/clock";
import type { Clock } from "../core/types";
import { requireInteger, requirePositive } from "../core/validate";
import {
  type AdaptiveConcurrencyOptions,
  type ConcurrencyGuard,
  type Lease,
  adaptiveConcurrency,
} from "./adaptive";
import type { ConcurrencyCoordinator } from "./coordinator";

/** Injectable repeating timer (so tests drive heartbeats deterministically). */
export interface HeartbeatScheduler {
  schedule(fn: () => void, everyMs: number): { cancel(): void };
  /**
   * One-shot timer, used ONLY by the eager-handoff path (D-DAC-20) to fire a
   * debounced off-cycle heartbeat `delayMs` from now. Optional for backward
   * compatibility: a scheduler without it works for the periodic-only default,
   * but `eagerHandoff: true` REQUIRES it (construction throws otherwise). The
   * default scheduler implements it with an `unref`'d `setTimeout`.
   */
  setTimer?(fn: () => void, delayMs: number): { cancel(): void };
}

export interface DistributedAdaptiveConcurrencyOptions {
  /** The cross-node coordinator that owns `L_global`. */
  coordinator: ConcurrencyCoordinator;
  /** Unique-per-process identity. REQUIRED (no default — collisions corrupt the aggregate). */
  nodeId: string;
  /** Shared-backend key. Nodes fronting the same backend MUST match. Default "". */
  key?: string;
  /** Forwarded verbatim to the private `adaptiveConcurrency`. Default {}. */
  local?: AdaptiveConcurrencyOptions;
  /** Heartbeat / lease-renewal period in ms — the `heartbeat_T`. Default 1000. */
  heartbeatMs?: number;
  /** Lease TTL handed to the coordinator (`expiresAt = now + leaseTtlMs`).
   *  MUST exceed `heartbeatMs` so a single slow heartbeat doesn't drop the node.
   *  Default `2 * heartbeatMs`. */
  leaseTtlMs?: number;
  /** Behavior when `coordinator.heartbeat()` throws. Default "fail-closed". */
  onCoordinatorOutage?: "fail-closed" | "local-only";
  /**
   * EAGER (event-driven) HANDOFF — opt-in, default `false` (D-DAC-20). When `true`,
   * the guard fires **off-cycle** heartbeats the instant local state shows the
   * coordinator's allocation is stale, instead of waiting for the next periodic
   * tick — collapsing handoff ramp latency from ~2 heartbeats toward the physical
   * floor (drain + one round-trip) WITHOUT loosening any bound. Three triggers,
   * all guard-side (no coordinator/wire change; safe by the existing exhaustive
   * model — an off-cycle beat is just a `Report`/`Reallocate` at a different time):
   *   - PULL: a node capped BELOW its fair share (`share < ⌊lGlobal/nodes⌋`, computed
   *     from already-returned telemetry) re-beats to pick up budget peers are freeing;
   *   - PUSH: an incumbent whose in-flight drains to ≤ its (lowered) share re-beats to
   *     report the freed capacity so peers can claim it;
   *   - ACK: after applying a grant whose generation changed (a lowered share), the
   *     node re-beats to confirm it — under acknowledged handoff the coordinator
   *     reserves the node's un-acked-high grant until this ack lands.
   * Off-cycle beats are debounced to ≥ {@link minHeartbeatMs} apart (coalesced through
   * one pending timer), so steady state adds ZERO beats — the burst is transient,
   * during a rebalance only. Pairs with `acknowledgedHandoff` for a hard
   * `Σ inflight ≤ L_global` bound at near-floor ramp. REQUIRES `scheduler.setTimer`.
   */
  eagerHandoff?: boolean;
  /**
   * Minimum spacing between off-cycle eager heartbeats, in ms (the debounce floor
   * that bounds eager coordinator load). Only used when `eagerHandoff: true`.
   * Smaller ⇒ faster ramp + more beats during a transient; larger ⇒ the reverse.
   * Default `max(1, round(heartbeatMs / 10))`, clamped to `≤ heartbeatMs`.
   */
  minHeartbeatMs?: number;
  /** Injectable clock. Default systemClock. */
  clock?: Clock;
  /** Injectable scheduler. Default a setInterval-based timer (unref'd). */
  scheduler?: HeartbeatScheduler;
}

/** A {@link ConcurrencyGuard} plus distributed lifecycle. */
export interface DistributedConcurrencyGuard extends ConcurrencyGuard {
  /** Force a heartbeat now (report L_local, refresh share). Resolves when the
   *  round-trip lands. Normally driven by the internal timer; exposed for tests
   *  and graceful pre-shutdown sync. Never throws (outage → outage policy). */
  heartbeat(): Promise<void>;
  /** Stop the timer and `leave()` the fleet. Idempotent. */
  close(): Promise<void>;
  /** Distributed stats snapshot (extends the base `stats()`). */
  stats(): {
    limit: number;
    inflight: number;
    rttNoload: number;
    lastRtt: number;
    share: number;
    lGlobal: number;
    nodes: number;
  };
}

/** A no-op release shared by every rejected lease (rejected leases hold no slot). */
const NOOP_RELEASE = (): void => {};

/**
 * The default {@link HeartbeatScheduler}: a `setInterval`-based timer that is
 * `unref`'d so a pending heartbeat never keeps the process alive. (`unref` is a
 * Node-ism; it's guarded so the scheduler also works in non-Node runtimes.)
 *
 * The first heartbeat fires on the **next tick** (a `0`-delay `setTimeout`), not
 * after a full `everyMs`, to minimize the cold-start stall (§8.1 / D-DAC-12);
 * the steady-state interval starts after it.
 */
const defaultScheduler: HeartbeatScheduler = {
  schedule(fn: () => void, everyMs: number): { cancel(): void } {
    let interval: ReturnType<typeof setInterval> | undefined;
    // First heartbeat on the next tick, then every `everyMs`.
    const first = setTimeout(() => {
      fn();
      interval = setInterval(fn, everyMs);
      // `unref` keeps a background heartbeat from pinning the event loop open.
      (interval as { unref?: () => void }).unref?.();
    }, 0);
    (first as { unref?: () => void }).unref?.();
    return {
      cancel(): void {
        clearTimeout(first);
        if (interval !== undefined) clearInterval(interval);
      },
    };
  },
  setTimer(fn: () => void, delayMs: number): { cancel(): void } {
    const t = setTimeout(fn, delayMs);
    // `unref` keeps a pending eager beat from pinning the event loop open.
    (t as { unref?: () => void }).unref?.();
    return {
      cancel(): void {
        clearTimeout(t);
      },
    };
  },
};

/**
 * Distributed adaptive concurrency guard. Composes a private
 * {@link adaptiveConcurrency} with a {@link ConcurrencyCoordinator}: the private
 * guard owns RTT/`L_local`/in-flight/idempotency, and the coordinator supplies
 * the per-node `share` that tightens the gate to `min(share, local.limit)`.
 *
 * Quick start:
 *
 *     import { distributedAdaptiveConcurrency, TestConcurrencyCoordinator } from "throttlekit";
 *
 *     const coordinator = new TestConcurrencyCoordinator();
 *     const guard = distributedAdaptiveConcurrency({
 *       coordinator,
 *       nodeId: process.env.HOSTNAME ?? "node-1",
 *       key: "inference-cluster",
 *     });
 *     // optionally gate startup on the first share:
 *     await guard.heartbeat();
 *     const lease = guard.acquire();
 *     if (!lease.ok) reject503();
 *     else try { await work(); } finally { lease.release(); }
 *     // on shutdown:
 *     await guard.close();
 */
export function distributedAdaptiveConcurrency(
  options: DistributedAdaptiveConcurrencyOptions,
): DistributedConcurrencyGuard {
  const { coordinator } = options;
  const nodeId = options.nodeId;
  // D-DAC-15: nodeId is required, no default. A collision corrupts the aggregate
  // (toward under-admission — safe — but wrong); fail loud if absent.
  if (typeof nodeId !== "string" || nodeId.length === 0) {
    throw new RangeError(
      `distributedAdaptiveConcurrency.nodeId is required (no default): a unique-per-process identity. Got ${String(nodeId)}`,
    );
  }
  const key = options.key ?? "";
  const heartbeatMs = options.heartbeatMs ?? 1000;
  // D-DAC-7: leaseTtlMs default 2·heartbeatMs so one slow heartbeat doesn't drop the node.
  const leaseTtlMs = options.leaseTtlMs ?? 2 * heartbeatMs;
  const onCoordinatorOutage = options.onCoordinatorOutage ?? "fail-closed";
  const clock = options.clock ?? systemClock;
  const scheduler = options.scheduler ?? defaultScheduler;

  requirePositive("distributedAdaptiveConcurrency.heartbeatMs", heartbeatMs);
  requireInteger("distributedAdaptiveConcurrency.heartbeatMs", heartbeatMs);
  requirePositive("distributedAdaptiveConcurrency.leaseTtlMs", leaseTtlMs);
  requireInteger("distributedAdaptiveConcurrency.leaseTtlMs", leaseTtlMs);
  // leaseTtlMs MUST exceed heartbeatMs so a single slow heartbeat doesn't drop the node.
  if (leaseTtlMs <= heartbeatMs) {
    throw new RangeError(
      `distributedAdaptiveConcurrency.leaseTtlMs must be > heartbeatMs (${heartbeatMs}), got ${leaseTtlMs}`,
    );
  }

  // Eager (event-driven) handoff (D-DAC-20). Off-cycle beats need a one-shot timer;
  // the default scheduler provides one, a custom scheduler must too when enabled.
  const eagerHandoff = options.eagerHandoff ?? false;
  if (eagerHandoff && typeof scheduler.setTimer !== "function") {
    throw new RangeError(
      "distributedAdaptiveConcurrency.eagerHandoff requires a scheduler that implements setTimer(fn, delayMs)",
    );
  }
  // Debounce floor for eager beats: default 1/10 of heartbeatMs, clamped to [1, heartbeatMs].
  const minHeartbeatMs = Math.min(
    heartbeatMs,
    options.minHeartbeatMs ?? Math.max(1, Math.round(heartbeatMs / 10)),
  );
  if (eagerHandoff) {
    requirePositive("distributedAdaptiveConcurrency.minHeartbeatMs", minHeartbeatMs);
    requireInteger("distributedAdaptiveConcurrency.minHeartbeatMs", minHeartbeatMs);
  }

  // The private in-process limiter: owns RTT, L_local, inflight, release idempotency.
  const local = adaptiveConcurrency(options.local ?? {});

  // Cold start (D-DAC-12): before the first grant lands, the node admits nothing
  // under fail-closed (share = 0) or up to local.limit under local-only.
  let share = onCoordinatorOutage === "fail-closed" ? 0 : local.limit;
  let lGlobal = 0;
  let nodes = 0;

  // Monotonic grant application (D-DAC-18). Each heartbeat cycle is stamped with
  // a strictly-increasing issue sequence; we apply only the freshest issued
  // cycle and DROP any older reply that lands after it. The coordinator mutates
  // fleet state atomically at call time, so a later-issued heartbeat always
  // reflects equal-or-newer coordinator state — applying a reordered, stale grant
  // could reinstate a larger pre-rebalance share and worsen the bounded async
  // in-flight overshoot. (This removes ONE source of staleness; it does not on its
  // own make `Σ inflight ≤ L_global` a hard instantaneous bound — a guard still
  // admits against its cached grant while a reduction is in flight; DESIGN §9.3.)
  let heartbeatSeq = 0;
  let appliedSeq = 0;
  // Acknowledged handoff (D-DAC-19, opt-in at the coordinator). The grant
  // GENERATION the guard is currently enforcing (bumped by the coordinator only
  // when the granted share VALUE changes). Echoed in each report so a handoff
  // coordinator knows when this node has applied the current value and can stop
  // reserving a superseded higher grant. 0 until the first grant with a `gen`
  // lands; harmless (ignored) under a non-handoff coordinator.
  let appliedGen = 0;

  // Eager-handoff (D-DAC-20) bookkeeping (unused when eagerHandoff is off). `reportedGen`
  // = the appliedGen the coordinator last heard from us; `lastReportedInflight` = the
  // in-flight we last reported (to spot freed, not-yet-reported capacity); `lastBeatStartAt`
  // = clock time of the last beat (the eager debounce reference); `eagerTimer` = the single
  // pending off-cycle beat (coalesces continuous triggers into one).
  let reportedGen = 0;
  let lastReportedInflight = 0;
  let lastBeatStartAt = Number.NEGATIVE_INFINITY;
  let eagerTimer: { cancel(): void } | undefined;

  let closed = false;
  let timer: { cancel(): void } | undefined;

  /** The effective ceiling: provably ≤ share (safe) and gives sub-heartbeat local reaction. */
  function effectiveLimit(): number {
    return Math.min(share, local.limit);
  }

  /** Capped BELOW our fair share — peers are draining budget we should claim. Computed
   *  from already-returned telemetry (lGlobal/nodes), so no extra wire field (D-DAC-20). */
  function belowFair(): boolean {
    return nodes > 0 && share < Math.floor(lGlobal / nodes);
  }

  /** Schedule ONE debounced off-cycle heartbeat ≥ minHeartbeatMs after the last beat.
   *  While a beat is pending this is a no-op, so continuous triggers never pile up — at
   *  steady state (no trigger) zero extra beats fire; the burst is transient (D-DAC-20). */
  function scheduleEager(): void {
    if (!eagerHandoff || closed || eagerTimer !== undefined) return;
    const delay = Math.max(0, lastBeatStartAt + minHeartbeatMs - clock.now());
    eagerTimer = scheduler.setTimer?.(() => {
      eagerTimer = undefined;
      void runHeartbeat();
    }, delay);
  }

  function acquire(): Lease {
    // Gate on min(share, local.limit). Both terms are ≤ local.limit, so whenever
    // this admits, local.inflight < local.limit holds and local.acquire() is
    // guaranteed to return ok:true (§4.2). On a closed gate, hand back a rejected
    // lease that holds no slot.
    if (local.inflight >= effectiveLimit()) {
      // Eager PULL (D-DAC-20): demand we can't satisfy while capped below fair share ⇒
      // peers are freeing budget ⇒ re-beat to claim it (debounced; no-op at steady state).
      if (eagerHandoff && belowFair()) scheduleEager();
      return { ok: false, release: NOOP_RELEASE };
    }
    const lease = local.acquire();
    if (!eagerHandoff) return lease;
    // Eager PUSH (D-DAC-20): wrap release so that when in-flight drains to ≤ our (lowered)
    // share with capacity we have not yet reported, we re-beat to hand it to peers. The
    // wrapper is a per-acquire closure — allocated ONLY on the opt-in eager path.
    return {
      ok: lease.ok,
      release(opts?: { dropped?: boolean }): void {
        lease.release(opts);
        if (local.inflight <= share && lastReportedInflight > share) scheduleEager();
      },
    };
  }

  /**
   * One heartbeat cycle: report `L_local` + in-flight, take the grant, refresh
   * `share`/`lGlobal`/`nodes`. On a coordinator throw, apply `onCoordinatorOutage`
   * (fail-closed ⇒ share = 0; local-only ⇒ share = local.limit). Never throws.
   */
  async function runHeartbeat(): Promise<void> {
    // A beat is happening now: cancel any pending eager beat (it is subsumed) and
    // stamp the debounce reference, so the NEXT eager beat is ≥ minHeartbeatMs away.
    if (eagerTimer !== undefined) {
      eagerTimer.cancel();
      eagerTimer = undefined;
    }
    lastBeatStartAt = clock.now();
    // Stamp this cycle so a reordered, stale reply can't clobber a fresher grant
    // (D-DAC-18 monotonic application). `mySeq` strictly increases per issue;
    // we drop any reply whose issue is older than the freshest already applied.
    const mySeq = ++heartbeatSeq;
    // (sentInflight, sentAppliedGen) are sampled together, synchronously, BEFORE the
    // await — so a handoff coordinator always sees a CONSISTENT snapshot (the in-flight
    // observed UNDER the reported applied generation). A torn snapshot would be unsound
    // (D-DAC-19); JS's single-threaded evaluation gives atomicity for free here.
    const sentInflight = local.inflight;
    const sentAppliedGen = appliedGen;
    try {
      const grant = await coordinator.heartbeat({
        key,
        nodeId,
        lLocal: local.limit,
        inflight: sentInflight,
        expiresAt: clock.now() + leaseTtlMs,
        seq: mySeq,
        appliedGen: sentAppliedGen,
      });
      // The coordinator now knows we'd applied up to `sentAppliedGen`, observed with
      // `sentInflight` (eager-handoff ack/push bookkeeping, D-DAC-20). `reportedGen` is
      // kept monotone so a late stale reply can't spuriously reopen an "un-acked" gap.
      reportedGen = Math.max(reportedGen, sentAppliedGen);
      lastReportedInflight = sentInflight;
      if (mySeq < appliedSeq) return; // a fresher heartbeat already landed
      appliedSeq = mySeq;
      share = grant.share;
      lGlobal = grant.lGlobal;
      nodes = grant.nodes;
      // Record the generation we are now enforcing (acknowledged handoff). Only the
      // freshest-issued grant reaches here (the monotonic guard above), so appliedGen
      // tracks the freshest applied grant; `undefined` (non-handoff coordinator) leaves
      // it unchanged.
      if (grant.gen !== undefined) appliedGen = grant.gen;
      // Eager ACK (D-DAC-20): we just applied a grant whose generation the coordinator
      // doesn't yet know we applied (a lowered share). Re-beat promptly so it stops
      // reserving our un-acked-high grant and frees that budget to peers.
      if (eagerHandoff && appliedGen > reportedGen) scheduleEager();
    } catch {
      // Coordinator outage (§8.2). Mirrors federation's onCoordinatorOutage.
      // Honor monotonicity here too: a stale outage response must not clobber a
      // fresher grant that already landed.
      if (mySeq < appliedSeq) return;
      appliedSeq = mySeq;
      share = onCoordinatorOutage === "fail-closed" ? 0 : local.limit;
    }
  }

  // First heartbeat fires on the next tick (not after a full heartbeatMs) to
  // minimize the cold-start stall (§8.1 / D-DAC-12), then every heartbeatMs.
  timer = scheduler.schedule(() => {
    void runHeartbeat();
  }, heartbeatMs);

  async function heartbeat(): Promise<void> {
    // Force one cycle now. runHeartbeat never throws, so this never throws.
    await runHeartbeat();
  }

  async function close(): Promise<void> {
    // Mark closed FIRST so no in-flight beat can schedule a new eager timer mid-close.
    const wasClosed = closed;
    closed = true;
    // Idempotent: cancel the periodic + any pending eager timer, then best-effort leave().
    if (timer !== undefined) {
      timer.cancel();
      timer = undefined;
    }
    if (eagerTimer !== undefined) {
      eagerTimer.cancel();
      eagerTimer = undefined;
    }
    if (wasClosed) return;
    try {
      await coordinator.leave({ key, nodeId });
    } catch {
      // Best-effort departure; the node's lease expires by TTL regardless.
    }
  }

  return {
    acquire,
    get limit(): number {
      return effectiveLimit();
    },
    get inflight(): number {
      return local.inflight;
    },
    heartbeat,
    close,
    stats() {
      const base = local.stats();
      return {
        limit: effectiveLimit(),
        inflight: local.inflight,
        rttNoload: base.rttNoload,
        lastRtt: base.lastRtt,
        share,
        lGlobal,
        nodes,
      };
    },
  };
}
