# Billing — the provider boundary, webhooks and subscriptions

How a payment provider changes who may use labs, without ever becoming
authentication or bypassing authorization. The access model it plugs into is
[commercial-access.md](commercial-access.md); read that first.

Implemented in `apps/api/src/billing/`, migration
`services/progress/migrations/010_billing.sql`.

**Status: test mode only.** The only provider is `test`, an in-process
simulator. No real provider is integrated, no live key exists anywhere, and
the api refuses `BILLING_PROVIDER=test` under `NODE_ENV=production`. Billing is
**off** by default, and off for the private beta.

- [1. What exists](#1-what-exists)
- [2. The flow](#2-the-flow)
- [3. Configuration](#3-configuration)
- [4. Webhooks: verification, idempotency, ordering, failure](#4-webhooks-verification-idempotency-ordering-failure)
- [5. Provider state → product state](#5-provider-state--product-state)
- [6. Subscriptions and manual grants together](#6-subscriptions-and-manual-grants-together)
- [7. Business decisions this code does not make](#7-business-decisions-this-code-does-not-make)
- [8. Data held](#8-data-held)
- [9. Integrating a real provider](#9-integrating-a-real-provider)
- [10. Observability](#10-observability)
- [Tests](#tests)

## 1. What exists

| Piece | Where | What it does |
|---|---|---|
| Provider boundary | `billing/types.ts` — `BillingProvider` | `createCheckout`, `createPortal`, `getSubscription`, `verifyWebhook`. Everything else sees provider-neutral shapes only |
| Test provider | `billing/test-provider.ts` | A deterministic simulator: hosted-style checkout, signed webhooks, renewal, failed payment, cancellation, trial. No network, no credential, no money |
| Webhook endpoint | `POST /api/billing/webhooks/:provider` (`billing/routes.ts`) | Raw bytes, 64 KB cap, signature before anything else |
| Processor | `billing/processor.ts` | Verify → dedupe → map to an account → order → store → sync the entitlement, one transaction |
| Lifecycle | `billing/lifecycle.ts` | Provider status → product status; subscriptions → billing's entitlement row |
| Storage | migration 010: `billing_customers`, `billing_checkouts`, `billing_subscriptions`, `billing_events`; `access_entitlements` gains a `billing` source | References and product state only |

A billing-granted entitlement is an `access_entitlements` row with
`granted_via = 'billing'`, kind `SUBSCRIPTION` (or `TRIAL` for a provider
trial), beside — never instead of — the operator's row. `AccessControl.decide`
reads both ([commercial-access.md §4](commercial-access.md#4-states-and-transitions)).

## 2. The flow

```text
student (signed in)
  │  chooses an offer
  ▼
api: createCheckout(userId from the session, offer from configuration)
  │  records the checkout (billing_checkouts): this platform started it, for this account
  ▼
provider's hosted checkout ── card details go here, never to JumpToTech
  │
  ├── browser returns to the success URL ──► grants NOTHING
  │
  └── provider sends signed webhooks
        checkout.completed      → the provider customer is bound to the account
        subscription.created    → billing_subscriptions + billing's entitlement row
  ▼
AccessControl.decide — the student can start labs on their next request
```

The account is never taken from the browser. The checkout is created for the
authenticated caller and carries their internal user id as the provider's
client reference; a webhook naming an account is believed only if this
platform recorded a checkout for that same account.

## 3. Configuration

| Variable | Meaning | Default |
|---|---|---|
| `BILLING_PROVIDER` | `test`, or empty for off. Anything else refuses to start | off |
| `BILLING_WEBHOOK_SECRET` | The webhook signing secret, ≥ 32 characters. Redacted from every log | — (required when on) |
| `BILLING_RENEWAL_LEEWAY_HOURS` | 0–168. Hours access outlasts a renewing period's end while the renewal is collected (§5) | **none — required** |
| `BILLING_PAST_DUE_GRACE_HOURS` | 0–720. Hours a failed renewal keeps access, from the unpaid period's start (§5) | **none — required** |
| `BILLING_OFFERS_JSON` | What can be bought: `{"offers":[{"id","plan","priceRef","name","description?","priceLabel?","interval?","features?"}]}` | no offers |

The two hour values are business decisions (§7), so there is no default:
setting one is choosing it. An offer's `plan` must be a configured plan
([commercial-access.md §10](commercial-access.md#10-plans-trials-and-limits))
or `null` (every track); `priceRef` is the provider's price id and never leaves
the server. **An offer has no amount, currency or tax field, and one is
refused**: the provider's price is what is charged, and `priceLabel` is display
text only.

For local development:

```bash
BILLING_PROVIDER=test
BILLING_WEBHOOK_SECRET=$(openssl rand -hex 32)
BILLING_RENEWAL_LEEWAY_HOURS=0
BILLING_PAST_DUE_GRACE_HOURS=0
BILLING_OFFERS_JSON='{"offers":[{"id":"dev-monthly","plan":null,"priceRef":"price_test_dev","name":"Development offer","priceLabel":"Test mode"}]}'
```

These variables are deliberately **not** passed through the compose files:
the only provider is refused in production, so there is nothing to deploy.

## 4. Webhooks: verification, idempotency, ordering, failure

| Step | Rule | Answer |
|---|---|---|
| Size | At most 64 KB, read as raw bytes before any JSON parsing | 413 |
| Signature | `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`, constant-time compare; a timestamp more than 300 s away is refused (a captured webhook cannot be replayed later) | 400 `WEBHOOK_REJECTED`, nothing read or stored |
| Shape | Every field strictly validated; unknown statuses refused | 400 |
| Type | An event type this platform does not use | 200 `ignored`, recorded |
| Idempotency | The provider's event id is claimed in `billing_events` inside the processing transaction | a repeat: 200 `duplicate`, nothing done |
| Account | The customer's bound account; or — for a subscription that arrives before its `checkout.completed` — the client reference, **only** if this platform started a checkout for that account | unknown: 500, retried |
| Ownership | A customer or subscription already bound to another account is never rebound | 200 `ignored`, `billing.ownership_conflict` logged |
| Ordering | An event older than the stored state (`provider_state_at`) is recorded and not applied; the account's row lock serialises concurrent events, and the SQL upsert refuses an older state again | 200 `stale` |
| Price | A price no offer names | 500, retried after the configuration is fixed |
| Apply | Store the subscription; compute billing's entitlement from **all** the account's subscriptions; sync the row | 200 `applied` |

Everything from the claim to the entitlement change is **one transaction**. If
any step fails, nothing happened — not even the claim — and the answer is 500,
so the provider's retry processes the event from the start. A handler that
fails temporarily and succeeds on retry applies exactly once
(`billing-webhooks.test.ts`, `billing-persistence-integration.test.ts`).

Nothing a browser sends reaches the processor. The body is never stored or
logged: only the event id, type and outcome.

## 5. Provider state → product state

Students and operators see a **product** status, never a raw provider one:

| Provider status | Product status | Billing's entitlement row |
|---|---|---|
| `trialing` | TRIAL | active through the trial end (+ leeway unless cancelling); kind TRIAL |
| `active` | ACTIVE | active through the period end + `BILLING_RENEWAL_LEEWAY_HOURS` |
| `active`, cancel at period end | CANCELING ("active until …") | active through the period end exactly — no leeway, no renewal is coming |
| `past_due` (a renewal payment failed) | PAYMENT_PROBLEM | active until the unpaid period's start + `BILLING_PAST_DUE_GRACE_HOURS`; with 0, it ends when the paid period ended |
| `unpaid`, `incomplete` | PAYMENT_PROBLEM | window closed |
| `paused` | PAUSED | window closed |
| `canceled`, `incomplete_expired` | ENDED | window closed |

"Window closed" means the row's `expiresAt` is set to now (or the period's end,
if earlier): the student's access state reads EXPIRED. Billing never sets
REVOKED — that is an operator's word — and a closed window stays closed through
a later `ops access restore`.

**Cancellation.** Both kinds are supported, and which one a customer gets is
decided at the provider, not here: *at period end* keeps access to the end of
what was paid, then the window closes; *immediately* closes it on the next
request. **Reactivation**: undoing a pending cancellation before the end
restores renewal (and the leeway); after a subscription has ended, a new
checkout creates a new subscription on the same provider customer.

**Failed payment.** Access follows the configured grace exactly, then ends;
the provider's recovery (a later successful charge) restores it. Refunds and
dunning (how often the provider retries a card, what emails it sends) are the
provider's configuration, and a business decision (§7).

**Plan changes.** The provider owns prices, proration and invoices. The platform
owns only the result: a subscription moved to another price is reported with
that price, and the offer naming it decides the plan from the next request.

## 6. Subscriptions and manual grants together

- A manual grant (beta, scholarship, staff) and a subscription are separate
  rows. Cancelling the subscription never removes the grant; revoking the grant
  never cancels anything paid. If both are active, the operator's non-trial row
  answers (its plan applies), then the subscription, then a trial.
- **Suspension is account-wide.** `ops access suspend` suspends every row,
  including billing's; a renewal arriving while suspended updates the window
  but stays suspended; a subscription bought while suspended is born
  suspended; `restore` brings back each row with its current window.
- An operator cannot revoke billing's row: `ops access revoke` says to cancel
  in the provider (a refund or cancellation is a financial act), or to suspend
  to stop lab use now.

## 7. Business decisions this code does not make

| Decision | Until decided |
|---|---|
| Which provider (if any) | Only the `test` simulator exists (§9) |
| Plans, offers, prices, currencies, tax | No offer or plan is built in; no amount is stored anywhere |
| Renewal leeway | Required configuration, no default |
| Grace period after a failed payment | Required configuration, no default |
| Cancellation timing offered to customers (end of period / immediate), refunds, dunning | Provider configuration |
| Precedence between a manual grant and a subscription with a different plan | The operator's grant answers (§6) — change it if the business wants otherwise |
| What happens to a running lab when a payment fails | The same as any access end: refused from the next request ([commercial-access.md §5](commercial-access.md#5-what-access-controls)) |
| Trials through the provider vs. operator trials | Both count as the account's one trial |

## 8. Data held

| Table | Holds | Never holds |
|---|---|---|
| `billing_customers` | provider, customer reference, account — one customer per account per provider | name, email, address, payment method |
| `billing_checkouts` | provider, checkout reference, account, offer id, created/completed | amounts |
| `billing_subscriptions` | provider, subscription/customer/price references, plan, status, period, cancel flag, ended at, `provider_state_at` | card, bank or invoice details |
| `billing_events` | provider, event id, type, outcome, subscription reference, times | the payload |

No table has a column that could hold a card number, CVV, bank account or
payment credential (asserted against `information_schema` in
`billing-persistence-integration.test.ts`). The application never receives
card data: checkout and payment-method management are the provider's hosted
pages.

## 9. Integrating a real provider

Not done, and not to be done without the decisions in §7. What it takes:

1. A second `BillingProvider` implementation mapping the provider's events and
   statuses onto §5's table, with its own signature verification, and refusing
   what it cannot map.
2. Its credentials from the environment only, validated at startup; a **live**
   key refused until a reviewed change enables live mode deliberately (the
   `mode` field is `'test'` only today).
3. Compose and `infrastructure/secret-distribution.json` entries for its
   secrets, and `production:config-check` rules.
4. Its webhook endpoint registered at the provider; the nginx edge already
   routes `/api/`.
5. A test-mode run of the whole flow against the provider's sandbox, recorded.

## 10. Observability

| Signal | Meaning |
|---|---|
| `jtt_billing_webhooks_total{provider,outcome}` | applied, duplicate, stale, ignored, invalid_signature, malformed, unmapped, failed — zero-initialised |
| `jtt_billing_provider_requests_total{provider,op,outcome}` | checkout, portal and subscription calls to the provider |
| `billing.webhook_processed` / `_rejected` / `_failed` | one line per delivery: event id and type, outcome, account id — never the body, an email or the secret |
| `billing.ownership_conflict`, `billing.checkout_unknown` | a webhook that tried to bind something to the wrong account |

## Tests

| Suite | Proves |
|---|---|
| `apps/api/test/billing-webhooks.test.ts` | the whole flow over HTTP; a success URL grants nothing; bad, missing, forged and replayed signatures; oversized and malformed bodies; duplicates (sequential and concurrent); out-of-order delivery; failure then retry; unknown accounts and prices retried; renewal, leeway, failed payment with and without grace, cancel at period end and at once, reactivation, provider trials; manual grants and suspension alongside billing; ownership; no card data stored or logged |
| `apps/api/test/billing-config.test.ts` | off by default; test provider refused in production; required decisions with no default; offers without amounts; every provider status mapped to a product status |
| `apps/api/test/billing-persistence-integration.test.ts` | migration 010 on PostgreSQL; one transaction per webhook; concurrent duplicates across two connections; rollback then retry; ordering in SQL; the schema's own refusals; no payment-detail column (`make test-db`) |
