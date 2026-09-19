/**
 * The student pages fit the screens the beta is used on.
 *
 * The workspace is designed for laptops and desktops; below 960 px it stacks
 * and the page scrolls (docs/student-experience.md). What must hold at every
 * width checked here is that nothing but the terminal scrolls sideways — a page
 * wider than the window hides controls off to the right — and, on a small laptop
 * (1280 × 720, the smallest common one), that the lab's actions and terminal are
 * on screen without scrolling.
 *
 * Measured with the real bundle and real API payloads, so long lab titles,
 * track names and path stages are the ones students see.
 */
import { expect, test, type Page } from '@playwright/test';
import { LAB_ID, endAllSessions, expectTerminalConnected, signIn, uniqueStudent } from './support/student.js';

const WIDTHS = [
  { name: 'laptop', width: 1280, height: 720 },
  { name: 'small laptop', width: 1024, height: 768 },
  { name: 'tablet', width: 768, height: 1024 },
];

const PAGES: Array<{ hash: string; heading: RegExp }> = [
  { hash: '#/', heading: /^Welcome/ },
  { hash: '#/paths/devops-engineer', heading: /^DevOps Engineer path$/ },
  { hash: '#/labs', heading: /^Lab catalog$/ },
  { hash: `#/labs/${LAB_ID}`, heading: /^Files and Directories$/ },
  { hash: '#/progress', heading: /^Your progress$/ },
  { hash: '#/help', heading: /^How JumpToTech Labs works$/ },
];

/** How far the document is wider than the window, in CSS pixels. 0 is right. */
function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

/** Whether an element is entirely inside the window, without scrolling. */
async function onScreen(page: Page, selector: string): Promise<boolean> {
  return page.locator(selector).first().evaluate((element) => {
    const box = element.getBoundingClientRect();
    return box.top >= 0 && box.left >= 0 && box.bottom <= window.innerHeight && box.right <= window.innerWidth;
  });
}

test('every student page fits the window at laptop, small-laptop and tablet widths', async ({ page }) => {
  await signIn(page, uniqueStudent('layout'));
  for (const size of WIDTHS) {
    await page.setViewportSize({ width: size.width, height: size.height });
    for (const target of PAGES) {
      await page.goto(`/${target.hash}`);
      await expect(page.getByRole('heading', { level: 1, name: target.heading })).toBeVisible();
      expect(await horizontalOverflow(page), `${target.hash} at ${size.name} (${size.width}px)`).toBeLessThanOrEqual(0);
    }
  }
});

test('the workspace keeps its actions and terminal on screen on a small laptop, and never scrolls sideways', async ({ page, context }) => {
  test.setTimeout(600_000);
  try {
    await page.setViewportSize({ width: 1280, height: 720 });
    await signIn(page, uniqueStudent('layout-ws'));
    await page.goto(`/#/labs/${LAB_ID}`);
    await page.getByRole('button', { name: 'Launch lab' }).click();
    await expect(page.locator('.workspace__status')).toContainText('Ready', { timeout: 180_000 });
    await expectTerminalConnected(page);

    // A failing verdict is the tallest the verification panel gets.
    await page.getByRole('button', { name: 'Verify', exact: true }).click();
    await expect(page.locator('section.verify')).toContainText('Not complete yet', { timeout: 60_000 });

    const actions = page.getByRole('group', { name: 'Lab actions' });
    for (const name of ['Verify', 'Reset', 'End lab']) {
      await expect(actions.getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 });
    }
    expect(await onScreen(page, '.terminal-bar'), 'terminal bar on screen').toBe(true);
    const terminal = await page.locator('.terminal-body').boundingBox();
    expect(terminal, 'terminal laid out').not.toBeNull();
    // Room to work: at least a dozen rows of 14 px text.
    expect(terminal!.height, 'terminal height at 1280 × 720').toBeGreaterThanOrEqual(220);
    expect(await horizontalOverflow(page), 'workspace at 1280 × 720').toBeLessThanOrEqual(0);

    for (const size of WIDTHS.slice(1)) {
      await page.setViewportSize({ width: size.width, height: size.height });
      await expect(actions.getByRole('button', { name: 'Verify', exact: true })).toBeVisible();
      expect(await horizontalOverflow(page), `workspace at ${size.name} (${size.width}px)`).toBeLessThanOrEqual(0);
    }
  } finally {
    await endAllSessions(context);
  }
});
