# RB-22 — Billing: webhooks, the provider, and drift

**Alerts:** `BillingWebhooksFailing`, `BillingWebhookSignaturesRejected`,
`BillingProviderFailing`, `BillingStateDrift` (all warning)
**Source:** `jtt_billing_webhooks_total`, `jtt_billing_provider_requests_total`,
`jtt_billing_reconcile_drift` — published only when `BILLING_PROVIDER` is set.
**Blast radius:** students who pay may not get access yet, or students who
cancelled may keep it; nobody else. Lab use itself is unaffected.

The model is [billing.md](../billing.md). Commands use `prod`, `q` and `ops`
from [private-beta-operations.md §1](private-beta-operations.md).

Two facts shape every step: **the provider retries** a webhook the api answered
with an error, so a failure is a delay until its retries run out; and **the api
never applies a webhook partially** — each is one transaction — so nothing needs
cleaning up after a failure.

## 1. Confirm it is real

```bash
q 'sum by (outcome) (increase(jtt_billing_webhooks_total[1h]))'
q 'sum by (op, outcome) (increase(jtt_billing_provider_requests_total[1h]))'
q 'jtt_billing_reconcile_drift'
prod logs --since 1h api | grep -E '"event":"billing\.(webhook_failed|webhook_rejected|provider_failed|ownership_conflict)"'
```

## 2. Scope it

| Signal | What it is |
|---|---|
| `outcome="failed"` | Verified webhooks the api could not process: the database, a bug. `billing.webhook_failed` names the code |
| `outcome="unmapped"` | A price no offer in `BILLING_OFFERS_JSON` names, or a subscription for an account that never started a checkout here |
| `outcome="invalid_signature"` at every delivery | `BILLING_WEBHOOK_SECRET` does not match the provider's signing secret (a rotation done on one side only) |
| `outcome="invalid_signature"` in bursts, real deliveries still `applied` | The endpoint is being probed. Nothing was applied |
| Provider requests failing | Checkout, portal or reconciliation cannot reach the provider |
| Drift > 0 | The last `ops billing reconcile` found disagreements |

## 3. Immediate mitigation

- **Failing / unmapped**: nothing to stop — the provider keeps retrying. Fix the
  cause (§5) before its retries run out.
- **Signature mismatch after a rotation**: put the provider's current signing
  secret in `BILLING_WEBHOOK_SECRET`, `prod up -d api`. The provider's retries
  then succeed.
- **Probing**: nothing is applied without a valid signature. No action unless
  it degrades the api (then rate-limit at the edge).
- **A paying student is waiting now**: an operator grant is always available
  and independent of billing — `ops access grant <id> --until <end of their
  period> --by <you> --reason "billing delayed, event <id>"`. Revoke it once
  billing catches up.

## 4. Diagnose

1. `prod logs --since 6h api | grep '"event":"billing.webhook_failed"'` — the
   `code` and `eventRef` of each failure.
2. `UNMAPPED_PRICE`: compare the price in the provider's dashboard for that
   event with `BILLING_OFFERS_JSON`.
3. `UNMAPPED_SUBSCRIPTION`: the subscription names an account that never
   started a checkout here — made in the provider's dashboard, or a payment
   link. It is not bound to anyone automatically by design.
4. `INTERNAL` / database codes: [RB-02](RB-02-database.md).
5. For one student: `ops billing show <user-id>` — customer, subscriptions,
   billing's row, and the events processed for them, with outcomes.

## 5. Fix

- **Unmapped price**: add the offer (or correct `priceRef`) in
  `BILLING_OFFERS_JSON`, `prod up -d api`. The provider's next retry applies it.
- **Retries ran out, or a webhook never came**: `ops billing reconcile` (report
  only) lists every disagreement; then
  `ops billing reconcile --apply --by <you> --reason "<incident>"` re-processes
  each drifted subscription from the provider's current state through the same
  processor a webhook uses.
- **A subscription the provider does not know** (reported under "needs a
  person"): deleted or refunded at the provider, or created in another
  account. Decide with whoever owns billing; do not edit the database.

## 6. Verify recovery

```bash
q 'increase(jtt_billing_webhooks_total{outcome=~"failed|unmapped"}[30m])'   # 0
ops billing reconcile                                                       # 0 disagreement(s)
ops billing show <user-id>                                                  # the student sees what they paid for
```

## 7. What this does NOT mean

- **Not a payment problem of a student's.** A declined card is a normal
  `applied` event that moves a subscription to PAYMENT_PROBLEM; it alerts
  nobody.
- **Not an access-control failure.** Access is decided from stored rows on
  every request; these alerts are about the rows being late, not wrong.
- **Not money lost.** Nothing here charges or refunds; the provider does.

## 8. Escalate when

- Webhooks have failed for longer than the provider's retry period (check its
  documentation), or reconciliation reports subscriptions for a person.
- `billing.ownership_conflict` appears: a customer or subscription named a
  different account than the one it belongs to. Treat as a security event
  ([RB-08](RB-08-security-events.md)).

## 9. Follow-up

- Run `ops billing reconcile` after every billing incident, and record the
  report in the incident notes.
- If the cause was configuration, add the check to the change's review.
