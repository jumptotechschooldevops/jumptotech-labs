/**
 * Playwright configuration for the real-browser E2E suite — TEST ONLY.
 *
 * The suite drives a running stack (e2e/stack.sh): the nginx-served production
 * web bundle, the api in OIDC mode, PostgreSQL, the terminal service, sandboxd
 * and a real Linux sandbox container per session. Nothing in the browser or the
 * backend is mocked, except where a failure-path test says so explicitly.
 *
 * It runs serially on purpose. Students are capped at one session each and the
 * stack at five, and the tests create real containers; parallel workers would
 * turn capacity refusals into flakes.
 */
import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL;
if (!baseURL) {
  // Fail closed: a missing target must never fall back to some default that
  // might be another stack on this machine.
  throw new Error('E2E_BASE_URL is not set. Run the suite with `npm run test:e2e` (starts the stack), or set it for a running one.');
}

export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  globalSetup: './global-setup.ts',
  fullyParallel: false,
  workers: 1,
  // No retries: a flake is a finding, not something to paper over.
  retries: 0,
  forbidOnly: !!process.env.CI,
  // A lab start creates a container and waits for its setup checks.
  timeout: 240_000,
  expect: { timeout: 20_000 },
  reporter: [
    ['list'],
    ['html', { outputFolder: './playwright-report', open: 'never' }],
  ],
  use: {
    baseURL,
    headless: true,
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
