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
 * Exit: 0 no FAIL · 1 at least one FAIL · 2 could not run (usage, compose missing).
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
  if (result.error) return { error: `could not run docker compose: ${result.error.message}` };
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

/** Every check for one resolved configuration. */
function evaluate(config: ResolvedCompose, dockerSocketGid: number | undefined): CheckResult[] {
  const results = [
    ...evaluateProductionComposition(config, {
      repoRoot,
      ...(dockerSocketGid !== undefined ? { hostDockerSocketGid: dockerSocketGid } : {}),
    }),
    ...evaluateServiceLoaders(config, LOADERS, SECRET_NAMES),
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
    OIDC_AUDIENCE: 'jtt-private-beta',
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
}

function scenarios(base: Record<string, string>): Scenario[] {
  return [
    { name: 'a complete five-student beta configuration passes', change: {}, dockerSocketGid: 998, expectFail: [] },
    { name: 'the capacity default (20) is refused', change: { MAX_ACTIVE_SESSIONS: null }, expectFail: ['capacity.beta-contract'] },
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
      expectFail: ['loader.api', 'loader.terminal'],
    },
    { name: 'a weak broker secret is refused', change: { SANDBOXD_ATTACH_SECRET: 'short' }, expectFail: ['loader.terminal', 'loader.sandboxd'] },
    { name: 'a missing runtime owner is refused by compose', change: { RUNTIME_OWNER_ID: null }, expectFail: ['compose'] },
    { name: 'a Docker socket group mismatch is refused', change: { DOCKER_SOCKET_GID: null }, dockerSocketGid: 998, expectFail: ['runtime.docker-socket-gid'] },
    {
      name: 'a malformed .env line is refused without echoing its value',
      change: { POSTGRES_PASSWORD: `"${base.POSTGRES_PASSWORD}` },
      expectFail: ['compose'],
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
