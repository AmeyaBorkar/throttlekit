import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    redis: "src/redis/index.ts",
    postgres: "src/postgres/index.ts",
    cloudflare: "src/cloudflare/index.ts",
    express: "src/adapters/express.ts",
    fetch: "src/adapters/fetch.ts",
    hono: "src/adapters/hono.ts",
    next: "src/adapters/next.ts",
    fastify: "src/adapters/fastify.ts",
    koa: "src/adapters/koa.ts",
    otel: "src/observability/index.ts",
    testkit: "src/testkit/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  treeshake: true,
  // No sourcemaps in the published package — they more than doubled the tarball and a rate limiter
  // is not something consumers step-debug into. Code + .d.ts ship; ~2.0 MB unpacked → ~400 KB.
  sourcemap: false,
  target: "es2022",
  splitting: false,
  minify: false,
});
