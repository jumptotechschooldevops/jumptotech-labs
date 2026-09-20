/**
 * Every binary a Dockerfile downloads is checked against a pinned SHA-256
 * before it is installed.
 *
 * kubectl, the docker CLI, the compose plugin and terraform were fetched with
 * `curl -fsSL` and installed as they arrived (release-engineering audit): TLS
 * proves who served the file, not that it is the file the version names. The
 * api, sandboxd and terminal images run these binaries with the privilege the
 * platform exists to contain — sandboxd's docker CLI holds the socket.
 *
 * Read from the files: a changed checksum is proven by the build itself
 * (`sha256sum -c` fails it), which is not something a unit test can run.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DOCKER_DIR = path.join(REPO_ROOT, 'infrastructure/docker');
const dockerfiles = readdirSync(DOCKER_DIR)
  .filter((file) => file.endsWith('.Dockerfile'))
  .map((file) => [file, readFileSync(path.join(DOCKER_DIR, file), 'utf8')] as const);

/**
 * A path read from a Dockerfile becomes part of a pattern below. Every regex
 * metacharacter in it is made literal — the backslash among them and first, or
 * an unescaped one turns the rest of the path into escape sequences and the
 * pattern accepts a `sha256sum -c` line that names some other file.
 */
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The `sha256sum -c -` line that verifies `target` itself, and no other path. */
const verifies = (target: string): RegExp =>
  new RegExp(`^\\s*echo "\\$\\{[a-z]+sum\\}  ${escapeRegExp(target)}" \\| sha256sum -c -; \\\\$`);

/** `ARG NAME=value` defaults, per file. */
const args = (text: string): Map<string, string> =>
  new Map([...text.matchAll(/^ARG ([A-Z0-9_]+)=(\S+)$/gm)].map(([, name, value]) => [name!, value!]));

describe('Dockerfile downloads', () => {
  it('download something (the check below is not vacuous)', () => {
    const downloads = dockerfiles.flatMap(([, text]) => [...text.matchAll(/curl -fsSLo (\S+)/g)]);
    expect(downloads.length).toBeGreaterThanOrEqual(8);
  });

  it('verify each file against a SHA-256 before the next command uses it', () => {
    const unverified: string[] = [];
    for (const [file, text] of dockerfiles) {
      for (const match of text.matchAll(/curl -fsSLo (\S+)[^\n]*\n[^\n]*\n([^\n]*)/g)) {
        // The line after the URL line: `echo "${sum}  <path>" | sha256sum -c -`.
        const [, target, next] = match;
        if (!verifies(target!).test(next!)) unverified.push(`${file}: ${target}`);
      }
    }
    expect(unverified).toEqual([]);
  });

  it('read the downloaded path literally, whatever characters it holds', () => {
    const line = (target: string) => `    echo "\${ksum}  ${target}" | sha256sum -c -; \\`;
    // Paths a regex would otherwise read as syntax. A backslash is the one that
    // has to be escaped first: escaping the others around it would leave `\.`,
    // and the escape a later pass adds becomes part of the input's own escape.
    const awkward = ['/tmp/a\\d.tgz', '/tmp/a+b.tgz', '/usr/local/bin/kubectl?', '/tmp/(a|b).zip', '/tmp/x[1].tgz'];
    for (const target of awkward) {
      expect(verifies(target).test(line(target)), `verifies its own line: ${target}`).toBe(true);
    }
    // ...and unescaped, each of those accepts a line naming some other file.
    const impostors: [string, string][] = [
      ['/tmp/a\\d.tgz', '/tmp/a1.tgz'],
      ['/tmp/docker.tgz', '/tmp/dockeritgz'],
      ['/tmp/a+b.tgz', '/tmp/ab.tgz'],
      ['/usr/local/bin/kubectl?', '/usr/local/bin/kubect'],
      ['/tmp/(a|b).zip', '/tmp/a.zip'],
      ['/tmp/x[1].tgz', '/tmp/x1.tgz'],
    ];
    for (const [target, other] of impostors) {
      expect(verifies(target).test(line(other)), `${target} must not accept ${other}`).toBe(false);
    }
  });

  it('pin a well-formed checksum for both architectures they build', () => {
    for (const [file, text] of dockerfiles) {
      const pinned = [...args(text)].filter(([name]) => /_SHA256_(AMD64|ARM64)$/.test(name));
      for (const [name, value] of pinned) expect(value, `${file} ${name}`).toMatch(/^[0-9a-f]{64}$/);
      const families = new Set(pinned.map(([name]) => name.replace(/_(AMD64|ARM64)$/, '')));
      for (const family of families) {
        expect(pinned.map(([name]) => name), file).toEqual(expect.arrayContaining([`${family}_AMD64`, `${family}_ARM64`]));
      }
      // Every per-arch variable the `case` assigns from is declared.
      for (const [, used] of text.matchAll(/="\$([A-Z0-9_]+_SHA256_(?:AMD64|ARM64))"/g)) {
        expect(args(text).has(used!), `${file}: ${used} is used but never declared`).toBe(true);
      }
    }
  });

  it('agree across images: one version of each tool, and one checksum per version', () => {
    const seen = new Map<string, { value: string; file: string }>();
    const conflicts: string[] = [];
    for (const [file, text] of dockerfiles) {
      for (const [name, value] of args(text)) {
        if (!/(_VERSION|_SHA256_AMD64|_SHA256_ARM64)$/.test(name)) continue;
        const prior = seen.get(name);
        if (prior && prior.value !== value) conflicts.push(`${name}: ${prior.file}=${prior.value} ${file}=${value}`);
        else seen.set(name, { value, file });
      }
    }
    expect(conflicts).toEqual([]);
  });

  it('match the kubectl the CI runners install', () => {
    const workflow = readFileSync(path.join(REPO_ROOT, '.github/workflows/quality-gates.yml'), 'utf8');
    const api = args(dockerfiles.find(([file]) => file === 'api.Dockerfile')![1]);
    expect(workflow).toContain(`KUBECTL_VERSION: ${api.get('KUBECTL_VERSION')}`);
    expect(workflow).toContain(`KUBECTL_SHA256: ${api.get('KUBECTL_SHA256_AMD64')}`);
  });
});
