/**
 * Would this host's production configuration start, and is it the configuration
 * the private beta was proven with?
 *
 *   npm run production:config-check                       # the operator's .env
 *   npm run production:config-check -- --docker-socket-gid "$(stat -c %g /var/run/docker.sock)"
 *   npm run production:config-check -- --print-network-env  # for verify:network-policy
 *   npm run production:config-check -- --self-test        # CI: the gates fail closed
 *
 * Asks `docker compose config` for the five production files with the
 * observability profile — the exact merge the runbook's `prod` function starts —
 * then:
 *
 *   · checks the merged configuration against the production-host contract
 *     (test-support/production-host-contract.ts): exposure, privilege, pinned
 *     gates, the five-student capacity contract, durability;
 *   · runs the api, terminal and sandboxd configuration loaders — the functions
 *     each container runs first at startup — against the environment Compose
 *     resolved for that service. A refusal here is a container that would exit;
 *   · prints the NetworkPolicy contract digest the api will demand of the
 *     cluster's enforcement attestation.
 *
 * Nothing is started, built or contacted. It needs the Docker CLI with the
 * compose plugin and `npm ci`; it does not need a daemon.
 *
 * ## It never prints a secret
 *
 * The resolved configuration holds every secret in `.env`. It is kept in memory,
 * never written or echoed. Output names services, variables and ports; loader
 * refusals — which already name variables rather than values — are redacted
 * against every secret value before they are printed.
 *
 * `--self-test` uses generated sentinel secrets in a scrubbed environment (no
 * `.env`, no shell variables) and proves, against the real compose files and the
 * real loaders, that a complete beta configuration passes and that each unsafe
 * variation is refused.
 *
 * Exit: 0 no FAIL · 1 at least one FAIL (including compose refusing the .env) ·
 * 2 could not run (usage; the docker CLI missing or hung).
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { networkPolicyContractDigest } from '@jumptotech/lab-orchestrator';
import {
  PRODUCTION_COMPOSE_FILES,
  PRODUCTION_COMPOSE_PROFILES,
  evaluateProductionComposition,
  evaluateServiceLoaders,
  formatResult,
  redactValues,
  summarise,
  type CheckResult,
  type ResolvedCompose,
} from '@jumptotech/test-support/production-host-contract';
import { loadConfig, loadNetworkPolicyConfig } from '../apps/api/src/config.js';
import { secretWeakness } from '../services/observability/src/secret-policy.js';
import { loadSandboxdConfig } from '../services/sandboxd/src/config.js';
import { loadTerminalConfig } from '../services/terminal/src/config.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distribution = JSON.parse(readFileSync(path.join(repoRoot, 'infrastructure/secret-distribution.json'), 'utf8')) as {
  secrets: string[];
};
const SECRET_NAMES: readonly string[] = distribution.secrets;

const LOADERS = { api: loadConfig, terminal: loadTerminalConfig, sandboxd: loadSandboxdConfig } as const;

/** The variables `loadNetworkPolicyConfig` reads; together they decide the attestation digest. */
export const NETWORK_CONTRACT_VARIABLES = [
  'NODE_ENV',
  'SESSION_NETWORKPOLICY_NAME',
  'NETWORK_POLICY_ENABLED',
  'CLUSTER_DNS_NAMESPACE',
  'CLUSTER_DNS_POD_SELECTOR',
  'CLUSTER_POD_CIDR',
  'CLUSTER_SERVICE_CIDR',
  'ALLOW_EXTERNAL_EGRESS',
  'CLUSTER_EGRESS_DENY_CIDRS',
  'NETWORK_POLICY_ATTESTATION_REQUIRED',
  'NETWORK_POLICY_ATTESTATION_MAX_AGE_SECONDS',
] as const;

interface Resolution {
  config?: ResolvedCompose;
  error?: string;
  /** The docker CLI could not be run at all (missing, hung): a tooling failure, not a refusal. */
  toolFailure?: boolean;
}

/** `docker compose config` for the production stack. stdout (every secret) stays in memory. */
function resolveComposition(options: { envFile?: string; env: NodeJS.ProcessEnv }): Resolution {
  const args = [
    'compose',
    '--project-directory',
    repoRoot,
    ...(options.envFile ? ['--env-file', options.envFile] : []),
    ...PRODUCTION_COMPOSE_FILES.flatMap((file) => ['-f', path.join(repoRoot, file)]),
    ...PRODUCTION_COMPOSE_PROFILES.flatMap((profile) => ['--profile', profile]),
    'config',
    '--format',
    'json',
  ];
  // Rendering needs no daemon; two minutes is a hung CLI, not a slow one.
  const result = spawnSync('docker', args, { env: options.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
  if (result.error) return { error: `could not run docker compose: ${result.error.message}`, toolFailure: true };
  if (result.status !== 0) {
    const message = result.stderr.trim().split('\n').slice(-3).join(' ') || `docker compose config exited ${result.status}`;
    return { error: redactComposeError(message, options.envFile ?? path.join(repoRoot, '.env')) };
  }
  return { config: JSON.parse(result.stdout) as ResolvedCompose };
}

/**
 * Compose names the variable it refused, but a malformed .env line is quoted
 * back: `line 4: unterminated quoted value "<the value>`. Remove every quoted
 * fragment, then every value and token from the env file, before printing.
 */
function redactComposeError(message: string, envFile: string): string {
  let fragments: string[] = [];
  try {
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const value = line.includes('=') ? line.slice(line.indexOf('=') + 1) : line;
      fragments.push(line, value, value.replace(/^["']|["']$/g, ''), ...value.split(/[\s"']+/));
    }
  } catch {
    fragments = [];
  }
  return redactValues(message, fragments).replace(/"[^"]*("|$)/g, '"[REDACTED]"');
}

function apiEnvironment(config: ResolvedCompose): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(config.services?.api?.environment ?? {})
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([key, value]) => [key, String(value)]),
  );
}

/** Where a secret reaches a container under another name. */
const SECRET_ALIASES: Readonly<Record<string, readonly string[]>> = {
  GRAFANA_ADMIN_PASSWORD: ['GF_SECURITY_ADMIN_PASSWORD'],
};

/**
 * Each loader refuses two equal secrets that it holds itself; none can see a
 * secret it does not hold. SANDBOXD_ATTACH_SECRET equal to OIDC_CLIENT_SECRET
 * or to the database password passed every loader, and would have put the
 * api's credentials inside the terminal, the process students type into. Only
 * this check sees every service at once. Names only, never a value.
 */
function evaluateSecretDistinctness(config: ResolvedCompose): CheckResult[] {
  const resolved = new Map<string, string>();
  for (const name of SECRET_NAMES) {
    for (const service of Object.values(config.services ?? {})) {
      for (const variable of [name, ...(SECRET_ALIASES[name] ?? [])]) {
        const value = service.environment?.[variable];
        if (typeof value === 'string' && value.trim() !== '' && !resolved.has(name)) resolved.set(name, value.trim());
      }
    }
  }
  const results: CheckResult[] = [];
  const owners = new Map<string, string>();
  const shared: string[] = [];
  for (const [name, value] of resolved) {
    const owner = owners.get(value);
    if (owner) shared.push(`${owner} and ${name}`);
    else owners.set(value, name);
  }
  results.push(
    shared.length > 0
      ? {
          id: 'secrets.distinct',
          status: 'FAIL',
          detail: `the same value serves ${shared.join('; ')}: each must be generated separately (make secrets), or one service holds another's credential`,
        }
      : { id: 'secrets.distinct', status: 'PASS', detail: `${resolved.size} secrets, each a distinct value across every service` },
  );
  // No service loader reads it, so no loader can refuse the value .env.example ships.
  const grafana = resolved.get('GRAFANA_ADMIN_PASSWORD');
  const weakness = grafana === undefined ? 'missing' : secretWeakness(grafana);
  results.push(
    weakness
      ? {
          id: 'secrets.grafana-admin',
          status: 'FAIL',
          detail: `GRAFANA_ADMIN_PASSWORD is ${weakness === 'missing' ? 'not set' : `not a generated secret (${weakness})`}: make secrets generates one`,
        }
      : { id: 'secrets.grafana-admin', status: 'PASS', detail: 'GRAFANA_ADMIN_PASSWORD meets the production secret policy' },
  );
  return results;
}

/** Every check for one resolved configuration. */
function evaluate(config: ResolvedCompose, dockerSocketGid: number | undefined): CheckResult[] {
  const results = [
    ...evaluateProductionComposition(config, {
      repoRoot,
      ...(dockerSocketGid !== undefined ? { hostDockerSocketGid: dockerSocketGid } : {}),
    }),
    ...evaluateServiceLoaders(config, LOADERS, SECRET_NAMES),
    ...evaluateSecretDistinctness(config),
  ];
  try {
    const digest = networkPolicyContractDigest(loadNetworkPolicyConfig(apiEnvironment(config)));
    results.push({ id: 'attestation.expected-digest', status: 'INFO', detail: digest });
  } catch {
    // The api loader above already reported why the network contract is refused.
  }
  return results;
}

// --- --self-test ----------------------------------------------------------------

const hex = (bytes = 24): string => randomBytes(bytes).toString('hex');

function completeBetaEnvironment(): Record<string, string> {
  return {
    RUNTIME_OWNER_ID: 'production-config-self-test',
    PUBLIC_ORIGIN: 'https://labs.production-check.invalid',
    ALLOWED_ORIGINS: 'https://labs.production-check.invalid',
    OIDC_ISSUER: 'https://idp.production-check.invalid',
    OIDC_CLIENT_ID: 'jtt-private-beta',
    // A dedicated API audience, as .env.example recommends: the same value as
    // the client id is a warning (gates.oidc-client).
    OIDC_AUDIENCE: 'jumptotech-api',
    OIDC_REDIRECT_URI: 'https://labs.production-check.invalid/auth/callback',
    MAX_ACTIVE_SESSIONS: '5',
    MAX_ACTIVE_SESSIONS_PER_STUDENT: '1',
    BACKUP_STATUS_DIR: '/srv/jumptotech/backups/status',
    DOCKER_SOCKET_GID: '998',
    ...Object.fromEntries(SECRET_NAMES.map((name) => [name, hex()])),
  };
}

interface Scenario {
  name: string;
  /** Variables to set (string) or remove (null) from the complete environment. */
  change: Record<string, string | null>;
  dockerSocketGid?: number;
  /** Check ids that must FAIL. Empty: nothing may FAIL. `compose` means compose itself must refuse. */
  expectFail: string[];
  /** When given, exactly these check ids must WARN — so a clean configuration also proves it warns about nothing. */
  expectWarn?: string[];
}

function scenarios(base: Record<string, string>): Scenario[] {
  return [
    { name: 'a complete five-student beta configuration passes', change: {}, dockerSocketGid: 998, expectFail: [], expectWarn: [] },
    {
      // The compose default admits 20 labs; the terminal's default holds 16 shells.
      name: 'the capacity default (20) is refused, and is past the terminal default (16)',
      change: { MAX_ACTIVE_SESSIONS: null },
      expectFail: ['capacity.beta-contract', 'capacity.shell-ceilings'],
    },
    { name: 'two sessions per student is refused', change: { MAX_ACTIVE_SESSIONS_PER_STUDENT: '2' }, expectFail: ['capacity.beta-contract'] },
    { name: 'AUTH_MODE=development in .env cannot reach the api', change: { AUTH_MODE: 'development' }, expectFail: [] },
    { name: 'NODE_ENV=development in .env cannot reach the api', change: { NODE_ENV: 'development' }, expectFail: [] },
    { name: 'WEB_TLS=off in .env cannot reach the edge', change: { WEB_TLS: 'off' }, expectFail: [] },
    {
      name: 'the development student header is refused',
      change: { DEV_STUDENT_HEADER_ENABLED: 'true' },
      expectFail: ['gates.authentication', 'loader.api'],
    },
    { name: 'a missing OIDC client secret is refused', change: { OIDC_CLIENT_SECRET: null }, expectFail: ['loader.api'] },
    { name: 'an http issuer is refused', change: { OIDC_ISSUER: 'http://idp.production-check.invalid' }, expectFail: ['loader.api'] },
    { name: 'an insecure session cookie is refused', change: { AUTH_COOKIE_SECURE: 'false' }, expectFail: ['loader.api'] },
    {
      name: 'a plaintext public origin is refused',
      change: {
        PUBLIC_ORIGIN: 'http://labs.production-check.invalid',
        OIDC_REDIRECT_URI: 'http://labs.production-check.invalid/auth/callback',
        ALLOWED_ORIGINS: 'http://labs.production-check.invalid',
      },
      expectFail: ['gates.tls-edge', 'loader.api'],
    },
    { name: 'a missing public origin is refused by compose', change: { PUBLIC_ORIGIN: null }, expectFail: ['compose'] },
    {
      name: 'a development CORS origin is refused',
      change: { ALLOWED_ORIGINS: 'http://localhost:3000,https://labs.production-check.invalid' },
      expectFail: ['loader.api'],
    },
    {
      name: 'waiving the NetworkPolicy attestation is refused',
      change: { NETWORK_POLICY_ATTESTATION_REQUIRED: 'false' },
      expectFail: ['gates.network-policy', 'loader.api'],
    },
    { name: 'the shipped placeholder database password is refused', change: { POSTGRES_PASSWORD: 'dev-only-change-me' }, expectFail: ['loader.api'] },
    {
      name: 'one value for two secrets is refused',
      change: { INTERNAL_SERVICE_SECRET: base.TERMINAL_SESSION_SECRET! },
      expectFail: ['loader.api', 'loader.terminal', 'secrets.distinct'],
    },
    { name: 'a weak broker secret is refused', change: { SANDBOXD_ATTACH_SECRET: 'short' }, expectFail: ['loader.terminal', 'loader.sandboxd'] },
    {
      // Every loader accepts this: no single service holds both.
      name: "one value for two services' secrets is refused",
      change: { SANDBOXD_ATTACH_SECRET: base.OIDC_CLIENT_SECRET! },
      expectFail: ['secrets.distinct'],
    },
    { name: 'the default Grafana admin password is refused', change: { GRAFANA_ADMIN_PASSWORD: 'admin' }, expectFail: ['secrets.grafana-admin'] },
    {
      // Compose keeps a quoted value's whitespace; the api trimmed this key and sandboxd did not.
      name: 'a secret with trailing whitespace is refused',
      change: { NAMESPACE_DERIVATION_SECRET: `"${base.NAMESPACE_DERIVATION_SECRET} "` },
      expectFail: ['loader.api', 'loader.sandboxd'],
    },
    { name: 'a missing runtime owner is refused by compose', change: { RUNTIME_OWNER_ID: null }, expectFail: ['compose'] },
    { name: 'a Docker socket group mismatch is refused', change: { DOCKER_SOCKET_GID: null }, dockerSocketGid: 998, expectFail: ['runtime.docker-socket-gid'] },
    {
      name: 'a malformed .env line is refused without echoing its value',
      change: { POSTGRES_PASSWORD: `"${base.POSTGRES_PASSWORD}` },
      expectFail: ['compose'],
    },
    // The api accepts these origins; the web edge's certificate gate does not,
    // so the edge would exit at every start.
    ...(
      [
        ['an IP address', 'https://203.0.113.7'],
        ['a port', 'https://labs.production-check.invalid:8443'],
        ['a single-label host', 'https://localhost'],
      ] as const
    ).map(([what, origin]) => ({
      name: `a public origin with ${what}, which the edge refuses, is refused`,
      change: { PUBLIC_ORIGIN: origin, ALLOWED_ORIGINS: origin, OIDC_REDIRECT_URI: `${origin}/auth/callback` },
      expectFail: ['gates.tls-edge'],
    })),
    { name: 'a terminal with fewer shells than seats is refused', change: { TERMINAL_MAX_SESSIONS: '4' }, expectFail: ['capacity.shell-ceilings'] },
    {
      name: 'a second trusted origin is a warning that names it',
      change: { ALLOWED_ORIGINS: 'https://labs.production-check.invalid,https://staging.production-check.invalid' },
      expectFail: [],
      expectWarn: ['gates.origins'],
    },
    { name: 'a parent-domain session cookie is a warning', change: { AUTH_COOKIE_DOMAIN: 'production-check.invalid' }, expectFail: [], expectWarn: ['gates.origins'] },
    { name: 'starting with launches paused is a warning', change: { LAB_LAUNCHES_PAUSED: 'true' }, expectFail: [], expectWarn: ['capacity.launches'] },
    // docs/commercial-access.md: allowed, but the one setting that admits every signed-in account.
    { name: 'ACCESS_POLICY=open is a warning', change: { ACCESS_POLICY: 'open' }, expectFail: [], expectWarn: ['access.policy'] },
    { name: 'an ACCESS_POLICY the api does not know is refused', change: { ACCESS_POLICY: 'closed' }, expectFail: ['loader.api'] },
    // Compose passes no EDGE_PROBE_ENABLED to the api, so the probe keeps its
    // production default; the contract still warns if a compose edit ever does.
    { name: 'EDGE_PROBE_ENABLED=false in .env cannot switch the TLS alerts off', change: { EDGE_PROBE_ENABLED: 'false' }, expectFail: [], expectWarn: [] },
    // The api accepts these; sign-in then fails, or the audience admits ID tokens.
    { name: 'a __Host- session cookie, which breaks sign-in, is refused', change: { AUTH_COOKIE_NAME: '__Host-jtt' }, expectFail: ['gates.oidc-client'] },
    { name: 'an API audience equal to the client id is a warning', change: { OIDC_AUDIENCE: 'jtt-private-beta' }, expectFail: [], expectWarn: ['gates.oidc-client'] },
    {
      name: 'a callback URI that is not literal is a warning',
      change: { OIDC_REDIRECT_URI: 'https://labs.production-check.invalid:443/auth/callback' },
      expectFail: [],
      expectWarn: ['gates.oidc-client'],
    },
  ];
}

function selfTest(): number {
  const workDir = mkdtempSync(path.join(tmpdir(), 'jtt-production-config-'));
  const scrubbed = Object.fromEntries(
    ['PATH', 'HOME', 'DOCKER_CONFIG', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'TMPDIR']
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]),
  );
  const base = completeBetaEnvironment();
  let failures = 0;
  try {
    for (const [index, scenario] of scenarios(base).entries()) {
      const values: Record<string, string> = { ...base };
      for (const [name, value] of Object.entries(scenario.change)) {
        if (value === null) delete values[name];
        else values[name] = value;
      }
      const envFile = path.join(workDir, `scenario-${index}.env`);
      writeFileSync(envFile, `${Object.entries(values).map(([name, value]) => `${name}=${value}`).join('\n')}\n`, { mode: 0o600 });

      const resolution = resolveComposition({ envFile, env: scrubbed });
      const problems: string[] = [];
      let secretLeak = false;
      if (!resolution.config) {
        if (!scenario.expectFail.includes('compose')) problems.push(`compose refused: ${resolution.error}`);
        if (SECRET_NAMES.some((name) => base[name] && (resolution.error ?? '').includes(base[name]!))) {
          problems.push('a secret value appeared in the compose error');
        }
      } else {
        if (scenario.expectFail.includes('compose')) problems.push('compose accepted a configuration it must refuse');
        const results = evaluate(resolution.config, scenario.dockerSocketGid);
        const failed = results.filter((result) => result.status === 'FAIL').map((result) => result.id);
        for (const id of scenario.expectFail.filter((id) => id !== 'compose')) {
          if (!failed.includes(id)) problems.push(`${id} did not fail`);
        }
        for (const id of failed) {
          if (!scenario.expectFail.includes(id)) problems.push(`${id} failed unexpectedly: ${results.find((r) => r.id === id)!.detail}`);
        }
        if (scenario.expectWarn) {
          const warned = results.filter((result) => result.status === 'WARN').map((result) => result.id);
          for (const id of scenario.expectWarn.filter((id) => !warned.includes(id))) problems.push(`${id} did not warn`);
          for (const id of warned.filter((id) => !scenario.expectWarn!.includes(id))) {
            problems.push(`${id} warned unexpectedly: ${results.find((r) => r.id === id)!.detail}`);
          }
        }
        const printed = results.map(formatResult).join('\n');
        secretLeak = SECRET_NAMES.some((name) => values[name] && values[name]!.length >= 6 && printed.includes(values[name]!));
        if (secretLeak) problems.push('a secret value appeared in the output');
      }
      if (problems.length === 0) {
        console.log(`PASS   ${scenario.name}`);
      } else {
        failures += 1;
        console.log(`FAIL   ${scenario.name}`);
        for (const problem of problems) console.log(`         ${problem}`);
      }
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  console.log(failures === 0 ? '\nRESULT: PASS — the production configuration gates fail closed' : `\nRESULT: FAIL — ${failures} scenario(s)`);
  return failures === 0 ? 0 : 1;
}

// --- main -----------------------------------------------------------------------

function main(): number {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        'env-file': { type: 'string' },
        'docker-socket-gid': { type: 'string' },
        'print-network-env': { type: 'boolean', default: false },
        'self-test': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
      },
      strict: true,
    }));
  } catch (error) {
    console.error(`production-config-check: ${(error as Error).message}`);
    return 2;
  }
  if (values['self-test']) return selfTest();

  const gidText = values['docker-socket-gid'];
  if (gidText !== undefined && !/^\d+$/.test(gidText)) {
    console.error('production-config-check: --docker-socket-gid must be a number');
    return 2;
  }

  const resolution = resolveComposition({
    ...(values['env-file'] ? { envFile: path.resolve(values['env-file']) } : {}),
    env: process.env,
  });
  if (!resolution.config) {
    if (resolution.toolFailure) {
      console.error(`production-config-check: ${resolution.error}`);
      return 2;
    }
    console.error(`FAIL   compose.render  docker compose refused the production configuration: ${resolution.error}`);
    return values['print-network-env'] ? 2 : 1;
  }

  if (values['print-network-env']) {
    // Not secrets: CIDRs, selectors, booleans. The exact values the api will run with.
    const environment = apiEnvironment(resolution.config);
    for (const name of NETWORK_CONTRACT_VARIABLES) {
      if (environment[name] !== undefined) console.log(`${name}=${environment[name]}`);
    }
    return 0;
  }

  const results = evaluate(resolution.config, gidText === undefined ? undefined : Number(gidText));
  if (values.json) {
    console.log(JSON.stringify({ results, summary: summarise(results) }, null, 2));
  } else {
    for (const result of results) console.log(formatResult(result));
    const counts = summarise(results);
    console.log(`\n${counts.PASS} PASS, ${counts.FAIL} FAIL, ${counts.WARN} WARN`);
  }
  return results.some((result) => result.status === 'FAIL') ? 1 : 0;
}

process.exitCode = main();
