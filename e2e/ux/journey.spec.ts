/**
 * The student journey in a real browser, and what a reload does to it.
 *
 * sign in → dashboard → learning path → lab → Launch → terminal → hint →
 * Verify (fail) → work → Verify (pass) → End → summary → next lab → dashboard,
 * with a reload at each state that holds something the student would miss.
 */
import { Gate } from './support/platform.js';
import { ALICE, actionButton, endLab, expect, expectTerminalConnected, launch, openSignedIn, test, terminalState } from './support/fixture.js';

test('a student goes from sign-in to a completed lab and on to the next one, without a dead end', async ({ page, platform }) => {
  await test.step('sign in from the gate, and land back where they started', async () => {
    platform.nextSignIn = ALICE;
    await page.goto('/#/paths/devops-engineer');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'DevOps Engineer path' })).toBeVisible();
  });

  await test.step('dashboard → lab page → Launch', async () => {
    await page.getByRole('link', { name: 'Dashboard' }).click();
    await expect(page.getByRole('heading', { level: 1, name: /Welcome, Alice Student/ })).toBeVisible();
    await page.goto('/#/labs/LINUX-001');
    await page.getByRole('button', { name: 'Launch lab' }).click();
    await expect(page).toHaveURL(/#\/labs\/LINUX-001\/workspace$/);
    await expectTerminalConnected(page);
    await expect(page.locator('.workspace__status')).toContainText('Ready');
  });

  await test.step('what the student types reaches the shell', async () => {
    await page.locator('.terminal-surface').click();
    await page.keyboard.type('ls project');
    await expect(page.locator('.xterm-rows')).toContainText('ls project');
  });

  await test.step('a hint, then a failing Verify that says what to look at', async () => {
    await page.getByRole('button', { name: 'Show a hint' }).click();
    await expect(page.getByRole('region', { name: 'Hints' })).toContainText('Hint 1');
    await actionButton(page, 'Verify').click();
    await expect(page.locator('section.verify')).toContainText('Not complete yet');
    await expect(page.locator('section.verify')).toContainText('What to look at next');
  });

  await test.step('the work is done; Verify passes and says it was saved', async () => {
    platform.solved.add(platform.current().session.sessionId);
    await actionButton(page, 'Verify').click();
    await expect(page.locator('section.verify')).toContainText('Lab passed — every check passes');
    await expect(page.locator('section.verify')).toContainText('Saved to your progress');
    await expect(page.locator('.workspace__status')).toContainText('Completed');
  });

  await test.step('End: the summary names the next lab, which opens ready to launch', async () => {
    await endLab(page);
    await expect(page.getByText('You completed this lab. It is saved to your progress.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Next recommended lab' })).toBeVisible();
    await expect(page.locator('.recommendation')).toContainText('LINUX-002 File Permissions');
    const next = page.getByRole('link', { name: /^Continue learning\s*: LINUX-002$/ });
    await next.click();
    await expect(page.getByRole('heading', { level: 1, name: 'File Permissions' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Launch lab' })).toBeEnabled();
  });

  await test.step('the dashboard counts the completed lab and shows nothing running', async () => {
    await page.getByRole('link', { name: 'Dashboard' }).click();
    await expect(page.getByRole('progressbar', { name: '1 of 3 labs completed', exact: true })).toBeVisible();
    await expect(page.locator('.active-lab')).toHaveCount(0);
  });

  expect(platform.count(/^POST \/api\/labs\/.*\/start$/)).toBe(1);
});

test('a reload keeps a running lab: same session, terminal back, revealed hints still shown, no second start', async ({ page, platform }) => {
  await openSignedIn(page, platform);
  await launch(page);
  const sessionId = platform.current().session.sessionId;
  await page.getByRole('button', { name: 'Show a hint' }).click();
  await page.getByRole('button', { name: 'Show hint 2' }).click();
  await expect.poll(() => platform.hints.get(platform.current().attempt.attemptId)?.size).toBe(2);
  await actionButton(page, 'Verify').click();
  await expect(page.locator('section.verify')).toContainText('Not complete yet');

  await page.reload();

  await expectTerminalConnected(page);
  expect(platform.current().session.sessionId).toBe(sessionId);
  const hints = page.getByRole('region', { name: 'Hints' });
  await expect(hints).toContainText('Hint 1');
  await expect(hints).toContainText('Hint 2');
  await expect(hints.getByText('2 of 2')).toBeVisible();
  // A verdict belongs to the visit that asked for it; the page says so plainly.
  await expect(page.locator('section.verify')).toContainText('Not verified yet');
  expect(platform.count(/^POST \/api\/labs\/.*\/start$/)).toBe(1);
  // One terminal open after the reload, not one per page load.
  await expect.poll(() => platform.openSockets.size).toBe(1);
});

// Known defect on main, fixed in its own PR: a completed lab reached after its summary is gone says only 'not running'.
test.fixme('a reload after a pass keeps the lab completed; a reload after End does not bring the lab back', async ({ page, platform }) => {
  await openSignedIn(page, platform);
  await launch(page);
  platform.solved.add(platform.current().session.sessionId);
  await actionButton(page, 'Verify').click();
  await expect(page.locator('.workspace__status')).toContainText('Completed');

  await page.reload();
  await expectTerminalConnected(page);
  await expect(page.locator('.workspace__status')).toContainText('Completed');
  await expect(page.locator('section.verify')).toContainText('You have already completed this lab');

  await endLab(page);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'LINUX-001 is not running' })).toBeVisible();
  // The summary is gone with the reload; the completion is not.
  await expect(page.getByText('You have completed this lab. It is saved to your progress.')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Lab actions' })).toHaveCount(0);
  await expect(page.locator('.active-lab')).toHaveCount(0);
  await expect(terminalState(page)).toHaveCount(0);
});

test('a reload while the terminal is still connecting connects once, to the same lab', async ({ page, platform }) => {
  await openSignedIn(page, platform);
  await launch(page);
  const gate = (platform.terminalGate = new Gate());
  await page.reload();
  await gate.reached;
  await expect(page.getByText('Connecting to your terminal…')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Verify', exact: true })).toBeEnabled();
  gate.open();
  platform.terminalGate = null;
  await expectTerminalConnected(page);
  await expect.poll(() => platform.openSockets.size).toBe(1);
});
