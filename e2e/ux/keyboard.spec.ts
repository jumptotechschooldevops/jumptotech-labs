/**
 * The student workflow with a keyboard only, and where focus goes when the
 * page changes under it.
 *
 * Real Chromium and real xterm.js: focus, Tab order and `:focus-visible` are
 * exactly what jsdom cannot tell us.
 */
import type { Page } from '@playwright/test';
import { actionButton, expect, expectTerminalConnected, launch, openSignedIn, terminalState, test } from './support/fixture.js';

/** A short description of what has keyboard focus. */
function focused(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return 'body';
    if (el.closest('.terminal-surface')) return 'terminal';
    const name = el.getAttribute('aria-label') ?? el.textContent?.trim().replace(/\s+/g, ' ') ?? '';
    return `${el.tagName.toLowerCase()}:${name}`;
  });
}

/** Whether the focused element draws a visible focus indicator. */
function focusRingVisible(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return false;
    const style = getComputedStyle(el);
    return (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) || style.boxShadow !== 'none';
  });
}

test('the first Tab reaches "Skip to content", which moves focus to the page', async ({ page, platform }) => {
  await openSignedIn(page, platform);
  await page.keyboard.press('Tab');
  expect(await focused(page)).toBe('a:Skip to content');
  expect(await focusRingVisible(page)).toBe(true);
  await page.keyboard.press('Enter');
  expect(await focused(page)).toMatch(/^main:/);
});

test('every control reached by Tab on the lab page shows where focus is', async ({ page, platform }) => {
  await openSignedIn(page, platform, undefined, '#/labs/LINUX-001');
  await expect(page.getByRole('button', { name: 'Launch lab' })).toBeVisible();
  const missing: string[] = [];
  for (let i = 0; i < 40; i += 1) {
    await page.keyboard.press('Tab');
    const where = await focused(page);
    if (where === 'body') break;
    if (!(await focusRingVisible(page))) missing.push(where);
    if (where === 'button:Launch lab') break;
  }
  expect(missing, 'focused controls without a visible focus indicator').toEqual([]);
  expect(await focused(page)).toBe('button:Launch lab');
});

test('a lab can be launched, used and left with the keyboard: into the terminal, and out with Shift+Tab', async ({ page, platform }) => {
  await openSignedIn(page, platform, undefined, '#/labs/LINUX-001');
  await page.getByRole('button', { name: 'Launch lab' }).focus();
  await page.keyboard.press('Enter');
  await expectTerminalConnected(page);

  // Connected: the student can type straight away.
  await expect.poll(() => focused(page)).toBe('terminal');
  await page.keyboard.type('pwd');
  await expect(page.locator('.xterm-rows')).toContainText('pwd');

  // Tab belongs to the shell (completion)…
  await page.keyboard.press('Tab');
  expect(await focused(page)).toBe('terminal');
  // …and Shift+Tab hands focus back to the page, as the terminal bar says.
  await expect(page.getByText('Shift+Tab leaves the terminal')).toBeVisible();
  await page.keyboard.press('Shift+Tab');
  expect(await focused(page)).not.toBe('terminal');
  expect(await focused(page)).not.toBe('body');
});

test('Shift+Tab still leaves a terminal whose output has scrolled', async ({ page, platform }) => {
  await openSignedIn(page, platform, undefined, '#/labs/LINUX-001');
  await page.getByRole('button', { name: 'Launch lab' }).focus();
  await page.keyboard.press('Enter');
  await expectTerminalConnected(page);
  await expect.poll(() => focused(page)).toBe('terminal');

  // Enough lines that the terminal has scrollback: its viewport now scrolls,
  // and a scrollable container is a tab stop of its own unless told otherwise.
  for (let i = 0; i < 60; i += 1) await page.keyboard.press('Enter');
  await expect
    .poll(() => page.locator('.xterm-viewport').evaluate((node) => node.scrollHeight > node.clientHeight))
    .toBe(true);

  await page.keyboard.press('Shift+Tab');
  expect(await focused(page)).not.toBe('terminal');
  expect(await focused(page)).not.toBe('body');
});

test('the End dialog opens on Cancel, keeps Tab inside, closes on Escape, and gives focus back to End lab', async ({ page, platform }) => {
  await openSignedIn(page, platform);
  await launch(page);
  await actionButton(page, 'End lab').focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('alertdialog', { name: 'End this lab?' });
  await expect(dialog).toBeVisible();
  expect(await focused(page)).toBe('button:Cancel');

  for (const expected of ['button:End lab', 'button:Cancel', 'button:End lab']) {
    await page.keyboard.press('Tab');
    expect(await focused(page)).toBe(expected);
    expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Shift+Tab');
  expect(await focused(page)).toBe('button:Cancel');

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(await focused(page)).toBe('button:End lab');
  expect(platform.count(/^DELETE /)).toBe(0);
});

test('ending a lab with the keyboard leaves focus on the outcome, not at the top of the page', async ({ page, platform }) => {
  await openSignedIn(page, platform);
  await launch(page);
  await actionButton(page, 'End lab').focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  expect(await focused(page)).toBe('button:End lab');
  await page.keyboard.press('Enter');

  await expect(page.getByRole('heading', { name: 'Lab ended' })).toBeVisible();
  await expect.poll(() => focused(page)).toBe('h2:Lab ended');
  // The next Tab goes on through the summary's actions.
  await page.keyboard.press('Tab');
  expect(await focused(page)).toMatch(/^(a|button):/);
});

test('a terminal that reconnects by itself does not take focus out of an open dialog', async ({ page, platform }) => {
  await openSignedIn(page, platform);
  await launch(page);

  // The connection drops; the automatic reconnect is about a second away.
  const reconnected = new Promise<void>((resolve) => {
    const before = platform.terminalOpened;
    const timer = setInterval(() => {
      if (platform.terminalOpened > before && platform.openSockets.size === 1) {
        clearInterval(timer);
        resolve();
      }
    }, 20);
  });
  await platform.dropTerminals(1006);
  await expect(terminalState(page)).toContainText('Connection to the terminal was lost.');

  // Meanwhile the student opens "End this lab?".
  await actionButton(page, 'End lab').focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('alertdialog', { name: 'End this lab?' });
  await expect(dialog).toBeVisible();
  expect(await focused(page)).toBe('button:Cancel');

  await reconnected;
  await expectTerminalConnected(page);
  expect(await focused(page)).toBe('button:Cancel');
  // The dialog still owns the keyboard: Escape closes it.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('Reset confirmed from the keyboard puts the student back in the fresh shell', async ({ page, platform }) => {
  await openSignedIn(page, platform);
  await launch(page);
  await actionButton(page, 'Reset').focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  expect(await focused(page)).toBe('button:Reset lab');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Your environment was reset to its starting state.')).toBeVisible();
  await expectTerminalConnected(page);
  // The dialog handed focus back to Reset; the fresh shell then takes it, since
  // typing in it is what comes next.
  await expect.poll(() => focused(page)).toBe('terminal');
});

test('hints open one at a time from the keyboard, and each is announced where focus is', async ({ page, platform }) => {
  await openSignedIn(page, platform);
  await launch(page);
  const show = page.getByRole('button', { name: /Show a hint/ });
  await show.focus();
  await page.keyboard.press('Enter');
  const hints = page.getByRole('region', { name: 'Hints' });
  await expect(hints).toContainText('Hint 1');
  // Focus stays on the (renamed) button, ready for the next hint.
  await expect.poll(() => focused(page)).toMatch(/^button:Show hint 2/);
  await page.keyboard.press('Enter');
  await expect(hints).toContainText('Hint 2');
  await expect(hints).toContainText('That is every hint for this lab.');
  // The button is gone with the last hint; focus is on that hint, not <body>.
  await expect.poll(() => focused(page)).toMatch(/^li:Hint 2/);
});
