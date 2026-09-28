/**
 * Semantic accessibility of every student page and the workspace's states,
 * and the dynamic statuses a screen reader relies on.
 *
 * See support/audit.ts for exactly what is checked (and what is not).
 */
import type { Page } from '@playwright/test';
import { auditPage } from './support/audit.js';
import { ALICE, actionButton, endLab, expect, expectTerminalConnected, launch, openSignedIn, test } from './support/fixture.js';

async function expectClean(page: Page, where: string): Promise<void> {
  expect(await auditPage(page), where).toEqual([]);
}

const PAGES: Array<{ hash: string; heading: RegExp }> = [
  { hash: '#/', heading: /^Welcome/ },
  { hash: '#/paths', heading: /learning paths/i },
  { hash: '#/paths/devops-engineer', heading: /^DevOps Engineer path$/ },
  { hash: '#/paths/devops-engineer/stages/linux', heading: /^Linux$/ },
  { hash: '#/labs', heading: /^Lab catalog$/ },
  { hash: '#/labs?track=linux', heading: /^Lab catalog$/ },
  { hash: '#/labs/LINUX-001', heading: /^Files and Directories$/ },
  { hash: '#/tracks', heading: /tracks/i },
  { hash: '#/tracks/linux', heading: /^Linux$/ },
  { hash: '#/progress', heading: /^Your progress$/ },
  { hash: '#/help', heading: /^How JumpToTech Labs works$/ },
  { hash: '#/no-such-page', heading: /^Page not found$/ },
];

test('every student page passes the semantic audit', async ({ page, platform }) => {
  await openSignedIn(page, platform);
  for (const target of PAGES) {
    await page.goto(`/${target.hash}`);
    await expect(page.getByRole('heading', { level: 1, name: target.heading })).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expectClean(page, target.hash);
  }
});

test('the workspace passes the audit in each state a student meets', async ({ page, platform }) => {
  await openSignedIn(page, platform);
  await launch(page);
  await expectClean(page, 'workspace, connected');

  await page.getByRole('button', { name: 'Show a hint' }).click();
  await page.getByRole('button', { name: 'Show hint 2' }).click();
  await actionButton(page, 'Verify').click();
  await expect(page.locator('section.verify')).toContainText('Not complete yet');
  await expectClean(page, 'workspace, hints open and a failing verdict');

  await actionButton(page, 'End lab').click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await expectClean(page, 'workspace, End dialog open');
  await page.keyboard.press('Escape');

  platform.solved.add(platform.current().session.sessionId);
  await actionButton(page, 'Verify').click();
  await expect(page.locator('section.verify')).toContainText('Lab passed');
  await endLab(page);
  await expect(page.getByRole('heading', { name: 'Next recommended lab' })).toBeVisible();
  await expectClean(page, 'ended summary with the next lab');
});

test('the sign-in gate passes the audit: signed out, expired and unreachable', async ({ page, platform }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expectClean(page, 'signed out');

  await page.goto('about:blank');
  await openSignedIn(page, platform, ALICE, '#/labs/LINUX-001');
  platform.revoked.add(ALICE.subject);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByText('Your sign-in has expired')).toBeVisible();
  await expectClean(page, 'expired');

  await page.route('**/auth/session', (route) => route.abort('connectionrefused'));
  await page.reload();
  await expect(page.getByText('Cannot reach the labs API.')).toBeVisible();
  await expectClean(page, 'unreachable');
});

test('lab state is announced: the status line, the terminal line and the verdict are live regions with words', async ({ page, platform }) => {
  await openSignedIn(page, platform);
  await launch(page);
  // Each is a polite status region whose text says the state — never colour alone.
  await expect(page.locator('.workspace__status')).toHaveAttribute('role', 'status');
  await expect(page.locator('.workspace__status')).toContainText('Ready');
  await expect(page.locator('.terminal-bar__state')).toHaveAttribute('role', 'status');
  await expect(page.locator('.terminal-bar__state')).toHaveText('Terminal: Connected');
  await expect(page.locator('section.verify [aria-live="polite"]')).toHaveCount(1);

  await actionButton(page, 'Verify').click();
  // Every check says pass or fail in words, not just with a coloured mark.
  const checks = page.locator('.verify__check');
  await expect(checks).toHaveCount(2);
  await expect(checks.nth(0)).toContainText('— Passed');
  await expect(checks.nth(1)).toContainText('— Not passing yet');

  // The Active lab link says which lab and its state.
  await expect(page.locator('.active-lab')).toContainText('LINUX-001');
  await expect(page.locator('.active-lab')).toContainText(', Ready');
});

test('nothing ticking inside a live region: a starting lab is announced once, not every second', async ({ page, platform }) => {
  await page.clock.install();
  await openSignedIn(page, platform, undefined, '#/labs/LINUX-001');
  const start = platform.hold('start');
  await page.getByRole('button', { name: 'Launch lab' }).click();
  await start.reached;
  await expect(page.getByText('Preparing your lab environment…')).toBeVisible();

  // Record every text change inside a live region that would be announced.
  await page.evaluate(() => {
    const announced: string[] = [];
    (window as unknown as { announced: string[] }).announced = announced;
    const live = '[aria-live="polite"], [aria-live="assertive"], [role="status"], [role="alert"]';
    new MutationObserver((records) => {
      for (const record of records) {
        const target = record.target instanceof Element ? record.target : record.target.parentElement;
        if (!target?.closest(live)) continue;
        if (target.closest('[aria-live="off"]')) continue;
        announced.push(target.closest(live)!.textContent?.trim().slice(0, 80) ?? '');
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await page.clock.runFor(5_000);
  const announced = await page.evaluate(() => (window as unknown as { announced: string[] }).announced);
  expect(announced, 'live-region changes while nothing but the clock moved').toEqual([]);
  // The elapsed time is still there to read.
  await expect(page.locator('.overlay__elapsed')).toHaveText(/^\d+s$/);

  start.open();
  await expectTerminalConnected(page);
});
