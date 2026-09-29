/**
 * Billing through the operator socket — `ops billing list | show | reconcile`
 * (docs/billing.md §4).
 *
 * Webhooks get lost: a provider gives up after its retries, an endpoint was
 * down for a day, a configuration change altered what a price entitles. The
 * question this suite answers is whether an operator can find that out and fix
 * it without editing a production database:
 *
 *   1. `reconcile` reports every disagreement between stored state and the
 *      provider, and between billing's entitlement rows and what their
 *      subscriptions imply — and changes nothing.
 *   2. `reconcile --apply` (attributed: --by, --reason) re-processes the
 *      provider's current state through the webhook processor; a second run
 *      finds nothing.
 *   3. A subscription the provider no longer knows is reported for a person,
 *      never "fixed".
 *   4. Nothing printed is a secret, an email or a payload.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SESSION_POLICY,
  InMemorySessionStore,
  KindLabProvider,
  LabRegistry,
  SessionManager,
} from '@jumptotech/lab-orchestrator';
import { FakeKubernetes } from '@jumptotech/lab-orchestrator/testing';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';
import {
  createBillingMetrics,
  createLogger,
  createOperationsMetrics,
  createRegistry,
} from '@jumptotech/observability';

import { loadConfig } from '../src/config.js';
import { createOperatorHandler, startOperatorSocket } from '../src/operator.js';
import { main as cli, parseArgs } from '../src/operator-cli.js';
import { InMemoryUserRepository } from '../src/auth/users.js';
import { AccessControl, InMemoryAccessStore } from '../src/access/entitlements.js';
import { parsePlans } from '../src/access/plans.js';
import type { BillingPolicy } from '../src/billing/config.js';
import { BillingProcessor } from '../src/billing/processor.js';
import { BillingService } from '../src/billing/service.js';
import { InMemoryBillingStore } from '../src/billing/store.js';
import { TestBillingProvider } from '../src/billing/test-provider.js';
import type { Offer } from '../src/billing/types.js';

let labs: LabRegistry;
beforeAll(async () => {
  labs = await realCatalog();
});

const dirs: string[] = [];
const servers: Array<{ close: () => void }> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const WEBHOOK_SECRET = 'whsec-operations-0123456789abcdef0123456789';
const PLANS = parsePlans({
  plans: [
    { id: 'fixture-all', name: 'Everything', tracks: 'all' },
    { id: 'fixture-linux', name: 'Linux', tracks: ['linux'] },
  ],
});
const offer = (planId: string): Offer => ({
  id: 'fixture-monthly',
  planId,
  priceRef: 'price_test_monthly',
  name: 'Fixture',
  description: null,
  priceLabel: null,
  interval: 'month',
  features: [],
});

async function compose(options: { billing?: boolean } = {}) {
  const config = loadConfig({
    TERMINAL_SESSION_SECRET: 'billing-operations-test-secret',
    ALLOWED_ORIGINS: 'http://localhost:3000',
  } as NodeJS.ProcessEnv);
  const clock = { now: Date.parse('2026-10-01T12:00:00.000Z') };
  const metricsRegistry = createRegistry({ service: 'api', defaultMetrics: false });
  const operations = createOperationsMetrics(metricsRegistry);
  const billingMetrics = createBillingMetrics(metricsRegistry, 'test');
  const lines: string[] = [];
  const logger = createLogger({ service: 'api', level: 'debug', sink: (line) => lines.push(line) });
  const k8s = new FakeKubernetes();
  const provider = new KindLabProvider({ k8s, clusterName: 'jumptotech-labs', resetDrainTimeoutMs: 2_000, destroyTimeoutMs: 2_000, sleep: async () => undefined });
  const sessions = new SessionManager({
    registry: labs,
    provider,
    store: new InMemorySessionStore(),
    policy: DEFAULT_SESSION_POLICY,
    lifetimes: config.lifetimes,
    namespaceSecret: config.namespaceSecret,
  });

  const users = new InMemoryUserRepository('oidc');
  const alice = await users.upsert({ issuer: 'https://issuer.example.com/', subject: 'a-1', email: 'alice@example.com' });
  const accessStore = new InMemoryAccessStore(users);
  const billingProvider = new TestBillingProvider({ webhookSecret: WEBHOOK_SECRET, appUrl: 'http://localhost:3000', now: () => clock.now });
  const store = new InMemoryBillingStore(accessStore);
  const build = (policy: BillingPolicy, offers: Offer[], provider: TestBillingProvider = billingProvider) => {
    const processor = new BillingProcessor({ provider, store, offers, plans: PLANS, policy, now: () => clock.now, logger, metrics: billingMetrics });
    return new BillingService({
      provider,
      store,
      processor,
      access: accessStore,
      offers,
      plans: PLANS,
      policy,
      appUrl: 'http://localhost:3000',
      now: () => clock.now,
      logger,
      metrics: billingMetrics,
    });
  };
  const holder = { service: build({ renewalLeewayHours: 0, pastDueGraceHours: 0 }, [offer('fixture-all')]) };

  const dir = mkdtempSync('/tmp/jttbil-');
  dirs.push(dir);
  const socketPath = path.join(dir, 'operator', 'api.sock');
  const deps: Parameters<typeof createOperatorHandler>[0] = {
    sessions,
    logger,
    actions: operations.operatorActions,
    launchesPaused: false,
    retentionSeconds: 900,
    reaperLastSuccessMs: () => clock.now,
    reaperIntervalSeconds: 60,
    access: { store: accessStore, policy: 'entitlement', plans: PLANS },
    now: () => clock.now,
  };
  // A getter, read on every request, so a test can swap the configuration the way a restart would.
  if (options.billing !== false) Object.defineProperty(deps, 'billing', { get: () => holder.service });
  const server = await startOperatorSocket({ socketPath, logger, handler: createOperatorHandler(deps) });
  servers.push(server!);

  const run = async (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    const writeErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => (err.push(String(chunk)), true)) as typeof process.stderr.write;
    try {
      const code = await cli(argv, { OPERATOR_SOCKET_PATH: socketPath });
      return { code, out: out.join(''), err: err.join('') };
    } finally {
      process.stdout.write = write;
      process.stderr.write = writeErr;
    }
  };

  const subscribe = async () => {
    const started = await holder.service.startCheckout(alice.userId, 'fixture-monthly');
    await holder.service.completeTestCheckout(alice.userId, started.url.split('/').pop()!);
    return (await store.subscriptionsOf(alice.userId))[0]!.subscriptionRef;
  };
  const decide = () =>
    new AccessControl(accessStore, 'entitlement', () => new Date(clock.now), { plans: PLANS }).decide(alice.userId);
  const gauge = async (name: string) => {
    const found = (await metricsRegistry.getMetricsAsJSON()).find((m) => m.name === name);
    return (found?.values as Array<{ value: number }> | undefined)?.[0]?.value;
  };

  return { alice, clock, run, subscribe, decide, holder, build, billingProvider, store, accessStore, lines, gauge };
}

describe('ops billing — seeing it', () => {
  it('lists subscriptions and shows one account in product terms, never an email or a secret', async () => {
    const h = await compose();
    const ref = await h.subscribe();
    const list = await h.run('billing', 'list');
    expect(list.code, list.err + list.out).toBe(0);
    expect(list.out).toContain('TEST mode');
    expect(list.out).toContain(ref);
    expect(list.out).toContain('ACTIVE');

    const shown = await h.run('billing', 'show', h.alice.userId);
    expect(shown.code).toBe(0);
    expect(shown.out).toMatch(/customer:\s+cus_test_/);
    expect(shown.out).toMatch(/student sees:\s+ACTIVE until/);
    expect(shown.out).toMatch(/billing row:\s+ACTIVE SUBSCRIPTION\/fixture-all/);
    expect(shown.out).toMatch(/subscription\.created\s+applied/);
    expect(shown.out + list.out).not.toMatch(/alice@example\.com|whsec|4242/);
  });

  it('answers plainly when billing is off, and refuses a malformed account id', async () => {
    const off = await compose({ billing: false });
    const res = await off.run('billing', 'list');
    expect(res.code).toBe(1);
    expect(res.out).toContain('BILLING_DISABLED');
    const on = await compose();
    expect((await on.run('billing', 'show', 'not-an-id')).out).toContain('INVALID_USER_ID');
  });
});

describe('ops billing reconcile — finding and fixing what webhooks missed', () => {
  it('reports a cancellation whose webhook never arrived, changes nothing, then fixes it with --apply', async () => {
    const h = await compose();
    const ref = await h.subscribe();
    h.clock.now += 2 * 86_400_000;
    // Cancelled at the provider; the webhook was lost.
    h.billingProvider.silently(ref, (s) => ({ ...s, status: 'canceled', endedAt: new Date(h.clock.now).toISOString() }));
    expect((await h.decide()).allowed).toBe(true);

    const report = await h.run('billing', 'reconcile');
    expect(report.code, report.err + report.out).toBe(0);
    expect(report.out).toContain('1 subscription(s); 2 disagreement(s)');
    expect(report.out).toMatch(/status: stored active \| provider canceled/);
    expect(report.out).toContain('report only — nothing changed');
    expect((await h.decide()).allowed).toBe(true);
    expect(await h.gauge('jtt_billing_reconcile_drift')).toBe(2);

    const refused = await h.run('billing', 'reconcile', '--apply');
    expect(refused.code).toBe(2);
    expect(refused.err).toContain('needs --by <operator> and --reason <text>');

    const fixed = await h.run('billing', 'reconcile', '--apply', '--by', 'aisalkyn', '--reason', 'provider outage 1 Oct');
    expect(fixed.code).toBe(0);
    expect(fixed.out).toContain(`${ref}: applied`);
    expect((await h.decide()).allowed).toBe(false);
    expect(await h.gauge('jtt_billing_reconcile_drift')).toBe(0);
    expect(await h.gauge('jtt_billing_reconcile_last_run_timestamp_seconds')).toBe(Math.floor(h.clock.now / 1000));

    const again = await h.run('billing', 'reconcile');
    expect(again.out).toContain('0 disagreement(s)');
    // The fix went through the processor and left a normal audit trail.
    const shown = await h.run('billing', 'show', h.alice.userId);
    expect(shown.out).toMatch(/reconcile\.subscription\s+applied/);
    expect(h.lines.some((l) => l.includes('"event":"billing.reconciled"'))).toBe(true);
  });

  it('records the operator and reason of an --apply in the access history, not the provider', async () => {
    const h = await compose();
    const ref = await h.subscribe();
    h.clock.now += 2 * 86_400_000;
    h.billingProvider.silently(ref, (s) => ({ ...s, status: 'canceled', endedAt: new Date(h.clock.now).toISOString() }));

    const fixed = await h.run('billing', 'reconcile', '--apply', '--by', 'aisalkyn', '--reason', 'INC-12 lost webhooks');
    expect(fixed.code, fixed.err + fixed.out).toBe(0);
    const [latest] = await h.accessStore.events(h.alice.userId, 1);
    expect(latest).toMatchObject({ actor: 'aisalkyn' });
    expect(latest!.reason).toContain('INC-12 lost webhooks');
    expect(latest!.reason).toContain('reconcile.subscription');
  });

  it('never lets a snapshot fetched before a real webhook override that webhook', async () => {
    const h = await compose();
    const ref = await h.subscribe();
    h.clock.now += 86_400_000;
    // A renewal whose webhook was lost, so reconcile has something to re-process.
    h.billingProvider.silently(ref, (s) => ({ ...s, currentPeriodEnd: new Date(h.clock.now + 30 * 86_400_000).toISOString() }));
    // The student cancels while reconcile is between fetching the subscription and applying it.
    const fetch = h.billingProvider.getSubscription.bind(h.billingProvider);
    let raced = false;
    h.billingProvider.getSubscription = async (subscriptionRef: string) => {
      const snapshot = await fetch(subscriptionRef);
      if (!raced) {
        raced = true;
        h.clock.now += 60_000;
        await h.holder.service.simulate(h.alice.userId, 'cancel-now');
        h.clock.now += 60_000;
      }
      return snapshot;
    };

    const fixed = await h.run('billing', 'reconcile', '--apply', '--by', 'ops', '--reason', 'weekly check', '--json');
    expect(fixed.code, fixed.err + fixed.out).toBe(0);
    expect(JSON.parse(fixed.out).data.applied).toEqual([{ subscriptionRef: ref, outcome: 'stale' }]);
    expect((await h.decide()).allowed).toBe(false);
  });

  it('finds billing rows that no longer match what their subscriptions imply after a configuration change', async () => {
    const h = await compose();
    await h.subscribe();
    // The same subscription, but the offer now entitles a different plan and a renewal leeway was configured.
    h.holder.service = h.build({ renewalLeewayHours: 24, pastDueGraceHours: 0 }, [offer('fixture-linux')]);
    const report = await h.run('billing', 'reconcile', '--json');
    const data = JSON.parse(report.out).data;
    expect(data.drift.map((d: { field: string }) => d.field).sort()).toEqual(['entitlement', 'plan']);
    await h.run('billing', 'reconcile', '--apply', '--by', 'ops', '--reason', 'plan mapping changed');
    const decision = await new AccessControl(h.accessStore, 'entitlement', () => new Date(h.clock.now), { plans: PLANS }).decide(
      h.alice.userId,
      { track: 'kubernetes' },
    );
    expect(decision).toMatchObject({ allowed: false, refusal: 'LAB_NOT_IN_PLAN' });
    const shown = JSON.parse((await h.run('billing', 'show', h.alice.userId, '--json')).out).data;
    expect(shown.billingEntitlement).toMatchObject({ planId: 'fixture-linux' });
    expect((await h.run('billing', 'reconcile')).out).toContain('0 disagreement(s)');
  });

  it('reports a subscription the provider no longer knows, for a person to decide', async () => {
    const h = await compose();
    const ref = await h.subscribe();
    // A provider that never heard of it (another account, a deleted test object).
    const forgetful = new TestBillingProvider({ webhookSecret: WEBHOOK_SECRET, appUrl: 'http://localhost:3000', now: () => h.clock.now });
    h.holder.service = h.build({ renewalLeewayHours: 0, pastDueGraceHours: 0 }, [offer('fixture-all')], forgetful);
    const report = await h.run('billing', 'reconcile', '--apply', '--by', 'ops', '--reason', 'weekly check');
    expect(report.out).toContain('needs a person (the provider does not know it)');
    expect(report.out).toContain(ref);
    expect((await h.decide()).allowed).toBe(true);
  });

  it('every documented `ops billing` command parses', () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
    const documented = ['docs/billing.md', 'docs/runbooks/RB-22-billing.md']
      .flatMap((file) => readFileSync(path.join(repoRoot, file), 'utf8').split('\n'))
      .map((line) => line.trim())
      .filter((line) => line.startsWith('ops billing '))
      .map((line) => line.replace(/\s+#.*$/, ''));
    expect(documented.length).toBeGreaterThanOrEqual(5);
    for (const command of documented) {
      const argv = (command.slice('ops '.length).match(/"[^"]*"|\S+/g) ?? [])
        .map((word) => word.replace(/^"|"$/g, ''))
        .map((word) => (word === '<user-id>' ? '0f8fad5b-d9cb-469f-a165-70867728950e' : word));
      expect(parseArgs(argv), command).not.toHaveProperty('error');
    }
    for (const argv of [
      ['billing', 'list'],
      ['billing', 'show', '0f8fad5b-d9cb-469f-a165-70867728950e'],
      ['billing', 'reconcile'],
      ['billing', 'reconcile', '--apply', '--by', 'aisalkyn', '--reason', 'lost webhooks'],
    ]) {
      expect(parseArgs(argv), argv.join(' ')).not.toHaveProperty('error');
    }
    expect(parseArgs(['billing', 'refund', 'x'])).toHaveProperty('error');
    expect(parseArgs(['billing', 'reconcile', '--by', 'x'])).toHaveProperty('error');
  });
});
