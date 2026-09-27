/**
 * The monitoring containers hold no container runtime and no route to a
 * student's sandbox or the lab cluster.
 *
 * Prometheus, Alertmanager and Grafana scrape and display the platform; none of
 * them has any business on the `kind` network (the lab cluster's API server) or
 * the `sandboxes` network (student containers), and a Docker socket in any of
 * them would be the root-equivalent capability the runtime broker exists to
 * keep in exactly one place.
 *
 * The CI step "Observability containers hold no container runtime" claimed
 * this, and for its whole life checked nothing: its awk range
 * `/^  prometheus:/,/^  [a-z]/` ends on the very line that starts it, so it read
 * only the three `  name:` lines, and a Prometheus joined to both networks
 * passed (measured in the CI/CD supply-chain audit). `infrastructure/
 * secret-distribution.json` allowlists members only for the `database`
 * network, so nothing else held the rule. This holds it on every `npm test`,
 * and proves its own reader sees each service's body before trusting a pass.
 *
 * A small reader rather than a YAML dependency, like
 * compose-secret-distribution.test.ts: the claim is about the literal text an
 * operator runs, and comment lines — which discuss these networks — are
 * skipped.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const COMPOSE_FILES = [
  'docker-compose.yml',
  'docker-compose.runtime.yml',
  'docker-compose.observability.yml',
  'docker-compose.production.yml',
  'docker-compose.production-observability.yml',
];
const MONITORING = ['prometheus', 'alertmanager', 'grafana'];

/** Each top-level service's non-comment body lines, from one compose file. */
function serviceBodies(text: string): Map<string, string[]> {
  const bodies = new Map<string, string[]>();
  let inServices = false;
  let current: string[] | undefined;
  for (const line of text.split('\n')) {
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    if (/^\S/.test(line)) {
      inServices = /^services:\s*$/.test(line);
      current = undefined;
      continue;
    }
    const header = /^ {2}([a-z][a-z0-9_-]*):\s*$/.exec(line);
    if (inServices && header) {
      current = bodies.get(header[1]!) ?? [];
      bodies.set(header[1]!, current);
      continue;
    }
    current?.push(line);
  }
  return bodies;
}

/** What a monitoring service's lines give it that it must not have. */
function isolationViolations(file: string, text: string): string[] {
  const violations: string[] = [];
  for (const [service, lines] of serviceBodies(text)) {
    if (!MONITORING.includes(service)) continue;
    for (const line of lines) {
      if (/(^|[^a-z0-9_-])(kind|sandboxes)([^a-z0-9_-]|$)/.test(line)) {
        violations.push(`${file}: ${service} joins a lab network: ${line.trim()}`);
      }
      if (line.includes('docker.sock')) violations.push(`${file}: ${service} mounts a Docker socket: ${line.trim()}`);
    }
  }
  return violations;
}

describe('the monitoring containers', () => {
  const files = COMPOSE_FILES.map((file) => {
    const absolute = path.join(REPO_ROOT, file);
    return [file, existsSync(absolute) ? readFileSync(absolute, 'utf8') : undefined] as const;
  });

  it('are read from files that all exist', () => {
    expect(files.filter(([, text]) => text === undefined).map(([file]) => file)).toEqual([]);
  });

  it('are actually seen by the reader, body and all', () => {
    // The CI step this replaces passed because its reader saw nothing. Each
    // monitoring service must be found with its body; Prometheus, the one that
    // names its networks (Grafana and Alertmanager take the default), with that
    // block in view.
    const observability = serviceBodies(files.find(([file]) => file === 'docker-compose.observability.yml')![1]!);
    for (const service of MONITORING) {
      expect((observability.get(service) ?? []).length, `${service}'s body`).toBeGreaterThan(5);
    }
    expect(observability.get('prometheus')!.some((line) => /^ {4}networks:/.test(line))).toBe(true);
  });

  it('join neither the kind nor the sandboxes network, and mount no Docker socket', () => {
    expect(files.flatMap(([file, text]) => isolationViolations(file, text ?? ''))).toEqual([]);
  });

  it('would be caught joining one, in either list or map form', () => {
    const observability = files.find(([file]) => file === 'docker-compose.observability.yml')![1]!;
    const listForm = observability.replace(/(\n {2}prometheus:\n(?:.*\n)*? {4}networks:\n)/, '$1      - kind\n');
    expect(listForm).not.toBe(observability);
    expect(isolationViolations('mutated', listForm)).toEqual(['mutated: prometheus joins a lab network: - kind']);

    const mapForm = 'services:\n  grafana:\n    image: grafana/grafana\n    networks:\n      sandboxes: {}\nnetworks:\n  sandboxes: {}\n';
    expect(isolationViolations('mutated', mapForm)).toEqual(['mutated: grafana joins a lab network: sandboxes: {}']);

    const socket = 'services:\n  alertmanager:\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n';
    expect(isolationViolations('mutated', socket)).toEqual([
      'mutated: alertmanager mounts a Docker socket: - /var/run/docker.sock:/var/run/docker.sock',
    ]);
  });

  it('are not confused by a top-level network of the same name', () => {
    // The top-level `networks:` section defines `kind` and `sandboxes`; those
    // lines belong to no service.
    const text = 'services:\n  prometheus:\n    networks:\n      - default\nnetworks:\n  kind:\n    external: true\n  sandboxes: {}\n';
    expect(isolationViolations('file', text)).toEqual([]);
  });
});
