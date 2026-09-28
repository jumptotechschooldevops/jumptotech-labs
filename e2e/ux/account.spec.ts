/**
 * Commercial access in a real browser (docs/commercial-access.md, docs/billing.md).
 *
 * A student without access is told why, in words, before and when they press
 * Launch; subscribes through the test provider's hosted checkout; comes back
 * to "being confirmed" — not "subscribed" — because only the provider's
 * webhook grants access; and can launch once it arrives. And a student whose
 * access has ended is refused a new lab with a plain sentence, not a status
 * code.
 */
import { ALICE, expect, expectTerminalConnected, openSignedIn, test } from './support/fixture.js';

const OFFER = {
  id: 'fixture-monthly',
  name: 'Fixture monthly',
  description: 'A test fixture, not a product decision.',
  priceLabel: 'Test price',
  interval: 'month' as const,
  features: ['Every track'],
  plan: null,
};

test('no access → subscribe in test mode → "being confirmed" → the webhook arrives → Launch works', async ({ page, platform }) => {
  platform.access = { policy: 'entitlement', state: 'NONE', active: false, startsAt: null, expiresAt: null };
  platform.billing = { enabled: true, mode: 'test', offers: [OFFER], subscription: null, canManageBilling: false, canSubscribe: true };

  await test.step('Launch is refused, and says why in words', async () => {
    await openSignedIn(page, platform, ALICE, '#/labs/LINUX-001');
    await page.getByRole('button', { name: 'Launch lab' }).click();
    await expect(page.getByText('Your account does not have lab access yet').first()).toBeVisible();
    await expect(page.locator('body')).not.toContainText('403');
  });

  await test.step('the account page, reached from the name in the header, shows no access and the offer', async () => {
    await page.getByRole('link', { name: ALICE.displayName }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Your account' })).toBeVisible();
    await expect(page.getByText('No lab access')).toBeVisible();
    await expect(page.getByText(/Test mode\./)).toBeVisible();
    await expect(page.getByText('Test price · billed every month')).toBeVisible();
  });

  await test.step('checkout at the (simulated) provider, then back to "being confirmed"', async () => {
    await page.getByRole('button', { name: 'Subscribe to Fixture monthly' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Test checkout' })).toBeVisible();
    await page.getByRole('button', { name: 'Simulate a successful payment' }).click();
    await expect(page).toHaveURL(/#\/account\?checkout=returned$/);
    await expect(page.getByText(/being confirmed with the payment provider/)).toBeVisible();
    await expect(page.locator('body')).not.toContainText(/subscribed|payment successful/i);
    expect(platform.paidCheckouts.size).toBe(1);
  });

  await test.step('the provider\'s webhook arrives; the page picks it up without a reload', async () => {
    platform.confirmPayment(new Date(Date.now() + 30 * 86_400_000).toISOString());
    const sub = page.getByRole('region', { name: 'Subscription' }).or(page.locator('section[aria-labelledby="account-billing"]'));
    await expect(sub.getByText('Active', { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: 'Manage billing' })).toBeVisible();
  });

  await test.step('and Launch now works', async () => {
    await page.goto('/#/labs/LINUX-001');
    await page.getByRole('button', { name: 'Launch lab' }).click();
    await expectTerminalConnected(page);
  });
});

test('access that has ended refuses a new lab with a plain sentence, and the account page says the same', async ({ page, platform }) => {
  platform.access = {
    policy: 'entitlement',
    state: 'EXPIRED',
    active: false,
    startsAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-06-30T00:00:00.000Z',
  };
  await openSignedIn(page, platform, ALICE, '#/labs/LINUX-001');
  await page.getByRole('button', { name: 'Launch lab' }).click();
  await expect(page.getByText('Your lab access has ended').first()).toBeVisible();
  await page.goto('/#/account');
  await expect(page.getByText('No lab access')).toBeVisible();
  await expect(page.getByText(/Your access period is over/)).toBeVisible();
  // Billing is off here: nothing about payment is shown or implied.
  await expect(page.locator('body')).not.toContainText(/payment|subscribe|card/i);
});
