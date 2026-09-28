/**
 * An impatient student: double clicks, clicks while things load, navigates
 * mid-request, and answers that arrive late.
 *
 * Each test holds one platform request open at the moment that matters, does
 * what a student would do meanwhile, then lets it answer — so the ordering is
 * exact, not a matter of timing.
 */
import { actionButton, endLab, expect, expectTerminalConnected, launch, openSignedIn, test } from './support/fixture.js';

test.describe('Launch', () => {
  test('a double click on Launch sends one start, and the lab page cannot send another while it runs', async ({ page, platform }) => {
    await openSignedIn(page, platform, undefined, '#/labs/LINUX-001');
    const start = platform.hold('start');
    await page.getByRole('button', { name: 'Launch lab' }).dblclick();
    await start.reached;
    await expect(page.getByText('Preparing your lab environment…')).toBeVisible();

    // Back to the lab page while it is still starting: nothing to press twice.
    await page.goBack();
    await expect(page.getByText('Preparing your lab environment…')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Launch lab' })).toHaveCount(0);

    start.open();
    await page.getByRole('link', { name: 'Continue lab' }).click();
    await expectTerminalConnected(page);
    expect(platform.count(/^POST \/api\/labs\/LINUX-001\/start$/)).toBe(1);
  });

  test('leaving the workspace while the lab starts: the app says it is starting, then where it is', async ({ page, platform }) => {
    await openSignedIn(page, platform, undefined, '#/labs/LINUX-001');
    const start = platform.hold('start');
    await page.getByRole('button', { name: 'Launch lab' }).click();
    await start.reached;
    await page.getByRole('link', { name: 'Dashboard' }).click();
    await expect(page.locator('.active-lab')).toHaveText(/Starting LINUX-001…/);

    start.open();
    await expect(page.locator('.active-lab')).toHaveText(/Active lab\s*LINUX-001/);
    await page.locator('.active-lab').click();
    await expectTerminalConnected(page);
    expect(platform.count(/start$/)).toBe(1);
  });

  test('a start that fails says what happened in plain words, and Try again works', async ({ page, platform }) => {
    await openSignedIn(page, platform, undefined, '#/labs/LINUX-001');
    platform.failNext('start', { status: 500, code: 'INTERNAL_ERROR', message: 'TypeError: Cannot read properties of undefined (reading "id")' });
    await page.getByRole('button', { name: 'Launch lab' }).click();
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('The lab could not be started');
    await expect(alert).toContainText('This is not a mistake in your work.');
    await expect(page.locator('body')).not.toContainText('TypeError');

    await page.getByRole('button', { name: 'Try again' }).click();
    await expectTerminalConnected(page);
  });

  test('a Launch the server refuses because another tab started a lab meanwhile explains it and offers that lab', async ({ page, platform }) => {
    await openSignedIn(page, platform, undefined, '#/labs/LINUX-002');
    await expect(page.getByRole('button', { name: 'Launch lab' })).toBeVisible();

    // Another tab of the same student launches LINUX-001; this page does not know yet.
    const other = await page.context().newPage();
    await platform.install(other);
    await other.goto('/#/labs/LINUX-001');
    await other.getByRole('button', { name: 'Launch lab' }).click();
    await expectTerminalConnected(other);
    await other.close();

    await page.getByRole('button', { name: 'Launch lab' }).click();
    const notice = page.getByRole('alert').filter({ hasText: 'You already have a lab running' });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Continue the lab you already have');
    await notice.getByRole('link', { name: 'Continue LINUX-001' }).click();
    await expectTerminalConnected(page);
    expect(platform.liveSessions().length).toBe(1);
  });

  test('a lab page opened while another lab runs offers that lab, not a Launch that would be refused', async ({ page, platform }) => {
    await openSignedIn(page, platform);
    await launch(page, 'LINUX-001');
    await page.goto('/#/labs/LINUX-002');
    await expect(page.getByRole('heading', { name: 'You already have a lab running' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Launch lab' })).toHaveCount(0);
    await page.getByRole('link', { name: 'Continue LINUX-001' }).click();
    await expectTerminalConnected(page);
    expect(platform.count(/start$/)).toBe(1);
  });
});

test.describe('navigation', () => {
  test('a slow lab page that answers after the student moved on does not replace the page they are on', async ({ page, platform }) => {
    await openSignedIn(page, platform);
    const slow = platform.hold('lab');
    await page.goto('/#/labs/LINUX-001');
    await slow.reached;
    await page.goto('/#/labs/K8S-001');
    await expect(page.getByRole('heading', { level: 1, name: 'Create Your First Pod' })).toBeVisible();

    const late = page.waitForResponse((response) => response.url().endsWith('/api/labs/LINUX-001'));
    slow.open();
    await (await late).finished();
    await expect(page.getByRole('heading', { level: 1, name: 'Create Your First Pod' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Files and Directories' })).toHaveCount(0);
  });

  test('Back and Forward through a running lab keep one terminal, connected', async ({ page, platform }) => {
    await openSignedIn(page, platform);
    await launch(page);
    await page.goBack();
    await expect(page.getByRole('link', { name: 'Continue lab' })).toBeVisible();
    await page.goForward();
    await expectTerminalConnected(page);
    await page.goBack();
    await page.goForward();
    await expectTerminalConnected(page);
    await expect.poll(() => platform.openSockets.size).toBe(1);
  });

  test('rapid navigation between the dashboard and a lab leaves the right page and nothing broken', async ({ page, platform }) => {
    await openSignedIn(page, platform);
    for (const hash of ['#/labs/LINUX-001', '#/', '#/labs/LINUX-002', '#/progress', '#/labs/LINUX-001', '#/']) {
      await page.evaluate((h) => (window.location.hash = h), hash);
    }
    await expect(page.getByRole('heading', { level: 1, name: /Welcome/ })).toBeVisible();
    await expect(page.getByRole('main')).not.toContainText('could not be loaded');
  });
});

test.describe('Verify', () => {
  test('a double click on Verify sends one check', async ({ page, platform }) => {
    await openSignedIn(page, platform);
    await launch(page);
    await actionButton(page, 'Verify').dblclick();
    await expect(page.locator('section.verify')).toContainText('Not complete yet');
    expect(platform.count(/\/check$/)).toBe(1);
  });

  test('while Verify runs, Reset waits; the verdict appears once, then Reset clears it', async ({ page, platform }) => {
    await openSignedIn(page, platform);
    await launch(page);
    const check = platform.hold('check');
    await actionButton(page, 'Verify').click();
    await check.reached;
    await expect(page.getByRole('group', { name: 'Lab actions' }).getByRole('button', { name: 'Verifying…' })).toBeDisabled();
    await expect(actionButton(page, 'Reset')).toBeDisabled();
    await expect(page.locator('section.verify')).toContainText('Checking your environment…');

    check.open();
    await expect(page.locator('section.verify')).toContainText('Not complete yet');
    await actionButton(page, 'Reset').click();
    await page.getByRole('alertdialog', { name: 'Reset this lab?' }).getByRole('button', { name: 'Reset lab' }).click();
    await expect(page.getByText('Your environment was reset to its starting state.')).toBeVisible();
    await expect(page.locator('section.verify')).toContainText('Not verified yet');
    await expectTerminalConnected(page);
  });

  test('a Verify still running when the student ends the lab and launches again never grades the new lab', async ({ page, platform }) => {
    await openSignedIn(page, platform);
    await launch(page);
    const first = platform.current().session.sessionId;
    platform.solved.add(first);
    const check = platform.hold('check');
    await actionButton(page, 'Verify').click();
    await check.reached;

    await endLab(page);
    await page.getByRole('button', { name: 'Launch a fresh environment' }).click();
    await expectTerminalConnected(page);
    expect(platform.current().session.sessionId).not.toBe(first);

    check.open();
    // The old answer (a pass, for the lab that ended) arrives. Wait until it has.
    await expect.poll(() => platform.count(/\/check$/)).toBe(1);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('section.verify')).toContainText('Not verified yet');
    await expect(page.locator('.workspace__status')).not.toContainText('Completed');

    await actionButton(page, 'Verify').click();
    await expect(page.locator('section.verify')).toContainText('Not complete yet');
    expect(platform.count(/\/check$/)).toBe(2);
  });

  test('a Verify the platform could not run reads as that, never as a failed task, and leaks nothing', async ({ page, platform }) => {
    await openSignedIn(page, platform);
    await launch(page);
    platform.failNext('check', { status: 502, code: 'ENVIRONMENT_UNREACHABLE', message: 'exec failed: dial tcp 10.89.0.4:2376: i/o timeout' });
    await actionButton(page, 'Verify').click();
    const verify = page.locator('section.verify');
    await expect(verify).toContainText('Verification could not run');
    await expect(verify).toContainText('This is a platform problem, not a mistake in your work.');
    await expect(verify).not.toContainText('10.89.0.4');
    await expect(verify).not.toContainText('Not complete yet');

    await page.reload();
    await expectTerminalConnected(page);
    await expect(verify).toContainText('Not verified yet');
  });
});

test.describe('Reset and End', () => {
  test('a double click on End lab or Reset opens its confirmation and leaves it open to read', async ({ page, platform }) => {
    await openSignedIn(page, platform);
    await launch(page);
    for (const [button, title] of [['End lab', 'End this lab?'], ['Reset', 'Reset this lab?']] as const) {
      await actionButton(page, button).dblclick();
      const dialog = page.getByRole('alertdialog', { name: title });
      await expect(dialog).toBeVisible();
      // Still there once the double click is over, not dismissed by its second press.
      await dialog.getByRole('button', { name: 'Cancel' }).focus();
      await expect(dialog).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
    }
    expect(platform.count(/\/reset$|^DELETE /)).toBe(0);
  });

  test('a double click on "Show a hint" reveals one hint, not two', async ({ page, platform }) => {
    await openSignedIn(page, platform);
    await launch(page);
    await page.getByRole('button', { name: 'Show a hint' }).dblclick();
    await expect(page.getByRole('region', { name: 'Hints' }).getByText('1 of 2')).toBeVisible();
    await expect(page.locator('.hints__item')).toHaveCount(1);
    expect(platform.count(/\/hints$/)).toBe(1);
  });

  test('Reset confirmed twice sends one reset, rebuilds, and reconnects one terminal', async ({ page, platform }) => {
    await openSignedIn(page, platform);
    await launch(page);
    const reset = platform.hold('reset');
    await actionButton(page, 'Reset').click();
    const confirm = page.getByRole('alertdialog', { name: 'Reset this lab?' }).getByRole('button', { name: 'Reset lab' });
    await confirm.dblclick();
    await reset.reached;
    await expect(page.getByText('Resetting your lab environment…').first()).toBeVisible();
    await expect(actionButton(page, 'End lab')).toBeDisabled();

    reset.open();
    await expectTerminalConnected(page);
    expect(platform.count(/\/reset$/)).toBe(1);
    await expect.poll(() => platform.openSockets.size).toBe(1);
  });

  test('End confirmed twice sends one end; the ended lab has no terminal, no actions and no Active lab link', async ({ page, platform }) => {
    await openSignedIn(page, platform);
    await launch(page);
    await actionButton(page, 'End lab').click();
    await page.getByRole('alertdialog', { name: 'End this lab?' }).getByRole('button', { name: 'End lab' }).dblclick();
    await expect(page.getByRole('heading', { name: 'Lab ended' })).toBeVisible();
    expect(platform.count(/^DELETE \/api\/sessions\//)).toBe(1);
    await expect(page.locator('.terminal-surface')).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'Lab actions' })).toHaveCount(0);
    await expect(page.locator('.active-lab')).toHaveCount(0);
    await expect.poll(() => platform.openSockets.size).toBe(0);
  });

  test('End while the terminal is reconnecting: the lab ends, and nothing tries to reconnect afterwards', async ({ page, platform }) => {
    await page.clock.install();
    await openSignedIn(page, platform);
    await launch(page);
    platform.refuseTerminal = 1000;
    await platform.dropTerminals(1006);
    await expect(page.locator('.terminal-bar__state')).toContainText('Reconnecting…');

    await endLab(page);
    const attempts = platform.terminalOpened;
    await page.clock.runFor(120_000);
    expect(platform.terminalOpened, 'reconnect attempts after End').toBe(attempts);
    await expect(page.getByRole('heading', { name: 'Lab ended' })).toBeVisible();
    await expect(page.locator('.terminal-surface')).toHaveCount(0);
  });

  test('an End that fails keeps the lab usable, says so, and can be retried', async ({ page, platform }) => {
    await openSignedIn(page, platform);
    await launch(page);
    platform.failNext('end', { status: 500, code: 'INTERNAL_ERROR', message: 'pg: connection terminated unexpectedly' });
    await actionButton(page, 'End lab').click();
    await page.getByRole('alertdialog', { name: 'End this lab?' }).getByRole('button', { name: 'End lab' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'The lab could not be ended' })).toBeVisible();
    await expect(page.locator('body')).not.toContainText('pg: connection');
    await expect(actionButton(page, 'End lab')).toBeEnabled();
    await expectTerminalConnected(page);

    await endLab(page);
  });

  test('a Reset that fails says so in plain words and leaves Reset and End available', async ({ page, platform }) => {
    await openSignedIn(page, platform);
    await launch(page);
    platform.failNext('reset', { status: 500, code: 'EXEC_FAILED', message: 'docker: Error response from daemon: container 3f2a… is not running' });
    await actionButton(page, 'Reset').click();
    await page.getByRole('alertdialog', { name: 'Reset this lab?' }).getByRole('button', { name: 'Reset lab' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'The lab could not be reset' })).toBeVisible();
    await expect(page.locator('body')).not.toContainText('daemon');
    await expect(actionButton(page, 'Reset')).toBeEnabled();
    await expect(actionButton(page, 'End lab')).toBeEnabled();
  });
});
