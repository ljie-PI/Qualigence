import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // The suite now spans many I/O-heavy files (SQLite, mTLS/gRPC, Playwright,
    // envelope crypto). Under full-suite parallelism the default 5s timeout is
    // occasionally too tight purely from CPU/IO contention, not from a slow
    // test itself. Raise the ceiling repo-wide instead of tuning each file.
    testTimeout: 20_000,
  },
});
