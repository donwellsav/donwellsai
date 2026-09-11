import { defineConfig } from '@playwright/test'

/**
 * Playwright E2E config for Donwells.ai Electron app.
 *
 * Starts Electron via the main entry point, connects to CDP for automation.
 * Run with: npx playwright test
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  retries: 1,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'electron',
      testMatch: /.*\.e2e\.ts/,
    },
  ],
})
