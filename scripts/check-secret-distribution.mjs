#!/usr/bin/env node
/**
 * Which service receives which secret, as Docker Compose actually resolves it —
 * BETA-P0-010.
 *
 *   make secrets-check
 *   node scripts/check-secret-distribution.mjs
 *
 * The hermetic contract test reads the compose files as text. This asks
 * `docker compose config` instead — overlays merged, interpolation applied — so
 * a secret that reaches a service through a merge, an anchor or a nested
 * default is seen the way the running stack would see it.
 *
 * ## It never touches a real secret
 *
 * Every secret is set to a distinct sentinel in a temporary env file, and
 * compose runs with a scrubbed environment so neither the operator's shell nor
 * the repository's `.env` can contribute a value. A service "receives" a secret
 * when that secret's sentinel appears anywhere in its resolved definition —
 * environment, command, labels, build args — so an unexpected channel counts
 * too. Output names variables and services only; sentinel values are never
 * printed, and nothing real is ever in memory to print.
 *
 * Needs the Docker CLI with the compose plugin. Needs no daemon.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contract = JSON.parse(
  readFileSync(path.join(repoRoot, 'infrastructure/secret-distribution.json'), 'utf8'),
);

const sentinels = Object.fromEntries(
  contract.secrets.map((name) => [name, `p0010sentinel${randomBytes(12).toString('hex')}`]),
);

/**
 * Non-secret variables the compose files require with `${NAME:?}` and no
 * default. Without them `docker compose config` refuses to resolve at all.
 * `RUNTIME_OWNER_ID` (BETA-P0-008) is deliberately never defaulted in compose.
 * These are not secrets and are not checked for distribution here.
 */
const requiredSettings = { RUNTIME_OWNER_ID: 'secret-distribution-check' };

const workDir = mkdtempSync(path.join(tmpdir(), 'jtt-secret-distribution-'));
const envFile = path.join(workDir, 'sentinel.env');
writeFileSync(
  envFile,
  `${Object.entries({ ...requiredSettings, ...sentinels })
    .map(([name, value]) => `${name}=${value}`)
    .join('\n')}\n`,
  { mode: 0o600 },
);

/** Only what the Docker CLI needs to find itself. No secret can come from here. */
const scrubbedEnv = Object.fromEntries(
  ['PATH', 'HOME', 'DOCKER_CONFIG', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'TMPDIR']
    .filter((name) => process.env[name] !== undefined)
    .map((name) => [name, process.env[name]]),
);

let failures = 0;

try {
  for (const [stackName, stack] of Object.entries(contract.stacks)) {
    const args = [
      'compose',
      '--project-directory',
      repoRoot,
      '--env-file',
      envFile,
      ...stack.files.flatMap((file) => ['-f', path.join(repoRoot, file)]),
      ...stack.profiles.flatMap((profile) => ['--profile', profile]),
      'config',
      '--format',
      'json',
    ];
    const result = spawnSync('docker', args, { env: scrubbedEnv, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    if (result.status !== 0) {
      // Compose's own error names a variable or a file, never a value from our
      // sentinel file; still, do not echo stdout, which would be the config.
      console.error(`[${stackName}] docker compose config failed:\n${result.stderr.trim()}`);
      failures += 1;
      continue;
    }

    const config = JSON.parse(result.stdout);
    const resolvedServices = Object.keys(config.services ?? {}).sort();
    const expectedServices = Object.keys(stack.services).sort();

    for (const service of resolvedServices) {
      if (!expectedServices.includes(service)) {
        console.error(`[${stackName}] ${service} is not in the distribution contract; add it with the secrets it may hold`);
        failures += 1;
      }
    }

    for (const service of expectedServices) {
      const definition = config.services?.[service];
      if (!definition) {
        console.error(`[${stackName}] the contract lists ${service}, but the stack does not define it`);
        failures += 1;
        continue;
      }
      const serialised = JSON.stringify(definition);
      const received = contract.secrets.filter((name) => serialised.includes(sentinels[name])).sort();
      const allowed = [...stack.services[service]].sort();

      const extra = received.filter((name) => !allowed.includes(name));
      const missing = allowed.filter((name) => !received.includes(name));
      if (extra.length > 0) {
        console.error(`[${stackName}] ${service} receives ${extra.join(', ')}, which it is not allowed`);
        failures += 1;
      }
      if (missing.length > 0) {
        console.error(`[${stackName}] ${service} should receive ${missing.join(', ')}, but does not`);
        failures += 1;
      }
      if (extra.length === 0 && missing.length === 0) {
        console.log(`[${stackName}] ${service.padEnd(12)} ${received.length ? received.join(', ') : '(no secrets)'}`);
      }
    }
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\nsecret distribution does not match infrastructure/secret-distribution.json (${failures} problem(s))`);
  process.exit(1);
}
console.log('\nevery service receives exactly the secrets infrastructure/secret-distribution.json allows');
