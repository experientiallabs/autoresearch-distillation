import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  use: {
    baseURL: "http://127.0.0.1:3327",
    launchOptions: { args: ["--use-mock-keychain"] },
  },
  webServer: {
    command: "npm run start -- --hostname 127.0.0.1 --port 3327",
    url: "http://127.0.0.1:3327",
    reuseExistingServer: false,
  },
});
