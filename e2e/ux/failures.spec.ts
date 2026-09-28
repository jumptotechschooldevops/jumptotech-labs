/**
 * When the platform or the network fails: what the student sees, whether it
 * tells them to wait, retry or reload, and whether it recovers by itself.
 *
 * Retry delays are skipped with Playwright's clock, never slept through.
 */
import { actionButton, expect, expectTerminalConnected, launch, openSignedIn, terminalState, test } from './support/fixture.js';

test.describe('the terminal', () => {
  test('refused every time: says it could not connect, retries a bounded number of times, then Try again recovers', async ({ page, platform }) => {
    await page.clock.install();
    platform.refuseTerminal = 1000;
    await openSignedIn(page, platform, undefined, '#/labs/LINUX-001');
    await page.getByRole('button', { name: 'Launch lab' }).click();

    const overlay = page.getByRole('alert').filter({ hasText: 'The terminal could not connect' });
    await expect(overlay).toBeVisible();
    await expect(overlay).toContainText('Trying again automatically…');
    // Try again is offered through the automatic retries, not only after them.
    await expect(overlay.getByRole('button', { name: 'Try again' })).toBeVisible();

    // The automatic retries run out (about a minute), and stop.
    for (let i = 0; i < 8; i += 1) await page.clock.runFor(30_000);
    await expect(overlay).not.toContainText('Trying again automatically…');
    const attempts = platform.terminalOpened;
    expect(attempts, 'first connection plus six automatic retries').toBe(7);
    await page.clock.runFor(120_000);
    expect(platform.terminalOpened, 'no retries after giving up').toBe(attempts);

    platform.refuseTerminal = 0;
    await overlay.getByRole('button', { name: 'Try again' }).click();
    await expectTerminalConnected(page);
  });

  test('lost after working: says so, reconnects by itself to one terminal, and keeps what was on screen', async ({ page, platform }) => {
    await openSignedIn(page, platform);
    await launch(page);
    await page.locator('.terminal-surface').click();
    await page.keyboard.type('echo before-the-drop');
    await expect(page.locator('.xterm-rows')).toContainText('before-the-drop');

    await platform.dropTerminals(1006);
    await expect(terminalState(page)).toContainText('Connection to the terminal was lost. Reconnecting…');
    await expect(page.getByRole('button', { name: 'Reconnect' })).toBeVisible();

    await expectTerminalConnected(page);
    await expect(page.locator('.xterm-rows')).toContainText('before-the-drop');
    await expect.poll(() => platform.openSockets.size).toBe(1);
  });

  test('Reconnect pressed again and again ends with one connected terminal, not several', async ({ page, platform }) => {
    await openSignedIn(page, platform);
    await launch(page);
    platform.refuseTerminal = 1;
    await platform.dropTerminals(1006);
    const reconnect = page.getByRole('button', { name: 'Reconnect' });
    await expect(reconnect).toBeVisible();
    for (let i = 0; i < 5; i += 1) {
      if (await reconnect.isVisible()) await reconnect.click({ timeout: 1_000 }).catch(() => undefined);
    }
    await expectTerminalConnected(page);
    await expect.poll(() => platform.openSockets.size).toBe(1);
  });

  test('an expired terminal token is replaced once, without asking the student, and never leaked', async ({ page, platform }) => {
    await openSignedIn(page, platform);
    await launch(page);
    const grantsBefore = platform.count(/\/terminal$/);
    platform.refuseTokens = 1;
    await platform.dropTerminals(1006);
    await expectTerminalConnected(page);
    await expect(page.locator('body')).not.toContainText('jwt expired');
    await expect(page.locator('.xterm-rows')).not.toContainText('kid terminal-2');
    // Exactly one fresh token after the refusal.
    expect(platform.count(/\/terminal$/)).toBe(grantsBefore + 1);
  });
});

test.describe('the API', () => {
  test('unreachable when the app opens: says so, says what to do, and Try again recovers', async ({ page, platform }) => {
    await platform.signIn(page.context(), `http://127.0.0.1:${process.env.E2E_UX_PORT ?? 4790}`, { subject: 'ux|alice', displayName: 'Alice Student' });
    let down = true;
    await page.route('**/auth/session', (route) => (down ? route.abort('connectionrefused') : route.fallback()));
    await page.goto('/');
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('Cannot reach the labs API.');
    await expect(page.locator('main')).toContainText('Check your internet connection');

    down = false;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  });

  test('unreachable during Verify: a network problem, told as one — never a failed task', async ({ page, platform }) => {
    await openSignedIn(page, platform);
    await launch(page);
    platform.abortNext('check');
    await actionButton(page, 'Verify').click();
    const verify = page.locator('section.verify');
    await expect(verify).toContainText('Cannot reach JumpToTech Labs');
    await expect(verify).toContainText('Check your internet connection, then try again.');
    await expect(verify).not.toContainText('Not complete yet');
    await expect(page.locator('body')).not.toContainText('docker compose');

    await actionButton(page, 'Verify').click();
    await expect(verify).toContainText('Not complete yet');
  });

  test('a failing status poll shows one quiet line, and it clears when the platform answers again', async ({ page, platform }) => {
    await page.clock.install();
    await openSignedIn(page, platform);
    await launch(page);
    await expect.poll(() => platform.count(/^GET \/api\/sessions\/[^/]+$/)).toBeGreaterThanOrEqual(1);

    platform.failNext('session', { status: 502, code: 'BAD_GATEWAY', message: 'upstream connect error or disconnect/reset before headers. reset reason: connection failure' });
    await page.clock.runFor(16_000);
    const banner = page.getByText('Having trouble reaching the platform. Retrying…');
    await expect(banner).toBeVisible();
    await expect(banner).toHaveCount(1);
    await expect(page.locator('body')).not.toContainText('upstream connect error');

    await page.clock.runFor(16_000);
    await expect(banner).toHaveCount(0);
    await expectTerminalConnected(page);
  });

  test('progress that cannot be read is said to be unavailable, never shown as nothing done', async ({ page, platform }) => {
    // Both first reads: the app's, and the dashboard's own refresh on arrival.
    for (let i = 0; i < 2; i += 1) {
      platform.failNext('progress', { status: 503, code: 'PROGRESS_UNAVAILABLE', message: 'progress store: ECONNREFUSED 172.18.0.5:5432' });
    }
    await openSignedIn(page, platform);
    const panel = page.getByRole('complementary', { name: 'Progress summary' });
    await expect(panel).toContainText('Progress is unavailable right now');
    await expect(panel).not.toContainText('0 of 3');
    await expect(page.locator('body')).not.toContainText('172.18.0.5');

    await panel.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('progressbar', { name: '0 of 3 labs completed', exact: true })).toBeVisible();
  });

  test('the workspace code failing to download (a blip, or a deploy mid-visit) ends in Reload, not a blank page', async ({ page, platform }) => {
    let block = true;
    await page.route(/\/assets\/WorkspacePage-[^/]+\.js$/, (route) => (block ? route.abort('connectionreset') : route.fallback()));
    await openSignedIn(page, platform, undefined, '#/labs/LINUX-001');
    await page.getByRole('button', { name: 'Launch lab' }).click();
    const alert = page.getByRole('alert').filter({ hasText: 'This page could not be shown' });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('A running lab keeps running');
    // Other pages still work meanwhile.
    await alert.getByRole('link', { name: 'Go to your dashboard' }).click();
    await expect(page.getByRole('heading', { level: 1, name: /Welcome/ })).toBeVisible();

    block = false;
    await page.goto('/#/labs/LINUX-001/workspace');
    await page.reload();
    await expectTerminalConnected(page);
    expect(platform.count(/start$/)).toBe(1);
  });

  test('a session list that cannot be read is not reported as "not running"', async ({ page, platform }) => {
    await openSignedIn(page, platform);
    await launch(page);
    platform.failNext('sessions', { status: 500, code: 'INTERNAL_ERROR', message: 'relation "sessions" does not exist' });
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'We could not check whether this lab is running' })).toBeVisible();
    await expect(page.getByRole('heading', { name: /is not running/ })).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('relation');

    await page.getByRole('button', { name: 'Try again' }).click();
    await expectTerminalConnected(page);
  });
});
