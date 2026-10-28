import { defineConfig, devices } from '@playwright/test';

// Адрес превью задаётся E2E_BASE_URL; без него приложение собирается и запускается локально.
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

export default defineConfig({
  testDir: '.',
  retries: process.env.CI ? 2 : 0,
  reporter: [['list'], ['html', { outputFolder: '../../playwright-report', open: 'never' }]],
  outputDir: '../../test-results',
  use: { baseURL, trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'pnpm --filter web build && pnpm --filter web start',
        url: 'http://localhost:3000/healthz',
        reuseExistingServer: !process.env.CI,
        timeout: 300_000,
      },
});
