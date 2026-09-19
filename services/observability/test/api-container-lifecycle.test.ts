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

  it('is why: web and terminal wait for the api to be healthy', () => {
    for (const service of ['web', 'terminal']) {
      expect(serviceBlock('docker-compose.yml', service)).toMatch(/api:\n\s+condition: service_healthy/);
    }
  });
});

describe('a stopped api shuts down, rather than being killed', () => {
  it('starts under node, so SIGTERM reaches the handler that stops the reaper and closes the pool', () => {
    const cmd = /^CMD (\[.*\])$/m.exec(code(read('infrastructure/docker/api.Dockerfile')));
    expect(cmd, 'api.Dockerfile has an exec-form CMD').not.toBeNull();
    const argv = JSON.parse(cmd![1]!) as string[];
    // Under `npx`, npm receives the signal and exits without passing it on.
    expect(argv[0]).toBe('node');
    expect(argv).not.toContain('npx');
    expect(read('apps/api/src/index.ts')).toMatch(/for \(const signal of \['SIGINT', 'SIGTERM'\] as const\)/);
  });
});
