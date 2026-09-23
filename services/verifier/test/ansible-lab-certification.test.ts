/**
 * Ansible project checks added by the 2026-09-20 lab certification pass.
 *
 * Both shortcuts were measured with a real ansible-playbook run: the project
 * converges and renders the right file on both nodes, so every managed-node
 * check passed. What they leave wrong is in the project itself, which is
 * what these checks read. Each runs the lab's own requirement against the
 * lab's own starting workspace, with the student's change applied.
 */
import { describe, expect, it } from 'vitest';
import { loadSetupFiles, type AnsibleSandboxPort, type SandboxPathRead } from '@jumptotech/lab-orchestrator';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';
import { AnsibleVerifyReader } from '../src/ansible-reader.js';
import { verifyRequirement } from '../src/index.js';
import { SandboxReader } from '../src/sandbox-reader.js';

const SANDBOX = 'jtt-lab-00000000a006';

/** The control node's project directory, and nothing else. */
function project(files: Map<string, string>) {
  const sandbox = new SandboxReader({
    async read(p: string): Promise<SandboxPathRead | null> {
      const content = files.get(p);
      return content === undefined
        ? null
        : { type: 'file', mode: '644', owner: 'student', group: 'student', sizeBytes: content.length, content };
    },
  });
  const port = {
    workspaceDir: '/home/student/lab',
    async readWorkspaceFile(_sandbox: string, p: string) {
      return files.get(p) ?? null;
    },
  } as unknown as AnsibleSandboxPort;
  return { sandbox, ansible: new AnsibleVerifyReader(port, SANDBOX) };
}

async function starting(labId: string) {
  const lab = (await realCatalog()).get(labId);
  const files = new Map<string, string>();
  for (const file of await loadSetupFiles(lab)) files.set(file.path, file.content.toString());
  return { lab, files };
}

async function status(labId: string, label: string, change: (files: Map<string, string>) => void) {
  const { lab, files } = await starting(labId);
  change(files);
  const found = lab.requirements.filter((r) => r.label === label);
  expect(found, `${labId}: ${label}`).toHaveLength(1);
  return (await verifyRequirement(found[0]!, project(files) as never)).status;
}

// ------------------------------------------------------------- ANSIBLE-006

describe('ANSIBLE-006 — the new port lives in the group variables', () => {
  const LABEL = "The web group's variables set the new port";
  const set = (value: string) => (files: Map<string, string>) =>
    files.set('group_vars/web.yml', files.get('group_vars/web.yml')!.replace('app_port: 8080', `app_port: ${value}`));

  it('fails the starting file, whose comment already mentions 9090', async () => {
    expect(await status('ANSIBLE-006', LABEL, () => {})).toBe('fail');
  });

  it('passes app_port set to 9090, quoted or not', async () => {
    expect(await status('ANSIBLE-006', LABEL, set('9090'))).toBe('pass');
    expect(await status('ANSIBLE-006', LABEL, set('"9090"'))).toBe('pass');
  });
});

// ------------------------------------------------------------- ANSIBLE-008

describe('ANSIBLE-008 — the template moves into the role', () => {
  const LABEL = 'The configuration template lives in the role';

  it('passes the template moved into roles/web/templates', async () => {
    expect(
      await status('ANSIBLE-008', LABEL, (files) => {
        files.set('roles/web/templates/app.conf.j2', files.get('templates/app.conf.j2')!);
        files.delete('templates/app.conf.j2');
      }),
    ).toBe('pass');
  });

  it('fails an empty role templates directory beside the playbook-level template', async () => {
    // Before: the layout check saw the directory, Ansible's search path fell
    // back to the playbook's templates/app.conf.j2, and every check passed.
    expect(await status('ANSIBLE-008', LABEL, () => {})).toBe('fail');
  });
});
