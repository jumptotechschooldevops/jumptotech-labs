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
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LAB_ID,
  apiGet,
  apiSend,
  endAllSessions,
  LINUX_001_SOLUTION,
  expectTerminalConnected,
  mySessions,
  runInTerminal,
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

test('an account the identity provider refuses lands on the sign-in screen, told the beta is invitation-only', async ({ page, context }) => {
  // How the private beta is restricted (D3): the provider turns a non-invited
  // account away, back to /auth/callback with error=access_denied. That page
  // used to be the API's JSON error body.
  const base = new URL(process.env.E2E_BASE_URL!);
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'E2E test identity provider' })).toBeVisible();
  await page.getByLabel('Username').fill(uniqueStudent('not-invited'));
  await page.getByRole('button', { name: 'Sign in' }).click();

  await page.waitForURL((url) => url.origin === base.origin && url.pathname === '/');
  await expect(page.getByRole('alert')).toContainText('This beta is open only to invited students');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
  // The reason is taken out of the address bar, and nothing was signed in.
  await expect.poll(() => new URL(page.url()).search).toBe('');
  expect((await context.cookies()).find((c) => c.name === 'jtt_session')).toBeUndefined();
  expect((await apiGet(context, '/api/sessions')).status()).toBe(401);
  expect(await page.content()).not.toContain('AUTH_REFUSED');
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

/** Stop or re-create a real platform service of this stack (e2e/stack.sh service). */
function stackService(action: 'stop' | 'start' | 'recreate' | 'restart', service: 'api' | 'terminal' | 'postgres'): void {
  const stack = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../stack.sh');
  execFileSync('bash', [stack, 'service', action, service], { stdio: 'inherit', timeout: 420_000 });
}

function containerAddress(service: 'api'): string {
  const project = process.env.E2E_PROJECT ?? 'jtt-e2e';
  return execFileSync(
    'docker',
    ['ps', '-q', '--filter', `label=com.docker.compose.project=${project}`, '--filter', `label=com.docker.compose.service=${service}`],
    { encoding: 'utf8', timeout: 15_000 },
  )
    .split('\n')
    .filter(Boolean)
    .map((id) => execFileSync('docker', ['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}', id], { encoding: 'utf8' }).trim())
    .join(',');
}

test('api stopped and re-created mid-lab (an operator `up -d api`): the lab stays open and works again', async ({ page, context }) => {
  test.setTimeout(600_000);
  const student = uniqueStudent('apirecreate');
  let apiStopped = false;
  try {
    await signIn(page, student);
    await page.goto(`/#/labs/${LAB_ID}`);
    await page.getByRole('button', { name: 'Launch lab' }).click();
    await expect(page.locator('.workspace__status')).toContainText('Ready', { timeout: 180_000 });
    await expectTerminalConnected(page);
    await runInTerminal(page, 'mkdir -p ~/project && echo kept > ~/project/marker');
    const before = containerAddress('api');

    await test.step('the api goes away; the student returns to the tab', async () => {
      stackService('stop', 'api');
      apiStopped = true;
      // What a student switching back to this tab triggers: a session re-check.
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await expect(page.getByRole('status').filter({ hasText: 'Cannot reach the labs API right now' })).toBeVisible({ timeout: 30_000 });
    });

    await test.step('the workspace and its open terminal are still there', async () => {
      await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(0);
      await expect(page.locator('.workspace__status')).toContainText('Ready');
      expect(await runInTerminal(page, 'cat ~/project/marker')).toBe('kept');
    });

    await test.step('the api is re-created; the edge routes to the new container and the banner clears', async () => {
      stackService('recreate', 'api');
      apiStopped = false;
      console.log(`api address before ${before}, after ${containerAddress('api')}`);
      await page.getByRole('status').filter({ hasText: 'Cannot reach the labs API right now' }).getByRole('button', { name: 'Try again' }).click();
      await expect(page.getByText('Cannot reach the labs API right now')).toHaveCount(0, { timeout: 30_000 });
    });

    await test.step('server actions work again through the edge: Verify grades the same sandbox', async () => {
      await page.getByRole('button', { name: 'Verify', exact: true }).click();
      // Only the project directory exists; the other creation checks still fail.
      await expect(page.locator('section.verify')).toContainText(/Not complete yet — \d of 5 checks passing/, { timeout: 90_000 });
      expect(await runInTerminal(page, 'cat ~/project/marker')).toBe('kept');
      expect(await mySessions(context)).toMatchObject([{ labId: LAB_ID, status: 'ACTIVE' }]);
    });
  } finally {
    if (apiStopped) stackService('recreate', 'api');
    await endAllSessions(context);
  }
});

test('terminal service re-created mid-lab: the workspace reconnects by itself to the same sandbox', async ({ page, context }) => {
  test.setTimeout(600_000);
  const student = uniqueStudent('termrecreate');
  try {
    await signIn(page, student);
    await page.goto(`/#/labs/${LAB_ID}`);
    await page.getByRole('button', { name: 'Launch lab' }).click();
    await expect(page.locator('.workspace__status')).toContainText('Ready', { timeout: 180_000 });
    await expectTerminalConnected(page);
    await runInTerminal(page, 'mkdir -p ~/project && echo survived > ~/project/marker');

    await test.step('the terminal container is replaced while the socket is open', async () => {
      stackService('recreate', 'terminal');
    });

    await test.step('without a click, the terminal connects again and the sandbox still has the file', async () => {
      await expectTerminalConnected(page, 120_000);
      await expect(page.getByRole('button', { name: 'Reconnect' })).toHaveCount(0);
      expect(await runInTerminal(page, 'cat ~/project/marker')).toBe('survived');
      expect(await mySessions(context)).toMatchObject([{ labId: LAB_ID, status: 'ACTIVE' }]);
    });
  } finally {
    await endAllSessions(context);
  }
});

test('database restarted mid-lab: the lab keeps running, and sessions and progress work again', async ({ page, context }) => {
  test.setTimeout(600_000);
  const student = uniqueStudent('dbrestart');
  try {
    await signIn(page, student);
    await page.goto(`/#/labs/${LAB_ID}`);
    await page.getByRole('button', { name: 'Launch lab' }).click();
    await expect(page.locator('.workspace__status')).toContainText('Ready', { timeout: 180_000 });
    await expectTerminalConnected(page);
    await runInTerminal(page, LINUX_001_SOLUTION);

    await test.step('PostgreSQL restarts under the running platform', async () => {
      stackService('restart', 'postgres');
    });

    await test.step('the terminal was not disturbed', async () => {
      await expectTerminalConnected(page);
      expect(await runInTerminal(page, 'ls ~/project/archive')).toBe('app.log');
    });

    await test.step('once the api reconnects, the session is read back and a passing Verify is saved', async () => {
      // Bounded: the pool must recover on its own, without an api restart.
      await expect.poll(async () => (await apiGet(context, '/api/sessions')).status(), { timeout: 90_000, intervals: [2_000] }).toBe(200);
      expect(await mySessions(context)).toMatchObject([{ labId: LAB_ID, status: 'ACTIVE' }]);
      await page.getByRole('button', { name: 'Verify', exact: true }).click();
      await expect(page.locator('section.verify')).toContainText('Lab passed — every check passes', { timeout: 90_000 });
      await expect(page.locator('section.verify')).toContainText('Saved to your progress');
    });

    await test.step('the saved result survives a reload', async () => {
      await page.reload();
      await expect(page.locator('.workspace__status')).toContainText('Completed', { timeout: 60_000 });
    });
  } finally {
    await endAllSessions(context);
  }
});

test('database down while a student is signed in: the sign-in is not thrown away, and works again with the same cookie', async ({ page, context }) => {
  test.setTimeout(600_000);
  const student = uniqueStudent('dbdown');
  let stopped = false;
  try {
    await signIn(page, student);
    await page.goto('/#/help');
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    const cookieBefore = (await context.cookies()).find((c) => c.name === 'jtt_session')?.value;
    expect(cookieBefore).toBeTruthy();

    await test.step('PostgreSQL stops', async () => {
      stackService('stop', 'postgres');
      stopped = true;
    });

    await test.step('the session check says it could not check, and does not clear the cookie', async () => {
      const response = await apiGet(context, '/auth/session');
      expect(response.status()).toBe(503);
      expect((await response.json()).error.code).toBe('AUTH_UNAVAILABLE');
      expect(response.headers()['set-cookie'] ?? '').not.toMatch(/jtt_session=;/);
      const api = await apiGet(context, '/api/sessions');
      expect(api.status()).toBe(503);
    });

    await test.step('the tab coming back re-checks the sign-in, and the app stays signed in', async () => {
      // Wait for the re-check itself to come back refused, rather than for a
      // fixed time: what matters is the app's state after that answer.
      const recheck = page.waitForResponse((r) => new URL(r.url()).pathname === '/auth/session' && r.status() === 503, { timeout: 60_000 });
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await recheck;
      // The app has taken that answer in (its banner says so), and it stayed
      // signed in: a sign-in screen would have replaced it instead.
      await expect(page.getByText('Cannot reach the labs API right now.')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'E2E test identity provider' })).toHaveCount(0);
      expect((await context.cookies()).find((c) => c.name === 'jtt_session')?.value).toBe(cookieBefore);
    });

    await test.step('PostgreSQL returns: the same cookie works, with no new sign-in', async () => {
      stackService('start', 'postgres');
      stopped = false;
      await expect.poll(async () => (await apiGet(context, '/api/sessions')).status(), { timeout: 120_000, intervals: [2_000] }).toBe(200);
      const session = await apiGet(context, '/auth/session');
      expect((await session.json()).data.authenticated).toBe(true);
      expect((await context.cookies()).find((c) => c.name === 'jtt_session')?.value).toBe(cookieBefore);
    });
  } finally {
    if (stopped) stackService('start', 'postgres');
    await endAllSessions(context);
  }
});
