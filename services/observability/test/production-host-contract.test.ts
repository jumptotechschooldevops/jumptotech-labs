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
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as contract from '@jumptotech/test-support/production-host-contract';
import {
  PRODUCTION_COMPOSE_FILES,
  PRODUCTION_PUBLICATIONS,
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
      environment: gated(),
      cap_add: ['SETUID', 'SETGID'],
      networks: { default: null, kind: null, sandboxes: null },
      healthcheck: { test: ['CMD', 'node', '-e', 'livez'] },
    },
    sandboxd: {
      environment: gated(),
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
    service.logging = { driver: 'json-file', options: { 'max-size': '20m', 'max-file': '5' } };
  }
  return { services, networks: { database: { internal: true }, default: {}, kind: { external: true }, sandboxes: {} } };
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
    ['NetworkPolicy off', 'gates.network-policy', (c) => (c.services!.api!.environment!.NETWORK_POLICY_ENABLED = 'false')],
    ['the attestation waived', 'gates.network-policy', (c) => (c.services!.api!.environment!.NETWORK_POLICY_ATTESTATION_REQUIRED = 'false')],
    ['the compose capacity default', 'capacity.beta-contract', (c) => (c.services!.api!.environment!.MAX_ACTIVE_SESSIONS = '20')],
    ['two labs per student', 'capacity.beta-contract', (c) => (c.services!.api!.environment!.MAX_ACTIVE_SESSIONS_PER_STUDENT = '2')],
    ['PostgreSQL data in a bind mount', 'durability.volumes', (c) => (c.services!.postgres!.volumes = [{ type: 'bind', source: '/tmp/pg', target: '/var/lib/postgresql/data' }])],
    ['no database health check', 'durability.healthchecks', (c) => delete c.services!.postgres!.healthcheck],
    ['a service with no restart policy', 'durability.restart-policy', (c) => delete c.services!.sandboxd!.restart],
    ['restart: always, which undoes prod stop web', 'durability.restart-policy', (c) => (c.services!.web!.restart = 'always')],
    ['restart: on-failure', 'durability.restart-policy', (c) => (c.services!.grafana!.restart = 'on-failure')],
    ['a service on the daemon default log driver, which never rotates', 'durability.log-rotation', (c) => delete c.services!.api!.logging],
    ['json-file with no size bound', 'durability.log-rotation', (c) => (c.services!.web!.logging = { driver: 'json-file', options: { 'max-file': '5' } })],
    ['no backup status mount', 'backup.status-dir', (c) => (c.services!.api!.volumes = c.services!.api!.volumes!.filter((v) => !v.target.includes('backup')))],
    ['a writable backup status mount', 'backup.status-dir', (c) => (c.services!.api!.volumes![1]!.read_only = false)],
  ];

  it.each(cases)('%s', (_name, id, change) => {
    expect(statusOf(mutate(change), id)).toBe('FAIL');
  });

  it('warns, rather than passes, when the backup status directory is the in-checkout default', () => {
    const results = mutate((c) => (c.services!.api!.volumes![1]!.source = '/repo/backups/status'));
    expect(results.filter((result) => result.status === 'WARN').map((result) => result.id)).toEqual(['backup.status-dir']);
    expect(statusOf(results, 'backup.status-dir')).toBe('WARN');
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

  it('bounds every production service log in the overlays that start it', () => {
    for (const file of ['docker-compose.production.yml', 'docker-compose.production-observability.yml']) {
      const text = read(file);
      expect(text).toMatch(/x-rotated-logs: &rotated-logs\n  driver: json-file\n  options:\n    max-size: 20m\n    max-file: "5"/);
      const restarts = text.match(/^    restart: unless-stopped$/gm) ?? [];
      const rotated = text.match(/^    logging: \*rotated-logs$/gm) ?? [];
      expect(rotated.length, file).toBe(restarts.length);
    }
    const rotatedLocally = evaluateProductionComposition(shipped(), { repoRoot: '/repo' }).find((r) => r.id === 'durability.log-rotation');
    expect(rotatedLocally?.status).toBe('PASS');
    expect(statusOf(mutate((c) => (c.services!.grafana!.logging = { driver: 'local' })), 'durability.log-rotation')).toBe('PASS');
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
