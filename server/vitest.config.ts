import { defineConfig } from "vitest/config";

// The server is a standalone package with its own install. Without this config, vitest walks up and
// loads the repo-root vitest.config.ts — whose `vitest` import isn't resolvable from the server's own
// node_modules in CI (the server CI job installs only `server/`). Pinning the config here keeps the
// server's tests self-contained: rooted at this package, resolving vitest from `server/node_modules`.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
