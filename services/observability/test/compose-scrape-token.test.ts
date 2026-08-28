/**
 * PLATFORM-003 — the default stack can actually start.
 *
 * `createObservabilityListener` refuses to start a service that would serve
 * `/metrics` without a scrape token (see `listener.ts`). That refusal is
 * correct: unauthenticated metrics publish capacity and failure rates to
 * anything that can reach the port.
 *
 * The failure this test exists for is the *other* half of that contract. The
 * token was supplied only by `docker-compose.observability.yml`, while `make
 * up` — documented as "Start the application: every track, all 114 labs" —
 * composes `docker-compose.yml` + `docker-compose.runtime.yml` and nothing
 * else. So on a correctly provisioned `.env` the default stack could not start
 * at all: `sandboxd` exited 1 with `OBSERVABILITY_CONFIG_INVALID`, and `api`
 * and `terminal` would have done the same had they been reached.
 *
 * It is a configuration gap rather than a code bug, so no unit test could see
 * it and every unit test still passed. This one reads the compose files as
 * shipped and asserts the invariant directly: every service that builds an
 * observability listener is handed a token by the stack that starts it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Services that call `createObservabilityListener` at startup, and therefore
 * cannot start without a token, mapped to the compose file that defines them.
 */
const METRICS_SERVICES: ReadonlyArray<{ service: string; composeFile: string }> = [
  { service: 'api', composeFile: 'docker-compose.yml' },
  { service: 'terminal', composeFile: 'docker-compose.yml' },
  { service: 'sandboxd', composeFile: 'docker-compose.runtime.yml' },
];

/**
 * Pull one service's `environment:` keys out of a compose file.
 *
 * Deliberately a small reader rather than a YAML dependency: the assertion is
 * about a literal line being present in the file an operator runs, and parsing
 * it through a library would not make that any more true.
 */
function environmentKeysFor(composeFile: string, service: string): string[] {
  const lines = readFileSync(path.join(REPO_ROOT, composeFile), 'utf8').split('\n');

  const serviceStart = lines.findIndex((line) => line === `  ${service}:`);
  expect(serviceStart, `${composeFile} defines a '${service}' service`).toBeGreaterThanOrEqual(0);

  // The service block runs until the next two-space-indented key.
  let serviceEnd = lines.length;
  for (let i = serviceStart + 1; i < lines.length; i += 1) {
    if (/^ {2}\S/.test(lines[i] ?? '')) {
      serviceEnd = i;
      break;
    }
  }

  const block = lines.slice(serviceStart, serviceEnd);
  const envStart = block.findIndex((line) => line === '    environment:');
  if (envStart < 0) return [];

  const keys: string[] = [];
  for (let i = envStart + 1; i < block.length; i += 1) {
    const line = block[i] ?? '';
    if (/^ {4}\S/.test(line)) break; // next key at the service level
    const match = /^ {6}([A-Z0-9_]+):/.exec(line);
    if (match?.[1]) keys.push(match[1]);
  }
  return keys;
}

describe('the default compose stack supplies what its services refuse to start without', () => {
  for (const { service, composeFile } of METRICS_SERVICES) {
    it(`${service} is given OBSERVABILITY_SCRAPE_TOKEN by ${composeFile}`, () => {
      expect(environmentKeysFor(composeFile, service)).toContain('OBSERVABILITY_SCRAPE_TOKEN');
    });
  }

  it('requires the token rather than defaulting it to empty', () => {
    // `${VAR:-}` would satisfy the presence check above and still start a
    // service with no token — which is the exact failure, one layer down.
    for (const { service, composeFile } of METRICS_SERVICES) {
      const contents = readFileSync(path.join(REPO_ROOT, composeFile), 'utf8');
      const declarations = contents
        .split('\n')
        .filter((line) => line.includes('OBSERVABILITY_SCRAPE_TOKEN:'));
      expect(declarations.length, `${composeFile} declares the token`).toBeGreaterThan(0);
      for (const line of declarations) {
        expect(line, `${service}/${composeFile} must require the token`).toContain(
          '${OBSERVABILITY_SCRAPE_TOKEN:?',
        );
      }
    }
  });

  it('never turns anonymous metrics on to work around a missing token', () => {
    for (const file of ['docker-compose.yml', 'docker-compose.runtime.yml']) {
      const contents = readFileSync(path.join(REPO_ROOT, file), 'utf8');
      expect(contents).not.toMatch(/OBSERVABILITY_ALLOW_ANONYMOUS_METRICS:\s*["']?true/i);
    }
  });
});
