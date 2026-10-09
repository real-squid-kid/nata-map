import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './scripts/browser',
  testMatch: 'no-server.spec.js',
  outputDir: './var/qa/results',
  workers: 1,
  timeout: 30000,
  reporter: 'list',
  use: {
    channel: 'msedge',
    headless: true,
    baseURL: 'http://127.0.0.1:5173',
    viewport: { width: 1440, height: 960 },
    screenshot: 'off',
    trace: 'off',
  },
});
