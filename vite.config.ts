/// <reference types="vitest/config" />
import { defineConfig } from "vite";

// A static site: relative paths, so dist/ works from any folder on any static host.
export default defineConfig({
  base: "./",
  worker: { format: "es" },
  server: { port: 5178 },
  build: { chunkSizeWarningLimit: 4000 },
  test: { environment: "node", setupFiles: ["tests/setup.ts"] },
});
