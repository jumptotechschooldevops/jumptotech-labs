/**
 * The account page — lab access, plan and subscription, in product words
 * (docs/billing.md).
 *
 * What these pin: the page shows what the server says and nothing it does
 * not — a return from checkout is "being confirmed", never "you're
 * subscribed"; an access problem is never blamed on payment unless billing
 * says so; a provider link is followed only if it is http(s); and the billing
 * section does not exist where billing is off.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { AccountPage, TestCheckoutPage, TestPortalPage } from '../src/pages/AccountPage';
import { parseRoute, hrefFor } from '../src/lib/router';
import type { BillingView } from '../src/lib/types';
import { renderWithProviders } from './app-harness';
import { apiMock, resetApiMock } from './api-mock';

vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  const { apiMock: mock } = await import('./api-mock');
  return { ...actual, api: mock };
});

const assign = vi.fn();
const originalLocation = window.location;

beforeEach(() => {
  resetApiMock();
  assign.mockReset();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...originalLocation, href: 'http://localhost:3000/#/account', hash: '#/account', assign },
  });
});

afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  vi.useRealTimers();
});

const OFFER = {
  id: 'fixture-monthly',
  name: 'Fixture monthly',
  description: 'Not a product decision.',
  priceLabel: 'Test price',
  interval: 'month' as const,
  features: ['Every track'],
  plan: { id: 'fixture-all', name: 'Everything', tracks: 'all' as const },
};

function billing(overrides: Partial<BillingView> = {}) {
  return {
    billing: {
      enabled: true,
      mode: 'test' as const,
      offers: [OFFER],
      subscription: null,
      canManageBilling: false,
      canSubscribe: true,
      ...overrides,
    },
    legal: { termsUrl: null, privacyUrl: null, refundUrl: null },
  };
}

const section = (name: string) => screen.getByRole('heading', { name }).closest('section')!;

describe('lab access', () => {
  it('says plainly when the platform requires no plan, and shows no billing where there is none', async () => {
    renderWithProviders(<AccountPage />);
    expect(await screen.findByText(/does not require a plan/)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Subscription' })).toBeNull();
    expect(screen.queryByRole('link', { name: /Terms/ })).toBeNull();
  });

  it('shows an active beta grant with its plan, end date and limit', async () => {
    apiMock.getAccess.mockResolvedValue({
      access: {
        policy: 'entitlement',
        state: 'ACTIVE',
        active: true,
        startsAt: '2026-10-01T00:00:00.000Z',
        expiresAt: '2026-12-31T23:00:00.000Z',
        kind: 'BETA',
        source: 'operator',
        plan: { id: 'beta', name: 'Private beta', description: null, tracks: ['linux', 'docker'] },
        maxConcurrentSessions: 1,
      },
    });
    renderWithProviders(<AccountPage />);
    const access = await waitFor(() => section('Lab access'));
    await waitFor(() => expect(within(access).getByText('Private beta', { selector: '.badge' })).toBeTruthy());
    expect(within(access).getByText('Private beta — linux, docker')).toBeTruthy();
    expect(within(access).getByText(/2026/)).toBeTruthy();
    expect(within(access).getByText('1')).toBeTruthy();
  });

  it('explains missing access without blaming payment', async () => {
    apiMock.getAccess.mockResolvedValue({
      access: { policy: 'entitlement', state: 'EXPIRED', active: false, startsAt: null, expiresAt: null },
    });
    renderWithProviders(<AccountPage />);
    const access = await waitFor(() => section('Lab access'));
    await waitFor(() => expect(within(access).getByText(/Your lab access has ended/)).toBeTruthy());
    expect(access.textContent).not.toMatch(/payment|card|charge|ACCESS_NOT_ACTIVE|403/i);
  });
});

describe('subscription', () => {
  it('offers a checkout in test mode and leaves for the provider\'s page', async () => {
    apiMock.getBilling.mockResolvedValue(billing());
    apiMock.startCheckout.mockResolvedValue({ url: 'http://localhost:3000/#/account/test-checkout/cs_test_1' });
    renderWithProviders(<AccountPage />);
    const sub = await waitFor(() => section('Subscription'));
    expect(within(sub).getByText(/Test mode\./)).toBeTruthy();
    expect(within(sub).getByText('Test price · billed every month')).toBeTruthy();
    fireEvent.click(within(sub).getByRole('button', { name: 'Subscribe to Fixture monthly' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('http://localhost:3000/#/account/test-checkout/cs_test_1'));
    expect(apiMock.startCheckout).toHaveBeenCalledWith('fixture-monthly');
  });

  it('never follows a provider link that is not http(s)', async () => {
    apiMock.getBilling.mockResolvedValue(billing());
    apiMock.startCheckout.mockResolvedValue({ url: 'javascript:alert(document.cookie)' });
    renderWithProviders(<AccountPage />);
    const sub = await waitFor(() => section('Subscription'));
    fireEvent.click(within(sub).getByRole('button', { name: /Subscribe/ }));
    await waitFor(() => expect(screen.getByText(/will not open/)).toBeTruthy());
    expect(assign).not.toHaveBeenCalled();
  });

  it('words each product status, and opens the provider\'s portal to manage billing', async () => {
    apiMock.getBilling.mockResolvedValue(
      billing({
        subscription: {
          status: 'PAYMENT_PROBLEM',
          planId: 'fixture-all',
          planName: 'Everything',
          currentPeriodEnd: '2026-11-30T00:00:00.000Z',
          cancelAtPeriodEnd: false,
          accessUntil: null,
        },
        canManageBilling: true,
        canSubscribe: false,
      }),
    );
    apiMock.openBillingPortal.mockResolvedValue({ url: 'http://localhost:3000/#/account/test-portal' });
    renderWithProviders(<AccountPage />);
    const sub = await waitFor(() => section('Subscription'));
    await waitFor(() => expect(within(sub).getByText('Payment problem')).toBeTruthy());
    expect(within(sub).getByText(/last payment did not go through/)).toBeTruthy();
    expect(within(sub).queryByRole('button', { name: /Subscribe/ })).toBeNull();
    expect(sub.textContent).not.toMatch(/past_due|unpaid|price_|cus_|sub_/);
    fireEvent.click(within(sub).getByRole('button', { name: 'Manage billing' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('http://localhost:3000/#/account/test-portal'));
  });

  it('a subscription set to end says it will not renew and until when access lasts', async () => {
    apiMock.getBilling.mockResolvedValue(
      billing({
        subscription: {
          status: 'CANCELING',
          planId: null,
          planName: null,
          currentPeriodEnd: '2026-11-30T00:00:00.000Z',
          cancelAtPeriodEnd: true,
          accessUntil: '2026-11-30T00:00:00.000Z',
        },
        canManageBilling: true,
        canSubscribe: false,
      }),
    );
    renderWithProviders(<AccountPage />);
    const sub = await waitFor(() => section('Subscription'));
    await waitFor(() => expect(within(sub).getByText('Ends at the end of the period')).toBeTruthy());
    expect(within(sub).getByText(/will not renew/)).toBeTruthy();
    expect(within(sub).getByText('Access until')).toBeTruthy();
  });

  it('back from checkout, says the payment is being confirmed — never that it succeeded', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    apiMock.getBilling.mockResolvedValue(billing());
    apiMock.getAccess.mockResolvedValue({
      access: { policy: 'entitlement', state: 'NONE', active: false, startsAt: null, expiresAt: null },
    });
    renderWithProviders(<AccountPage checkout="returned" />);
    expect(await screen.findByText(/being confirmed with the payment provider/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/subscribed|successful|you now have/i);
    const reads = apiMock.getAccess.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(3100);
    });
    expect(apiMock.getAccess.mock.calls.length).toBeGreaterThan(reads);
  });

  it('shows the published legal documents as links, and none that are not published', async () => {
    apiMock.getBilling.mockResolvedValue({
      ...billing(),
      legal: { termsUrl: 'https://example.com/terms', privacyUrl: null, refundUrl: 'https://example.com/refunds' },
    });
    renderWithProviders(<AccountPage />);
    const terms = await screen.findByRole('link', { name: 'Terms of Service' });
    expect(terms.getAttribute('href')).toBe('https://example.com/terms');
    expect(terms.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getByRole('link', { name: 'Refund and cancellation policy' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Privacy Policy' })).toBeNull();
  });
});

describe('the test provider\'s simulated pages', () => {
  it('a test checkout simulates the payment, then returns to the account', async () => {
    apiMock.getTestCheckout.mockResolvedValue({ mode: 'test', checkout: { offer: OFFER, status: 'open' } });
    apiMock.completeTestCheckout.mockResolvedValue({ mode: 'test', outcomes: ['applied', 'applied'] });
    renderWithProviders(<TestCheckoutPage checkoutRef="cs_test_1" />);
    expect(await screen.findByText(/Test mode — simulated payment provider/)).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Simulate a successful payment' }));
    await waitFor(() => expect(apiMock.completeTestCheckout).toHaveBeenCalledWith('cs_test_1'));
    await waitFor(() => expect(window.location.hash).toBe('#/account?checkout=returned'));
  });

  it('the test portal acts on the student\'s own subscription only', async () => {
    apiMock.getBilling.mockResolvedValue(
      billing({
        subscription: {
          status: 'ACTIVE',
          planId: null,
          planName: null,
          currentPeriodEnd: '2026-11-30T00:00:00.000Z',
          cancelAtPeriodEnd: false,
          accessUntil: '2026-11-30T00:00:00.000Z',
        },
        canManageBilling: true,
      }),
    );
    apiMock.simulateSubscription.mockResolvedValue({ mode: 'test', outcomes: ['applied'] });
    renderWithProviders(<TestPortalPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel at the end of the period' }));
    await waitFor(() => expect(apiMock.simulateSubscription).toHaveBeenCalledWith('cancel-at-period-end'));
  });
});

describe('routes', () => {
  it('parses the account routes, and never takes access from the URL', () => {
    expect(parseRoute('#/account')).toEqual({ name: 'account' });
    expect(parseRoute('#/account?checkout=returned')).toEqual({ name: 'account', checkout: 'returned' });
    expect(parseRoute('#/account?checkout=granted&access=ACTIVE')).toEqual({ name: 'account' });
    expect(parseRoute('#/account/test-checkout/cs_test_abc')).toEqual({ name: 'testCheckout', checkoutRef: 'cs_test_abc' });
    expect(parseRoute('#/account/test-checkout/<script>')).toEqual({ name: 'notFound' });
    expect(parseRoute('#/account/test-portal')).toEqual({ name: 'testPortal' });
    expect(hrefFor({ name: 'account', checkout: 'canceled' })).toBe('#/account?checkout=canceled');
  });
});
