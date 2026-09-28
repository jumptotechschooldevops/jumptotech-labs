/**
 * The account page — who you are, whether you may use labs and on what plan,
 * and (when the platform bills) your subscription (docs/billing.md).
 *
 * Everything here is read from the server and shown in product words: never a
 * raw provider status, a price reference or a customer id. Nothing on this
 * page grants access. Subscribing sends the browser to the provider's hosted
 * checkout; access changes only when the provider's verified webhook arrives,
 * which is why a return from checkout says "being confirmed" and re-reads,
 * rather than announcing success.
 *
 * The test-mode pages at the bottom exist only with the `test` provider, which
 * the api refuses in production. They simulate what a customer does at a real
 * provider's hosted pages.
 */
import { useCallback, useEffect, useState } from 'react';
import { ErrorNotice } from '../components/ErrorNotice';
import { Badge, LoadingState, PageHeader, type Tone } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { displayNameFor } from '../lib/auth';
import { accessRefusal, describeError, toApiError, type StudentError } from '../lib/errors';
import { formatDay } from '../lib/format';
import { hrefFor, navigate, usePageTitle } from '../lib/router';
import type {
  BillingOffer,
  BillingView,
  CommercialStatus,
  LabAccess,
  LegalLinks,
  TestSubscriptionAction,
} from '../lib/types';

/**
 * Leave for the provider's page. Only an http(s) URL is followed: whatever an
 * answer contained, it cannot make this page run `javascript:`.
 */
export function goToProvider(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url, window.location.href);
  } catch {
    throw new Error('The billing provider sent an address this page will not open.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('The billing provider sent an address this page will not open.');
  }
  window.location.assign(parsed.toString());
}

const KIND_LABEL: Record<NonNullable<LabAccess['kind']>, string> = {
  STANDARD: 'Active',
  BETA: 'Private beta',
  TRIAL: 'Trial',
  SUBSCRIPTION: 'Subscription',
};

const SUBSCRIPTION_TEXT: Record<CommercialStatus, { label: string; tone: Tone }> = {
  NONE: { label: 'No subscription', tone: 'neutral' },
  TRIAL: { label: 'Trial', tone: 'info' },
  ACTIVE: { label: 'Active', tone: 'success' },
  CANCELING: { label: 'Ends at the end of the period', tone: 'warning' },
  PAYMENT_PROBLEM: { label: 'Payment problem', tone: 'danger' },
  PAUSED: { label: 'Paused', tone: 'neutral' },
  ENDED: { label: 'Ended', tone: 'neutral' },
};

function tracksText(tracks: 'all' | string[]): string {
  return tracks === 'all' ? 'Every track' : tracks.join(', ');
}

function AccessSection({ access }: { access: LabAccess }) {
  if (access.policy === 'open') {
    return <p>This platform does not require a plan: every signed-in account may use the labs.</p>;
  }
  if (!access.active) {
    const refusal = accessRefusal(access.state);
    return (
      <>
        <p>
          <Badge tone="warning">No lab access</Badge> <strong>{refusal.title}.</strong>
        </p>
        <p>{refusal.message}</p>
      </>
    );
  }
  return (
    <dl className="facts">
      <div>
        <dt>Status</dt>
        <dd>
          <Badge tone="success">{access.kind ? KIND_LABEL[access.kind] : 'Active'}</Badge>
        </dd>
      </div>
      <div>
        <dt>Access until</dt>
        <dd>{access.expiresAt ? formatDay(access.expiresAt) : 'No end date'}</dd>
      </div>
      <div>
        <dt>Plan</dt>
        <dd>{access.plan ? `${access.plan.name} — ${tracksText(access.plan.tracks)}` : 'Every track'}</dd>
      </div>
      {typeof access.maxConcurrentSessions === 'number' ? (
        <div>
          <dt>Labs at once</dt>
          <dd>{access.maxConcurrentSessions}</dd>
        </div>
      ) : null}
    </dl>
  );
}

function OfferCard({ offer, onChoose, busy }: { offer: BillingOffer; onChoose: () => void; busy: boolean }) {
  return (
    <article className="offer" aria-labelledby={`offer-${offer.id}`}>
      <h3 id={`offer-${offer.id}`} className="offer__name">
        {offer.name}
      </h3>
      {offer.description ? <p>{offer.description}</p> : null}
      <p className="offer__price">
        {offer.priceLabel ?? 'Price shown at checkout'}
        {offer.interval ? ` · billed every ${offer.interval}` : ''}
      </p>
      <p className="offer__plan">Includes: {offer.plan ? tracksText(offer.plan.tracks) : 'Every track'}</p>
      {offer.features.length > 0 ? (
        <ul className="offer__features">
          {offer.features.map((feature) => (
            <li key={feature}>{feature}</li>
          ))}
        </ul>
      ) : null}
      <button type="button" className="btn btn--primary" disabled={busy} onClick={onChoose}>
        {busy ? 'Opening checkout…' : `Subscribe to ${offer.name}`}
      </button>
    </article>
  );
}

function SubscriptionSection({
  billing,
  onError,
}: {
  billing: BillingView;
  onError: (error: StudentError) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const leave = async (key: string, work: () => Promise<{ url: string }>) => {
    setBusy(key);
    let url: string;
    try {
      url = (await work()).url;
    } catch (error) {
      onError(describeError(toApiError(error), 'load'));
      setBusy(null);
      return;
    }
    try {
      goToProvider(url);
    } catch (error) {
      onError({
        kind: 'failed',
        title: 'The billing page could not be opened',
        message: error instanceof Error ? error.message : 'The billing page could not be opened.',
        guidance: 'Try again. If it keeps happening, contact JumpToTech support.',
        reference: 'BILLING_REDIRECT_REFUSED',
        retryable: false,
      });
      setBusy(null);
    }
  };
  const sub = billing.subscription;
  return (
    <>
      {billing.mode === 'test' ? (
        <p className="notice notice--info" role="note">
          <strong>Test mode.</strong> Payments here are simulated. No card is asked for and nothing is charged.
        </p>
      ) : null}
      {sub ? (
        <dl className="facts">
          <div>
            <dt>Subscription</dt>
            <dd>
              <Badge tone={SUBSCRIPTION_TEXT[sub.status].tone}>{SUBSCRIPTION_TEXT[sub.status].label}</Badge>
            </dd>
          </div>
          {sub.planName ? (
            <div>
              <dt>Plan</dt>
              <dd>{sub.planName}</dd>
            </div>
          ) : null}
          <div>
            <dt>{sub.accessUntil ? 'Access until' : 'Period ended'}</dt>
            <dd>{formatDay(sub.accessUntil ?? sub.currentPeriodEnd)}</dd>
          </div>
        </dl>
      ) : (
        <p>You have no subscription.</p>
      )}
      {sub?.status === 'PAYMENT_PROBLEM' ? (
        <p>
          The last payment did not go through. Update your payment method in <em>Manage billing</em>; lab access
          continues only as long as the platform allows after a failed payment.
        </p>
      ) : null}
      {sub?.status === 'CANCELING' ? (
        <p>Your subscription will not renew. You keep lab access until the date above.</p>
      ) : null}
      {billing.canManageBilling ? (
        <p>
          <button
            type="button"
            className="btn btn--secondary"
            disabled={busy !== null}
            onClick={() => void leave('portal', () => api.openBillingPortal())}
          >
            {busy === 'portal' ? 'Opening…' : 'Manage billing'}
          </button>{' '}
          <span className="muted">Payment methods, invoices and cancellation are managed on the payment provider’s page.</span>
        </p>
      ) : null}
      {billing.canSubscribe ? (
        <div className="offers">
          {billing.offers.map((offer) => (
            <OfferCard
              key={offer.id}
              offer={offer}
              busy={busy === offer.id}
              onChoose={() => void leave(offer.id, () => api.startCheckout(offer.id))}
            />
          ))}
        </div>
      ) : null}
    </>
  );
}

function LegalSection({ legal }: { legal: LegalLinks }) {
  const links = [
    { href: legal.termsUrl, label: 'Terms of Service' },
    { href: legal.privacyUrl, label: 'Privacy Policy' },
    { href: legal.refundUrl, label: 'Refund and cancellation policy' },
  ].filter((link): link is { href: string; label: string } => typeof link.href === 'string');
  if (links.length === 0) return null;
  return (
    <ul className="legal-links">
      {links.map((link) => (
        <li key={link.label}>
          <a href={link.href} target="_blank" rel="noopener noreferrer">
            {link.label}
          </a>
        </li>
      ))}
    </ul>
  );
}

export function AccountPage({ checkout }: { checkout?: 'returned' | 'canceled' }) {
  usePageTitle('Your account');
  const auth = useAuth();
  const [access, setAccess] = useState<LabAccess | null>(null);
  const [billing, setBilling] = useState<{ billing: BillingView; legal: LegalLinks } | null>(null);
  const [error, setError] = useState<StudentError | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [a, b] = await Promise.all([api.getAccess(), api.getBilling()]);
      setAccess(a.access);
      setBilling(b);
      setError(null);
    } catch (caught) {
      setError(describeError(toApiError(caught), 'load'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    if (checkout !== 'returned') return undefined;
    // Back from checkout: the provider's confirmation arrives on its own time.
    // Re-read a few times rather than claiming success the server has not seen.
    let count = 0;
    const timer = window.setInterval(() => {
      count += 1;
      void load();
      if (count >= 5) window.clearInterval(timer);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [load, checkout]);

  const identity = auth.identity;
  return (
    <div className="page page--narrow">
      <PageHeader title="Your account" description="Your sign-in, your lab access and, where it applies, your subscription." />

      {checkout === 'returned' && !access?.active ? (
        <p className="notice notice--info" role="status">
          Thanks — your payment is being confirmed with the payment provider. Your lab access updates here as soon as
          it is confirmed.
        </p>
      ) : null}
      {checkout === 'canceled' ? (
        <p className="notice notice--info" role="status">
          You left the checkout before finishing it. Your subscription and access are unchanged.
        </p>
      ) : null}
      {error ? <ErrorNotice error={error} live={false} /> : null}

      <section className="panel" aria-labelledby="account-identity">
        <h2 id="account-identity" className="panel__title">
          Signed in as
        </h2>
        {identity ? (
          <dl className="facts">
            <div>
              <dt>Name</dt>
              <dd>{displayNameFor(identity)}</dd>
            </div>
            {identity.email ? (
              <div>
                <dt>Email</dt>
                <dd>{identity.email}</dd>
              </div>
            ) : null}
          </dl>
        ) : null}
      </section>

      <section className="panel" aria-labelledby="account-access">
        <h2 id="account-access" className="panel__title">
          Lab access
        </h2>
        {loading && !access ? <LoadingState label="Loading your access…" /> : access ? <AccessSection access={access} /> : null}
      </section>

      {billing?.billing.enabled ? (
        <section className="panel" aria-labelledby="account-billing">
          <h2 id="account-billing" className="panel__title">
            Subscription
          </h2>
          <SubscriptionSection billing={billing.billing} onError={setError} />
        </section>
      ) : null}

      {billing ? <LegalSection legal={billing.legal} /> : null}
    </div>
  );
}

// --- the test provider's simulated pages ---------------------------------------

function TestModeBanner() {
  return (
    <p className="notice notice--warning" role="note">
      <strong>Test mode — simulated payment provider.</strong> This page stands in for a real provider’s hosted page.
      No card is asked for and no money moves.
    </p>
  );
}

export function TestCheckoutPage({ checkoutRef }: { checkoutRef: string }) {
  usePageTitle('Test checkout');
  const [state, setState] = useState<{ offer: BillingOffer; status: 'open' | 'completed' } | null>(null);
  const [error, setError] = useState<StudentError | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .getTestCheckout(checkoutRef)
      .then((data) => setState(data.checkout))
      .catch((caught) => setError(describeError(toApiError(caught), 'load')));
  }, [checkoutRef]);

  return (
    <div className="page page--narrow">
      <PageHeader title="Test checkout" />
      <TestModeBanner />
      {error ? <ErrorNotice error={error} live={false} /> : null}
      {state ? (
        <section className="panel" aria-labelledby="test-checkout-offer">
          <h2 id="test-checkout-offer" className="panel__title">
            {state.offer.name}
          </h2>
          <p>{state.offer.priceLabel ?? 'Price shown at checkout'}</p>
          {state.status === 'completed' ? (
            <p>This checkout is already complete.</p>
          ) : (
            <p>
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  api
                    .completeTestCheckout(checkoutRef)
                    .then(() => navigate({ name: 'account', checkout: 'returned' }))
                    .catch((caught) => {
                      setError(describeError(toApiError(caught), 'load'));
                      setBusy(false);
                    });
                }}
              >
                {busy ? 'Simulating…' : 'Simulate a successful payment'}
              </button>{' '}
              <a className="btn btn--ghost" href={hrefFor({ name: 'account', checkout: 'canceled' })}>
                Cancel
              </a>
            </p>
          )}
        </section>
      ) : null}
    </div>
  );
}

const TEST_ACTIONS: Array<{ action: TestSubscriptionAction; label: string }> = [
  { action: 'cancel-at-period-end', label: 'Cancel at the end of the period' },
  { action: 'resume', label: 'Keep renewing (undo cancel)' },
  { action: 'cancel-now', label: 'Cancel immediately' },
  { action: 'renew', label: 'Simulate a renewal' },
  { action: 'fail-renewal', label: 'Simulate a failed renewal payment' },
  { action: 'recover', label: 'Simulate the failed payment being collected' },
];

export function TestPortalPage() {
  usePageTitle('Test billing portal');
  const [billing, setBilling] = useState<BillingView | null>(null);
  const [error, setError] = useState<StudentError | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api
      .getBilling()
      .then((data) => setBilling(data.billing))
      .catch((caught) => setError(describeError(toApiError(caught), 'load')));
  }, []);
  useEffect(load, [load]);

  const sub = billing?.subscription;
  return (
    <div className="page page--narrow">
      <PageHeader title="Test billing portal" />
      <TestModeBanner />
      {error ? <ErrorNotice error={error} live={false} /> : null}
      {sub ? (
        <section className="panel" aria-labelledby="test-portal-subscription">
          <h2 id="test-portal-subscription" className="panel__title">
            Your subscription: {SUBSCRIPTION_TEXT[sub.status].label}
          </h2>
          <div className="button-row">
            {TEST_ACTIONS.map(({ action, label }) => (
              <button
                key={action}
                type="button"
                className="btn btn--secondary"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  api
                    .simulateSubscription(action)
                    .then(load)
                    .catch((caught) => setError(describeError(toApiError(caught), 'load')))
                    .finally(() => setBusy(false));
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </section>
      ) : billing ? (
        <p>You have no subscription.</p>
      ) : null}
      <p>
        <a href={hrefFor({ name: 'account' })}>Back to your account</a>
      </p>
    </div>
  );
}
