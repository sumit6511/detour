import { defineConfig, devices } from "@playwright/test";

// Runs against the production build served by `vite preview`. Set PW_CHROMIUM_PATH to use a
// Chromium that's already installed instead of Playwright's own download.
const executablePath = process.env.PW_CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 90_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:4173",
    trace: "off",
    launchOptions: { executablePath },
  },
  // The production server: the built game plus the multiplayer socket on one port.
  webServer: {
    command: "npm run build && npm run build:server && node server-dist/index.mjs",
    env: { PORT: "4173", STATIC_DIR: "dist" },
    port: 4173,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1360, height: 900 } } },
    { name: "phone", use: { ...devices["Pixel 7"] } },
  ],
});
