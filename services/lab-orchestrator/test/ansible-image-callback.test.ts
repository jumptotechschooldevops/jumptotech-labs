/**
 * The Ansible sandbox image carries the run-summary callback the orchestrator
 * enables for every idempotency check.
 *
 * `DockerAnsibleSandbox.runPlaybook` sets ANSIBLE_CALLBACK_PLUGINS to
 * ANSIBLE_CALLBACK_DIR, enables ANSIBLE_CALLBACK_NAME, and reads the JSON the
 * callback writes to JTT_STATS_FILE. When the Ansible track was ported to main
 * the callback file was left behind and nothing noticed: every
 * `ansible_idempotent` check reported that the run "did not complete", for
 * correct playbooks too. The image is built on each host, so a unit test
 * cannot run it — but it can hold the three pieces that must agree to each
 * other.
 */
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANSIBLE_CALLBACK_DIR, ANSIBLE_CALLBACK_NAME } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DOCKER = path.resolve(here, '../../../infrastructure/docker');

describe('the Ansible image ships the jtt_stats callback', () => {
  it('copies the callback into the directory the orchestrator points Ansible at, under the name it enables', async () => {
    const dockerfile = await readFile(path.join(DOCKER, 'sandbox-ansible.Dockerfile'), 'utf8');
    const copy = dockerfile
      .split('\n')
      .find((line) => /^COPY\s+\S*ansible-lab-callback\.py\s+/.test(line));
    expect(copy, 'sandbox-ansible.Dockerfile has no COPY of ansible-lab-callback.py').toBeDefined();
    expect(copy!.trim().split(/\s+/).at(-1)).toBe(`${ANSIBLE_CALLBACK_DIR}/${ANSIBLE_CALLBACK_NAME}.py`);
  });

  it('is a callback of that name that writes {"hosts": …} to the file the orchestrator reads', async () => {
    const callback = await readFile(path.join(DOCKER, 'ansible-lab-callback.py'), 'utf8');
    expect(callback).toMatch(new RegExp(`CALLBACK_NAME\\s*=\\s*["']${ANSIBLE_CALLBACK_NAME}["']`));
    expect(callback).toMatch(/CALLBACK_NEEDS_ENABLED\s*=\s*True/);
    expect(callback).toContain('os.environ.get("JTT_STATS_FILE")');
    expect(callback).toContain('{"hosts": summary}');
  });

  it('is enabled and read back by the sandbox under the same names', async () => {
    const sandbox = await readFile(path.resolve(here, '../src/ansible/sandbox.ts'), 'utf8');
    expect(sandbox).toContain('ANSIBLE_CALLBACK_PLUGINS: ANSIBLE_CALLBACK_DIR');
    expect(sandbox).toContain('ANSIBLE_CALLBACKS_ENABLED: ANSIBLE_CALLBACK_NAME');
    expect(sandbox).toContain('JTT_STATS_FILE: statsFile');
    expect(sandbox).toMatch(/parsed\.hosts/);
  });
});
