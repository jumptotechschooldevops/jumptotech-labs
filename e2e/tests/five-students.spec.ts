/**
 * Five students at once, in five browsers, on one stack — the private-beta
 * capacity contract (MAX_ACTIVE_SESSIONS=5, one lab per student) driven through
 * the real UI rather than the API harness.
 *
 * Five separate browser contexts sign in through the identity provider and
 * press Launch at the same moment. Each must get a Ready lab, a working
 * terminal on its own sandbox, and its own verification result, at the same
 * time as the others. A sixth student is refused in words. After the five end
 * their labs, the sixth can start one.
 *
 * What this is not: a capacity measurement. It runs on a development machine
 * with Linux sandboxes only; host sizing is proven on the host
 * (production-host-readiness.md §13).
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import {
  LAB_ID,
  LINUX_001_SOLUTION,
  endAllSessions,
  expectTerminalConnected,
  mySessions,
  ownerContainers,
  runInTerminal,
  signIn,
  uniqueStudent,
} from './support/student.js';

interface Student {
  name: string;
  context: BrowserContext;
  page: Page;
}

test('five students work at the same time on isolated labs; a sixth is refused until one ends', async ({ browser }) => {
  test.setTimeout(900_000);
  const students: Student[] = [];
  const all: BrowserContext[] = [];

  try {
    await test.step('five students sign in, each in their own browser context', async () => {
      for (let i = 1; i <= 5; i += 1) {
        const context = await browser.newContext();
        all.push(context);
        const page = await context.newPage();
        const name = uniqueStudent(`five-${i}`);
        await signIn(page, name);
        await page.goto(`/#/labs/${LAB_ID}`);
        await expect(page.getByRole('button', { name: 'Launch lab' })).toBeEnabled();
        students.push({ name, context, page });
      }
    });

    await test.step('all five press Launch together and every lab becomes Ready', async () => {
      await Promise.all(students.map(({ page }) => page.getByRole('button', { name: 'Launch lab' }).click()));
      await Promise.all(
        students.map(({ page }) => expect(page.locator('.workspace__status')).toContainText('Ready', { timeout: 300_000 })),
      );
      const ids = new Set<string>();
      for (const { context } of students) {
        const sessions = await mySessions(context);
        expect(sessions).toHaveLength(1);
        expect(sessions[0]).toMatchObject({ labId: LAB_ID, status: 'ACTIVE' });
        ids.add(sessions[0]!.sessionId);
      }
      expect(ids.size).toBe(5);
      expect(ownerContainers().length).toBeGreaterThanOrEqual(5);
    });

    await test.step('five terminals are connected at once, each to its own sandbox', async () => {
      await Promise.all(students.map(({ page }) => expectTerminalConnected(page)));
      for (const { name, page } of students) await runInTerminal(page, `echo ${name} > ~/whoami.txt`);
      for (const { name, page } of students) {
        expect(await runInTerminal(page, 'cat ~/whoami.txt')).toBe(name);
      }
    });

    await test.step('verification runs for all five at the same time, and each result is its own', async () => {
      // Students 1–3 finish the task; 4 and 5 do not.
      for (const { page } of students.slice(0, 3)) await runInTerminal(page, LINUX_001_SOLUTION);
      await Promise.all(students.map(({ page }) => page.getByRole('button', { name: 'Verify', exact: true }).click()));
      await Promise.all(
        students.map(({ page }, i) =>
          expect(page.locator('section.verify')).toContainText(
            i < 3 ? 'Lab passed — every check passes' : 'Not complete yet — 1 of 5 checks passing',
            { timeout: 120_000 },
          ),
        ),
      );
    });

    const sixth = await browser.newContext();
    all.push(sixth);
    const sixthPage = await sixth.newPage();

    await test.step('a sixth student is told every environment is in use', async () => {
      await signIn(sixthPage, uniqueStudent('five-6'));
      await sixthPage.goto(`/#/labs/${LAB_ID}`);
      await sixthPage.getByRole('button', { name: 'Launch lab' }).click();
      await expect(sixthPage.getByText('All lab environments are in use').first()).toBeVisible({ timeout: 60_000 });
      await expect(sixthPage.getByText('LAB_CAPACITY_REACHED').first()).toBeVisible();
      expect(await mySessions(sixth)).toEqual([]);
    });

    await test.step('when the five end their labs, capacity is released and the sixth can start', async () => {
      await Promise.all(students.map(({ context }) => endAllSessions(context)));
      // End is asynchronous: a session is ENDING until its sandbox is gone.
      for (const { context } of students) {
        await expect.poll(() => mySessions(context), { timeout: 120_000, intervals: [1_000] }).toEqual([]);
      }
      // The refusal left the student on the workspace with "Try again".
      await sixthPage.getByRole('button', { name: 'Try again', exact: true }).click();
      await expect(sixthPage.locator('.workspace__status')).toContainText('Ready', { timeout: 180_000 });
      await expectTerminalConnected(sixthPage);
      await endAllSessions(sixth);
    });
  } finally {
    await Promise.all(all.map((context) => endAllSessions(context)));
    await Promise.all(all.map((context) => context.close()));
  }
});
