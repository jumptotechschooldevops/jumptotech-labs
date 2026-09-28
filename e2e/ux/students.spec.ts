/**
 * Browser state when the student changes — sign out and in as someone else,
 * a sign-in that expires, another tab signed in as a different student, five
 * students side by side.
 *
 * Authorization is the API's job and has its own tests; what is checked here
 * is that nothing one student saw stays on screen, in memory or in storage
 * for the next.
 */
import type { Page } from '@playwright/test';
import { ALICE, BOB, actionButton, baseUrl, expect, expectTerminalConnected, launch, openSignedIn, test } from './support/fixture.js';
import type { Student } from './support/platform.js';

async function storage(page: Page) {
  return page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) }));
}

test('after Alice signs out, Bob signing in on the same browser sees nothing of hers', async ({ page, platform }) => {
  await openSignedIn(page, platform, ALICE);
  await launch(page);
  await page.getByRole('button', { name: 'Show a hint' }).click();
  platform.solved.add(platform.current(ALICE.subject).session.sessionId);
  await actionButton(page, 'Verify').click();
  await expect(page.locator('.workspace__status')).toContainText('Completed');

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  // Alice's terminal is closed with her app, and her place is forgotten.
  await expect.poll(() => platform.openSockets.size).toBe(0);
  expect(new URL(page.url()).hash).toBe('');
  await expect(page.locator('body')).not.toContainText('Alice');

  platform.nextSignIn = BOB;
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Welcome, Bob Student' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('Alice');
  await expect(page.locator('.active-lab')).toHaveCount(0);
  await expect(page.getByRole('progressbar', { name: '0 of 3 labs completed', exact: true })).toBeVisible();
  await expect(page.getByText('No lab attempts yet.')).toBeVisible();

  // Alice's lab, opened by Bob, is a lab he has not started.
  await page.goto('/#/labs/LINUX-001/workspace');
  await expect(page.getByRole('heading', { level: 1, name: 'LINUX-001 is not running' })).toBeVisible();
  await expect(page.locator('.terminal-surface')).toHaveCount(0);
  expect(await storage(page)).toEqual({ local: [], session: [] });
});

test('a sign-in that expires mid-lab says so, and signing back in returns to the same running lab', async ({ page, platform }) => {
  await openSignedIn(page, platform, ALICE);
  await launch(page);
  const sessionId = platform.current(ALICE.subject).session.sessionId;

  platform.revoked.add(ALICE.subject);
  await actionButton(page, 'Verify').click();

  const notice = page.getByRole('alert').filter({ hasText: 'Your sign-in has expired' });
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('Your saved progress is not affected');
  await expect(page.locator('.terminal-surface')).toHaveCount(0);

  platform.nextSignIn = ALICE;
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/#\/labs\/LINUX-001\/workspace$/);
  await expectTerminalConnected(page);
  expect(platform.current(ALICE.subject).session.sessionId).toBe(sessionId);
  expect(platform.count(/start$/)).toBe(1);
});

test('when another tab signs in as a different student, this tab starts afresh as that student', async ({ page, platform }) => {
  await openSignedIn(page, platform, ALICE);
  await launch(page);

  // A second tab in the same browser signs in as Bob (the cookie is shared).
  const other = await page.context().newPage();
  await platform.install(other);
  platform.nextSignIn = BOB;
  await other.goto(`${baseUrl()}/auth/login?returnTo=${encodeURIComponent('/#/')}`);
  await expect(other.getByRole('heading', { level: 1, name: 'Welcome, Bob Student' })).toBeVisible();

  // Alice's tab comes back into view and re-checks who it belongs to.
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByText('Bob Student')).toBeVisible();
  await expect(page.locator('body')).not.toContainText('Alice');
  await expect(page.locator('.terminal-surface')).toHaveCount(0);
  await expect(page.locator('.active-lab')).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1, name: 'LINUX-001 is not running' })).toBeVisible();
  // Alice's terminal socket went with her app.
  await expect.poll(() => platform.openSockets.size).toBe(0);
});

test('five students side by side each see only their own lab, name and progress, and store nothing', async ({ browser, platform }) => {
  const students: Student[] = Array.from({ length: 5 }, (_, i) => ({ subject: `ux|student-${i + 1}`, displayName: `Student ${i + 1}` }));
  const pages = await Promise.all(
    students.map(async (student) => {
      const context = await browser.newContext({ baseURL: baseUrl() });
      const page = await context.newPage();
      await platform.install(page);
      await platform.signIn(context, baseUrl(), student);
      return { student, page };
    }),
  );
  try {
    const labs = ['LINUX-001', 'LINUX-002', 'K8S-001', 'LINUX-001', 'LINUX-002'];
    await Promise.all(
      pages.map(async ({ page }, i) => {
        await page.goto(`/#/labs/${labs[i]}`);
        await page.getByRole('button', { name: 'Launch lab' }).click();
        await expectTerminalConnected(page);
      }),
    );
    await expect.poll(() => platform.openSockets.size).toBe(5);

    // One passes; only that student sees it.
    platform.solved.add(platform.current(students[0]!.subject).session.sessionId);
    await actionButton(pages[0]!.page, 'Verify').click();
    await expect(pages[0]!.page.locator('.workspace__status')).toContainText('Completed');

    for (const [i, { student, page }] of pages.entries()) {
      await expect(page.locator('.user-menu__identity')).toHaveText(student.displayName);
      await expect(page.locator('.active-lab')).toContainText(labs[i]!);
      for (const other of students) {
        if (other !== student) await expect(page.locator('body')).not.toContainText(other.displayName);
      }
      if (i > 0) await expect(page.locator('.workspace__status')).not.toContainText('Completed');
      expect(await storage(page)).toEqual({ local: [], session: [] });
      const cookies = await page.context().cookies();
      expect(cookies.map((cookie) => [cookie.name, cookie.value, cookie.httpOnly])).toEqual([['ux_student', student.subject, true]]);
    }
  } finally {
    await Promise.all(pages.map(({ page }) => page.context().close()));
  }
});
