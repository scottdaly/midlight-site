import { defineConfig } from '@playwright/test';

/**
 * Playwright E2E Test Configuration for Midlight Backend API
 *
 * Run tests with:
 *   npm run test:e2e          # Run all API tests
 *
 * Note: Start the server first with `npm run server:dev` before running tests.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30000, // 30 seconds per test
  expect: {
    timeout: 5000, // 5 seconds for assertions
  },
  fullyParallel: true, // API tests can run in parallel
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ['html', { outputFolder: 'playwright-report' }],
    ['list'],
  ],
  use: {
    // Base URL for API requests
    baseURL: process.env.TEST_API_URL || 'http://localhost:3001',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'api',
      testMatch: '**/*.spec.ts',
    },
  ],
  // Output folder for test artifacts
  outputDir: 'test-results/',
  // Start the server before tests
  webServer: {
    command: 'npm run server:dev',
    url: 'http://localhost:3001/health',
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
