import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    redis: "src/redis/index.ts",
    express: "src/adapters/express.ts",
    fetch: "src/adapters/fetch.ts",
    otel: "src/observability/index.ts",
    testkit: "src/testkit/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  treeshake: true,
  sourcemap: true,
  target: "es2022",
  splitting: false,
  minify: false,
});
