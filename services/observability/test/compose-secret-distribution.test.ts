/**
 * BETA-P0-010 — each service receives exactly the secrets it uses.
 *
 * `infrastructure/secret-distribution.json` is the allowlist; this proves the
 * compose files as shipped agree with it, on every `npm test`, without Docker.
 * `make secrets-check` proves the same thing through `docker compose config`.
 *
 * Two failures this exists for, both of which passed every earlier test:
 *
 *   · `INTERNAL_SERVICE_SECRET: ${INTERNAL_SERVICE_SECRET:-${TERMINAL_SESSION_SECRET}}`
 *     — a secret *defaulted to another secret*. The stack started, every request
 *     succeeded, and three secrets were one;
 *   · a secret added to a service that never reads it. Nothing fails; the
 *     credential simply sits in one more process a bug could leak it from.
 *
 * Like `compose-scrape-token.test.ts`, a small reader rather than a YAML
 * dependency: the assertion is about literal text in the files an operator
 * runs. Comment lines are ignored — the files discuss secrets at length.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

interface Contract {
  secrets: string[];
  optionalEmpty: string[];
  stacks: Record<string, { files: string[]; exposure?: 'production'; services: Record<string, string[]> }>;
  credentialMounts: Record<string, string[] | string>;
  publishedPorts: {
    never: number[];
    loopbackOnly: number[];
    production: Array<{ service: string; published: number; target: number; purpose: string }>;
  };
  privateNetworks: Record<string, { members: string[]; internalIn: string[] } | string[]>;
}

const contract = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'infrastructure/secret-distribution.json'), 'utf8'),
) as Contract;

const COMPOSE_FILES = [
  'docker-compose.yml',
  'docker-compose.runtime.yml',
  'docker-compose.observability.yml',
  'docker-compose.production.yml',
];

function read(file: string): string {
  return readFileSync(path.join(REPO_ROOT, file), 'utf8');
}

/** Each top-level service's non-comment lines, from one compose file. */
function serviceBlocks(file: string): Map<string, string[]> {
  const lines = read(file).split('\n');
  const blocks = new Map<string, string[]>();
  let inServices = false;
  let current: string | null = null;

  for (const line of lines) {
    if (/^\S/.test(line)) {
      inServices = line.startsWith('services:');
      current = null;
      continue;
    }
    if (!inServices) continue;
    const service = /^ {2}([a-z][a-z0-9_-]*):\s*$/.exec(line);
    if (service?.[1]) {
      current = service[1];
      blocks.set(current, blocks.get(current) ?? []);
      continue;
    }
    if (current && !/^\s*#/.test(line)) blocks.get(current)!.push(line);
  }
  return blocks;
}

/** Every secret a block references, however it is spelled inside a value. */
function referencedSecrets(lines: readonly string[]): string[] {
  const found = new Set<string>();
  for (const line of lines) {
    for (const match of line.matchAll(/\$\{([A-Z0-9_]+)/g)) {
      if (contract.secrets.includes(match[1]!)) found.add(match[1]!);
    }
  }
  return [...found].sort();
}

describe('the secret distribution contract', () => {
  for (const [stackName, stack] of Object.entries(contract.stacks)) {
    describe(`the ${stackName} stack (${stack.files.join(' + ')})`, () => {
      const merged = new Map<string, Set<string>>();
      for (const file of stack.files) {
        for (const [service, lines] of serviceBlocks(file)) {
          const set = merged.get(service) ?? new Set<string>();
          for (const name of referencedSecrets(lines)) set.add(name);
          merged.set(service, set);
        }
      }

      it('names every service it defines, so a new one cannot arrive unreviewed', () => {
        expect([...merged.keys()].sort()).toEqual(Object.keys(stack.services).sort());
      });

      for (const [service, allowed] of Object.entries(stack.services)) {
        it(`${service} receives exactly ${allowed.length ? allowed.join(', ') : 'no secrets'}`, () => {
          expect([...(merged.get(service) ?? [])].sort()).toEqual([...allowed].sort());
        });
      }
    });
  }

  it('lists the same services in the contract as the matrix in .env.example documents', () => {
    const example = read('.env.example');
    const full = contract.stacks.observability!.services;
    for (const name of contract.secrets) {
      const holders = Object.entries(full)
        .filter(([, secrets]) => secrets.includes(name))
        .map(([service]) => service);
      // Two or more spaces: the matrix is aligned, prose mentioning a name is not.
      const documented = new RegExp(`^#\\s+${name}\\s{2,}(\\S.*)$`, 'm').exec(example)?.[1] ?? '';
      for (const holder of holders) {
        if (holder === 'prometheus') continue;
        expect(documented, `.env.example documents ${holder} as holding ${name}`).toContain(holder);
      }
    }
  });
});

describe('no secret is defaulted', () => {
  for (const file of COMPOSE_FILES) {
    it(`${file} requires every secret it references, and defaults none to another`, () => {
      const problems: string[] = [];
      for (const [service, lines] of serviceBlocks(file)) {
        for (const line of lines) {
          for (const match of line.matchAll(/\$\{([A-Z0-9_]+)([^}]*)\}?/g)) {
            const name = match[1]!;
            if (!contract.secrets.includes(name)) continue;
            const modifier = line.slice(match.index! + 2 + name.length);
            const required = modifier.startsWith(':?');
            const optionalEmpty = modifier.startsWith(':-}') && contract.optionalEmpty.includes(name);
            if (!required && !optionalEmpty) problems.push(`${service}: ${name}`);
          }
        }
      }
      expect(problems, 'secrets referenced without `:?` (or `:-}` for an optional one)').toEqual([]);
    });
  }

  it('never lets a secret fall back to another variable', () => {
    for (const file of COMPOSE_FILES) {
      const offending = read(file)
        .split('\n')
        .filter((line) => !/^\s*#/.test(line))
        .filter((line) => contract.secrets.some((name) => line.includes(`\${${name}:-\${`)));
      expect(offending, file).toEqual([]);
    }
  });

  it('uses no env_file, which would hand a service every variable in it', () => {
    for (const file of COMPOSE_FILES) {
      const lines = read(file).split('\n').filter((line) => !/^\s*#/.test(line));
      expect(lines.filter((line) => /^\s+env_file:/.test(line)), file).toEqual([]);
    }
  });
});

describe('credentials delivered as files', () => {
  for (const [source, owners] of Object.entries(contract.credentialMounts)) {
    if (source === '$comment') continue;
    it(`${source} is mounted only into ${(owners as string[]).join(', ')}`, () => {
      const holders = new Set<string>();
      for (const file of COMPOSE_FILES) {
        const text = read(file);
        // A YAML anchor carries the mount into whichever service aliases it.
        const anchor = new RegExp(`^x-[a-z-]+: &([a-z-]+)\\n(?:[ \\t].*\\n)*?[ \\t]+source: ${source.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\s*$`, 'm').exec(text)?.[1];
        for (const [service, lines] of serviceBlocks(file)) {
          if (lines.some((line) => line.includes(`source: ${source}`))) holders.add(service);
          if (anchor && lines.some((line) => line.includes(`*${anchor}`))) holders.add(service);
        }
      }
      expect([...holders].sort()).toEqual([...(owners as string[])].sort());
    });
  }
});

/** One short-syntax `ports:` entry: its host interface and ports, if readable. */
interface PortEntry {
  spec: string;
  hostIp: string | null;
  published: number;
  target: number;
}

/**
 * Each short-syntax `ports:` entry in a block, and how the block merges with the
 * files before it: `ports:` appends, `ports: !override` replaces, and
 * `ports: !reset []` clears. `${VAR:-9402}` is collapsed first, because its
 * `:-` would otherwise read as a separator; the default is kept as the host
 * port. An entry this cannot read is returned with a NaN target, and fails the
 * policy rather than passing it. `expose:` is not read: it publishes nothing.
 */
function portsDirective(lines: readonly string[]): { merge: 'append' | 'override' | 'reset' | null; entries: PortEntry[] } {
  const entries: PortEntry[] = [];
  let merge: 'append' | 'override' | 'reset' | null = null;
  let inPorts = false;
  for (const line of lines) {
    const header = /^ {4}ports:\s*(!reset\s*\[\]|!override)?\s*$/.exec(line);
    if (header) {
      merge = header[1]?.startsWith('!reset') ? 'reset' : header[1] ? 'override' : 'append';
      inPorts = merge !== 'reset';
      continue;
    }
    if (!inPorts) continue;
    if (!/^ {6}/.test(line)) {
      inPorts = false;
      continue;
    }
    const item = /^ {6}-\s*(.+?)\s*$/.exec(line);
    const spec = (item?.[1] ?? line.trim()).replace(/^["']|["']$/g, '');
    const parts = spec.replace(/\$\{[A-Z0-9_]+:-(\d+)\}/g, '$1').replace(/\$\{[^}]*\}/g, 'VAR').split(':');
    const last = parts[parts.length - 1]!;
    const target = /^\d+(\/(tcp|udp))?$/.test(last) ? Number.parseInt(last, 10) : Number.NaN;
    const published = parts.length >= 2 ? Number.parseInt(parts[parts.length - 2]!, 10) : target;
    entries.push({ spec, hostIp: parts.length === 3 ? parts[0]! : null, published, target });
  }
  return { merge, entries };
}

function publishedPorts(lines: readonly string[]): PortEntry[] {
  return portsDirective(lines).entries;
}

/** A service's ports after every file in a stack is merged in order. */
function stackPorts(files: readonly string[]): Map<string, PortEntry[]> {
  const merged = new Map<string, PortEntry[]>();
  for (const file of files) {
    for (const [service, lines] of serviceBlocks(file)) {
      const { merge, entries } = portsDirective(lines);
      if (merge === null) continue;
      const before = merge === 'append' ? (merged.get(service) ?? []) : [];
      merged.set(service, [...before, ...entries]);
    }
  }
  return merged;
}

/** The networks a service block lists, in list syntax. */
function serviceNetworks(lines: readonly string[]): string[] {
  const found: string[] = [];
  let inNetworks = false;
  for (const line of lines) {
    if (/^ {4}networks:\s*$/.test(line)) {
      inNetworks = true;
      continue;
    }
    if (!inNetworks) continue;
    const item = /^ {6}-\s*([a-z][a-z0-9_-]*)\s*$/.exec(line);
    if (item) found.push(item[1]!);
    else if (!/^ {6}/.test(line)) inNetworks = false;
  }
  return found;
}

/** Whether a file's top-level `networks:` marks a network `internal: true`. */
function declaresInternal(file: string, network: string): boolean {
  const code = read(file)
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  const top = /^networks:\n((?:[ \t].*\n?|\n)*)/m.exec(code)?.[1] ?? '';
  return new RegExp(`^ {2}${network}:\\n(?: {4}.*\\n)*? {4}internal:\\s*true\\s*$`, 'm').test(top);
}

describe('ports that carry a credential (BETA-P0-011)', () => {
  const policy = contract.publishedPorts;

  for (const file of COMPOSE_FILES) {
    it(`${file} publishes ${policy.never.join(', ')} nowhere`, () => {
      const problems: string[] = [];
      for (const [service, lines] of serviceBlocks(file)) {
        for (const port of publishedPorts(lines)) {
          if (Number.isNaN(port.target)) problems.push(`${service}: unreadable ports entry '${port.spec}'`);
          else if (policy.never.includes(port.target)) problems.push(`${service}: publishes ${port.target}`);
        }
      }
      expect(problems).toEqual([]);
    });
  }

  it('publishes nothing from sandboxd but its loopback metrics listener', () => {
    const published = COMPOSE_FILES.flatMap((file) =>
      publishedPorts(serviceBlocks(file).get('sandboxd') ?? []).map((port) => `${port.hostIp}:${port.target}`),
    );
    expect(published).toEqual(['127.0.0.1:9402']);
  });

  it('reads the entries it polices, so a passing check is not an empty one', () => {
    const web = publishedPorts(serviceBlocks('docker-compose.yml').get('web') ?? []);
    expect(web).toEqual([{ spec: '127.0.0.1:${WEB_PORT:-3000}:3000', hostIp: '127.0.0.1', published: 3000, target: 3000 }]);
  });
});

describe('network exposure (BETA-P0-012)', () => {
  const policy = contract.publishedPorts;

  for (const [stackName, stack] of Object.entries(contract.stacks)) {
    const production = stack.exposure === 'production';
    it(
      production
        ? `the ${stackName} stack publishes exactly ${policy.production.map((e) => `${e.published}→${e.service}:${e.target}`).join(', ')}`
        : `the ${stackName} stack publishes only listed ports, and only on 127.0.0.1`,
      () => {
        const problems: string[] = [];
        const actual: string[] = [];
        for (const [service, ports] of stackPorts(stack.files)) {
          for (const port of ports) {
            if (Number.isNaN(port.target)) {
              problems.push(`${service}: unreadable ports entry '${port.spec}'`);
            } else if (policy.never.includes(port.target)) {
              problems.push(`${service}: publishes ${port.target}`);
            } else if (production) {
              actual.push(`${service}:${port.published}:${port.target}`);
            } else if (!policy.loopbackOnly.includes(port.target)) {
              problems.push(`${service}: publishes ${port.target}, which is not in loopbackOnly`);
            } else if (port.hostIp !== '127.0.0.1') {
              problems.push(`${service}: publishes ${port.target} on ${port.hostIp ?? 'every interface'}`);
            }
          }
        }
        expect(problems).toEqual([]);
        if (production) {
          expect(actual.sort()).toEqual(policy.production.map((e) => `${e.service}:${e.published}:${e.target}`).sort());
        }
      },
    );
  }

  it('keeps the development PostgreSQL port, on loopback only', () => {
    const postgres = stackPorts(contract.stacks.runtime!.files).get('postgres') ?? [];
    expect(postgres.map((port) => `${port.hostIp}:${port.target}`)).toEqual(['127.0.0.1:5432']);
  });

  it('publishes nothing from postgres, api, terminal or sandboxd in production', () => {
    const production = stackPorts(contract.stacks.production!.files);
    for (const service of ['postgres', 'api', 'terminal', 'sandboxd']) {
      expect(production.get(service) ?? [], service).toEqual([]);
    }
    // The internal ports are named once more, so a policy edit that dropped one
    // from the contract still cannot let it through here.
    const publishedTargets = [...production.values()].flat().map((port) => port.target);
    for (const port of [3000, 4000, 4001, 4002, 5432, 9400, 9401, 9402]) {
      expect(publishedTargets, String(port)).not.toContain(port);
    }
    expect(publishedTargets.sort()).toEqual([8080, 8443]);
  });

  it('points 443 at the TLS listener and 80 at the redirect-only listener', () => {
    const tls = read('infrastructure/docker/nginx/web-tls.conf')
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    const [httpLevel = '', ...servers] = tls.split(/^server\s*\{/m);
    const redirect = servers.find((block) => /listen\s+8080\b/.test(block)) ?? '';
    // The server that holds the certificate; the 8443 default_server holds none (BETA-P0-017).
    const https = servers.find((block) => /listen\s+8443\s+ssl;/.test(block)) ?? '';

    // BETA-P0-017: the redirect goes to the configured host rather than the
    // request's Host header, and port 80 also answers ACME HTTP-01 tokens from
    // one read-only directory. Still no proxy_pass and no application route.
    expect(redirect).toMatch(/return\s+301\s+https:\/\/\$server_name\$request_uri;/);
    expect(redirect).not.toMatch(/proxy_pass|locations\.conf|\/usr\/share\/nginx\/html|ssl_certificate/);
    expect([...redirect.matchAll(/\broot\s+([^;]+);/g)].map((match) => match[1])).toEqual(['/var/www/acme']);
    expect(https).toMatch(/ssl_certificate\s+\/etc\/nginx\/tls\/fullchain\.pem;/);
    expect(https).toMatch(/ssl_certificate_key\s+\/etc\/nginx\/tls\/privkey\.pem;/);
    expect(httpLevel).toMatch(/ssl_protocols\s+TLSv1\.2 TLSv1\.3;/);
    expect(https).toMatch(/include\s+\/etc\/nginx\/jumptotech\/locations\.conf;/);
    expect(servers).toHaveLength(3);
    expect(read('docker-compose.production.yml')).toMatch(
      /source: \.\/infrastructure\/docker\/nginx\/web-tls\.conf\n\s+target: \/etc\/nginx\/conf\.d\/default\.conf/,
    );
  });

  it('does not mistake EXPOSE or expose: for publication', () => {
    const lines = ['    expose:', '      - "5432"', '    ports:', '      - "127.0.0.1:5432:5432"'];
    expect(publishedPorts(lines).map((port) => port.target)).toEqual([5432]);
    expect(publishedPorts(['    expose:', '      - "4002"'])).toEqual([]);
    expect(portsDirective(['    ports: !reset []']).merge).toBe('reset');
    // The images declare listeners (EXPOSE) that the production stack does not publish.
    expect(read('infrastructure/docker/web.Dockerfile')).toMatch(/^EXPOSE 3000 8080 8443$/m);
  });

  for (const [network, rule] of Object.entries(contract.privateNetworks)) {
    if (network === '$comment' || Array.isArray(rule)) continue;
    for (const [stackName, stack] of Object.entries(contract.stacks)) {
      it(`the ${stackName} stack puts only ${rule.members.join(' and ')} on the ${network} network`, () => {
        const members = new Map<string, string[]>();
        for (const file of stack.files) {
          for (const [service, lines] of serviceBlocks(file)) {
            const listed = serviceNetworks(lines);
            if (listed.length > 0) members.set(service, listed);
          }
        }
        const joined = [...members].filter(([, networks]) => networks.includes(network)).map(([service]) => service);
        expect(joined.sort()).toEqual([...rule.members].sort());
        expect(members.get('postgres')).toEqual([network]);
        expect(
          stack.files.some((file) => declaresInternal(file, network)),
          `${network} is internal: true`,
        ).toBe(rule.internalIn.includes(stackName));
      });
    }
  }
});

describe('no TLS verification bypass in shipped configuration or source (BETA-P0-012)', () => {
  const BYPASSES: Array<[string, RegExp]> = [
    ['rejectUnauthorized: false', /rejectUnauthorized\s*:\s*false/],
    ['NODE_TLS_REJECT_UNAUTHORIZED=0', /NODE_TLS_REJECT_UNAUTHORIZED\s*[:=]\s*["']?0/],
    ['a weak sslmode', /sslmode=(disable|allow|prefer|require|no-verify)\b/i],
    ['uselibpqcompat', /uselibpqcompat\s*=\s*true/i],
    ['PGSSLMODE assignment', /PGSSLMODE\s*[:=]\s*\S/],
    ['nginx proxy_ssl_verify off', /proxy_ssl_verify\s+off/],
  ];

  function shippedFiles(): string[] {
    const files = [...COMPOSE_FILES, '.env.example', 'Makefile'];
    const walk = (dir: string, accept: RegExp): void => {
      for (const name of readdirSync(path.join(REPO_ROOT, dir))) {
        const rel = path.join(dir, name);
        if (['node_modules', 'dist', 'test', 'generated'].includes(name)) continue;
        if (statSync(path.join(REPO_ROOT, rel)).isDirectory()) walk(rel, accept);
        else if (accept.test(name) && !/\.test\.ts$/.test(name)) files.push(rel);
      }
    };
    walk('infrastructure/docker', /(\.Dockerfile|\.conf)$/);
    walk('.github/workflows', /\.ya?ml$/);
    walk('scripts', /\.(mjs|sh|ts)$/);
    for (const root of ['apps', 'services']) {
      for (const pkg of readdirSync(path.join(REPO_ROOT, root))) {
        for (const sub of ['src', 'bin']) {
          const dir = path.join(root, pkg, sub);
          try {
            if (statSync(path.join(REPO_ROOT, dir)).isDirectory()) walk(dir, /\.(ts|tsx|mjs|js)$/);
          } catch {
            // no such directory in this package
          }
        }
      }
    }
    return files;
  }

  it('sets none of them anywhere', () => {
    const files = shippedFiles();
    expect(files).toContain('services/progress/src/postgres/database.ts');
    expect(files.length).toBeGreaterThan(50);
    const found = files.flatMap((file) => {
      const code = read(file)
        .split('\n')
        // Comments may explain a bypass; only code and configuration may not use one.
        .filter((line) => !/^\s*(#|\/\/|\*|\/\*)/.test(line))
        .join('\n');
      return BYPASSES.filter(([, pattern]) => pattern.test(code)).map(([name]) => `${file}: ${name}`);
    });
    expect(found).toEqual([]);
  });

  it('builds the database pool with verified TLS or none', () => {
    const database = read('services/progress/src/postgres/database.ts');
    expect(database).toMatch(/ssl: databaseTlsOptions\(config\)/);
    expect(read('services/progress/src/postgres/tls.ts')).toMatch(/rejectUnauthorized: true,/);
  });
});
