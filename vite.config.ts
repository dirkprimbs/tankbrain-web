/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

// A static site: relative paths, so dist/ works from any folder on any static host.
export default defineConfig({
  base: "./",
  define: { __APP_VERSION__: JSON.stringify(version) },
  worker: { format: "es" },
  server: { port: 5178 },
  build: { chunkSizeWarningLimit: 4000 },
  test: { environment: "node", setupFiles: ["tests/setup.ts"] },
});
