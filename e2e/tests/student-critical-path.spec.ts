/**
 * E2E-001 … E2E-009 — one student, the whole private-beta critical path, in a
 * real browser against the real stack.
 *
 * One test with steps rather than nine tests: each step depends on the state
 * the previous one created (a signed-in browser, a running sandbox), and a
 * failure report should name the step where the student got stuck.
 */
import { expect, test } from '@playwright/test';
import {
  LAB_ID,
  LAB_TITLE,
  LINUX_001_SOLUTION,
  endAllSessions,
  expectTerminalConnected,
  mySessions,
  ownerContainers,
  runInTerminal,
  signIn,
  uniqueStudent,
} from './support/student.js';

test('a student signs in, completes LINUX-001 in the browser terminal, and the result persists', async ({ page, context }) => {
  const student = uniqueStudent('stu');
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  try {
    await test.step('E2E-001 the production bundle loads and asks an anonymous visitor to sign in', async () => {
      const response = await page.goto('/');
      expect(response?.status()).toBe(200);
      await expect(page.getByRole('heading', { name: 'JumpToTech Labs', level: 1 })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
      // Nothing behind the gate rendered for an anonymous visitor.
      await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
    });

    await test.step('E2E-002 the student signs in through the OIDC provider and holds only an HttpOnly session cookie', async () => {
      await signIn(page, student);
      const cookies = await context.cookies();
      const session = cookies.find((cookie) => cookie.name === 'jtt_session');
      expect(session, 'session cookie').toBeDefined();
      expect(session!.httpOnly).toBe(true);
      expect(session!.sameSite).toBe('Lax');
      // Page scripts cannot read it, and nothing token-shaped is in Web Storage.
      const visible = await page.evaluate(() => ({
        cookie: document.cookie,
        local: Object.keys(window.localStorage),
        session: Object.keys(window.sessionStorage),
      }));
      expect(visible.cookie).not.toContain('jtt_session');
      expect(visible.local.concat(visible.session).filter((key) => /token|session|auth/i.test(key))).toEqual([]);
    });

    await test.step('E2E-003 the dashboard and a learning path render from the live API', async () => {
      await expect(page.getByRole('heading', { level: 1, name: new RegExp(`Welcome.*E2E ${student}`) })).toBeVisible();
      await expect(page.getByText(/\d+ labs across \d+ tracks|How a lab works/).first()).toBeVisible();
      await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Learning Path' }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'DevOps Engineer path' })).toBeVisible();
      await expect(page.getByRole('region', { name: 'Stages, in order' }).getByRole('link', { name: 'Stage 2: Linux' })).toBeVisible();
      await expect(page.getByRole('progressbar', { name: /^DevOps Engineer path: 0 of \d+ labs completed$/ })).toBeVisible();
    });

    await test.step('E2E-004 the student finds and opens the lab from the catalog', async () => {
      await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Labs' }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Lab catalog' })).toBeVisible();
      await page.getByRole('searchbox', { name: 'Search' }).fill(LAB_ID);
      await expect(page.getByRole('status').filter({ hasText: /^Showing 1 of \d+ labs$/ })).toBeVisible();
      // focus + Enter: a click on a link holding visually-hidden text is
      // reported as intercepted by its heading, though a user's click lands.
      await page.getByRole('link', { name: `View lab : ${LAB_TITLE}` }).focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(new RegExp(`#/labs/${LAB_ID}$`));
      await expect(page.getByRole('heading', { level: 1, name: LAB_TITLE })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Launch lab' })).toBeEnabled();
    });

    await test.step('E2E-005 launching creates a real session that the API attributes to this student', async () => {
      await page.getByRole('button', { name: 'Launch lab' }).click();
      await expect(page).toHaveURL(new RegExp(`#/labs/${LAB_ID}/workspace$`));
      await expect(page.locator('.workspace__status')).toContainText('Ready', { timeout: 180_000 });
      const sessions = await mySessions(context);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({ labId: LAB_ID, status: 'ACTIVE' });
      expect(ownerContainers().length).toBeGreaterThanOrEqual(1);
    });

    await test.step('E2E-006 the browser terminal connects to the sandbox and runs commands', async () => {
      await expectTerminalConnected(page);
      expect(await runInTerminal(page, 'whoami')).toBe('student');
      expect(await runInTerminal(page, 'pwd')).toBe('/home/student');
    });

    await test.step('E2E-007a Verify reports an incomplete lab with failing checks before any work', async () => {
      await page.getByRole('button', { name: 'Verify', exact: true }).click();
      const panel = page.locator('section.verify');
      // `path_absent` (app.log was moved, not copied) is already true on an
      // empty home directory; the four creation checks are not.
      await expect(panel).toContainText('Not complete yet — 1 of 5 checks passing', { timeout: 60_000 });
      await expect(panel.locator('.verify__check--fail')).toHaveCount(4);
      await expect(panel).toContainText("No directory found at '/home/student/project'");
    });

    await test.step('E2E-007b the student does the task in the terminal and Verify passes', async () => {
      await runInTerminal(page, LINUX_001_SOLUTION);
      expect(await runInTerminal(page, 'ls ~/project ~/project/archive')).toMatch(/config\.txt.*app\.log/);
      await page.getByRole('button', { name: 'Verify', exact: true }).click();
      const panel = page.locator('section.verify');
      await expect(panel).toContainText('Lab passed — every check passes', { timeout: 60_000 });
      await expect(panel).toContainText('Saved to your progress');
      await expect(panel.locator('.verify__check--pass')).toHaveCount(5);
      await expect(page.locator('.workspace__status')).toContainText('Completed');
    });

    await test.step('E2E-008 a full reload keeps the session, reconnects the terminal, and keeps the result', async () => {
      await page.reload();
      await expect(page.locator('.workspace__status')).toContainText('Ready');
      await expect(page.locator('.workspace__status')).toContainText('Completed');
      await expectTerminalConnected(page);
      // The same sandbox: the student's files are still there.
      expect(await runInTerminal(page, 'ls ~/project/archive')).toBe('app.log');

      await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Progress' }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Your progress' })).toBeVisible();
      await expect(page.getByRole('progressbar', { name: /^Overall: 1 of \d+ labs completed$/ })).toBeVisible();
    });

    await test.step('E2E-009 End lab removes the sandbox and the saved completion survives', async () => {
      await page.goto(`/#/labs/${LAB_ID}/workspace`);
      await expect(page.locator('.workspace__status')).toContainText('Ready');
      await page.getByRole('button', { name: 'End lab' }).click();
      await page.getByRole('alertdialog', { name: 'End this lab?' }).getByRole('button', { name: 'End lab' }).click();
      await expect(page.getByRole('heading', { name: 'Lab ended' })).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText('You completed this lab. It is saved to your progress.')).toBeVisible();

      await expect.poll(async () => (await mySessions(context)).length, { timeout: 60_000 }).toBe(0);
      await expect.poll(() => ownerContainers().length, { timeout: 90_000, intervals: [2_000] }).toBe(0);
    });

    expect(pageErrors, 'uncaught page errors').toEqual([]);
  } finally {
    await endAllSessions(context);
  }
});

test('Reset gives a student a fresh environment, reconnects the terminal, and keeps a completed result', async ({ page, context }) => {
  test.setTimeout(600_000);
  const student = uniqueStudent('reset');
  try {
    await signIn(page, student);
    await page.goto(`/#/labs/${LAB_ID}`);
    await page.getByRole('button', { name: 'Launch lab' }).click();
    await expect(page.locator('.workspace__status')).toContainText('Ready', { timeout: 180_000 });
    await expectTerminalConnected(page);
    await runInTerminal(page, LINUX_001_SOLUTION);
    await page.getByRole('button', { name: 'Verify', exact: true }).click();
    await expect(page.locator('section.verify')).toContainText('Lab passed — every check passes', { timeout: 60_000 });
    const before = (await mySessions(context))[0]!;

    await test.step('the student confirms Reset', async () => {
      await page.getByRole('group', { name: 'Lab actions' }).getByRole('button', { name: 'Reset', exact: true }).click();
      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toContainText('Files, running processes and shell history are lost.');
      await dialog.getByRole('button', { name: 'Reset lab' }).click();
    });

    await test.step('the same session comes back Ready on a fresh sandbox, and what the student types at once reaches the fresh shell', async () => {
      // The dialog stays open until the reset has answered; the page then
      // reconnects the terminal. A student starts typing as soon as the dialog
      // is gone, while that connection is still being set up. Those keys used
      // to be dropped before the shell was ready (a command arrived truncated,
      // or not at all), so this types exactly once, with no retry.
      await expect(page.getByRole('alertdialog')).toBeHidden({ timeout: 240_000 });
      expect(await runInTerminal(page, 'test -e ~/project && echo present || echo absent', 60_000)).toBe('absent');
      await expectTerminalConnected(page);
      await expect(page.locator('.workspace__status')).toContainText('Ready');
      const after = await mySessions(context);
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({ sessionId: before.sessionId, status: 'ACTIVE' });
    });

    await test.step('the completed result is kept; Verify grades the fresh sandbox', async () => {
      await expect(page.locator('.workspace__status')).toContainText('Completed');
      await page.getByRole('button', { name: 'Verify', exact: true }).click();
      await expect(page.locator('section.verify')).toContainText('Not complete yet — 1 of 5 checks passing', { timeout: 60_000 });
    });
  } finally {
    await endAllSessions(context);
  }
});

test('reloading while the lab is still being created finds it again and connects when it is ready', async ({ page, context }) => {
  test.setTimeout(600_000);
  const student = uniqueStudent('reload');
  try {
    await signIn(page, student);
    await page.goto(`/#/labs/${LAB_ID}`);
    await page.getByRole('button', { name: 'Launch lab' }).click();
    await expect(page).toHaveURL(new RegExp(`#/labs/${LAB_ID}/workspace$`));
    // Reload at once, before the start request can have answered.
    await page.reload();

    await expect(page.locator('.workspace__status')).toContainText('Ready', { timeout: 240_000 });
    await expectTerminalConnected(page, 120_000);
    expect(await runInTerminal(page, 'whoami')).toBe('student');
    const sessions = await mySessions(context);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ labId: LAB_ID, status: 'ACTIVE' });
  } finally {
    await endAllSessions(context);
  }
});

test('opening the lab in a second tab takes the terminal over; Reconnect in the first takes it back', async ({ page, context }) => {
  test.setTimeout(600_000);
  const student = uniqueStudent('tabs');
  try {
    await signIn(page, student);
    await page.goto(`/#/labs/${LAB_ID}`);
    await page.getByRole('button', { name: 'Launch lab' }).click();
    await expect(page.locator('.workspace__status')).toContainText('Ready', { timeout: 180_000 });
    await expectTerminalConnected(page);
    await runInTerminal(page, 'echo first-tab > ~/tab.txt');

    const second = await context.newPage();
    await second.goto(`/#/labs/${LAB_ID}/workspace`);
    await expectTerminalConnected(second);
    expect(await runInTerminal(second, 'cat ~/tab.txt')).toBe('first-tab');

    await test.step('the first tab says why it was disconnected, and does not claim the lab ended', async () => {
      await expect(page.getByText('Disconnected — this terminal was opened in another tab or window.')).toBeVisible({ timeout: 60_000 });
      await expect(page.locator('.workspace__status')).toContainText('Ready');
    });

    await test.step('Reconnect in the first tab takes the terminal back', async () => {
      await page.getByRole('button', { name: 'Reconnect' }).click();
      await expectTerminalConnected(page, 60_000);
      await expect(page.locator('.xterm-rows')).toContainText(/student@[^:\s]+:~\$/, { timeout: 30_000 });
      expect(await runInTerminal(page, 'cat ~/tab.txt')).toBe('first-tab');
      await expect(second.getByText('Disconnected — this terminal was opened in another tab or window.')).toBeVisible({ timeout: 60_000 });
    });
    await second.close();
  } finally {
    await endAllSessions(context);
  }
});
