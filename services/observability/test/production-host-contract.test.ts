/**
 * The production-host deployment contract — hermetic half.
 *
 * `npm run production:config-check -- --self-test` (CI `gates`) proves the
 * contract against the real compose files and the real service loaders, which
 * needs the Docker CLI. This suite proves the contract's own decisions with
 * fabricated resolved configurations, so a check that silently stops checking
 * fails here in every `npm test`:
 *
 *   · the shipped shape passes cleanly, and each unsafe variation is a FAIL, not a WARN;
 *   · a loader refusal never carries a secret value to the terminal;
 *   · the contract's file list and publications are the ones the runbook and
 *     infrastructure/secret-distribution.json already declare;
 *   · the scrape token is written so Prometheus (uid 65534) can read it on a
 *     Linux host — the defect found while writing this contract.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as contract from '@jumptotech/test-support/production-host-contract';
import {
  PRODUCTION_COMPOSE_FILES,
  PRODUCTION_PUBLICATIONS,
  composeDurationSeconds,
  evaluateProductionComposition,
  evaluateServiceLoaders,
  formatResult,
  redactValues,
  secretValuesOf,
  type CheckResult,
  type ResolvedCompose,
  type ResolvedService,
} from '@jumptotech/test-support/production-host-contract';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (file: string): string => readFileSync(path.join(REPO_ROOT, file), 'utf8');

const gated = (extra: Record<string, string> = {}): Record<string, string> => ({ NODE_ENV: 'production', ...extra });

/** The production composition as `docker compose config` resolves it today, reduced to what the contract reads. */
function shipped(): ResolvedCompose {
  const services: Record<string, ResolvedService> = {
    postgres: {
      networks: { database: null },
      volumes: [{ type: 'volume', source: 'postgres-data', target: '/var/lib/postgresql/data' }],
      healthcheck: { test: ['CMD-SHELL', 'pg_isready'] },
    },
    api: {
      environment: gated({
        AUTH_MODE: 'oidc',
        DEV_STUDENT_HEADER_ENABLED: 'false',
        PUBLIC_ORIGIN: 'https://labs.contract.invalid',
        ALLOWED_ORIGINS: 'https://labs.contract.invalid',
        OIDC_CLIENT_ID: 'jtt-private-beta',
        OIDC_AUDIENCE: 'jumptotech-api',
        MAX_ACTIVE_SESSIONS: '5',
        MAX_ACTIVE_SESSIONS_PER_STUDENT: '1',
        NETWORK_POLICY_ENABLED: 'true',
        NETWORK_POLICY_ATTESTATION_REQUIRED: '',
      }),
      networks: { database: null, default: null, kind: null },
      volumes: [
        { type: 'bind', source: '/repo/labs', target: '/app/labs', read_only: true },
        { type: 'bind', source: '/srv/jumptotech/backups/status', target: '/var/lib/jumptotech/backup-status', read_only: true },
      ],
      healthcheck: { test: ['CMD', 'node', '-e', 'readyz'] },
    },
    terminal: {
      environment: gated({ TERMINAL_MAX_SESSIONS: '16' }),
      cap_add: ['SETUID', 'SETGID'],
      networks: { default: null, kind: null, sandboxes: null },
      healthcheck: { test: ['CMD', 'node', '-e', 'livez'] },
    },
    sandboxd: {
      environment: gated({ SANDBOXD_MAX_SESSIONS: '32' }),
      volumes: [{ type: 'bind', source: '/var/run/docker.sock', target: '/var/run/docker.sock' }],
      group_add: ['998'],
      networks: { default: null },
    },
    web: {
      environment: { WEB_TLS: 'required', PUBLIC_ORIGIN: 'https://labs.contract.invalid' },
      ports: [
        { target: 8443, published: '443', host_ip: '' },
        { target: 8080, published: '80' },
      ],
      healthcheck: { test: ['CMD', 'jtt-tls-preflight', 'served'] },
      networks: { default: null },
    },
    prometheus: {
      command: ['--config.file=/etc/prometheus/prometheus.yml', '--web.listen-address=127.0.0.1:9090'],
      ports: [{ target: 3000, published: '3001', host_ip: '127.0.0.1' }],
      volumes: [{ type: 'volume', source: 'prometheus-data', target: '/prometheus' }],
      networks: { default: null },
    },
    alertmanager: {
      command: ['--web.listen-address=127.0.0.1:9093', '--cluster.listen-address='],
      network_mode: 'service:prometheus',
      volumes: [{ type: 'volume', source: 'alertmanager-data', target: '/alertmanager' }],
    },
    grafana: {
      environment: { GF_AUTH_ANONYMOUS_ENABLED: 'false', GF_AUTH_BASIC_ENABLED: 'false' },
      network_mode: 'service:prometheus',
      volumes: [{ type: 'volume', source: 'grafana-data', target: '/var/lib/grafana' }],
    },
  };
  for (const service of Object.values(services)) {
    service.restart = 'unless-stopped';
    service.logging = { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '5' } };
  }
  services.postgres!.stop_grace_period = '1m0s';
  return { services, networks: { database: { internal: true }, default: {}, kind: { external: true }, sandboxes: {} } };
}

/** The same public origin for the api and the edge, as `${PUBLIC_ORIGIN}` gives both. */
function setOrigin(config: ResolvedCompose, origin: string): void {
  config.services!.api!.environment!.PUBLIC_ORIGIN = origin;
  config.services!.api!.environment!.ALLOWED_ORIGINS = origin;
  config.services!.web!.environment!.PUBLIC_ORIGIN = origin;
}

const statusOf = (results: CheckResult[], id: string): CheckResult['status'] | undefined =>
  results.find((result) => result.id === id)?.status;

function mutate(change: (config: ResolvedCompose) => void): CheckResult[] {
  const config = shipped();
  change(config);
  return evaluateProductionComposition(config, { repoRoot: '/repo', hostDockerSocketGid: 998 });
}

describe('the shipped production shape', () => {
  it('passes every check with no warning', () => {
    const results = evaluateProductionComposition(shipped(), { repoRoot: '/repo', hostDockerSocketGid: 998 });
    expect(results.filter((result) => result.status !== 'PASS')).toEqual([]);
  });

  it('does not judge the socket group when the host socket could not be read', () => {
    const results = evaluateProductionComposition(shipped(), { repoRoot: '/repo' });
    expect(results.map((result) => result.id)).not.toContain('runtime.docker-socket-gid');
  });
});

describe('each unsafe variation is a FAIL', () => {
  const cases: Array<[string, string, (config: ResolvedCompose) => void]> = [
    ['a missing overlay or profile', 'compose.services', (c) => delete c.services!.grafana],
    ['an unreviewed service', 'compose.services', (c) => (c.services!.debug = {})],
    ['PostgreSQL killed at the default 10 s stop grace', 'durability.database-shutdown', (c) => delete c.services!.postgres!.stop_grace_period],
    ['unrotated container logs', 'durability.log-rotation', (c) => delete c.services!.postgres!.logging],
    ['a log driver with no size bound', 'durability.log-rotation', (c) => (c.services!.api!.logging = { driver: 'json-file' })],
    ['PostgreSQL published on loopback', 'exposure.published-ports', (c) => (c.services!.postgres!.ports = [{ target: 5432, published: 5432, host_ip: '127.0.0.1' }])],
    ['the api published', 'exposure.published-ports', (c) => (c.services!.api!.ports = [{ target: 4000, published: 4000, host_ip: '127.0.0.1' }])],
    ['plaintext on the HTTPS port', 'exposure.published-ports', (c) => (c.services!.web!.ports = [{ target: 3000, published: 443 }, { target: 8080, published: 80 }])],
    ['Grafana on every interface', 'exposure.published-ports', (c) => (c.services!.prometheus!.ports = [{ target: 3000, published: 3001, host_ip: '0.0.0.0' }])],
    ['no HTTPS publication at all', 'exposure.published-ports', (c) => (c.services!.web!.ports = [{ target: 8080, published: 80 }])],
    ['a routable database network', 'exposure.database', (c) => (c.networks!.database = { internal: false })],
    ['the terminal on the database network', 'exposure.database', (c) => (c.services!.terminal!.networks = { database: null, default: null })],
    ['Prometheus on every interface', 'exposure.observability', (c) => (c.services!.prometheus!.command = ['--web.listen-address=0.0.0.0:9090'])],
    ['the Prometheus lifecycle API', 'exposure.observability', (c) => (c.services!.prometheus!.command = ['--web.listen-address=127.0.0.1:9090', '--web.enable-lifecycle'])],
    ['anonymous Grafana', 'exposure.observability', (c) => (c.services!.grafana!.environment = { GF_AUTH_ANONYMOUS_ENABLED: 'true', GF_AUTH_BASIC_ENABLED: 'false' })],
    ['the Docker socket in the api', 'privilege.docker-socket', (c) => c.services!.api!.volumes!.push({ type: 'bind', source: '/var/run/docker.sock', target: '/var/run/docker.sock' })],
    ['a privileged service', 'privilege.containers', (c) => (c.services!.web!.privileged = true)],
    ['an added capability', 'privilege.containers', (c) => (c.services!.api!.cap_add = ['NET_ADMIN'])],
    ['host networking', 'privilege.containers', (c) => (c.services!.web!.network_mode = 'host')],
    ['the wrong socket group', 'runtime.docker-socket-gid', (c) => (c.services!.sandboxd!.group_add = ['0'])],
    ['a development terminal', 'gates.node-env', (c) => (c.services!.terminal!.environment = { NODE_ENV: 'development' })],
    ['development authentication', 'gates.authentication', (c) => (c.services!.api!.environment!.AUTH_MODE = 'development')],
    ['the development student header', 'gates.authentication', (c) => (c.services!.api!.environment!.DEV_STUDENT_HEADER_ENABLED = 'true')],
    ['an unpinned certificate gate', 'gates.tls-edge', (c) => delete c.services!.web!.environment!.WEB_TLS],
    ['a plaintext public origin', 'gates.tls-edge', (c) => (c.services!.api!.environment!.PUBLIC_ORIGIN = 'http://labs.contract.invalid')],
    ['no served-certificate health check', 'gates.tls-edge', (c) => delete c.services!.web!.healthcheck],
    ['an IP address as the public origin, which the edge refuses', 'gates.tls-edge', (c) => setOrigin(c, 'https://203.0.113.7')],
    ['a port in the public origin, which the edge refuses', 'gates.tls-edge', (c) => setOrigin(c, 'https://labs.contract.invalid:8443')],
    ['a single-label public host, which the edge refuses', 'gates.tls-edge', (c) => setOrigin(c, 'https://localhost')],
    ['NetworkPolicy off', 'gates.network-policy', (c) => (c.services!.api!.environment!.NETWORK_POLICY_ENABLED = 'false')],
    ['the attestation waived', 'gates.network-policy', (c) => (c.services!.api!.environment!.NETWORK_POLICY_ATTESTATION_REQUIRED = 'false')],
    ['the compose capacity default', 'capacity.beta-contract', (c) => (c.services!.api!.environment!.MAX_ACTIVE_SESSIONS = '20')],
    ['two labs per student', 'capacity.beta-contract', (c) => (c.services!.api!.environment!.MAX_ACTIVE_SESSIONS_PER_STUDENT = '2')],
    ['a __Host- session cookie, which breaks the /auth transaction cookie', 'gates.oidc-client', (c) => (c.services!.api!.environment!.AUTH_COOKIE_NAME = '__Host-jtt')],
    ['a __host- session cookie in any case', 'gates.oidc-client', (c) => (c.services!.api!.environment!.AUTH_COOKIE_NAME = '__HOST-jtt')],
    ['a terminal that holds fewer shells than there are seats', 'capacity.shell-ceilings', (c) => (c.services!.terminal!.environment!.TERMINAL_MAX_SESSIONS = '4')],
    ['a sandboxd that holds fewer shells than there are seats', 'capacity.shell-ceilings', (c) => (c.services!.sandboxd!.environment!.SANDBOXD_MAX_SESSIONS = '2')],
    ['a shell ceiling that is not a number', 'capacity.shell-ceilings', (c) => (c.services!.terminal!.environment!.TERMINAL_MAX_SESSIONS = 'many')],
    ['PostgreSQL data in a bind mount', 'durability.volumes', (c) => (c.services!.postgres!.volumes = [{ type: 'bind', source: '/tmp/pg', target: '/var/lib/postgresql/data' }])],
    ['no database health check', 'durability.healthchecks', (c) => delete c.services!.postgres!.healthcheck],
    ['a service with no restart policy', 'durability.restart-policy', (c) => delete c.services!.sandboxd!.restart],
    ['restart: always, which undoes prod stop web', 'durability.restart-policy', (c) => (c.services!.web!.restart = 'always')],
    ['restart: on-failure', 'durability.restart-policy', (c) => (c.services!.grafana!.restart = 'on-failure')],
    ['no backup status mount', 'backup.status-dir', (c) => (c.services!.api!.volumes = c.services!.api!.volumes!.filter((v) => !v.target.includes('backup')))],
    ['a writable backup status mount', 'backup.status-dir', (c) => (c.services!.api!.volumes![1]!.read_only = false)],
  ];

  it.each(cases)('%s', (_name, id, change) => {
    expect(statusOf(mutate(change), id)).toBe('FAIL');
  });

  const onlyWarning = (results: CheckResult[]): string[] => results.filter((result) => result.status === 'WARN').map((result) => result.id);

  it('warns, rather than passes, when ALLOWED_ORIGINS trusts an origin beyond PUBLIC_ORIGIN, and names it', () => {
    const results = mutate((c) => (c.services!.api!.environment!.ALLOWED_ORIGINS = 'https://labs.contract.invalid,https://staging.contract.invalid'));
    expect(onlyWarning(results)).toEqual(['gates.origins']);
    expect(results.find((result) => result.id === 'gates.origins')!.detail).toContain('https://staging.contract.invalid');
  });

  it('never prints an origin entry that is not a bare origin, where a credential could be', () => {
    const results = mutate((c) => (c.services!.api!.environment!.ALLOWED_ORIGINS = 'https://labs.contract.invalid,https://ops:hunter2-secret@x.invalid'));
    const detail = results.find((result) => result.id === 'gates.origins')!.detail;
    expect(detail).not.toContain('hunter2-secret');
    expect(detail).toContain('1 entry that is not a bare origin (not printed)');
  });

  it('does not count PUBLIC_ORIGIN itself, with or without a trailing slash, as an extra origin', () => {
    const results = mutate((c) => (c.services!.api!.environment!.ALLOWED_ORIGINS = ' https://labs.contract.invalid/ '));
    expect(statusOf(results, 'gates.origins')).toBe('PASS');
  });

  it('warns when an ID token for this client would also be an API bearer token', () => {
    const results = mutate((c) => (c.services!.api!.environment!.OIDC_AUDIENCE = 'jtt-private-beta'));
    expect(onlyWarning(results)).toEqual(['gates.oidc-client']);
    expect(results.find((result) => result.id === 'gates.oidc-client')!.detail).toContain('dedicated API audience');
  });

  it.each([
    'https://LABS.contract.invalid/auth/callback',
    'https://labs.contract.invalid:443/auth/callback',
    'https://labs.contract.invalid/auth/callback?',
    'https://labs.contract.invalid/auth/callback#',
  ])('warns when the callback URI is not the literal one the provider will compare (%s)', (uri) => {
    expect(onlyWarning(mutate((c) => (c.services!.api!.environment!.OIDC_REDIRECT_URI = uri)))).toEqual(['gates.oidc-client']);
  });

  it('accepts the literal callback URI', () => {
    const results = mutate((c) => (c.services!.api!.environment!.OIDC_REDIRECT_URI = 'https://labs.contract.invalid/auth/callback'));
    expect(statusOf(results, 'gates.oidc-client')).toBe('PASS');
  });

  it.each(['false', '0', 'off', 'no'])('warns when the edge probe, and with it every TLS alert, is switched off (%s)', (value) => {
    expect(onlyWarning(mutate((c) => (c.services!.api!.environment!.EDGE_PROBE_ENABLED = value)))).toEqual(['observability.edge-probe']);
  });

  it('leaves the edge probe on its production default when it is unset or on', () => {
    expect(statusOf(mutate((c) => (c.services!.api!.environment!.EDGE_PROBE_ENABLED = 'true')), 'observability.edge-probe')).toBe('PASS');
    expect(statusOf(mutate((c) => (c.services!.api!.environment!.EDGE_PROBE_ENABLED = '')), 'observability.edge-probe')).toBe('PASS');
  });

  it('warns when the session cookie is widened to a parent domain', () => {
    expect(onlyWarning(mutate((c) => (c.services!.api!.environment!.AUTH_COOKIE_DOMAIN = 'contract.invalid')))).toEqual(['gates.origins']);
  });

  it.each(['true', 'TRUE', '1', 'yes', 'on'])('warns when the stack would start with launches paused (%s)', (value) => {
    expect(onlyWarning(mutate((c) => (c.services!.api!.environment!.LAB_LAUNCHES_PAUSED = value)))).toEqual(['capacity.launches']);
  });

  it('warns when production would admit every signed-in account to labs (ACCESS_POLICY=open)', () => {
    expect(onlyWarning(mutate((c) => (c.services!.api!.environment!.ACCESS_POLICY = 'open')))).toEqual(['access.policy']);
    expect(onlyWarning(mutate((c) => (c.services!.api!.environment!.ACCESS_POLICY = ' OPEN ')))).toEqual(['access.policy']);
  });

  it('passes access control when it is unset (entitlement in production) or entitlement', () => {
    expect(statusOf(mutate((c) => (c.services!.api!.environment!.ACCESS_POLICY = '')), 'access.policy')).toBe('PASS');
    expect(statusOf(mutate((c) => (c.services!.api!.environment!.ACCESS_POLICY = 'entitlement')), 'access.policy')).toBe('PASS');
  });

  it('treats an unset or false pause the way the api does', () => {
    expect(statusOf(mutate((c) => (c.services!.api!.environment!.LAB_LAUNCHES_PAUSED = 'false')), 'capacity.launches')).toBe('PASS');
    expect(statusOf(mutate((c) => (c.services!.api!.environment!.LAB_LAUNCHES_PAUSED = '')), 'capacity.launches')).toBe('PASS');
  });

  it('applies the loader defaults when compose leaves a shell ceiling unset', () => {
    const results = mutate((c) => {
      delete c.services!.terminal!.environment!.TERMINAL_MAX_SESSIONS;
      delete c.services!.sandboxd!.environment!.SANDBOXD_MAX_SESSIONS;
    });
    expect(statusOf(results, 'capacity.shell-ceilings')).toBe('PASS');
  });

  it('warns, rather than passes, when the backup status directory is the in-checkout default', () => {
    const results = mutate((c) => (c.services!.api!.volumes![1]!.source = '/repo/backups/status'));
    expect(results.filter((result) => result.status === 'WARN').map((result) => result.id)).toEqual(['backup.status-dir']);
    expect(statusOf(results, 'backup.status-dir')).toBe('WARN');
  });
});

describe('the PostgreSQL stop grace period is read the way Compose renders it', () => {
  it('reads Go durations', () => {
    expect(composeDurationSeconds('60s')).toBe(60);
    expect(composeDurationSeconds('1m0s')).toBe(60);
    expect(composeDurationSeconds('1h2m3s')).toBe(3723);
    expect(composeDurationSeconds('1m30.5s')).toBe(90.5);
    expect(composeDurationSeconds('500ms')).toBe(0.5);
  });

  it('refuses anything that is not a duration', () => {
    for (const text of ['', '60', 's', '1x', '1m 0s', '-1s', '1.s', '.5s', '1m0']) expect(composeDurationSeconds(text)).toBeUndefined();
  });

  it('passes 1m0s and 30s, and fails 29s, 500ms and an unreadable value', () => {
    const grace = (value: string) => mutate((c) => (c.services!.postgres!.stop_grace_period = value));
    expect(statusOf(grace('1m0s'), 'durability.database-shutdown')).toBe('PASS');
    expect(statusOf(grace('30s'), 'durability.database-shutdown')).toBe('PASS');
    expect(statusOf(grace('29s'), 'durability.database-shutdown')).toBe('FAIL');
    // Read as minutes, "500ms" would have been 30 000 s: a false PASS.
    expect(statusOf(grace('500ms'), 'durability.database-shutdown')).toBe('FAIL');
    expect(statusOf(grace('forever'), 'durability.database-shutdown')).toBe('FAIL');
  });

  // CodeQL js/polynomial-redos: the old /(\d+)(h|m|s)/g rescanned every run of digits from each start.
  it('reads a long run of zeros in linear time', () => {
    const zeros = '0'.repeat(200_000);
    const started = performance.now();
    expect(composeDurationSeconds(zeros)).toBeUndefined();
    expect(composeDurationSeconds(`${zeros}s`)).toBe(0);
    expect(composeDurationSeconds(`1m${zeros}s`)).toBe(60);
    expect(statusOf(mutate((c) => (c.services!.postgres!.stop_grace_period = zeros)), 'durability.database-shutdown')).toBe('FAIL');
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe('loader refusals reach the terminal without a secret', () => {
  const secret = 'f3c1a9d0b7e24c6a8d5f1e0b9c7a6d4e';
  const password = 'p@ss/w0rd:with%specials-0123456789';

  function withApiEnvironment(environment: Record<string, string>): ResolvedCompose {
    const config = shipped();
    config.services!.api!.environment = environment;
    return config;
  }

  it('redacts named secrets, secret-looking names and the password inside DATABASE_URL', () => {
    const config = withApiEnvironment({
      NODE_ENV: 'production',
      TERMINAL_SESSION_SECRET: secret,
      SOME_VENDOR_TOKEN: 'vendor-token-value-123456',
      DATABASE_URL: `postgresql://jtt:${encodeURIComponent(password)}@postgres:5432/db`,
    });
    const leaky = () => {
      throw new Error(`bad ${secret} and vendor-token-value-123456 and ${password} and ${encodeURIComponent(password)}`);
    };
    const results = evaluateServiceLoaders(config, { api: leaky, terminal: () => ({}), sandboxd: () => ({}) }, ['TERMINAL_SESSION_SECRET']);
    const api = results.find((result) => result.id === 'loader.api')!;
    expect(api.status).toBe('FAIL');
    expect(api.detail).not.toContain(secret);
    expect(api.detail).not.toContain('vendor-token-value-123456');
    expect(api.detail).not.toContain(password);
    expect(api.detail).not.toContain(encodeURIComponent(password));
    expect(api.detail.match(/\[REDACTED\]/g)).toHaveLength(4);
  });

  it('hands each loader exactly its own resolved environment, without nulls', () => {
    const seen: Record<string, NodeJS.ProcessEnv> = {};
    const config = shipped();
    config.services!.terminal!.environment = { NODE_ENV: 'production', UNSET: null };
    evaluateServiceLoaders(
      config,
      {
        api: (environment) => (seen.api = environment),
        terminal: (environment) => (seen.terminal = environment),
        sandboxd: (environment) => (seen.sandboxd = environment),
      },
      [],
    );
    expect(seen.terminal).toEqual({ NODE_ENV: 'production' });
    expect(seen.api!.MAX_ACTIVE_SESSIONS).toBe('5');
  });

  it('reports a gated service missing from the composition as a FAIL', () => {
    const config = shipped();
    delete config.services!.sandboxd;
    const results = evaluateServiceLoaders(config, { api: () => ({}), terminal: () => ({}), sandboxd: () => ({}) }, []);
    expect(results.find((result) => result.id === 'loader.sandboxd')!.status).toBe('FAIL');
  });

  it('ignores values too short to be a production secret, so messages stay readable', () => {
    expect(redactValues('port 5432 is fine', ['5432'])).toBe('port 5432 is fine');
    expect(secretValuesOf({ DATABASE_URL: 'not a url' }, [])).toEqual(['not a url']);
  });
});

describe('a manual check cannot be read as a pass', () => {
  it('spells MANUAL out in full', () => {
    expect(formatResult({ id: 'alerts.delivery', status: 'MANUAL', detail: 'x' })).toMatch(/^MANUAL CHECK REQUIRED\s+alerts\.delivery/);
    expect(formatResult({ id: 'a', status: 'PASS', detail: 'y' })).toMatch(/^PASS\s+a\s+y$/);
  });
});

describe('the contract restates declarations it does not own', () => {
  const distribution = JSON.parse(read('infrastructure/secret-distribution.json'));

  it('uses the same five files, in the same order, as secret-distribution.json and the runbook prod function', () => {
    expect([...PRODUCTION_COMPOSE_FILES]).toEqual(distribution.stacks['production-observability'].files);
    const runbook = read('docs/runbooks/private-beta-operations.md');
    const prod = runbook.slice(runbook.indexOf('prod() {'), runbook.indexOf('}', runbook.indexOf('prod() {')));
    const order = [...prod.matchAll(/-f (docker-compose[.a-z-]*\.yml)/g)].map((match) => match[1]);
    expect(order).toEqual([...PRODUCTION_COMPOSE_FILES]);
  });

  it('gives no runbook a production compose command with fewer than the five files', () => {
    // A three-file `up -d api` during a restore re-created the api without its
    // backup-status mount, metrics settings and health check.
    const docs = ['docs/development/production-host-readiness.md', 'docs/releases/production-host-evidence-template.md', 'docs/releases/private-beta-release-gate.md'];
    const runbooks = readdirSync(path.join(REPO_ROOT, 'docs/runbooks')).filter((file) => file.endsWith('.md'));
    const offenders: string[] = [];
    for (const file of [...docs, ...runbooks.map((name) => `docs/runbooks/${name}`)]) {
      const text = read(file);
      // Fenced blocks, and inline code spans, with shell line continuations joined.
      const spans = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g), ...text.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]!.replace(/\\\n\s*/g, ' '));
      for (const span of spans) {
        for (const command of span.split('\n').filter((line) => /docker compose\b.*docker-compose\.production\.yml/.test(line))) {
          const complete = PRODUCTION_COMPOSE_FILES.every((name) => command.includes(name)) && command.includes('--profile observability');
          if (!complete) offenders.push(`${file}: ${command.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('allows exactly the publications secret-distribution.json allows', () => {
    const declared = [
      ...distribution.publishedPorts.production.map((p: { service: string; published: number; target: number }) => `${p.service}:${p.published}:${p.target}`),
      ...distribution.publishedPorts.operatorLoopback.map((p: { service: string; target: number }) => `${p.service}:loopback:${p.target}`),
    ].sort();
    const contract = PRODUCTION_PUBLICATIONS.map((p) => `${p.service}:${p.loopbackOnly ? 'loopback' : p.published}:${p.target}`).sort();
    expect(contract).toEqual(declared);
  });

  it('requires the restart policy the production overlays ship', () => {
    const { PRODUCTION_RESTART_POLICY } = contract;
    expect(PRODUCTION_RESTART_POLICY).toBe('unless-stopped');
    for (const file of ['docker-compose.production.yml', 'docker-compose.production-observability.yml']) {
      expect(read(file)).toContain(`restart: ${PRODUCTION_RESTART_POLICY}`);
    }
  });

  it("accepts exactly the public host names the web edge's certificate gate accepts", () => {
    const gate = read('infrastructure/docker/nginx/tls-preflight.sh');
    const shellPattern = gate.match(/printf '%s' "\$host" \| grep -Eq '([^']+)'/)?.[1];
    expect(shellPattern, 'the host pattern in tls-preflight.sh public_host').toBeDefined();
    expect(contract.EDGE_PUBLIC_HOST_PATTERN.source).toBe(shellPattern);
    for (const host of ['labs.example.com', 'a.b-c.example', 'x1.io']) expect(contract.EDGE_PUBLIC_HOST_PATTERN.test(host), host).toBe(true);
    for (const host of ['localhost', '203.0.113.7', 'labs.example.com:443', 'Labs.example.com', 'labs.example.com/', 'user@labs.example.com', '-a.example.com']) {
      expect(contract.EDGE_PUBLIC_HOST_PATTERN.test(host), host).toBe(false);
    }
  });

  it('holds the beta capacity contract the five-student gate proved', async () => {
    const { BETA_CONTRACT } = await import('@jumptotech/test-support/beta-contract');
    const results = mutate((c) => (c.services!.api!.environment!.MAX_ACTIVE_SESSIONS = String(BETA_CONTRACT.maxActiveSessions)));
    expect(statusOf(results, 'capacity.beta-contract')).toBe('PASS');
  });
});

describe('the scrape token is readable by Prometheus on a Linux host', () => {
  const makefile = read('Makefile');
  const target = makefile.slice(makefile.indexOf('\nobservability-token:'), makefile.indexOf('\nobservability-up:'));

  it('writes the token other-readable in a traversable directory, never 0600', () => {
    expect(target).toContain('chmod 0644 infrastructure/observability/secrets/scrape-token');
    expect(target).toContain('chmod 0711 infrastructure/observability/secrets');
    expect(target).not.toMatch(/chmod 0?600/);
  });

  it('runs Prometheus as the uid that rule is written for', () => {
    const observability = read('docker-compose.observability.yml');
    const prometheus = observability.slice(observability.indexOf('\n  prometheus:'), observability.indexOf('\n  alertmanager:'));
    expect(prometheus).toContain('user: "65534:65534"');
  });

  it('documents the same mode where the token is regenerated by hand', () => {
    const readme = read('infrastructure/observability/secrets/README.md');
    expect(readme).toContain('chmod 0644 infrastructure/observability/secrets/scrape-token');
    expect(readme).not.toMatch(/chmod 600 /);
  });
});

describe('the gates that prove this contract actually run', () => {
  it('runs the configuration self-test and the script tests in CI gates', () => {
    const workflow = read('.github/workflows/quality-gates.yml');
    const gates = workflow.slice(workflow.indexOf('\n  gates:'), workflow.indexOf('\n  postgres-integration:'));
    expect(gates).toContain('npm run --silent production:config-check -- --self-test');
    expect(gates).toContain('bash scripts/test-production-host-scripts.sh');
  });

  it('offers every production-host script as a make target', () => {
    const makefile = read('Makefile');
    for (const target of ['production-preflight', 'production-config-check', 'private-beta-smoke', 'host-capacity-sample', 'test-production-host']) {
      expect(makefile).toMatch(new RegExp(`^${target}: ## `, 'm'));
    }
    expect(read('package.json')).toContain('"production:config-check": "tsx scripts/production-config-check.ts"');
  });

  it('refuses the development teardown targets on a production checkout before they destroy anything', () => {
    const makefile = read('Makefile');
    for (const [target, destructive] of [
      ['clean', 'docker compose down -v'],
      ['sandbox-clean', 'scripts/sandbox-clean.sh'],
    ] as const) {
      const start = makefile.indexOf(`\n${target}: ## `);
      expect(start, target).toBeGreaterThan(-1);
      const recipe = makefile.slice(start, makefile.indexOf('\n\n', start + 1));
      const guard = recipe.indexOf(`scripts/refuse-on-production.sh ${target} `);
      expect(guard, `${target} runs the guard`).toBeGreaterThan(-1);
      expect(recipe.indexOf(destructive), `${target} still does its work`).toBeGreaterThan(guard);
    }
  });

  it('refuses the development start targets on a production checkout before they re-create anything', () => {
    // On the production project these re-create every service from the
    // development files: no AUTH_MODE/NODE_ENV pins, no restart policy, no edge.
    const makefile = read('Makefile');
    for (const [target, starts] of [
      ['up', '$(COMPOSE) up'],
      ['up-kubernetes-only', 'docker compose up'],
      ['rebuild', '$(COMPOSE) up'],
      ['db-up', 'docker compose up'],
    ] as const) {
      const start = makefile.indexOf(`\n${target}: ## `);
      expect(start, target).toBeGreaterThan(-1);
      const recipe = makefile.slice(start, makefile.indexOf('\n\n', start + 1));
      const guard = recipe.indexOf(`scripts/refuse-on-production.sh --recreates ${target}\n`);
      expect(guard, `${target} runs the guard`).toBeGreaterThan(-1);
      expect(recipe.indexOf(starts), `${target} still does its work`).toBeGreaterThan(guard);
    }
  });

  it('never tells an operator to delete volumes', () => {
    for (const file of [
      'scripts/production-preflight.sh',
      'scripts/private-beta-smoke.sh',
      'scripts/host-capacity-sample.sh',
      'scripts/production-host-lib.sh',
      'docs/development/production-host-readiness.md',
      'docs/releases/production-host-evidence-template.md',
    ]) {
      // `down -v` may appear only in a sentence that forbids it.
      for (const line of read(file).split('\n').filter((l) => /down\s+-v\b/.test(l))) {
        expect(line, `${file}: ${line}`).toMatch(/\b(never|Never|NEVER)\b|without/);
      }
    }
  });
});
