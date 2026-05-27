# TALE real-trace evaluation — Azure 2023 LLM inference trace

Replays a **real production output-length distribution** through the TALE streaming meter (Layer 1),
replacing the synthetic heavy-tailed draws of [PROPOSAL.md](PROPOSAL.md). It upgrades the cost-axis
evaluation from "synthetic, single-machine" to "real distribution" — the single biggest reviewer
critique on TALE. Reproduce: `npx tsx research/cost-uncertainty/real-trace-eval.ts` (fetches the trace;
machine-readable summary in `real-trace-eval.json`).

## Dataset

**`AzureLLMInferenceTrace_conv`** (2023) — the dataset behind *Splitwise* (ISCA'24). Columns
`TIMESTAMP, ContextTokens, GeneratedTokens`; we use `GeneratedTokens` as the realized output length.
Public and **token-counts-only** (no prompt content, by Azure's GDPR design). Source:
`https://raw.githubusercontent.com/Azure/AzurePublicDataset/master/data/AzureLLMInferenceTrace_conv.csv`.
Not committed (size/license); fetched at run time.

## The real distribution (heavy-tailed, as claimed)

| n | mean | p50 | p90 | p99 | max |
|---:|---:|---:|---:|---:|---:|
| 19,366 | 211 | 129 | 424 | 601 | 1000 |

Tail ratio `max/p50 = 7.8×`. p50 (129) ≪ the service's 1000-token cap — exactly the regime where
reserving `max_tokens` sterilizes most of the reservation.

## Result — TALE meter on the real trace (budget `L=50,000`, `C=32` concurrent streams, `g=1`)

| cap `m` | reserve-max: Δ / efficiency | admit-then-count: Δ | streaming: Δ / efficiency |
|---:|---:|---:|---:|
| 256 | 0 / **0.60** | 7,223 | **0** / 1.00 |
| 512 | 0 / 0.41 | 11,140 | **0** / 1.00 |
| 1024 | 0 / 0.21 | 10,709 | **0** / 1.00 |
| 2048 | 0 / 0.10 | 10,709 | **0** / 1.00 |
| 4096 | 0 / **0.05** | 10,709 | **0** / 1.00 |

- **reserve-max** never overshoots, but its *reservation efficiency* `E[min(len,m)]/m` collapses
  `0.60 → 0.05` as the cap grows — at a 4096 cap it wastes **95%** of every reservation on this trace.
- **admit-then-count** is fully efficient but overshoots the budget by **7k–11k tokens (≈14–22% of
  `L`)** — real 32-way concurrency realized at the boundary.
- **streaming (`g=1`)** is the only scheme with **`Δ=0` *and* efficiency `1.0` at every cap** — it
  meters actual tokens, so neither the heavy tail nor concurrency hurts it.

This is the §5 thesis, confirmed on production data: the two corners each fail on one axis; the
streaming meter wins both.

## Honest caveats

- **The trace caps generated tokens at 1000**, so the *unbounded-in-`max_tokens`* growth of
  admit-then-count is only demonstrable up to the trace's own support — overshoot plateaus once
  `m ≥ ~1024` because no real request exceeds 1000. The synthetic sweep ([../hotnets2026/fig2.svg]) shows
  the unbounded growth; the real trace confirms the *effect and its sign* on production lengths.
- This is single-machine simulation against a real *distribution*, **not** a distributed deployment;
  the at-scale distributed evaluation remains the full paper's open systems work.
- The overshoot magnitude scales with the chosen `C` and `L`; the qualitative result
  (admit-then-count `Δ>0`, streaming `Δ=0`, reserve-max efficiency collapse) is invariant to them.
