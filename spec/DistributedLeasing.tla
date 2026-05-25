---------------------------- MODULE DistributedLeasing ----------------------------
(***************************************************************************)
(* Formal model of ThrottleKit's distributed leasing overshoot bound      *)
(* (`leased` mode in src/twotier/index.ts).                                *)
(*                                                                         *)
(* This abstracts the leased branch of `twoTier()` with the default        *)
(* `lowWater = 0` (purely lease-on-demand) and a per-request cost of 1.    *)
(*                                                                         *)
(* Correspondence to the code (src/twotier/index.ts, the `check` returned  *)
(* by the leased branch):                                                  *)
(*                                                                         *)
(*   Serve(n)  ==  the `have >= cost` fast path:                           *)
(*                   const have = credits.get(fk) ?? 0;                    *)
(*                   if (have >= cost) {                                   *)
(*                     credits.set(fk, have - cost);                       *)
(*                     maybeRefill(fk);   // no-op when lowWater <= 0       *)
(*                     return synthAllow(...);  // admitted++              *)
(*                   }                                                     *)
(*                                                                         *)
(*   Lease(n)  ==  the lease-on-demand path (have < cost, i.e. have = 0    *)
(*                 when cost = 1):                                          *)
(*                   const leaseAmount = Math.max(batch, cost); // = Batch *)
(*                   const d = await l2.apply(fk, ...leaseAmount);          *)
(*                   if (d.allowed) {                                       *)
(*                     credits.set(fk, credits + leaseAmount - cost);       *)
(*                     // = Batch - 1, and admit the triggering request     *)
(*                   }                                                      *)
(*                 L2 admits the lease iff a whole Batch fits in the        *)
(*                 remaining window budget (l2 >= Batch).                   *)
(*                                                                         *)
(*   Roll      ==  the L2 fixed window rolling over: the L2 budget resets   *)
(*                 to Limit and the count of admitted-this-window resets,   *)
(*                 but each node's LOCAL credits CARRY OVER (the code never *)
(*                 clears `credits` on a window boundary). This carryover   *)
(*                 is the sole source of cross-window overshoot.            *)
(*                                                                         *)
(* `admitted` counts requests admitted in the CURRENT L2 window. Because    *)
(* up to Batch-1 leftover credits per node can survive a Roll and then be   *)
(* served on top of a fresh full Limit, the tight per-window bound is:      *)
(*                                                                         *)
(*   admitted <= Limit + Cardinality(Nodes) * (Batch - 1)                  *)
(***************************************************************************)

EXTENDS Naturals, FiniteSets

CONSTANTS
    Nodes,   \* set of node identities, e.g. {n1, n2}
    Limit,   \* L2 budget per window (a Nat)
    Batch    \* lease size (a Nat >= 1)

VARIABLES
    l2,        \* remaining L2 budget in the current window, in 0..Limit
    credits,   \* credits[n] in 0..(Batch-1): node n's unconsumed leased tokens
    admitted   \* requests admitted in the CURRENT window (Nat)

vars == << l2, credits, admitted >>

(* The exact overshoot bound proved by this model. *)
MaxAdmitted == Limit + Cardinality(Nodes) * (Batch - 1)

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

(* Serve(n): local credit hit -- the `have >= cost` path. Consume one local *)
(* credit, admit the request, do not touch L2.                              *)
Serve(n) ==
    /\ credits[n] >= 1
    /\ credits' = [credits EXCEPT ![n] = @ - 1]
    /\ admitted' = admitted + 1
    /\ l2' = l2

(* Lease(n): lease-on-demand. Only fires when the node is out of local       *)
(* credits (credits[n] = 0) and L2 can fit a whole Batch (l2 >= Batch). One  *)
(* L2 round trip removes Batch from the window; the triggering request is    *)
(* served and Batch-1 credits are retained locally.                          *)
Lease(n) ==
    /\ credits[n] = 0
    /\ l2 >= Batch
    /\ l2' = l2 - Batch
    /\ credits' = [credits EXCEPT ![n] = Batch - 1]
    /\ admitted' = admitted + 1

(* Roll: the L2 fixed window rolls over. L2 budget and the per-window         *)
(* admitted counter reset; LOCAL credits carry over unchanged.                *)
Roll ==
    /\ l2' = Limit
    /\ admitted' = 0
    /\ credits' = credits

Next == \E n \in Nodes : Serve(n) \/ Lease(n) \/ Roll

Spec == Init /\ [][Next]_vars

(***************************************************************************)
(* Invariants.                                                             *)
(***************************************************************************)

(* The tight overshoot bound: admissions in any single L2 window never      *)
(* exceed the window budget plus the per-node leftover credits that can     *)
(* survive a window roll.                                                    *)
Overshoot == admitted <= MaxAdmitted

(* Tightness witness (intentionally FALSE: TLC must report a violation).    *)
(* If admissions could never reach MaxAdmitted, this would hold; TLC        *)
(* finding a counterexample at admitted = MaxAdmitted proves the Overshoot  *)
(* bound is exact, not loose. Left out of the committed .cfg -- enable it    *)
(* only to capture the tightness trace (see spec/README.md).                *)
OvershootTight == admitted <= MaxAdmitted - 1

=============================================================================
