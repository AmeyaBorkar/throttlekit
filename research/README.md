# research/ — what's here, and what's kept local

This tree holds the **evidence** behind ThrottleKit's formal claims: the design records, the
machine-checked gates, and the eval data that back the shipped features. None of it ships in the npm
package (`package.json#files` is an allowlist of `dist` + the top-level docs).

**Public, tracked here:**

- **Design records** — `bigger-bets/*/DESIGN.md`, `postgres-coordinator/DESIGN.md`,
  `regional-escrow/DESIGN.md`: the decision records (D-…) for each shipped mechanism.
- **Verification gates** — the `*-gate.ts` simulators and model-checkers that a feature had to pass
  before it shipped (e.g. `bigger-bets/federation/federated-wfe-gate.ts`).
- **Eval data** — the `.ts` simulators and their `.json` / `.csv` / `.svg` outputs.

The shipped behaviour is additionally pinned by the public test suite under [`test/`](../test) (e.g.
`test/gale/`, `test/twotier/`, the BFS twins under `test/concurrency/`).

**Kept LOCAL (not in this public repo):** the strategic roadmap and the unpublished paper drafts —
`bigger-bets/PLAN.md`, `gale/*.md` (the GALE proposal + paper sections), `cost-uncertainty/*.md` (the
TALE proposal + analysis), and `hotnets2026/` (the HotNets draft). They live on the maintainer's disk
and are git-ignored. Some design records and changelog notes reference them by path; those pointers
resolve for the maintainer, and the public claims they support are reproduced by the public gates,
eval data, and tests listed above.
