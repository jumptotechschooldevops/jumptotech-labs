/**
 * The web tier compresses what it serves, and only what it holds.
 *
 * A cold load of the application is the shell bundle, the terminal-emulator
 * chunk the workspace pulls in, and the stylesheets: 622 KB as built, 167 KB
 * gzipped. Uncompressed, a class of a hundred opening the page at the start of
 * a lesson transfers about 62 MB instead of about 17 MB, and every student with
 * a cold cache pays it again. nginx shipped with compression off.
 *
 * Two properties are pinned here, and the second is the reason this is a test
 * rather than a one-line configuration change:
 *
 *   · text assets are compressed, in *both* listeners — development and the
 *     production TLS edge share `locations.conf`, so they cannot drift;
 *   · `gzip_proxied` stays at its default, so nothing proxied from the api is
 *     compressed. Compressing a response that mixes a secret with
 *     caller-influenced text is how compression side channels are built. A
 *     static bundle holds neither, an API response can hold both.
 *
 * The ratio itself is measured from the built bundle when one is present, so
 * the number in the comment above cannot quietly stop being true.
 */
import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (file: string): string => readFileSync(path.join(REPO_ROOT, file), 'utf8');
const code = (text: string): string =>
  text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

describe('nginx: compression at the edge', () => {
  const locations = code(read('infrastructure/docker/nginx/locations.conf'));

  it('compresses text assets', () => {
    expect(locations).toMatch(/^gzip on;$/m);
    expect(locations).toMatch(/^gzip_vary on;$/m);
    for (const type of ['text/css', 'text/javascript', 'application/javascript']) {
      expect(locations).toContain(type);
    }
  });

  it('is in the file both listeners include, so the two cannot drift', () => {
    for (const listener of ['web.conf', 'web-tls.conf']) {
      expect(code(read(`infrastructure/docker/nginx/${listener}`))).toContain(
        'include /etc/nginx/jumptotech/locations.conf;',
      );
    }
    // And nowhere else: a second copy is how they would drift.
    expect(code(read('infrastructure/docker/nginx/web.conf'))).not.toMatch(/^gzip on;$/m);
    expect(code(read('infrastructure/docker/nginx/web-tls.conf'))).not.toMatch(/^gzip on;$/m);
  });

  it('never compresses a response proxied from the api', () => {
    // nginx's default is `gzip_proxied off`, which is what keeps compression to
    // the files this server holds. Turning it on is a decision about a security
    // property, not about performance, so it must not happen by accident.
    expect(locations).not.toMatch(/gzip_proxied/);
  });
});

describe('the built bundle', () => {
  const dist = path.join(REPO_ROOT, 'apps/web/dist/assets');

  it.skipIf(!existsSync(dist))('is several times smaller compressed', () => {
    let raw = 0;
    let compressed = 0;
    for (const file of readdirSync(dist)) {
      // Source maps are not served to a student on a page load.
      if (!/\.(js|css)$/.test(file)) continue;
      const bytes = readFileSync(path.join(dist, file));
      raw += bytes.length;
      compressed += gzipSync(bytes, { level: 5 }).length;
    }

    expect(raw).toBeGreaterThan(0);
    // Measured at 3.7x on the build this was written against. The assertion is
    // deliberately loose: it is here to catch compression becoming pointless
    // (an already-compressed bundle), not to pin a ratio.
    expect(raw / compressed).toBeGreaterThan(2);
  });
});
