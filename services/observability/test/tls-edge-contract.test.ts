/**
 * BETA-P0-017 — the production TLS edge, as shipped, from the text of the files.
 *
 * Hermetic: no Docker, no network. `tls-edge-integration.test.ts` runs the same
 * files in the real web image; this proves the files themselves cannot drift
 * from the contract between those runs:
 *
 *   · the production overlay pins the certificate gate, requires PUBLIC_ORIGIN,
 *     mounts the TLS directory and the ACME webroot read-only into web only,
 *     and health-checks the served certificate;
 *   · nginx serves one host over TLS 1.2/1.3 with forward-secret AEAD suites,
 *     refuses unknown names, keeps port 80 to a canonical redirect plus the ACME
 *     path, and loads only behind the gate's runtime file;
 *   · the development listener is unchanged: plain HTTP on 3000, no gate;
 *   · no certificate or key can enter an image, the bundle, a service's source,
 *     or git; the gate and the install script never print one.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (file: string): string => readFileSync(path.join(REPO_ROOT, file), 'utf8');
const code = (text: string, comment = /^\s*#/): string =>
  text
    .split('\n')
    .filter((line) => !comment.test(line))
    .join('\n');

/** A top-level compose service's block, comments removed. */
function serviceBlock(file: string, service: string): string {
  const text = code(read(file));
  const match = new RegExp(`^ {2}${service}:\\n((?: {4,}.*\\n|\\s*\\n)*)`, 'm').exec(text);
  return match?.[1] ?? '';
}

const DEVELOPMENT_COMPOSE = ['docker-compose.yml', 'docker-compose.runtime.yml', 'docker-compose.observability.yml'];

describe('the production overlay (docker-compose.production.yml)', () => {
  const web = serviceBlock('docker-compose.production.yml', 'web');
  const api = serviceBlock('docker-compose.production.yml', 'api');

  it('pins the certificate gate on and requires PUBLIC_ORIGIN for the edge and the api', () => {
    expect(web).toMatch(/^ {6}WEB_TLS: required$/m);
    expect(web).toMatch(/^ {6}PUBLIC_ORIGIN: \$\{PUBLIC_ORIGIN:\?[^}]+\}$/m);
    expect(api).toMatch(/^ {6}PUBLIC_ORIGIN: \$\{PUBLIC_ORIGIN:\?[^}]+\}$/m);
  });

  it('mounts the TLS configuration, the certificate directory and the ACME webroot read-only', () => {
    for (const [source, target] of [
      ['./infrastructure/docker/nginx/web-tls.conf', '/etc/nginx/conf.d/default.conf'],
      ['./infrastructure/docker/nginx/tls', '/etc/nginx/tls'],
      ['./infrastructure/docker/nginx/acme-webroot', '/var/www/acme'],
    ] as const) {
      const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
      expect(web, source).toMatch(
        new RegExp(`- type: bind\\n\\s+source: ${escaped(source)}\\n\\s+target: ${escaped(target)}\\n\\s+read_only: true`),
      );
    }
  });

  it('health-checks the certificate actually served', () => {
    expect(web).toMatch(/healthcheck:\n\s+test: \["CMD", "jtt-tls-preflight", "served"\]/);
  });

  it('leaves the development stacks without the gate, the TLS directory or a public origin requirement', () => {
    for (const file of DEVELOPMENT_COMPOSE) {
      const text = code(read(file));
      expect(text, file).not.toMatch(/WEB_TLS/);
      expect(text, file).not.toMatch(/nginx\/tls|acme-webroot|web-tls\.conf/);
      expect(text, file).not.toMatch(/PUBLIC_ORIGIN: \$\{PUBLIC_ORIGIN:\?/);
    }
  });

  it('keeps the credential mount for web alone, and the published ports at exactly 443 and 80', () => {
    const contract = JSON.parse(read('infrastructure/secret-distribution.json')) as {
      credentialMounts: Record<string, string[]>;
      publishedPorts: { production: Array<{ service: string; published: number; target: number }> };
    };
    expect(contract.credentialMounts['./infrastructure/docker/nginx/tls']).toEqual(['web']);
    expect(contract.publishedPorts.production.map((p) => `${p.service}:${p.published}:${p.target}`).sort()).toEqual([
      'web:443:8443',
      'web:80:8080',
    ]);
  });

  it('lets the resolved-config checker render the production stack', () => {
    expect(read('scripts/check-secret-distribution.mjs')).toMatch(/PUBLIC_ORIGIN: 'https:\/\/[a-z.-]+'/);
  });
});

describe('nginx: the TLS edge (web-tls.conf)', () => {
  const conf = code(read('infrastructure/docker/nginx/web-tls.conf'));
  const [httpLevel = '', ...servers] = conf.split(/^server\s*\{/m);
  const redirect = servers.find((block) => /listen\s+8080\s+default_server;/.test(block)) ?? '';
  const refuse = servers.find((block) => /listen\s+8443\s+ssl\s+default_server;/.test(block)) ?? '';
  const https = servers.find((block) => /listen\s+8443\s+ssl;/.test(block)) ?? '';
  const RUNTIME_INCLUDE = /include\s+\/etc\/nginx\/jumptotech\/runtime\/public-host\.conf;/;

  it('has exactly the three servers', () => {
    expect(servers).toHaveLength(3);
    expect([redirect, refuse, https].every(Boolean)).toBe(true);
  });

  it('allows TLS 1.2 and 1.3 only, with forward-secret AEAD suites, no tickets and no version banner', () => {
    expect(httpLevel).toMatch(/^ssl_protocols TLSv1\.2 TLSv1\.3;$/m);
    const ciphers = /^ssl_ciphers ([^;]+);$/m.exec(httpLevel)?.[1]?.split(':') ?? [];
    expect(ciphers.length).toBeGreaterThan(0);
    for (const cipher of ciphers) {
      expect(cipher).toMatch(/^ECDHE-(ECDSA|RSA)-(AES(128|256)-GCM-SHA(256|384)|CHACHA20-POLY1305)$/);
    }
    expect(httpLevel).toMatch(/^ssl_session_tickets off;$/m);
    expect(httpLevel).toMatch(/^server_tokens off;$/m);
    expect(conf).not.toMatch(/SSLv3|TLSv1(\.0|\.1)?\b(?!\.)/);
  });

  it('keeps port 80 to a redirect to the configured host, plus the ACME challenge directory', () => {
    expect(redirect).toMatch(RUNTIME_INCLUDE);
    expect(redirect).not.toMatch(/proxy_pass|locations\.conf|ssl_certificate/);
    expect(redirect).toMatch(/location \/ \{\s*return 301 https:\/\/\$server_name\$request_uri;\s*\}/);
    // `$host` is the request's own header: a redirect built from it could be aimed anywhere.
    expect(redirect).not.toMatch(/\$host|\$http_host/);
    const locations = [...redirect.matchAll(/location\s+([^{]+)\{/g)].map((m) => m[1]!.trim());
    expect(locations.sort()).toEqual(['/', '^~ /.well-known/acme-challenge/']);
    const acme = /location \^~ \/\.well-known\/acme-challenge\/ \{([^}]*)\}/.exec(redirect)?.[1] ?? '';
    expect(acme).toMatch(/root \/var\/www\/acme;/);
    expect(acme).toMatch(/try_files \$uri =404;/);
    expect([...redirect.matchAll(/\broot\s+([^;]+);/g)].map((m) => m[1])).toEqual(['/var/www/acme']);
  });

  it('refuses a TLS client that does not name the host, and a Host header that differs from it', () => {
    expect(refuse).toMatch(/ssl_reject_handshake on;/);
    expect(refuse).toMatch(/return 421;/);
    expect(refuse).not.toMatch(/ssl_certificate|include|root|proxy_pass/);
  });

  it('serves the application for the one host, from the mounted certificate, with HSTS, behind the gate', () => {
    expect(https).toMatch(RUNTIME_INCLUDE);
    expect(https).toMatch(/http2 on;/);
    expect(https).toMatch(/ssl_certificate\s+\/etc\/nginx\/tls\/fullchain\.pem;/);
    expect(https).toMatch(/ssl_certificate_key\s+\/etc\/nginx\/tls\/privkey\.pem;/);
    expect(https).toMatch(/add_header Strict-Transport-Security "max-age=31536000" always;/);
    expect(https).toMatch(/include\s+\/etc\/nginx\/jumptotech\/locations\.conf;/);
    expect(conf).not.toMatch(/server_name\s+_;/);
  });

  it('keeps the WebSocket upgrade for the terminal in the shared routes', () => {
    const locations = code(read('infrastructure/docker/nginx/locations.conf'));
    const terminal = /location \/terminal \{([^}]*)\}/.exec(locations)?.[1] ?? '';
    expect(terminal).toMatch(/proxy_pass http:\/\/terminal:4001;/);
    expect(terminal).toMatch(/proxy_http_version 1\.1;/);
    expect(terminal).toMatch(/proxy_set_header Upgrade \$http_upgrade;/);
    expect(terminal).toMatch(/proxy_set_header Connection "upgrade";/);
    expect(terminal).toMatch(/proxy_set_header X-Forwarded-Proto \$scheme;/);
  });
});

describe('nginx: the development listener (web.conf) is unchanged', () => {
  it('is plain HTTP on 3000, with no certificate and no dependency on the gate', () => {
    const conf = code(read('infrastructure/docker/nginx/web.conf'));
    expect(conf).toMatch(/listen 3000;/);
    expect(conf).not.toMatch(/ssl|runtime\/public-host\.conf|8443|8080/);
    expect(conf).toMatch(/include \/etc\/nginx\/jumptotech\/locations\.conf;/);
  });
});

describe('the web image (web.Dockerfile)', () => {
  const dockerfile = code(read('infrastructure/docker/web.Dockerfile'));

  it('builds an edge stage with openssl and the gate, and ships the bundle on top of it', () => {
    expect(dockerfile).toMatch(/^FROM nginx:1\.27-alpine AS edge$/m);
    expect(dockerfile).toMatch(/apk add --no-cache openssl/);
    expect(dockerfile).toMatch(
      /^COPY --chmod=0755 infrastructure\/docker\/nginx\/tls-preflight\.sh \/usr\/local\/bin\/jtt-tls-preflight$/m,
    );
    expect(dockerfile).toMatch(
      /^COPY --chmod=0755 infrastructure\/docker\/nginx\/05-jumptotech-tls-preflight\.sh \/docker-entrypoint\.d\/05-jumptotech-tls-preflight\.sh$/m,
    );
    const stages = [...dockerfile.matchAll(/^FROM\s+(.+)$/gm)].map((m) => m[1]);
    expect(stages).toEqual(['node:22-bookworm-slim AS build', 'nginx:1.27-alpine AS edge', 'edge']);
    expect(dockerfile.slice(dockerfile.lastIndexOf('FROM edge'))).toMatch(/COPY --from=build \/app\/apps\/web\/dist \/usr\/share\/nginx\/html/);
  });

  it('runs the gate before every stock entrypoint hook', () => {
    // The nginx image runs /docker-entrypoint.d/ in `sort -V` order; its own hooks start at 10-.
    expect('05-jumptotech-tls-preflight.sh' < '10-listen-on-ipv6-by-default.sh').toBe(true);
    expect(read('infrastructure/docker/nginx/05-jumptotech-tls-preflight.sh')).toMatch(
      /^exec \/usr\/local\/bin\/jtt-tls-preflight startup$/m,
    );
    for (const script of ['tls-preflight.sh', '05-jumptotech-tls-preflight.sh']) {
      expect(statSync(path.join(REPO_ROOT, 'infrastructure/docker/nginx', script)).mode & 0o111, script).not.toBe(0);
    }
  });
});

describe('the certificate gate (tls-preflight.sh)', () => {
  const script = read('infrastructure/docker/nginx/tls-preflight.sh');
  const body = code(script);

  it('writes the runtime include only after validation, and removes a stale one first', () => {
    const startup = /^startup\(\) \{([\s\S]*?)^\}/m.exec(body)?.[1] ?? '';
    const removed = startup.indexOf('rm -f "$PUBLIC_HOST_CONF"');
    const validated = startup.indexOf('validate "$LIVE_CERT" "$LIVE_KEY" "$host"');
    const written = startup.indexOf('printf \'server_name %s;\\n\' "$host" > "$PUBLIC_HOST_CONF.tmp"');
    expect(removed).toBeGreaterThan(-1);
    expect(validated).toBeGreaterThan(removed);
    expect(written).toBeGreaterThan(validated);
    expect(startup).toMatch(/required\) ;;/);
    expect(body).toMatch(/^set -eu$/m);
  });

  it('asks the private key for its public half only, and never prints or copies it', () => {
    const keyLines = body
      .split('\n')
      .filter((line) => line.includes('"$key"') && /\b(openssl|cat|cp|tee|base64|od|xxd|printf|echo)\b/.test(line));
    // Exactly two uses of the key: "can it be parsed" and "what is its public half".
    expect(keyLines.filter((line) => /openssl pkey/.test(line))).toHaveLength(2);
    for (const line of keyLines) {
      if (/openssl pkey/.test(line)) {
        expect(line).toMatch(/openssl pkey -in "\$key" -passin pass: (-noout|-pubout)/);
        expect(line).not.toMatch(/-text\b|-out\s/);
      } else {
        // Only messages naming the path, and grep for a certificate marker.
        expect(line).toMatch(/refuse "|grep -q 'BEGIN CERTIFICATE' "\$key"/);
      }
    }
    expect(body).not.toMatch(/\b(cat|tee|base64|xxd|od)\b[^\n]*\$(key|LIVE_KEY)/);
  });

  it('checks each property the runbook promises', () => {
    for (const property of [
      /-checkend 0/, // expiry
      /date -u -D/, // not yet valid
      /-checkhost "\$host"/, // host name
      /openssl verify -partial_chain -purpose sslserver -verify_hostname "\$host"/, // chain
      /CA:TRUE/, // leaf is not a CA
      /-ge 2048/, // RSA strength
      /-ge 256/, // EC strength
      /\$\(\(0\$mode & 077\)\)/, // key file mode
      /PRIVATE KEY/, // key in the certificate file
    ]) {
      expect(body).toMatch(property);
    }
  });
});

describe('the install script (scripts/tls-install.sh)', () => {
  const script = code(read('scripts/tls-install.sh'));

  it('validates before it swaps, keeps the previous pair, proves the served certificate, and rolls back', () => {
    const order = [
      'chmod 600 "$staged_key"',
      'jtt-tls-preflight check',
      'cp -p "$tls_dir/privkey.pem" "$tls_dir/privkey.pem.previous"',
      'mv -f "$staged_key" "$tls_dir/privkey.pem"',
      'web_exec nginx -t -q',
      'web_exec nginx -s reload',
      'web_exec jtt-tls-preflight served',
      'cp -p "$tls_dir/privkey.pem.previous" "$tls_dir/privkey.pem"',
    ].map((needle) => script.indexOf(needle));
    expect(order.every((index) => index > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(script).toMatch(/^umask 077$/m);
  });

  it('never prints the key, and never consumes its caller\'s stdin', () => {
    expect(script).not.toMatch(/\b(cat|tee|base64|xxd|od|echo|printf)\b[^\n]*\$(key|staged_key)\b/);
    expect(script).not.toMatch(/docker exec -i/);
    const containerCalls = script.split('\n').filter((l) => /web_(exec|oneoff|running)\(\) \{/.test(l) && /\bdocker\b|compose\[@\]/.test(l));
    expect(containerCalls).toHaveLength(5);
    for (const line of containerCalls) expect(line).toMatch(/<\/dev\/null/);
    expect(statSync(path.join(REPO_ROOT, 'scripts/tls-install.sh')).mode & 0o111).not.toBe(0);
  });
});

describe('certificate and key material stays out of git, images, the bundle and services', () => {
  it('ignores everything in the certificate directory and the ACME webroot but their README', () => {
    for (const dir of ['infrastructure/docker/nginx/tls', 'infrastructure/docker/nginx/acme-webroot']) {
      const rules = code(read(`${dir}/.gitignore`)).split('\n').filter(Boolean);
      expect(rules, dir).toEqual(['*', '!.gitignore', '!README.md']);
      const present = readdirSync(path.join(REPO_ROOT, dir)).filter((name) => !['.gitignore', 'README.md'].includes(name));
      for (const name of present) expect(name, `${dir}/${name} is ignored`).not.toMatch(/^(\.gitignore|README\.md)$/);
    }
  });

  it('excludes the certificate directory from every Docker build context', () => {
    const rules = code(read('.dockerignore')).split('\n').map((line) => line.trim());
    expect(rules).toContain('infrastructure/docker/nginx/tls/');
  });

  it('copies no path that contains the certificate directory into any image', () => {
    const forbidden = ['.', './', 'infrastructure', 'infrastructure/', 'infrastructure/docker', 'infrastructure/docker/', 'infrastructure/docker/nginx', 'infrastructure/docker/nginx/'];
    const problems: string[] = [];
    const dockerDir = path.join(REPO_ROOT, 'infrastructure/docker');
    for (const name of readdirSync(dockerDir).filter((n) => n.endsWith('.Dockerfile'))) {
      for (const line of code(readFileSync(path.join(dockerDir, name), 'utf8')).split('\n')) {
        const copy = /^(?:COPY|ADD)\s+(.+)$/.exec(line.trim());
        if (!copy || /--from=/.test(copy[1]!)) continue;
        const parts = copy[1]!.split(/\s+/).filter((part) => !part.startsWith('--'));
        for (const source of parts.slice(0, -1)) {
          const tlsDir = 'infrastructure/docker/nginx/tls';
          if (forbidden.includes(source) || source === tlsDir || source.startsWith(`${tlsDir}/`)) problems.push(`${name}: ${line.trim()}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('names no certificate or key path in the browser bundle or any service that answers a request', () => {
    const roots = ['apps/web/src', 'apps/api/src', 'services/terminal/src', 'services/sandboxd/src', 'services/lab-orchestrator/src', 'services/progress/src', 'services/verifier/src', 'services/observability/src'];
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(path.join(REPO_ROOT, dir))) {
        const rel = path.join(dir, name);
        if (statSync(path.join(REPO_ROOT, rel)).isDirectory()) walk(rel);
        // The operator's check reads the files by design; it is a command, not a served surface.
        else if (/\.(ts|tsx|js|mjs|html)$/.test(name) && rel !== path.join('services/observability/src/tls-certificate-health.ts')) {
          if (/nginx\/tls|privkey\.pem|fullchain\.pem|WEB_TLS/.test(read(rel))) found.push(rel);
        }
      }
    };
    for (const root of roots) {
      try {
        walk(root);
      } catch {
        // a package without that directory
      }
    }
    expect(found).toEqual([]);
  });

  it('puts no PEM block in compose, .env.example or the Makefile', () => {
    for (const file of [...DEVELOPMENT_COMPOSE, 'docker-compose.production.yml', '.env.example', 'Makefile']) {
      expect(read(file), file).not.toMatch(/-----BEGIN [A-Z ]*(PRIVATE KEY|CERTIFICATE)-----/);
    }
  });
});

describe('the lifecycle is wired where operators and CI will find it', () => {
  it('has make targets and npm scripts', () => {
    const makefile = read('Makefile');
    for (const target of ['tls-install', 'tls-check', 'test-tls-edge']) expect(makefile).toMatch(new RegExp(`^${target}:.*## `, 'm'));
    const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;
    expect(scripts['tls:check']).toBe('tsx scripts/tls-check.ts');
    expect(scripts['test:integration:tls-edge']).toMatch(/RUN_INTEGRATION_TESTS=1 vitest run test\/tls-edge-integration\.test\.ts --root services\/observability/);
  });

  it('runs the real-image suite in CI', () => {
    const workflow = read('.github/workflows/quality-gates.yml');
    const job = /^ {2}tls-edge-integration:\n([\s\S]*?)(?=^ {2}[a-z][a-z0-9-]*:\n|(?![\s\S]))/m.exec(workflow)?.[1] ?? '';
    expect(job).toMatch(/needs: gates/);
    expect(job).toMatch(/RUN_INTEGRATION_TESTS: '1'/);
    expect(job).toMatch(/test\/tls-edge-integration\.test\.ts[\s\\]+--root services\/observability/);
  });

  it('documents the procedure and links it', () => {
    const runbook = read('docs/runbooks/production-tls.md');
    for (const heading of ['DNS', 'Initial provisioning', 'Renewal', 'Expiry monitoring', 'Renewal failure', 'Key compromise', 'Staging', 'DECISION REQUIRED']) {
      expect(runbook, heading).toMatch(new RegExp(`^#{2,3} .*${heading}`, 'm'));
    }
    expect(read('docs/runbooks/README.md')).toContain('(production-tls.md)');
    expect(read('docs/runtime-architecture.md')).toMatch(/^## 12\. .*BETA-P0-017/m);
  });
});
