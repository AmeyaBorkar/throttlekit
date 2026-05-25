## What & why

What does this change, and what problem does it solve? Link any related issue.

## Checklist

- [ ] `npm run lint` clean (Biome)
- [ ] `npm run typecheck` clean (strict TS)
- [ ] `npm test` green (and `THROTTLEKIT_TEST_REDIS=...` if you touched the Redis path)
- [ ] Added/updated tests for the change
- [ ] Updated docs (README / TSDoc) if behavior or API changed
- [ ] Added a `CHANGELOG.md` entry under `[Unreleased]`
- [ ] For a new strategy: ships **both** the JS transition and the atomic Lua form, with a
      conformance case proving they agree

## Notes for reviewers

Anything tricky, trade-offs made, or follow-ups deliberately left out.
