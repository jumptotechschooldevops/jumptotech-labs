/**
 * The api container's lifecycle, from the files as shipped.
 *
 * Two defects found by restarting a real stack (docs/development/beta-operations-2026-09-18.md):
 *
 *   · a slow start was declared unhealthy. The api transpiles its TypeScript at
 *     start and took 225 s on a loaded host; its healthcheck gave it about 65 s
 *     (135 s with the observability overlay), and web and terminal wait for it
 *     to be healthy, so `up --wait` failed and they were left uncreated;
 *   · a stop was a kill. Under `npx`, npm received SIGTERM and exited without
 *     passing it on, so the handler that stops the reaper, closes the listeners
 *     and releases the database pool never ran.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (file: string): string => readFileSync(path.join(REPO_ROOT, file), 'utf8');
const code = (text: string): string =>
  text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

/** A top-level compose service's block, comments removed. */
function serviceBlock(file: string, service: string): string {
  const text = code(read(file));
  const match = new RegExp(`^ {2}${service}:\\n((?: {4,}.*\\n|\\s*\\n)*)`, 'm').exec(text);
  return match?.[1] ?? '';
}

describe('a serving api is not an unhealthy one', () => {
  /*
   * 2026-09-28 observability drill, load 20–40: the image's check fetched
   * `/health`, which reads the database and every provider live (0.1–14 s),
   * with a 3 s timeout that also had to boot the `node -e` probe. The api served
   * every request and was marked unhealthy; web and terminal, which wait on it,
   * were never created. terminal and sandboxd flipped the same way on static
   * endpoints, from the probe's own start-up alone.
   */
  const MIN_TIMEOUT_SECONDS = 10;

  it('probes readiness from cached checks, like the overlays, not the live /health', () => {
    const check = /HEALTHCHECK[^\n]*\\\n\s*CMD ([^\n]+)/.exec(read('infrastructure/docker/api.Dockerfile'));
    expect(check, 'api.Dockerfile has a HEALTHCHECK command').not.toBeNull();
    expect(check![1]).toContain('/readyz');
    expect(check![1]).not.toContain('/health');
  });

  it.each(['api', 'terminal', 'sandboxd'])('gives the %s image probe time to boot on a loaded host', (service) => {
    const match = /HEALTHCHECK[^\n]*--timeout=(\d+)s/.exec(read(`infrastructure/docker/${service}.Dockerfile`));
    expect(match, `${service}.Dockerfile has a HEALTHCHECK timeout`).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(MIN_TIMEOUT_SECONDS);
  });

  it.each(['api', 'terminal'])('gives the %s overlay probe the same time', (service) => {
    const match = /timeout:\s*(\d+)s/.exec(serviceBlock('docker-compose.observability.yml', service));
    expect(match, `the observability overlay sets the ${service} healthcheck timeout`).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(MIN_TIMEOUT_SECONDS);
  });
});

describe('a slow api start is not an unhealthy one', () => {
  const MIN_START_PERIOD_SECONDS = 180;

  it('gives the image healthcheck a start period long enough for a loaded host', () => {
    const match = /HEALTHCHECK[^\n]*--start-period=(\d+)s/.exec(read('infrastructure/docker/api.Dockerfile'));
    expect(match, 'api.Dockerfile has a HEALTHCHECK with a start period').not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(MIN_START_PERIOD_SECONDS);
  });

  it('gives the /readyz healthcheck the production overlays use the same', () => {
    const api = serviceBlock('docker-compose.observability.yml', 'api');
    const match = /start_period:\s*(\d+)s/.exec(api);
    expect(match, 'the observability overlay sets the api start_period').not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(MIN_START_PERIOD_SECONDS);
  });

  it.each(['terminal', 'sandboxd'])('gives %s, which also compiles at start and is waited on, the same', (service) => {
    const match = /HEALTHCHECK[^\n]*--start-period=(\d+)s/.exec(read(`infrastructure/docker/${service}.Dockerfile`));
    expect(match, `${service}.Dockerfile has a HEALTHCHECK with a start period`).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(MIN_START_PERIOD_SECONDS);
  });

  it('keeps the terminal overlay healthcheck as patient', () => {
    const match = /start_period:\s*(\d+)s/.exec(serviceBlock('docker-compose.observability.yml', 'terminal'));
    expect(match, 'the observability overlay sets the terminal start_period').not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(MIN_START_PERIOD_SECONDS);
  });

  it('is why: web and terminal wait for the api to be healthy', () => {
    for (const service of ['web', 'terminal']) {
      expect(serviceBlock('docker-compose.yml', service)).toMatch(/api:\n\s+condition: service_healthy/);
    }
  });
});

describe('a stopped api shuts down, rather than being killed', () => {
  it.each([
    ['api', 'apps/api/src/index.ts'],
    ['terminal', 'services/terminal/src/index.ts'],
    ['sandboxd', 'services/sandboxd/src/index.ts'],
  ])('%s runs as one node process, so SIGTERM reaches its own shutdown handler', (service, entry) => {
    const dockerfile = code(read(`infrastructure/docker/${service}.Dockerfile`)).replace(/\\\n\s*/g, ' ');
    const cmd = /^CMD (\[.*\])\s*$/m.exec(dockerfile);
    expect(cmd, `${service}.Dockerfile has an exec-form CMD`).not.toBeNull();
    let argv = JSON.parse(cmd![1]!) as string[];
    // The terminal is launched through `setpriv` (SEC-ARCH-2), which execs node
    // in its own place: still one process, and the signal still reaches it.
    if (service === 'terminal') {
      expect(argv[0]).toBe('/usr/bin/setpriv');
      argv = argv.slice(argv.indexOf('--') + 1);
    }
    // Under `npx`, npm receives the signal and exits without passing it on;
    // under the tsx CLI, the child was ended before its handler ran.
    expect(argv.slice(0, 3)).toEqual(['node', '--import', 'tsx']);
    expect(argv.join(' ')).not.toMatch(/npx|\.bin\/tsx/);
    expect(argv[3]!.replace(/^\/app\//, '')).toBe(entry);
    expect(read(entry)).toMatch(/for \(const signal of \['SIGINT', 'SIGTERM'\] as const\)/);
  });
});
