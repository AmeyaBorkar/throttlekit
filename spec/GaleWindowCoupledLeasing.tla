------------------------ MODULE GaleWindowCoupledLeasing ------------------------
(***************************************************************************)
(* GALE research spec: window-coupled distributed leasing.                 *)
(*                                                                         *)
(* This is a one-line refinement of MODULE DistributedLeasing (which       *)
(* models ThrottleKit's CURRENT `leased` mode, proving the tight but       *)
(* fleet-size-DEPENDENT bound  admitted <= Limit + N*(Batch-1)).           *)
(*                                                                         *)
(* The only change is the Roll action. In DistributedLeasing, a window     *)
(* roll resets l2 and admitted but lets each node's local `credits` CARRY  *)
(* OVER -- and that carryover is provably the SOLE source of overshoot.    *)
(* Here, credits are COUPLED TO THE L2 WINDOW: they expire at the boundary *)
(* (credits' = 0 for all nodes on Roll). With no carryover, the per-window *)
(* overshoot collapses to ZERO and the bound becomes INDEPENDENT OF N:     *)
(*                                                                         *)
(*   admitted <= Limit            (for ANY number of nodes)                *)
(*                                                                         *)
(* Cost of the change (not modeled here; it is a liveness/efficiency, not  *)
(* a safety, property): after each boundary a busy node must re-Lease (one *)
(* L2 round trip) and any credits it still held are forfeited -- a bounded *)
(* near-boundary utilization dip. GALE's adaptive lease sizing minimizes   *)
(* exactly that cost; this spec isolates the SAFETY win.                   *)
(*                                                                         *)
(* TLC needs Java; the committed, CI-runnable Java-free twin of this model *)
(* is research/gale/leasing-variants.ts, which first reproduces this       *)
(* family's baseline state counts (31, 441) to validate the harness, then  *)
(* confirms admitted == Limit (tight) independent of N, including under    *)
(* work-conserving credit returns.                                         *)
(***************************************************************************)

EXTENDS Naturals, FiniteSets

CONSTANTS
    Nodes,   \* set of node identities, e.g. {n1, n2, n3}
    Limit,   \* L2 budget per window (a Nat)
    Batch    \* lease size (a Nat >= 1)

VARIABLES
    l2,        \* remaining L2 budget in the current window, in 0..Limit
    credits,   \* credits[n] in 0..(Batch-1): node n's unconsumed leased tokens
    admitted   \* requests admitted in the CURRENT window (Nat)

vars == << l2, credits, admitted >>

(* The N-INDEPENDENT bound proved by this model: a fresh window's budget,   *)
(* with no carried-over credits to ride on top of it.                       *)
MaxAdmitted == Limit

ASSUME LeasingAssumptions ==
    /\ Nodes # {}
    /\ Limit \in Nat
    /\ Batch \in Nat /\ Batch >= 1

TypeOK ==
    /\ l2 \in 0..Limit
    /\ credits \in [Nodes -> 0..(Batch - 1)]
    /\ admitted \in 0..MaxAdmitted

Init ==
    /\ l2 = Limit
    /\ credits = [n \in Nodes |-> 0]
    /\ admitted = 0

(* Serve(n): local credit hit. Identical to DistributedLeasing. *)
Serve(n) ==
    /\ credits[n] >= 1
    /\ credits' = [credits EXCEPT ![n] = @ - 1]
    /\ admitted' = admitted + 1
    /\ l2' = l2

(* Lease(n): lease-on-demand. Identical to DistributedLeasing. *)
Lease(n) ==
    /\ credits[n] = 0
    /\ l2 >= Batch
    /\ l2' = l2 - Batch
    /\ credits' = [credits EXCEPT ![n] = Batch - 1]
    /\ admitted' = admitted + 1

(* Roll: THE refinement. The L2 window rolls over; l2 and admitted reset    *)
(* AND every node's local credits expire (window-coupled lifetime).         *)
Roll ==
    /\ l2' = Limit
    /\ admitted' = 0
    /\ credits' = [n \in Nodes |-> 0]

Next == \E n \in Nodes : Serve(n) \/ Lease(n) \/ Roll

Spec == Init /\ [][Next]_vars

(***************************************************************************)
(* Invariants.                                                             *)
(***************************************************************************)

(* Safety: admissions in any single L2 window never exceed the window       *)
(* budget. No "+ N*(Batch-1)" term -- the bound does not depend on the      *)
(* number of nodes. Contrast DistributedLeasing.Overshoot.                  *)
Overshoot == admitted <= MaxAdmitted

(* Tightness witness (intentionally FALSE: TLC must report a violation,     *)
(* exhibiting a reachable state with admitted = Limit, so Limit is the      *)
(* least upper bound -- the coupling loses no steady-state capacity).       *)
OvershootTight == admitted <= MaxAdmitted - 1

=============================================================================
