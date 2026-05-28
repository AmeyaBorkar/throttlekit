------------------------ MODULE GaleFederatedLeasing ------------------------
(***************************************************************************)
(* GALE research spec: cross-CLUSTER window-coupled federated leasing.     *)
(*                                                                         *)
(* This is a one-step LIFT of MODULE GaleWindowCoupledLeasing from a       *)
(* single-process leasing fleet to a multi-region federation. The math is  *)
(* identical (state transitions and invariants); the model is reused under *)
(* a relabeling because the system structure is recursively the same:      *)
(*                                                                         *)
(*   windowCoupled twoTier (already proven)                                 *)
(*   -- one shared L2 store; N leasing nodes each hold local credits;       *)
(*      credits expire at the L2 window boundary.                           *)
(*                                                                         *)
(*   federation (this spec)                                                 *)
(*   -- one shared GLOBAL coordinator (the "L3"); K regions each hold      *)
(*      regional ESCROW (their leased sub-budget); the escrow expires at    *)
(*      the global window boundary.                                         *)
(*                                                                         *)
(* The relabeling is:                                                       *)
(*                                                                         *)
(*   spec/GaleWindowCoupledLeasing.tla                this spec             *)
(*   -----------------------------------------        ----------------       *)
(*   Nodes                                            Regions                *)
(*   credits[n]      (unconsumed leased tokens)       escrow[r]              *)
(*   l2              (L2 budget this window)          globalBudget           *)
(*                                                                         *)
(* Why this is sound (the "recursive twoTier" insight): the body of each   *)
(* region is *itself* a twoTier (regional L1 + regional L2) -- but with    *)
(* respect to the GLOBAL coordinator that owns `Limit`, each region simply *)
(* plays the role that an individual node plays in GaleWindowCoupled. The  *)
(* INNER per-region twoTier is already proven by MODULE                    *)
(* GaleWindowCoupledLeasing (the request <-> regional-L2 layer). This spec *)
(* is the OUTER layer (region <-> global-coordinator). Composition gives   *)
(* the federation guarantee.                                                *)
(*                                                                         *)
(* What this spec proves:                                                   *)
(*                                                                         *)
(*   For ANY number of regions K, with one coordination event per region   *)
(*   per window (the federated `Lease`), and regional escrow expiring at   *)
(*   the global window boundary (federated window-coupling),                *)
(*                                                                         *)
(*     admitted <= Limit                                                    *)
(*                                                                         *)
(*   -- i.e. the cross-region overshoot (Delta) collapses to zero, and the *)
(*   bound is INDEPENDENT OF THE NUMBER OF REGIONS.                         *)
(*                                                                         *)
(* Contrast: the static-partition baseline (each region gets Limit/K) has  *)
(* Delta = 0 by construction but admits at most (Limit/K)*K = Limit only   *)
(* if every region is at saturation -- under skew, the per-region budget   *)
(* binds and total admissions drop. The federation here pools the budget   *)
(* without sacrificing the Delta = 0 bound.                                 *)
(*                                                                         *)
(* TLC needs Java; the committed Java-free twin is                          *)
(* test/gale/federated/leasing-model.test.ts (introduced by TK-905), which *)
(* reproduces the distinct-state counts reported by TLC and asserts the    *)
(* same invariants. Because this model is a literal relabeling of          *)
(* GaleWindowCoupledLeasing, the BFS twin numerically matches the existing *)
(* GALE leasing-variants suite for the corresponding configs (see          *)
(* research/bigger-bets/federation/DESIGN.md Section 4 for the table).     *)
(***************************************************************************)

EXTENDS Naturals, FiniteSets

CONSTANTS
    Regions,  \* set of region identities, e.g. {us_east, eu_west, ap_south}
    Limit,    \* global coordinator's budget per window (a Nat)
    Batch     \* per-region escrow lease size (a Nat >= 1)

VARIABLES
    globalBudget,   \* remaining global budget in current window, in 0..Limit
    escrow,         \* escrow[r] in 0..(Batch-1): region r's unconsumed leased sub-budget
    admitted        \* admissions across ALL regions in the current window (Nat)

vars == << globalBudget, escrow, admitted >>

(* The K-INDEPENDENT bound proved here: a single fresh global window's      *)
(* budget, with no carried-over regional escrow.                            *)
MaxAdmitted == Limit

ASSUME FederationAssumptions ==
    /\ Regions # {}
    /\ Limit \in Nat
    /\ Batch \in Nat /\ Batch >= 1

TypeOK ==
    /\ globalBudget \in 0..Limit
    /\ escrow \in [Regions -> 0..(Batch - 1)]
    /\ admitted \in 0..MaxAdmitted

Init ==
    /\ globalBudget = Limit
    /\ escrow = [r \in Regions |-> 0]
    /\ admitted = 0

(* Serve(r): region r's regional L2 admits a request out of its escrow.    *)
(* No global round trip. Corresponds to the "have >= cost" fast path in    *)
(* the regional twoTier (which itself is proven by MODULE                  *)
(* GaleWindowCoupledLeasing one layer down).                               *)
Serve(r) ==
    /\ escrow[r] >= 1
    /\ escrow' = [escrow EXCEPT ![r] = @ - 1]
    /\ admitted' = admitted + 1
    /\ globalBudget' = globalBudget

(* Lease(r): region r leases one whole Batch from the global coordinator.  *)
(* Fires when the region is out of escrow (escrow[r] = 0) and the global   *)
(* coordinator can fit a whole Batch (globalBudget >= Batch). ONE cross-   *)
(* region round trip per Batch admissions amortizes; the triggering        *)
(* request is admitted and Batch-1 units of escrow remain in the region.   *)
Lease(r) ==
    /\ escrow[r] = 0
    /\ globalBudget >= Batch
    /\ globalBudget' = globalBudget - Batch
    /\ escrow' = [escrow EXCEPT ![r] = Batch - 1]
    /\ admitted' = admitted + 1

(* Roll: the global window rolls over. globalBudget and admitted reset --  *)
(* AND every region's local escrow EXPIRES. This is the federated window-  *)
(* coupling rule (uncommitted escrow forfeits at the boundary). It is the  *)
(* sole reason Delta = 0 holds independent of K.                            *)
(*                                                                         *)
(* Implementation: the regional escrow lease carries the same PEXPIRE as   *)
(* the global window key; the global coordinator's `reconcile()` is        *)
(* idempotent on windowStart so retries through a partition converge.      *)
Roll ==
    /\ globalBudget' = Limit
    /\ admitted' = 0
    /\ escrow' = [r \in Regions |-> 0]

Next == \E r \in Regions : Serve(r) \/ Lease(r) \/ Roll

Spec == Init /\ [][Next]_vars

(***************************************************************************)
(* Invariants.                                                              *)
(***************************************************************************)

(* Safety: in any single global window, admissions never exceed the global *)
(* budget. The K-independent federation bound. Contrast                     *)
(* DistributedLeasing.Overshoot (carryover version) which scales as         *)
(*   admitted <= Limit + |Nodes| * (Batch - 1)                              *)
(* -- here that K-dependent term is GONE because escrow expires on Roll.    *)
Overshoot == admitted <= MaxAdmitted

(* Tightness witness (intentionally FALSE: TLC must report a violation,    *)
(* exhibiting a reachable state with admitted = Limit, so Limit is the     *)
(* LEAST upper bound -- federation loses no steady-state capacity). Not    *)
(* placed in the committed .cfg; add it to capture the tightness trace.    *)
OvershootTight == admitted <= MaxAdmitted - 1

=============================================================================
