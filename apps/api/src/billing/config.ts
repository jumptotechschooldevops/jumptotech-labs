/**
 * Billing configuration — docs/billing.md §3.
 *
 * Off unless `BILLING_PROVIDER` is set, and the only provider that exists is
 * `test`: an in-process simulator that is refused under NODE_ENV=production,
 * because it can be told to "complete a payment" by anyone who can sign in.
 *
 * Every number that is really a business decision is required and has no
 * default: how long access outlasts a period while a renewal is collected, and
 * how long a failed payment keeps access. Setting them is choosing them.
 */
import type { PlanCatalog } from '../access/plans.js';
import { isRef, type Offer } from './types.js';

export interface BillingPolicy {
  /**
   * Hours access outlasts a paid period's end while the renewal is collected —
   * the provider charges *at* the period end and reports it minutes (or, for
   * some providers, about an hour) later. 0 means access lapses at the period
   * end until the renewal event arrives.
   */
  renewalLeewayHours: number;
  /**
   * Hours a subscription whose renewal payment failed (`past_due`) keeps
   * access, counted from the start of the unpaid period. 0: access ends when
   * the paid period ends.
   */
  pastDueGraceHours: number;
}

export interface BillingConfig {
  provider: 'test';
  webhookSecret: string;
  offers: Offer[];
  policy: BillingPolicy;
}

export class BillingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BillingConfigError';
  }
}

const OFFER_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const MAX_OFFERS = 20;

function hours(env: NodeJS.ProcessEnv, name: string, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) {
    throw new BillingConfigError(
      `${name} is required when BILLING_PROVIDER is set: it is a business decision with no default (docs/billing.md §7).`,
    );
  }
  if (!/^\d{1,4}$/.test(raw) || Number(raw) > max) {
    throw new BillingConfigError(`${name} must be a whole number of hours from 0 to ${max}.`);
  }
  return Number(raw);
}

/** Parse `BILLING_OFFERS_JSON`. Every offer's plan must exist; no two offers share a price. */
export function parseOffers(document: unknown, plans: PlanCatalog): Offer[] {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new BillingConfigError('BILLING_OFFERS_JSON must be a JSON object with an "offers" array.');
  }
  const top = document as Record<string, unknown>;
  if (Object.keys(top).some((key) => key !== 'offers') || !Array.isArray(top.offers)) {
    throw new BillingConfigError('BILLING_OFFERS_JSON must be exactly { "offers": [ … ] }.');
  }
  if (top.offers.length > MAX_OFFERS) throw new BillingConfigError(`BILLING_OFFERS_JSON has more than ${MAX_OFFERS} offers.`);
  const offers: Offer[] = [];
  const ids = new Set<string>();
  const prices = new Set<string>();
  top.offers.forEach((raw, index) => {
    const where = `BILLING_OFFERS_JSON offers[${index}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BillingConfigError(`${where} must be an object.`);
    const o = raw as Record<string, unknown>;
    const allowed = ['id', 'plan', 'priceRef', 'name', 'description', 'priceLabel', 'interval', 'features'];
    const extra = Object.keys(o).filter((key) => !allowed.includes(key));
    // An amount, a currency or a tax rate here would be a second, drifting copy
    // of what the provider charges: the provider's price is the only one.
    if (extra.length > 0) throw new BillingConfigError(`${where}: unknown field(s) ${extra.join(', ')}.`);
    if (typeof o.id !== 'string' || !OFFER_ID.test(o.id)) throw new BillingConfigError(`${where}.id must be 1–48 of a-z, 0-9, '-'.`);
    if (ids.has(o.id)) throw new BillingConfigError(`${where}.id ${o.id} is defined twice.`);
    ids.add(o.id);
    if (!isRef(o.priceRef)) throw new BillingConfigError(`${where}.priceRef must be the provider's price reference.`);
    if (prices.has(o.priceRef)) throw new BillingConfigError(`${where}.priceRef is used by two offers.`);
    prices.add(o.priceRef);
    let planId: string | null = null;
    if (o.plan !== null) {
      if (typeof o.plan !== 'string' || !plans.get(o.plan)) {
        throw new BillingConfigError(`${where}.plan must be a plan in ACCESS_PLANS_JSON, or null for every track.`);
      }
      planId = o.plan;
    }
    if (typeof o.name !== 'string' || o.name.trim() === '' || o.name.length > 80) {
      throw new BillingConfigError(`${where}.name must be 1–80 characters.`);
    }
    const optionalText = (value: unknown, field: string, max: number): string | null => {
      if (value === undefined || value === null) return null;
      if (typeof value !== 'string' || value.length > max) throw new BillingConfigError(`${where}.${field} must be text of at most ${max} characters.`);
      return value.trim() || null;
    };
    const interval = o.interval ?? null;
    if (interval !== null && interval !== 'month' && interval !== 'year') {
      throw new BillingConfigError(`${where}.interval must be "month", "year" or absent.`);
    }
    const features = o.features ?? [];
    if (!Array.isArray(features) || features.length > 10 || !features.every((f) => typeof f === 'string' && f.length > 0 && f.length <= 120)) {
      throw new BillingConfigError(`${where}.features must be up to 10 short strings.`);
    }
    offers.push({
      id: o.id,
      planId,
      priceRef: o.priceRef,
      name: o.name.trim(),
      description: optionalText(o.description, 'description', 500),
      priceLabel: optionalText(o.priceLabel, 'priceLabel', 60),
      interval,
      features: features as string[],
    });
  });
  return offers;
}

/**
 * `BILLING_PROVIDER` and what it needs. null: billing is off, which is the
 * default and the private-beta configuration.
 */
export function billingFromEnv(env: NodeJS.ProcessEnv, plans: PlanCatalog): BillingConfig | null {
  const provider = env.BILLING_PROVIDER?.trim().toLowerCase();
  if (!provider) return null;
  if (provider !== 'test') {
    throw new BillingConfigError(
      `BILLING_PROVIDER=${provider.slice(0, 32)} is not integrated. The only provider is "test", a local simulator ` +
        '(docs/billing.md §9 lists what integrating a real one takes).',
    );
  }
  if ((env.NODE_ENV ?? '').trim() === 'production') {
    throw new BillingConfigError(
      'BILLING_PROVIDER=test is refused under NODE_ENV=production: its simulated checkout lets any signed-in account ' +
        'grant itself paid access.',
    );
  }
  const webhookSecret = env.BILLING_WEBHOOK_SECRET?.trim() ?? '';
  if (webhookSecret.length < 32) {
    throw new BillingConfigError('BILLING_WEBHOOK_SECRET must be set to at least 32 characters (openssl rand -hex 32).');
  }
  let offers: Offer[] = [];
  const rawOffers = env.BILLING_OFFERS_JSON?.trim();
  if (rawOffers) {
    let document: unknown;
    try {
      document = JSON.parse(rawOffers);
    } catch {
      throw new BillingConfigError('BILLING_OFFERS_JSON is not valid JSON.');
    }
    offers = parseOffers(document, plans);
  }
  return {
    provider: 'test',
    webhookSecret,
    offers,
    policy: {
      renewalLeewayHours: hours(env, 'BILLING_RENEWAL_LEEWAY_HOURS', 168),
      pastDueGraceHours: hours(env, 'BILLING_PAST_DUE_GRACE_HOURS', 720),
    },
  };
}

/**
 * Where the Terms of Service, Privacy Policy and refund/cancellation policy
 * are published — links only. The platform does not write, host or claim any
 * of them; unset, the account page shows none and says they are not yet
 * published (docs/billing.md §7).
 */
export interface LegalLinks {
  termsUrl: string | null;
  privacyUrl: string | null;
  refundUrl: string | null;
}

function legalUrl(env: NodeJS.ProcessEnv, name: string): string | null {
  const raw = env[name]?.trim();
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new BillingConfigError(`${name} must be an absolute https:// URL.`);
  }
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) {
    throw new BillingConfigError(`${name} must be an https:// URL.`);
  }
  if (parsed.username || parsed.password) throw new BillingConfigError(`${name} must not carry credentials.`);
  return parsed.toString();
}

export function legalFromEnv(env: NodeJS.ProcessEnv): LegalLinks {
  return {
    termsUrl: legalUrl(env, 'LEGAL_TERMS_URL'),
    privacyUrl: legalUrl(env, 'LEGAL_PRIVACY_URL'),
    refundUrl: legalUrl(env, 'LEGAL_REFUND_URL'),
  };
}
