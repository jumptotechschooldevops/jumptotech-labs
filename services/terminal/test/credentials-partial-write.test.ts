/**
 * A Docker credential write that fails part-way leaves nothing behind.
 *
 * `writeSessionDockerCerts` writes three files into a fresh directory and only
 * then returns its path. If a later write failed (ENOSPC, EMFILE), it threw
 * before the caller learned the path, so the caller's cleanup — which removes
 * what it was told about — removed nothing, and a CA and client certificate
 * (possibly half a key) stayed on disk with nothing that would ever sweep them.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const failOn = vi.hoisted(() => ({ suffix: null as string | null }));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    writeFile: (async (file: Parameters<typeof actual.writeFile>[0], ...rest: unknown[]) => {
      if (failOn.suffix && String(file).endsWith(failOn.suffix)) {
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
      }
      return (actual.writeFile as (...args: unknown[]) => Promise<void>)(file, ...rest);
    }) as typeof actual.writeFile,
  };
});

const { writeSessionDockerCerts } = await import('../src/credentials.js');

const dirs: string[] = [];
afterEach(async () => {
  failOn.suffix = null;
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function credentialsDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'jtt-creds-'));
  dirs.push(dir);
  return dir;
}

describe('a credential write that fails part-way', () => {
  it('removes the Docker certificate directory it had started', async () => {
    const dir = await credentialsDir();
    failOn.suffix = 'key.pem';

    await expect(
      writeSessionDockerCerts(dir, 'sess-000000000000000a', {
        ca: 'synthetic-ca',
        clientCert: 'synthetic-cert',
        clientKey: 'synthetic-key',
      }),
    ).rejects.toThrow(/ENOSPC/);

    expect(await readdir(dir)).toEqual([]);
  });
});
