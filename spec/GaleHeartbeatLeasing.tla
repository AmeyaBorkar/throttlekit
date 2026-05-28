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
(* the grant is CAPPED at the budget not committed to other live nodes        *)
(* (DESIGN section 6 / 10 / D-DAC-17). Under that cap GlobalCap holds for     *)
(* ANY interleaving.                                                          *)
(*                                                                         *)
(* WHAT IS PROVED (constant L): GlobalCap == Sum(share over active) <= L.     *)
(* The coordinator never COMMITS more than the global budget, regardless of   *)
(* heartbeat order, joins, or departures. This is the achievable, hard        *)
(* safety property -- and the one the bug violated.                          *)
(*                                                                         *)
(* WHAT IS NOT AN INVARIANT (deliberately): Sum(inflight) <= L. In-flight     *)
(* requests cannot be revoked, so when shares rebalance (a peer joins and     *)
(* ramps while an over-provisioned node drains) Sum(inflight) can             *)
(* transiently exceed L, draining monotonically back. This is a liveness/     *)
(* convergence property (DESIGN section 9.3 / D-DAC-14), identical to how     *)
(* single-process adaptiveConcurrency keeps serving in-flight after its       *)
(* estimate drops, and is further clamped in practice by min(share,           *)
(* local.limit) (D-DAC-6). It is therefore NOT in the invariant list.        *)
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
\* CAPPED at the budget not currently committed to OTHER active nodes, so the
\* committed sum can never exceed L regardless of the order nodes heartbeat in.
\* This is the federation lease, event-coupled (D-DAC-17).
Reallocate(n) ==
    /\ n \in active
    /\ LET others == SumOver(share, active \ {n})
       IN share' = [share EXCEPT ![n] = Min2(Target, L - others)]
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

\* Documentation-only (NOT an invariant; deliberately omitted from the .cfg):
\* in-flight can transiently exceed L during a rebalance because in-flight is
\* non-revocable. Convergence to <= L is the liveness property of DESIGN 9.3.
SteadyOvershoot == SumOver(inflight, active) <= L
=================================================================================
