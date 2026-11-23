/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `--mode single` builds one classic (non-module) script + one stylesheet with stable names,
// which scripts/inline-build.mjs then folds into a single self-contained HTML file.
// In development the game server runs separately (npm run dev starts both); /ws is proxied to it
// so the client can always use its own origin.
const serverProxy = { "/ws": { target: "ws://localhost:8787", ws: true } };

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: "./",
  server: { proxy: serverProxy },
  preview: { proxy: serverProxy },
  build:
    mode === "single"
      ? {
          outDir: "dist-single",
          modulePreload: false,
          cssCodeSplit: false,
          rollupOptions: {
            output: {
              format: "iife",
              inlineDynamicImports: true,
              entryFileNames: "app.js",
              assetFileNames: "app[extname]",
            },
          },
        }
      : { outDir: "dist" },
  test: { environment: "node", include: ["src/**/*.test.ts", "server/**/*.test.ts"] },
}));
