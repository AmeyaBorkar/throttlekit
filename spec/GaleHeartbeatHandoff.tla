------------------------- MODULE GaleHeartbeatHandoff -------------------------
(***************************************************************************)
(* GALE research spec: a HARD instantaneous `Sum(inflight) <= L` bound for    *)
(* distributed adaptive concurrency under ASYNC heartbeats (TK-1330). The     *)
(* async sibling of MODULE GaleHeartbeatLeasing.                              *)
(*                                                                         *)
(* WHY A SECOND MODULE. GaleHeartbeatLeasing is SYNCHRONOUS: it has ONE share  *)
(* variable per node -- the coordinator's COMMITTED share and the guard's      *)
(* APPLIED share are identical, grant replies are instantaneous. Under the     *)
(* occupancy cap (D-DAC-18) it proves InflightCap == Sum(inflight) <= L in     *)
(* that model. The async IMPLEMENTATION has three lags that model collapses to *)
(* zero, leaving 0.10.0 with a bounded (~1.5x), self-draining residual:        *)
(*   committed != applied  -- a grant reply has latency; the guard enforces     *)
(*                            the last grant that LANDED, not the last COMMITTED.*)
(*   reporting lag         -- the coordinator's view of a peer (ackIdx,         *)
(*                            repInflight) lags, advancing only on a heartbeat.  *)
(*   non-revocable inflight-- a held slot drains only on completion; after a    *)
(*                            share is lowered, inflight can exceed it.          *)
(* This module models all three and asks: what coordinator reserve rule makes   *)
(* Sum(inflight) <= L a HARD instantaneous invariant of the ASYNC system?       *)
(*                                                                         *)
(* THE MODEL. Per node n the coordinator issues a sequence of grants; hist[n]   *)
(* is those grant VALUES in issue (= sequence) order. The guard applies grants   *)
(* MONOTONICALLY by seq: appliedIdx[n] (the index it enforces) only ever moves  *)
(* UP -- an older grant that lands later is dropped (the shipped issue-seq guard *)
(* in distributed.ts). OUT-OF-ORDER delivery is Deliver moving appliedIdx to ANY *)
(* higher index. The coordinator's lagging view is ackIdx[n] (confirmed applied  *)
(* index) and repInflight[n], advanced together by Report (one heartbeat).       *)
(*                                                                         *)
(* THE RESERVE RULE (validated -- see WHAT IS PROVED). For each peer n:          *)
(*   Reserve(n) == Max(MaxUnacked(n), repInflight[n])                            *)
(*   MaxUnacked(n) == max grant VALUE over hist[n] at seq >= ackIdx[n]           *)
(* and a (re)grant to m is capped at L - Sum over peers of Reserve. The crux:    *)
(* MaxUnacked reserves on what the coordinator ITSELF ISSUED (lag-free) rather   *)
(* than on a laggy peer report -- so a grant a peer may still apply but has not  *)
(* yet acked is reserved even before the peer reports it. This closes the        *)
(* reporting-lag hole that the weaker `max(committed, reported_applied,          *)
(* reported_inflight)` rule (HARD-ASYNC-BOUND.md S2) leaves open.                *)
(*                                                                         *)
(* WHAT IS PROVED (constant L). Both bounds hold for EVERY async interleaving:   *)
(*   GlobalCap   == Sum(committed share over active) <= L  (never over-COMMIT).  *)
(*   InflightCap == Sum(inflight       over active) <= L  (never over-OCCUPY) -- *)
(*                  now HARD and INSTANTANEOUS in the ASYNC model, not merely    *)
(*                  synchronous. This is the bound GaleHeartbeatLeasing could    *)
(*                  give only synchronously; the acknowledged-handoff reserve     *)
(*                  lifts it to the async system at the cost of ramp latency      *)
(*                  (a joiner waits for incumbents' lowered shares to land AND     *)
(*                  be reported). InflightCapTight witnesses it reaches L (no      *)
(*                  steady-state capacity lost).                                  *)
(*                                                                         *)
(* MINIMALITY (proven in the BFS twin, not re-encoded here). Dropping MaxUnacked *)
(* back to `max(committed, reported_applied)` REFUTES InflightCap (a late-landing *)
(* un-acked high grant -- the 1.5x residual). Dropping repInflight REFUTES it     *)
(* (non-revocable in-flight draining below a lowered+acked share). The two terms  *)
(* are each necessary; their union is sufficient.                                *)
(*                                                                         *)
(* REQUIRED PROTOCOL CONSTRAINT (adversarial verification, 3 skeptics). Report is *)
(* ATOMIC here: it advances ackIdx and repInflight from the SAME instant. A TORN  *)
(* report (fresh seq + stale inflight) REFUTES InflightCap -- the coordinator      *)
(* prunes MaxUnacked while repInflight is stale-low, under-reserving a draining    *)
(* node. The implementation MUST sample (appliedSeq, inflight) atomically per      *)
(* heartbeat and apply both transactionally (incl. across coordinator failover).   *)
(* The twin pins this as a negative regression test.                              *)
(*                                                                         *)
(* VERIFIED WITH TLC 2.19 (OpenJDK 17), Nodes={n1,n2} L=4 K=3: TypeOK, GlobalCap   *)
(* and InflightCap hold on ALL 250,624 reachable states (search depth 37, no error).*)
(* InflightCapTight is VIOLATED (TLC exhibits inflight=(n1:4,n2:0), Sum=L), so L is  *)
(* the LEAST upper bound -- the hard async bound loses no steady-state capacity.     *)
(* The committed Java-free twin test/concurrency/distributed-async-leasing-model.ts  *)
(* (TK-1330) is the CI oracle (no Java in CI): it walks the space exhaustively and    *)
(* asserts the same invariants, plus the MINIMALITY refutations and the torn-report   *)
(* negative test. NOTE the twin canonicalizes by TRIMMING each node's dead grant       *)
(* prefix for BFS finiteness, whereas this module bounds Len(hist) <= K via a state    *)
(* CONSTRAINT; distinct-state COUNTS therefore differ (twin trims, TLC does not), but  *)
(* the INVARIANTS are identical. K in {2,3} agree in the twin (the hazard saturates at *)
(* 2 outstanding grants).                                                             *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
    Nodes,   \* set of node identities, e.g. {n1, n2}
    L,       \* the constant global concurrency budget for this heartbeat epoch
    K        \* max outstanding grant history per node (bounds the model for TLC)

VARIABLES
    active,       \* subset of Nodes currently heartbeating
    hist,         \* hist[n]: Seq of grant VALUES issued to n, in seq order
    appliedIdx,   \* appliedIdx[n]: index in hist[n] the guard enforces (0 = none)
    inflight,     \* inflight[n]: current in-flight at the guard (non-revocable)
    ackIdx,       \* ackIdx[n]: coordinator's CONFIRMED applied index (0 = none)
    repInflight   \* repInflight[n]: coordinator's last-reported in-flight for n

vars == << active, hist, appliedIdx, inflight, ackIdx, repInflight >>

Min2(a, b) == IF a < b THEN a ELSE b
Max2(a, b) == IF a > b THEN a ELSE b
Ceil(a, b) == (a + b - 1) \div b

\* An upper bound on any single node's fair share this epoch (as in the
\* synchronous module; the SAFETY bound depends only on the cap, not the target).
Target == Ceil(L, Cardinality(active))

\* AppliedVal(n): the share value the guard currently enforces (0 if none landed).
AppliedVal(n) == IF appliedIdx[n] = 0 THEN 0 ELSE hist[n][appliedIdx[n]]

\* Committed(n): the latest share the coordinator has issued (= last in hist).
Committed(n) == IF Len(hist[n]) = 0 THEN 0 ELSE hist[n][Len(hist[n])]

\* MaxUnacked(n): the max grant VALUE among grants the coordinator issued to n at
\* a seq >= the index n has acknowledged applying -- everything n could still be
\* enforcing or could still apply (the guard is monotone, so it will only move to
\* a seq >= ackIdx[n]). Computed from the coordinator's OWN issue history (lag-free).
RECURSIVE SuffixMaxFrom(_, _)
SuffixMaxFrom(n, i) == IF i > Len(hist[n]) THEN 0
                       ELSE Max2(hist[n][i], SuffixMaxFrom(n, i + 1))
MaxUnacked(n) == SuffixMaxFrom(n, Max2(1, ackIdx[n]))

\* THE validated acknowledged-handoff reserve: the union of the max un-acked grant
\* (defends a late-landing high grant) and the last-reported in-flight (defends
\* non-revocable occupancy draining below a lowered share). Both terms necessary.
Reserve(n) == Max2(MaxUnacked(n), repInflight[n])

RECURSIVE SumReserve(_)
SumReserve(S) == IF S = {} THEN 0
                 ELSE LET x == CHOOSE y \in S : TRUE
                      IN Reserve(x) + SumReserve(S \ {x})

RECURSIVE SumInflight(_)
SumInflight(S) == IF S = {} THEN 0
                  ELSE LET x == CHOOSE y \in S : TRUE
                       IN inflight[x] + SumInflight(S \ {x})

RECURSIVE SumCommitted(_)
SumCommitted(S) == IF S = {} THEN 0
                   ELSE LET x == CHOOSE y \in S : TRUE
                        IN Committed(x) + SumCommitted(S \ {x})

ASSUME HandoffAssumptions ==
    /\ Nodes # {}
    /\ L \in Nat
    /\ K \in Nat \ {0}

TypeOK ==
    /\ active \subseteq Nodes
    /\ active # {}
    /\ hist \in [Nodes -> Seq(0..L)]
    /\ appliedIdx \in [Nodes -> 0..K]
    /\ inflight \in [Nodes -> 0..L]
    /\ ackIdx \in [Nodes -> 0..K]
    /\ repInflight \in [Nodes -> 0..L]
    /\ \A n \in Nodes : appliedIdx[n] <= Len(hist[n])
    /\ \A n \in Nodes : ackIdx[n] <= appliedIdx[n]   \* coordinator never ahead of guard

Init ==
    /\ active \in { s \in SUBSET Nodes : s # {} }   \* any nonempty starting fleet
    /\ hist = [n \in Nodes |-> << >>]               \* cold start: no grants issued
    /\ appliedIdx = [n \in Nodes |-> 0]
    /\ inflight = [n \in Nodes |-> 0]
    /\ ackIdx = [n \in Nodes |-> 0]
    /\ repInflight = [n \in Nodes |-> 0]

\* Reallocate(n): the coordinator (re)grants n a share, CAPPED at the budget no
\* OTHER active peer is reserving (acknowledged-handoff Reserve), and appends it as
\* the newest grant. Bounded by K outstanding grants for TLC finiteness.
Reallocate(n) ==
    /\ n \in active
    /\ Len(hist[n]) < K
    /\ LET g == Max2(0, Min2(Target, L - SumReserve(active \ {n})))
       IN hist' = [hist EXCEPT ![n] = Append(hist[n], g)]
    /\ UNCHANGED << active, appliedIdx, inflight, ackIdx, repInflight >>

\* Deliver(n): a grant reply LANDS at the guard. Monotone: appliedIdx moves UP to
\* ANY higher index (out-of-order delivery -- an OLD grant at a low-but-still-ahead
\* index can land late); lower-seq grants are then dead (the monotonic guard).
Deliver(n) ==
    /\ n \in active
    /\ appliedIdx[n] < Len(hist[n])
    /\ \E i \in (appliedIdx[n] + 1)..Len(hist[n]) :
         appliedIdx' = [appliedIdx EXCEPT ![n] = i]
    /\ UNCHANGED << active, hist, inflight, ackIdx, repInflight >>

\* Report(n): one heartbeat. The coordinator's view of n catches up to the guard's
\* truth. ATOMIC -- ackIdx and repInflight advance from the SAME instant (a TORN
\* report refutes InflightCap; see the header and the twin's negative test).
Report(n) ==
    /\ n \in active
    /\ \/ ackIdx[n] # appliedIdx[n]
       \/ repInflight[n] # inflight[n]
    /\ ackIdx' = [ackIdx EXCEPT ![n] = appliedIdx[n]]
    /\ repInflight' = [repInflight EXCEPT ![n] = inflight[n]]
    /\ UNCHANGED << active, hist, appliedIdx, inflight >>

\* Acquire(n): admit one request -- only while below the guard's APPLIED share.
Acquire(n) ==
    /\ n \in active
    /\ inflight[n] < AppliedVal(n)
    /\ inflight' = [inflight EXCEPT ![n] = @ + 1]
    /\ UNCHANGED << active, hist, appliedIdx, ackIdx, repInflight >>

\* Release(n): a request on n completes (drains non-revocable in-flight).
Release(n) ==
    /\ inflight[n] > 0
    /\ inflight' = [inflight EXCEPT ![n] = @ - 1]
    /\ UNCHANGED << active, hist, appliedIdx, ackIdx, repInflight >>

\* Join(n): a new node enters cold -- no grants, nothing applied or in flight, so
\* an incumbent's outstanding share/occupancy is never double-counted.
Join(n) ==
    /\ n \notin active
    /\ active' = active \cup {n}
    /\ hist' = [hist EXCEPT ![n] = << >>]
    /\ appliedIdx' = [appliedIdx EXCEPT ![n] = 0]
    /\ inflight' = [inflight EXCEPT ![n] = 0]
    /\ ackIdx' = [ackIdx EXCEPT ![n] = 0]
    /\ repInflight' = [repInflight EXCEPT ![n] = 0]

\* Leave(n): a node departs; its budget + in-flight + coordinator view are reclaimed.
Leave(n) ==
    /\ n \in active
    /\ Cardinality(active) > 1
    /\ active' = active \ {n}
    /\ hist' = [hist EXCEPT ![n] = << >>]
    /\ appliedIdx' = [appliedIdx EXCEPT ![n] = 0]
    /\ inflight' = [inflight EXCEPT ![n] = 0]
    /\ ackIdx' = [ackIdx EXCEPT ![n] = 0]
    /\ repInflight' = [repInflight EXCEPT ![n] = 0]

Next ==
    \E n \in Nodes :
        \/ Reallocate(n) \/ Deliver(n) \/ Report(n)
        \/ Acquire(n) \/ Release(n) \/ Join(n) \/ Leave(n)

Spec == Init /\ [][Next]_vars

(***************************************************************************)
(* Invariants.                                                              *)
(***************************************************************************)

\* The coordinator never COMMITS more than the global budget (the share term).
GlobalCap == SumCommitted(active) <= L

\* THE result: in-flight never exceeds the global budget -- a HARD, INSTANTANEOUS
\* invariant of the ASYNC model under the acknowledged-handoff reserve. COMMITTED.
InflightCap == SumInflight(active) <= L

\* Tightness witnesses (intentionally FALSE: TLC must exhibit a reachable state
\* with the sum = L, so L is the LEAST upper bound -- the hard bound loses no
\* steady-state capacity). Swap into the .cfg to capture the trace.
GlobalCapTight == SumCommitted(active) <= L - 1
InflightCapTight == SumInflight(active) <= L - 1

\* State constraint for TLC: bound the outstanding grant history per node.
StateBound == \A n \in Nodes : Len(hist[n]) <= K
=================================================================================
