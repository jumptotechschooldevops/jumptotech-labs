/**
 * The student pages on the screens the beta is used on — laptops and tablets
 * (docs/student-experience.md: the workspace is designed for laptops and
 * stacks below 960 px; phones are not a product target).
 *
 * The stack suite measures the real catalog at three sizes. This one pushes
 * the workspace into its tallest and widest states — every banner at once, a
 * long lab title, the End dialog, the ended summary — at six sizes, which only
 * a platform that can be told what to answer can do on cue.
 */
import type { Page } from '@playwright/test';
import { actionButton, endLab, expect, expectTerminalConnected, horizontalOverflow, launch, openSignedIn, test } from './support/fixture.js';

const LAPTOPS = [
  { name: '1280×720 laptop', width: 1280, height: 720 },
  { name: '1366×768 laptop', width: 1366, height: 768 },
  { name: '1440×900 laptop', width: 1440, height: 900 },
  { name: '1024×768 small laptop', width: 1024, height: 768 },
];
const TABLETS = [
  { name: '768×1024 tablet', width: 768, height: 1024 },
  { name: '820×1180 tablet', width: 820, height: 1180 },
];
const ALL = [...LAPTOPS, ...TABLETS];

const LONG_TITLE =
  'Diagnose and Repair a Misconfigured Multi-Container Deployment Behind an Ingress Controller';

/** Elements whose boxes overlap — for things that must never sit on top of each other. */
async function overlapping(page: Page, a: string, b: string): Promise<boolean> {
  const [boxA, boxB] = await Promise.all([page.locator(a).first().boundingBox(), page.locator(b).first().boundingBox()]);
  if (!boxA || !boxB) return false;
  return boxA.x < boxB.x + boxB.width && boxB.x < boxA.x + boxA.width && boxA.y < boxB.y + boxB.height && boxB.y < boxA.y + boxA.height;
}

test('the workspace at its busiest fits every laptop and tablet size, with its actions reachable', async ({ page, platform }) => {
  platform.titles.set('LINUX-001', LONG_TITLE);
  await openSignedIn(page, platform);
  await launch(page);

  // Every banner the workspace can show at once: idle warning, time low, a
  // failed action, a failing verdict with its advice, and all hints open.
  const entry = platform.current();
  entry.session = { ...entry.session, idleWarning: true, secondsUntilIdle: 240, secondsRemaining: 240 };
  platform.failNext('end', { status: 500, code: 'INTERNAL_ERROR', message: 'x' });
  await page.reload();
  await expectTerminalConnected(page);
  await expect(page.getByText('Are you still working?')).toBeVisible();
  await expect(page.getByText('A few minutes left in this lab.')).toBeVisible();
  await page.getByRole('button', { name: 'Show a hint' }).click();
  await page.getByRole('button', { name: 'Show hint 2' }).click();
  await actionButton(page, 'Verify').click();
  await expect(page.locator('section.verify')).toContainText('What to look at next');
  await actionButton(page, 'End lab').click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'End lab' }).click();
  await expect(page.getByText('The lab could not be ended')).toBeVisible();

  for (const size of ALL) {
    await page.setViewportSize(size);
    await expect(page.getByRole('heading', { level: 1, name: LONG_TITLE })).toBeVisible();
    expect(await horizontalOverflow(page), `sideways scroll at ${size.name}`).toBeLessThanOrEqual(0);
    // The title wraps; it never runs under the status or the actions.
    expect(await overlapping(page, '.workspace__title', '.workspace__actions'), `title over actions at ${size.name}`).toBe(false);
    expect(await overlapping(page, '.workspace__title', '.workspace__status'), `title over status at ${size.name}`).toBe(false);
    for (const name of ['Verify', 'Reset', 'End lab'] as const) {
      const button = actionButton(page, name);
      await button.scrollIntoViewIfNeeded();
      await expect(button, `${name} at ${size.name}`).toBeInViewport({ ratio: 1 });
    }
    // The terminal is always there to type in, with room for a dozen lines.
    const terminal = await page.locator('.terminal-body').boundingBox();
    expect(terminal?.height ?? 0, `terminal height at ${size.name}`).toBeGreaterThanOrEqual(220);
  }
});

test('on a laptop, the actions and the terminal are on screen without scrolling, even with every banner up', async ({ page, platform }) => {
  await openSignedIn(page, platform);
  await launch(page);
  const entry = platform.current();
  entry.session = { ...entry.session, idleWarning: true, secondsUntilIdle: 240, secondsRemaining: 240 };
  await page.reload();
  await expectTerminalConnected(page);
  await expect(page.getByText('Are you still working?')).toBeVisible();

  for (const size of LAPTOPS) {
    await page.setViewportSize(size);
    await page.evaluate(() => window.scrollTo(0, 0));
    for (const name of ['Verify', 'Reset', 'End lab'] as const) {
      await expect(actionButton(page, name), `${name} at ${size.name}`).toBeInViewport({ ratio: 1 });
    }
    await expect(page.locator('.terminal-bar'), `terminal bar at ${size.name}`).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole('button', { name: 'Stay active' }), `Stay active at ${size.name}`).toBeInViewport({ ratio: 1 });
  }
});

test('the End dialog fits the window at every size, and its buttons are on screen', async ({ page, platform }) => {
  await openSignedIn(page, platform);
  await launch(page);
  await actionButton(page, 'End lab').click();
  const dialog = page.getByRole('alertdialog', { name: 'End this lab?' });
  for (const size of ALL) {
    await page.setViewportSize(size);
    await expect(dialog, `dialog at ${size.name}`).toBeInViewport({ ratio: 1 });
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeInViewport({ ratio: 1 });
    await expect(dialog.getByRole('button', { name: 'End lab' })).toBeInViewport({ ratio: 1 });
    expect(await horizontalOverflow(page), `sideways scroll with the dialog at ${size.name}`).toBeLessThanOrEqual(0);
  }
});

test('the ended summary, the lab page and the pages around them fit every size', async ({ page, platform }) => {
  platform.titles.set('LINUX-001', LONG_TITLE);
  await openSignedIn(page, platform);
  await launch(page);
  platform.solved.add(platform.current().session.sessionId);
  await actionButton(page, 'Verify').click();
  await expect(page.locator('section.verify')).toContainText('Lab passed');
  await endLab(page);
  await expect(page.getByRole('heading', { name: 'Next recommended lab' })).toBeVisible();

  for (const size of ALL) {
    await page.setViewportSize(size);
    expect(await horizontalOverflow(page), `summary at ${size.name}`).toBeLessThanOrEqual(0);
  }
  for (const hash of ['#/labs/LINUX-001', '#/labs', '#/', '#/paths/devops-engineer/stages/linux', '#/progress']) {
    await page.goto(`/${hash}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    for (const size of ALL) {
      await page.setViewportSize(size);
      expect(await horizontalOverflow(page), `${hash} at ${size.name}`).toBeLessThanOrEqual(0);
    }
  }
});

test('long terminal output scrolls inside the terminal, never the page sideways', async ({ page, platform }) => {
  await openSignedIn(page, platform);
  await launch(page);
  await page.locator('.terminal-surface').click();
  // One very long line and many short ones.
  await page.keyboard.type(`echo ${'x'.repeat(400)}`);
  for (let i = 0; i < 60; i += 1) await page.keyboard.press('Enter');
  for (const size of ALL) {
    await page.setViewportSize(size);
    expect(await horizontalOverflow(page), `sideways scroll with long output at ${size.name}`).toBeLessThanOrEqual(0);
    const body = await page.locator('.terminal-body').boundingBox();
    const bar = await page.locator('.terminal-bar').boundingBox();
    // The terminal does not grow to push its own bar or the page's actions away.
    expect(body!.height, `terminal height at ${size.name}`).toBeLessThan(size.height * 1.5);
    expect(bar!.y, `terminal bar above the terminal at ${size.name}`).toBeLessThan(body!.y);
  }
});
