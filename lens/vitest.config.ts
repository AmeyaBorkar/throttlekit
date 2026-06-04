import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Standalone package. Resolve the `throttlekit` import to the local monorepo SOURCE, which carries the
// @experimental Lens telemetry primitives (admissionTap / withAdmissionAnalytics) that are not yet in the
// published throttlekit package. Vitest transpiles the TS source on the fly, so no prior build is needed.
const throttlekitSrc = fileURLToPath(new URL("../src/index.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: { throttlekit: throttlekitSrc },
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
});
