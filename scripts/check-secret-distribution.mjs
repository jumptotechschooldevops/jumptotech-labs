#!/usr/bin/env node
/**
 * Which service receives which secret, as Docker Compose actually resolves it —
 * BETA-P0-010. Extended to published ports and credential mounts by BETA-P0-011,
 * and by BETA-P0-012 to every published port in every stack (loopback-only in
 * development, exactly 443 and 80 in production) and to private networks.
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

    // BETA-P0-012 — a private network exists in every stack, and is internal
    // where the contract says so. Membership is checked per service below.
    for (const [network, rule] of Object.entries(contract.privateNetworks)) {
      if (network === '$comment') continue;
      if (!config.networks?.[network]) {
        console.error(`[${stackName}] the ${network} network is not defined`);
        failures += 1;
      } else if (rule.internalIn.includes(stackName) && config.networks[network].internal !== true) {
        console.error(`[${stackName}] the ${network} network must be internal: true`);
        failures += 1;
      }
    }

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

      /*
       * BETA-P0-011 — the same resolved definition, asked where its credentials
       * can be reached from. A port or a mount that arrives through a merge or
       * an anchor is seen here the way the running stack would see it.
       *
       * BETA-P0-012 — every publication, not only the credential ports. Only
       * `ports:` is read: `expose:` is metadata and publishes nothing.
       */
      const production = stack.exposure === 'production';
      for (const port of definition.ports ?? []) {
        const target = Number(port.target);
        const published = Number(port.published);
        const hostIp = port.host_ip ?? '';
        if (contract.publishedPorts.never.includes(target)) {
          console.error(`[${stackName}] ${service} publishes port ${target}, which must never be published`);
          failures += 1;
        } else if (production) {
          const allowed = contract.publishedPorts.production.some(
            (entry) => entry.service === service && entry.published === published && entry.target === target,
          );
          if (!allowed) {
            console.error(
              `[${stackName}] ${service} publishes ${hostIp || 'every interface'}:${port.published} -> ${target}; ` +
                'a production stack publishes only the entries in publishedPorts.production',
            );
            failures += 1;
          }
        } else if (!contract.publishedPorts.loopbackOnly.includes(target)) {
          console.error(`[${stackName}] ${service} publishes port ${target}, which is not in publishedPorts.loopbackOnly`);
          failures += 1;
        } else if (hostIp !== '127.0.0.1') {
          console.error(`[${stackName}] ${service} publishes port ${target} on ${hostIp || 'every interface'}; it must bind 127.0.0.1`);
          failures += 1;
        }
      }
      if (production) {
        for (const entry of contract.publishedPorts.production.filter((e) => e.service === service)) {
          const present = (definition.ports ?? []).some(
            (port) => Number(port.published) === entry.published && Number(port.target) === entry.target,
          );
          if (!present) {
            console.error(`[${stackName}] ${service} should publish ${entry.published} -> ${entry.target} (${entry.purpose}), but does not`);
            failures += 1;
          }
        }
      }

      for (const [network, rule] of Object.entries(contract.privateNetworks)) {
        if (network === '$comment') continue;
        const joined = Object.keys(definition.networks ?? {}).includes(network);
        if (joined !== rule.members.includes(service)) {
          console.error(
            `[${stackName}] ${service} ${joined ? 'joins' : 'does not join'} the ${network} network; its members are ${rule.members.join(', ')}`,
          );
          failures += 1;
        }
      }
      for (const volume of definition.volumes ?? []) {
        if (typeof volume.source !== 'string') continue;
        for (const [source, owners] of Object.entries(contract.credentialMounts)) {
          if (source === '$comment') continue;
          if (path.resolve(repoRoot, source) === path.resolve(repoRoot, volume.source) && !owners.includes(service)) {
            console.error(`[${stackName}] ${service} mounts ${source}, which only ${owners.join(', ')} may`);
            failures += 1;
          }
        }
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
console.log(
  '\nevery service receives exactly the secrets, credential mounts, published ports and private networks infrastructure/secret-distribution.json allows',
);
