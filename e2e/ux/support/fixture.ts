/**
 * The UX suite's test fixture: a fresh fake platform per test, installed
 * before the page loads anything, and three checks after every test:
 *
 *   - the page made no request the fake platform did not expect;
 *   - the page threw no uncaught error;
 *   - nothing was written to localStorage or sessionStorage.
 */
import { test as base, expect, type Page } from '@playwright/test';
import { FakePlatform, type Student } from './platform.js';

export { expect };

export const ALICE: Student = { subject: 'ux|alice', displayName: 'Alice Student' };
export const BOB: Student = { subject: 'ux|bob', displayName: 'Bob Student' };

export const test = base.extend<{ platform: FakePlatform }>({
  platform: async ({ page }, use) => {
    const platform = new FakePlatform();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await platform.install(page);
    await use(platform);
    expect(platform.unexpected, 'requests the fake platform does not know').toEqual([]);
    expect(pageErrors, 'uncaught errors in the page').toEqual([]);
    if (!page.isClosed()) {
      const stored = await page
        .evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) }))
        .catch(() => ({ local: [], session: [] }));
      expect(stored, 'browser storage').toEqual({ local: [], session: [] });
    }
  },
});

/** Open the app already signed in as `student` (the sign-in flow itself is covered separately). */
export async function openSignedIn(page: Page, platform: FakePlatform, student: Student = ALICE, hash = '#/'): Promise<void> {
  await platform.signIn(page.context(), baseUrl(), student);
  await page.goto(`/${hash}`);
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

export function baseUrl(): string {
  return `http://127.0.0.1:${process.env.E2E_UX_PORT ?? 4790}`;
}

/** Launch a lab from its page and wait until its terminal is connected. */
export async function launch(page: Page, labId = 'LINUX-001'): Promise<void> {
  await page.goto(`/#/labs/${labId}`);
  await page.getByRole('button', { name: 'Launch lab' }).click();
  await expectTerminalConnected(page);
}

export const terminalState = (page: Page) => page.locator('.terminal-bar__state');

export async function expectTerminalConnected(page: Page): Promise<void> {
  await expect(terminalState(page)).toHaveText(/Terminal: Connected$/);
}

export const actions = (page: Page) => page.getByRole('group', { name: 'Lab actions' });
export const actionButton = (page: Page, name: 'Verify' | 'Reset' | 'End lab') =>
  actions(page).getByRole('button', { name, exact: true });

/** Confirm End in its dialog and wait for the summary. */
export async function endLab(page: Page): Promise<void> {
  await actionButton(page, 'End lab').click();
  await page.getByRole('alertdialog', { name: 'End this lab?' }).getByRole('button', { name: 'End lab' }).click();
  await expect(page.getByRole('heading', { name: /Lab ended/ })).toBeVisible();
}

/** How far the document is wider than the window, in CSS pixels. 0 is right. */
export function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}
