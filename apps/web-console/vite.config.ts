import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The Web Console is a static SPA. In production it is served by a reverse
// proxy / Server static route — there is no Web Console Node process. The
// Public API base URL is injected at runtime via `window.__QUALIGENCE_CONFIG__`
// (see `src/config.ts`), so the same immutable bundle works for Local and
// every Self-hosted deployment without a rebuild.
export default defineConfig({
  plugins: [react()],
  build: {
    target: "es2022",
    outDir: "dist",
    sourcemap: true,
  },
  server: {
    port: 5173,
  },
});
