-------------------------- MODULE GaleHeartbeatLeasing --------------------------
(***************************************************************************)
(* GALE research spec: distributed ADAPTIVE CONCURRENCY as event-release    *)
(* leasing. The event-release sibling of MODULE GaleFederatedLeasing         *)
(* (clock/window escrow), relabeled windowMs -> heartbeat_T:                 *)
(*                                                                         *)
(*   GaleFederatedLeasing            GaleHeartbeatLeasing                    *)
(*   --------------------            --------------------                    *)
(*   windowMs   (clock reset)        heartbeat_T  (per-node heartbeat)       *)
(*   globalBudget = Limit            L            (constant this epoch)      *)
(*   escrow[r]   (leased, decays)    share[n]     (granted, event-released)  *)
(*   admitted    (cumulative/window) inflight[n]  (instantaneous, persists)  *)
(*                                                                         *)
(* WHY THIS MODEL IS STAGGERED (and the earlier atomic-Roll model was        *)
(* unsound). Each node heartbeats INDEPENDENTLY, at its own time, against     *)
(* whatever fleet snapshot the coordinator holds then. A stateless           *)
(* equal-split (share = floor(L/N) computed per node) VIOLATES the global     *)
(* budget under this staggering: a node that joins computes its small share   *)
(* while an incumbent still holds its larger pre-join share, so Sum(share)    *)
(* transiently exceeds L with L CONSTANT (no shrink). The earlier spec hid    *)
(* this by re-splitting all shares atomically in one Roll. This module        *)
(* models the real staggered protocol: one node reallocates at a time, and    *)
(* the grant is CAPPED at the budget no other live node is currently HOLDING:  *)
(* share'[n] = max(0, min(Target, L - Sum over others of max(share, inflight))) *)
(* (DESIGN section 6 / 10 / D-DAC-17 for the share term, D-DAC-18 for the      *)
(* inflight term). Under that cap BOTH safety bounds below hold for ANY        *)
(* interleaving.                                                              *)
(*                                                                         *)
(* WHAT IS PROVED (constant L) -- two HARD invariants, both maintained by the  *)
(* one cap:                                                                   *)
(*   GlobalCap   == Sum(share    over active) <= L  (never over-COMMIT). The   *)
(*                  share term (D-DAC-17); the bound the original stateless    *)
(*                  equal-split bug violated.                                 *)
(*   InflightCap == Sum(inflight over active) <= L  (never over-OCCUPY). The   *)
(*                  inflight term (D-DAC-18). In-flight is non-revocable, so a  *)
(*                  joiner must not ramp into capacity an incumbent still       *)
(*                  occupies; reserving each peer's max(share, inflight) makes  *)
(*                  the joiner grow only as fast as the incumbent drains. The   *)
(*                  earlier share-ONLY cap left this as a transient overshoot   *)
(*                  (up to 1.5x on a 1->2 scale-up), documented as liveness     *)
(*                  (old DESIGN 9.3 / D-DAC-14); the occupancy cap (D-DAC-18)   *)
(*                  makes it hard IN THIS (synchronous) MODEL, converting the   *)
(*                  overshoot to a ramp DELAY (async residual: SCOPE below).    *)
(*                  min(share, local.limit) at the                              *)
(*                  guard (D-DAC-6) remains a further in-practice clamp.        *)
(*                                                                         *)
(* SCOPE -- this is a SYNCHRONOUS model: Reallocate reads and writes share      *)
(* atomically, with NO distinction between the share the coordinator has        *)
(* COMMITTED and the share a guard has APPLIED (grant replies are instantaneous  *)
(* here). InflightCap is therefore the SYNCHRONOUS-PROTOCOL guarantee. The async *)
(* implementation has grant-reply latency + heartbeat reporting lag, leaving a   *)
(* bounded (~1.5-2x), self-draining residual where Sum(inflight) can transiently *)
(* exceed L (a guard admits against its cached grant while a reduction is in     *)
(* flight); it is NOT a hard INSTANTANEOUS end-to-end bound. A hard async bound  *)
(* would need acknowledged handoff. See DESIGN 9.3 / D-DAC-18.                  *)
(*                                                                         *)
(* TLC needs Java; the committed Java-free twin is                           *)
(* test/concurrency/distributed-leasing-model.test.ts (TK-1316), which        *)
(* reproduces TLC's distinct-state count and asserts the same invariants.     *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Nodes,   \* set of node identities, e.g. {n1, n2}
    L        \* the constant global concurrency budget for this heartbeat epoch

VARIABLES
    active,    \* subset of Nodes currently in the fleet (heartbeating)
    share,     \* share[n]: node n's currently-granted ceiling (0 when inactive)
    inflight   \* inflight[n]: node n's current in-flight count

vars == << active, share, inflight >>

Min2(a, b) == IF a < b THEN a ELSE b
Max2(a, b) == IF a > b THEN a ELSE b
Ceil(a, b) == (a + b - 1) \div b

RECURSIVE SumOver(_, _)
SumOver(f, S) == IF S = {} THEN 0
                 ELSE LET x == CHOOSE y \in S : TRUE
                      IN f[x] + SumOver(f, S \ {x})

\* An upper bound on any single node's fair share this epoch. The real
\* coordinator uses the tighter base/remainder equal-split; Ceil(L,|active|) is a
\* safe over-approximation -- the SAFETY bound depends only on the CAP below, not
\* on the exact target.
Target == Ceil(L, Cardinality(active))

\* What each node is currently HOLDING this instant: the larger of its granted
\* share and its NON-REVOCABLE in-flight. The cap reserves this for every peer
\* (D-DAC-18), not just `share` (D-DAC-17), so a (re)grant never hands out
\* capacity a peer is still occupying -- the joiner ramps only as fast as
\* incumbents drain. Steady state (inflight <= share) collapses Held to share, so
\* the D-DAC-17 cap is the special case and no steady-state capacity is lost.
Held == [m \in Nodes |-> Max2(share[m], inflight[m])]

ASSUME HeartbeatAssumptions ==
    /\ Nodes # {}
    /\ L \in Nat

TypeOK ==
    /\ active \subseteq Nodes
    /\ active # {}
    /\ share \in [Nodes -> 0..L]
    /\ inflight \in [Nodes -> 0..L]

Init ==
    /\ active \in { s \in SUBSET Nodes : s # {} }   \* any nonempty starting fleet
    /\ share = [n \in Nodes |-> 0]                  \* cold start: nobody holds budget yet
    /\ inflight = [n \in Nodes |-> 0]

\* Reallocate(n): node n heartbeats and is (re)granted a share. The grant is
\* CAPPED at the budget no OTHER active node is currently HOLDING (max(share,
\* inflight) per peer), so NEITHER the committed sum NOR the in-flight sum can
\* exceed L, regardless of the order nodes heartbeat in. The max(0, ...) clamp
\* matters now: unlike the share-only sum (<= L by GlobalCap), the Held-sum over
\* peers can exceed L, so L - others may be negative. This is the federation
\* lease, event-coupled (D-DAC-17 share term + D-DAC-18 inflight term).
Reallocate(n) ==
    /\ n \in active
    /\ LET others == SumOver(Held, active \ {n})
       IN share' = [share EXCEPT ![n] = Max2(0, Min2(Target, L - others))]
    /\ UNCHANGED << active, inflight >>

\* Join(n): a new node enters holding NO budget (share 0) until it reallocates,
\* so an incumbent's outstanding share is never double-counted.
Join(n) ==
    /\ n \notin active
    /\ active' = active \cup {n}
    /\ share' = [share EXCEPT ![n] = 0]
    /\ UNCHANGED inflight

\* Leave(n): a node departs (voluntary close or lease-expiry); its share leaves
\* the live sum (budget reclaimed) and its in-flight is gone.
Leave(n) ==
    /\ n \in active
    /\ Cardinality(active) > 1
    /\ active' = active \ {n}
    /\ share' = [share EXCEPT ![n] = 0]
    /\ inflight' = [inflight EXCEPT ![n] = 0]

\* Acquire(n): admit one request -- only while below the node's granted share.
Acquire(n) ==
    /\ n \in active
    /\ inflight[n] < share[n]
    /\ inflight' = [inflight EXCEPT ![n] = @ + 1]
    /\ UNCHANGED << active, share >>

\* Release(n): a request on node n completes (event-release).
Release(n) ==
    /\ inflight[n] > 0
    /\ inflight' = [inflight EXCEPT ![n] = @ - 1]
    /\ UNCHANGED << active, share >>

Next ==
    \E n \in Nodes :
        \/ Reallocate(n) \/ Join(n) \/ Leave(n) \/ Acquire(n) \/ Release(n)

Spec == Init /\ [][Next]_vars

(***************************************************************************)
(* Invariants.                                                              *)
(***************************************************************************)

\* THE safety property: the coordinator never commits more than the global
\* budget. Maintained by the CAP in Reallocate (each grant <= L - others) and by
\* Join granting 0. A stateless equal-split (no cap) VIOLATES this under
\* staggered heartbeats -- that was the bug. Independent of |Nodes|.
GlobalCap == SumOver(share, active) <= L

\* Tightness witness for GlobalCap (intentionally FALSE: TLC must exhibit a
\* reachable state with Sum(share) = L, so L is the LEAST upper bound -- the
\* distributed allocation loses no steady-state capacity). Swap into the .cfg to
\* capture the trace; not in the committed invariant list.
GlobalCapTight == SumOver(share, active) <= L - 1

\* THE second safety property of the SYNCHRONOUS model (D-DAC-18): in-flight never
\* exceeds the global budget. Maintained by the inflight term of the cap -- a peer's
\* non-revocable in-flight is reserved as max(share, inflight), so a joiner cannot
\* ramp into capacity an incumbent has not yet drained. This ELIMINATES the
\* synchronous rebalance overshoot the share-only cap left (the old "SteadyOvershoot"
\* liveness note). It is hard for ANY interleaving at constant L *in this model*; the
\* async implementation has a bounded, self-draining residual (header SCOPE / DESIGN
\* 9.3). COMMITTED in the .cfg.
InflightCap == SumOver(inflight, active) <= L

\* Tightness witness for InflightCap (intentionally FALSE, like GlobalCapTight):
\* TLC must exhibit a reachable state with Sum(inflight) = L, so L is the LEAST
\* upper bound -- the occupancy cap loses no steady-state in-flight capacity (at
\* steady state every node fills its share and Sum(inflight) = Sum(share) = L).
\* Swap into the .cfg to capture the trace; not in the committed invariant list.
InflightCapTight == SumOver(inflight, active) <= L - 1
=================================================================================
