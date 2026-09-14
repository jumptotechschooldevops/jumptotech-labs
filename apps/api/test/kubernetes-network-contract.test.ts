/**
 * BETA-P0-015 — the API's half of the Kubernetes network contract.
 *
 *   1. Configuration is validated at startup: a bad CIDR or an empty DNS
 *      selector refuses to load rather than widening what a Pod can reach.
 *   2. Under NODE_ENV=production NetworkPolicy cannot be disabled and the
 *      enforcement attestation cannot be waived; both gates run after the
 *      earlier P0 gates, so their refusals keep precedence.
 *   3. External egress is off by default everywhere.
 *   4. The composition hands the requirement to the Kubernetes provider, so a
 *      production API over an unproven cluster admits no student.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FakeKubernetes } from '@jumptotech/lab-orchestrator/testing';
import { loadConfig, loadNetworkPolicyConfig } from '../src/config.js';
import { buildSandboxComposition } from '../src/composition.js';

const hex = (label: string): string => createHash('sha256').update(label).digest('hex');

const PRODUCTION = {
  NODE_ENV: 'production',
  AUTH_MODE: 'oidc',
  OIDC_ISSUER: 'https://issuer.example.com',
  OIDC_CLIENT_ID: 'jumptotech-labs',
  OIDC_AUDIENCE: 'jumptotech-labs',
  // BETA-P0-014: required in production.
  OIDC_CLIENT_SECRET: hex('oidc-client').slice(0, 40),
  PUBLIC_ORIGIN: 'https://labs.example.com',
  ALLOWED_ORIGINS: 'https://labs.example.com',
  TERMINAL_SESSION_SECRET: hex('terminal-session'),
  INTERNAL_SERVICE_SECRET: hex('internal-service'),
  NAMESPACE_DERIVATION_SECRET: hex('namespace-derivation'),
  OBSERVABILITY_SCRAPE_TOKEN: hex('scrape-token'),
  RUNTIME_OWNER_ID: 'labs-prod',
  // BETA-P0-014: production sign-in requires durable sessions, so a database.
  // Loopback, which the BETA-P0-012 transport gate accepts without TLS.
  DATABASE_URL: `postgresql://jumptotech:${hex('database-password').slice(0, 32)}@127.0.0.1:5432/jumptotech_labs`,
} as NodeJS.ProcessEnv;

function refusal(env: NodeJS.ProcessEnv): string {
  try {
    loadConfig(env);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected loadConfig to refuse');
}

describe('defaults', () => {
  it('is deny-by-default with no external egress and a named DNS selector, in development', () => {
    const network = loadNetworkPolicyConfig({});

    expect(network.enabled).toBe(true);
    expect(network.allowExternalEgress).toBe(false);
    expect(network.dnsPodSelector).toEqual({ 'k8s-app': 'kube-dns' });
    expect(network.additionalDeniedEgressCidrs).toEqual([]);
    expect(network.attestation.required).toBe(false);
  });

  it('requires an enforcement attestation in production without being asked', () => {
    expect(loadConfig(PRODUCTION).policy.network.attestation).toEqual({ required: true, maxAgeSeconds: 604_800 });
  });

  it('keeps external egress off in production unless explicitly permitted', () => {
    expect(loadConfig(PRODUCTION).policy.network.allowExternalEgress).toBe(false);
    expect(loadConfig({ ...PRODUCTION, ALLOW_EXTERNAL_EGRESS: 'true' }).policy.network.allowExternalEgress).toBe(true);
  });
});

describe('production refusals', () => {
  it('refuses NETWORK_POLICY_ENABLED=false', () => {
    expect(refusal({ ...PRODUCTION, NETWORK_POLICY_ENABLED: 'false' })).toMatch(
      /NODE_ENV=production refuses NETWORK_POLICY_ENABLED=false/,
    );
  });

  it('refuses NETWORK_POLICY_ATTESTATION_REQUIRED=false', () => {
    expect(refusal({ ...PRODUCTION, NETWORK_POLICY_ATTESTATION_REQUIRED: 'false' })).toMatch(
      /NODE_ENV=production refuses NETWORK_POLICY_ATTESTATION_REQUIRED=false/,
    );
  });

  it('lets development switch both off explicitly', () => {
    const network = loadNetworkPolicyConfig({ NETWORK_POLICY_ENABLED: 'false', NETWORK_POLICY_ATTESTATION_REQUIRED: 'false' });

    expect(network.enabled).toBe(false);
    expect(network.attestation.required).toBe(false);
  });

  it('keeps the earlier gates first: a missing runtime owner is still reported as one', () => {
    const { RUNTIME_OWNER_ID: _omitted, ...withoutOwner } = PRODUCTION;

    expect(refusal({ ...withoutOwner, NETWORK_POLICY_ENABLED: 'false' })).toMatch(/RUNTIME_OWNER_ID/);
  });
});

describe('validation, in every environment', () => {
  it.each([
    [{ CLUSTER_POD_CIDR: '10.244.0.0' }, /CLUSTER_POD_CIDR/],
    [{ CLUSTER_SERVICE_CIDR: '10.96.4.0/16' }, /CLUSTER_SERVICE_CIDR.*host bits/],
    [{ CLUSTER_EGRESS_DENY_CIDRS: '172.16.0.0/12, not-a-cidr' }, /CLUSTER_EGRESS_DENY_CIDRS/],
    [{ CLUSTER_DNS_POD_SELECTOR: 'k8s-app' }, /CLUSTER_DNS_POD_SELECTOR/],
    [{ NETWORK_POLICY_ATTESTATION_MAX_AGE_SECONDS: '0' }, /NETWORK_POLICY_ATTESTATION_MAX_AGE_SECONDS/],
  ] as Array<[NodeJS.ProcessEnv, RegExp]>)('refuses %j', (env, message) => {
    expect(() => loadNetworkPolicyConfig(env)).toThrow(message);
  });

  it('reads the DNS selector and the extra deny list', () => {
    const network = loadNetworkPolicyConfig({
      CLUSTER_DNS_POD_SELECTOR: 'k8s-app=kube-dns,app.kubernetes.io/name=coredns',
      CLUSTER_EGRESS_DENY_CIDRS: '203.0.112.0/24, 198.51.99.0/24',
    });

    expect(network.dnsPodSelector).toEqual({ 'k8s-app': 'kube-dns', 'app.kubernetes.io/name': 'coredns' });
    expect(network.additionalDeniedEgressCidrs).toEqual(['203.0.112.0/24', '198.51.99.0/24']);
  });
});

describe('composition', () => {
  it('hands the requirement to the Kubernetes provider: an unproven production cluster is unavailable', async () => {
    const config = loadConfig(PRODUCTION);
    const { kubernetes } = buildSandboxComposition({ config, k8s: new FakeKubernetes() });

    expect(JSON.stringify(await kubernetes.availability())).toMatch(/network isolation is not proven/);
  });

  it('leaves a development cluster ungated', async () => {
    const config = loadConfig({ AUTH_MODE: 'development', TERMINAL_SESSION_SECRET: hex('development') });
    const { kubernetes } = buildSandboxComposition({ config, k8s: new FakeKubernetes() });

    expect(JSON.stringify(await kubernetes.availability())).not.toMatch(/network isolation/);
  });
});
