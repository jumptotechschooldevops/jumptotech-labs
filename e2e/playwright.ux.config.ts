/**
 * Playwright configuration for the browser UX suite — TEST ONLY.
 *
 * The production web bundle (apps/web/dist, from `npm run build`) served by
 * `vite preview`, in a real Chromium, against the in-test fake platform
 * (e2e/ux/support/platform.ts). No Docker, no API, no database: each spec sets
 * up exactly the platform behaviour it is about — a slow check, a refused
 * terminal, an expired sign-in — so the suite is deterministic and runs in
 * seconds. What the real services do is the job of the stack suite
 * (playwright.config.ts); this one is about what the browser does with it.
 *
 * Fail closed: the preview server's API and terminal proxies point at a port
 * nothing listens on, so a request the fake platform did not intercept can
 * never reach some other stack running on this machine.
 */
import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_UX_PORT ?? 4790);
const baseURL = `http://127.0.0.1:${port}`;
const nowhere = 'http://127.0.0.1:9';

export default defineConfig({
  testDir: './ux',
  outputDir: './test-results-ux',
  fullyParallel: true,
  workers: process.env.CI ? 2 : 3,
  // No retries: a flake is a finding, not something to paper over.
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { outputFolder: './playwright-report-ux', open: 'never' }]],
  use: {
    baseURL,
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npx vite preview --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: '../apps/web',
    url: baseURL,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { VITE_DEV_API_PROXY: nowhere, VITE_DEV_TERMINAL_PROXY: nowhere },
  },
});
