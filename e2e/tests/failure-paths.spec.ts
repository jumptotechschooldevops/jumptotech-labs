/**
 * Failure paths a beta student can hit. Each must end in a clear message and a
 * way forward, never an indefinite spinner.
 *
 * Two of these inject the failure in the browser (Playwright network routing),
 * because the real services cannot be made to fail on cue without disturbing
 * the rest of the suite. Those tests say so in their names. Everything else is
 * the real stack refusing something for real.
 */
import { expect, test } from '@playwright/test';
import {
  LAB_ID,
  apiGet,
  apiSend,
  endAllSessions,
  expectTerminalConnected,
  mySessions,
  signIn,
  uniqueStudent,
} from './support/student.js';

test('[injected] API unreachable: the app says so and recovers on retry', async ({ page }) => {
  let block = true;
  await page.route('**/auth/session', (route) => (block ? route.abort('connectionrefused') : route.continue()));

  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('Cannot reach the labs API.');
  const retry = page.getByRole('button', { name: 'Try again' });
  await expect(retry).toBeVisible();

  block = false;
  await retry.click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
});

test('anonymous and forged sessions get nothing; sign-out revokes the cookie server-side', async ({ page, context, browser }) => {
  await test.step('no cookie: the API refuses and the app shows the sign-in gate', async () => {
    expect((await apiGet(context, '/api/sessions')).status()).toBe(401);
    expect((await apiSend(context, 'POST', `/api/labs/${LAB_ID}/start`)).status()).toBe(401);
    await page.goto(`/#/labs/${LAB_ID}/workspace`);
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });

  await test.step('a forged session cookie is anonymous', async () => {
    const forged = await browser.newContext();
    const url = new URL(process.env.E2E_BASE_URL!);
    await forged.addCookies([
      { name: 'jtt_session', value: 'A'.repeat(43), domain: url.hostname, path: '/', httpOnly: true, sameSite: 'Lax' },
    ]);
    const forgedPage = await forged.newPage();
    await forgedPage.goto('/');
    await expect(forgedPage.getByRole('button', { name: 'Sign in' })).toBeVisible();
    expect((await apiGet(forged, '/api/sessions')).status()).toBe(401);
    await forged.close();
  });

  await test.step('after Sign out, replaying the old cookie is refused', async () => {
    const student = uniqueStudent('out');
    await signIn(page, student);
    const cookie = (await context.cookies()).find((c) => c.name === 'jtt_session');
    expect(cookie).toBeDefined();

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();

    // Put the pre-sign-out value back: the server must have destroyed it.
    await context.addCookies([cookie!]);
    expect((await apiGet(context, '/api/sessions')).status()).toBe(401);
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });
});

test('a second lab while one is running is refused clearly (one lab per student)', async ({ page, context }) => {
  const student = uniqueStudent('limit');
  try {
    await signIn(page, student);
    await page.goto(`/#/labs/${LAB_ID}`);
    await page.getByRole('button', { name: 'Launch lab' }).click();
    await expect(page.locator('.workspace__status')).toContainText('Ready', { timeout: 180_000 });

    await test.step('the UI explains the limit and links back to the running lab', async () => {
      await page.goto('/#/labs/LINUX-002');
      await expect(page.getByRole('heading', { name: 'You already have a lab running' })).toBeVisible();
      await expect(page.getByRole('link', { name: `Continue ${LAB_ID}` })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Launch lab' })).toHaveCount(0);
    });

    await test.step('the server enforces it too, whatever the page shows', async () => {
      const response = await apiSend(context, 'POST', '/api/labs/LINUX-002/start');
      expect(response.status()).toBe(429);
      expect(((await response.json()) as { error?: { code?: string } }).error?.code).toBe('STUDENT_SESSION_LIMIT_REACHED');
      expect(await mySessions(context)).toMatchObject([{ labId: LAB_ID }]);
    });
  } finally {
    await endAllSessions(context);
  }
});

test('[injected] terminal WebSocket refused: the workspace says it could not connect, and Try again recovers', async ({ page, context }) => {
  const student = uniqueStudent('ws');
  let refuse = true;
  await page.routeWebSocket(/\/terminal/, (ws) => {
    if (refuse) {
      ws.close({ code: 1011, reason: 'injected by e2e' });
      return;
    }
    ws.connectToServer();
  });

  try {
    await signIn(page, student);
    await page.goto(`/#/labs/${LAB_ID}`);
    await page.getByRole('button', { name: 'Launch lab' }).click();
    await expect(page.locator('.workspace__status')).toContainText('Ready', { timeout: 180_000 });

    // Bounded: the page must reach a stated failure, not spin.
    await expect(page.getByText('The terminal could not connect')).toBeVisible({ timeout: 60_000 });

    refuse = false;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expectTerminalConnected(page, 60_000);
  } finally {
    await endAllSessions(context);
  }
});
