/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `--mode single` builds one classic (non-module) script + one stylesheet with stable names,
// which scripts/inline-build.mjs then folds into a single self-contained HTML file.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: "./",
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
  test: { environment: "node" },
}));
