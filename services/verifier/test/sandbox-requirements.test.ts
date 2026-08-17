/**
 * PLATFORM-004 — filesystem and Terraform verification.
 *
 * These are the checks behind LINUX-001 and TF-001, and the two properties they
 * exist to guarantee:
 *
 *   1. **State, not transcript.** Nothing here reads what the student typed.
 *      `terraform apply` having been run proves nothing; the state file and the
 *      artifacts on disk are what is graded.
 *   2. **The whole lab fails before the work and passes after it**, with the
 *      failure detail describing the observed state and never the solution.
 *
 * The reader is a small in-memory sandbox. The real thing — a `docker exec`
 * into a real container running `stat` as the unprivileged user — is exercised
 * in `services/lab-orchestrator/test/sandbox-integration.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLabDefinition, type SandboxPathRead } from '@jumptotech/lab-orchestrator';
import { verifyLab, type SandboxPort } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LABS_DIR = path.resolve(here, '../../../labs');
const LINUX_002 = path.join(LABS_DIR, 'linux', 'linux-002-permissions', 'lab.yaml');
const TF_001 = path.join(LABS_DIR, 'terraform', 'tf-001-init-plan-apply', 'lab.yaml');

/** An in-memory sandbox filesystem, keyed by path relative to the home. */
class FakeSandbox implements SandboxPort {
  readonly reads: string[] = [];
  constructor(private readonly entries: Record<string, Partial<SandboxPathRead>> = {}) {}

  put(pathName: string, entry: Partial<SandboxPathRead>): this {
    this.entries[pathName] = entry;
    return this;
  }

  remove(pathName: string): this {
    delete this.entries[pathName];
    return this;
  }

  async read(relativePath: string): Promise<SandboxPathRead | null> {
    this.reads.push(relativePath);
    const entry = this.entries[relativePath];
    if (!entry) return null;
    const content = entry.content ?? '';
    return {
      type: entry.type ?? 'file',
      mode: entry.mode ?? '644',
      owner: entry.owner ?? 'student',
      group: entry.group ?? 'student',
      sizeBytes: entry.sizeBytes ?? content.length,
      ...(entry.type === 'directory' ? {} : { content }),
      ...(entry.truncated ? { truncated: true } : {}),
    };
  }
}

function failures(checks: Array<{ status: string; label: string; detail?: string }>) {
  return checks.filter((c) => c.status !== 'pass');
}

// --- the filesystem family --------------------------------------------------

/**
 * The state a student reaches by doing LINUX-002 correctly.
 *
 * LINUX-002 is the permissions lab, so it exercises every handler in this
 * family: a directory, a regular file, modes, and an owner. The per-lab
 * fail-then-pass coverage for all ten Linux labs lives in
 * `linux-verifier.test.ts`; what this file pins is how each *handler* behaves
 * at the edges — symlinks, mode normalisation, and read memoisation.
 */
function solvedLinuxSandbox(): FakeSandbox {
  return new FakeSandbox({
    '/srv/jumptotech/reports/daily-balance.csv': { type: 'file', mode: '640', owner: 'reports' },
    '/srv/jumptotech/reports/collect-balances.sh': { type: 'file', mode: '750', owner: 'reports' },
    '/home/student/secure': { type: 'directory', mode: '700', owner: 'student', group: 'student' },
    '/home/student/secure/api-token.txt': {
      type: 'file',
      mode: '600',
      owner: 'student',
      group: 'student',
      content: 'token=abc123\n',
    },
  });
}

describe('LINUX-002 — the filesystem family end to end', () => {
  it('fails on an untouched sandbox, and says what is missing', async () => {
    const lab = await loadLabDefinition(LINUX_002);
    const result = await verifyLab({ lab, sandbox: new FakeSandbox(), namespace: 'jtt-lab-000000000001' });

    expect(result.passed).toBe(false);
    expect(result.summary).toBe('LAB NOT COMPLETE');
    expect(failures(result.checks)).toHaveLength(lab.requirements.length);
    // The failure detail describes the observed state, never the fix.
    expect(JSON.stringify(result.checks)).not.toMatch(/chmod|chgrp|chown|mkdir/);
  });

  it('passes once the filesystem is in the state the lab describes', async () => {
    const lab = await loadLabDefinition(LINUX_002);
    const result = await verifyLab({
      lab,
      sandbox: solvedLinuxSandbox(),
      namespace: 'jtt-lab-000000000001',
    });

    expect(failures(result.checks)).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.summary).toBe('LAB PASSED');
  });

  it('fails one check at a time, independently', async () => {
    const lab = await loadLabDefinition(LINUX_002);

    const wrongMode = solvedLinuxSandbox().put('/home/student/secure/api-token.txt', {
      type: 'file',
      mode: '644',
      owner: 'student',
      group: 'student',
      content: 'token=abc123\n',
    });
    const result = await verifyLab({ lab, sandbox: wrongMode, namespace: 'jtt-lab-000000000001' });

    const failed = failures(result.checks);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.detail).toBe(
      "'/home/student/secure/api-token.txt' has permissions 644, expected 600",
    );
  });

  it('rejects a symlink standing in for the file the lab grades', async () => {
    const lab = await loadLabDefinition(LINUX_002);
    const sandbox = solvedLinuxSandbox().put('/home/student/secure/api-token.txt', {
      type: 'symlink',
      mode: '777',
      owner: 'student',
      group: 'student',
      content: 'token=abc123\n',
    });

    const result = await verifyLab({ lab, sandbox, namespace: 'jtt-lab-000000000001' });
    const failed = failures(result.checks);

    // `stat` runs without `-L`, so a link reports as a link. Otherwise a
    // student could satisfy a permissions check by pointing at another file.
    expect(failed.some((c) => c.detail?.includes('is a symbolic link, not a regular file'))).toBe(true);
    expect(result.passed).toBe(false);
  });

  it('is not fooled by the wrong owner', async () => {
    const lab = await loadLabDefinition(LINUX_002);

    const wrongOwner = solvedLinuxSandbox().put('/home/student/secure/api-token.txt', {
      type: 'file',
      mode: '600',
      owner: 'root',
      group: 'root',
      content: 'token=abc123\n',
    });
    const result = await verifyLab({ lab, sandbox: wrongOwner, namespace: 'ns' });

    expect(failures(result.checks)[0]?.detail).toBe(
      "'/home/student/secure/api-token.txt' is owned by 'root', expected 'student'",
    );
  });

  it('compares mode as permission bits, not as a string', async () => {
    const lab = await loadLabDefinition(LINUX_002);

    // `0600` and `600` are the same permission; both must pass.
    const paddedMode = solvedLinuxSandbox().put('/home/student/secure/api-token.txt', {
      type: 'file',
      mode: '0600',
      owner: 'student',
      group: 'student',
      content: 'token=abc123\n',
    });

    expect((await verifyLab({ lab, sandbox: paddedMode, namespace: 'ns' })).passed).toBe(true);
  });

  it('reads each path once, however many checks ask about it', async () => {
    const lab = await loadLabDefinition(LINUX_002);
    const sandbox = solvedLinuxSandbox();
    await verifyLab({ lab, sandbox, namespace: 'ns' });

    // The token file is named by three requirements — exists, mode, owner.
    const token = '/home/student/secure/api-token.txt';
    expect(sandbox.reads.filter((p) => p === token)).toHaveLength(1);
    // …and the collector script by two.
    const script = '/srv/jumptotech/reports/collect-balances.sh';
    expect(sandbox.reads.filter((p) => p === script)).toHaveLength(1);
  });
});

// --- TF-001 -----------------------------------------------------------------

const SOLVED_STATE = JSON.stringify({
  version: 4,
  terraform_version: '1.9.8',
  outputs: {
    manifest_path: { value: 'build/manifest.txt', type: 'string' },
  },
  resources: [
    {
      mode: 'managed',
      type: 'local_file',
      name: 'manifest',
      provider: 'provider["registry.terraform.io/hashicorp/local"]',
      instances: [{ schema_version: 0, attributes: { filename: 'build/manifest.txt' } }],
    },
  ],
});

/** The state a student reaches after a correct init + apply. */
function solvedTerraformSandbox(): FakeSandbox {
  return new FakeSandbox({
    terraform: { type: 'directory', mode: '755' },
    'terraform/.terraform': { type: 'directory', mode: '755' },
    'terraform/.terraform.lock.hcl': { type: 'file', content: 'provider "registry.terraform.io/hashicorp/local" {}' },
    'terraform/versions.tf': { type: 'file', content: 'terraform { required_providers {} }' },
    'terraform/main.tf': { type: 'file', content: 'resource "local_file" "manifest" {}' },
    'terraform/terraform.tfstate': { type: 'file', content: SOLVED_STATE },
    'terraform/build/manifest.txt': { type: 'file', content: 'service=ledger-api\n' },
  });
}

describe('TF-001 (test requirements 19–20)', () => {
  it('fails on the starter configuration alone', async () => {
    const lab = await loadLabDefinition(TF_001);
    const starter = new FakeSandbox({
      terraform: { type: 'directory', mode: '755' },
      'terraform/versions.tf': { type: 'file', content: 'terraform { required_providers {} }' },
    });

    const result = await verifyLab({ lab, sandbox: starter, namespace: 'jtt-lab-000000000001' });

    expect(result.passed).toBe(false);
    expect(failures(result.checks)).toHaveLength(lab.requirements.length);
    expect(result.checks[0]?.detail).toContain('has no .terraform directory');
    expect(result.checks[1]?.detail).toContain('nothing has been applied there yet');
  });

  it('passes on the state a real apply produces', async () => {
    const lab = await loadLabDefinition(TF_001);
    const result = await verifyLab({
      lab,
      sandbox: solvedTerraformSandbox(),
      namespace: 'jtt-lab-000000000001',
    });

    expect(failures(result.checks)).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('does not pass when init ran but nothing was applied', async () => {
    const lab = await loadLabDefinition(TF_001);
    const sandbox = solvedTerraformSandbox()
      .remove('terraform/terraform.tfstate')
      .remove('terraform/build/manifest.txt');

    const result = await verifyLab({ lab, sandbox, namespace: 'ns' });

    const failed = failures(result.checks);
    expect(failed).toHaveLength(4);
    // Init itself still passes: the point is that applying is a separate fact.
    expect(result.checks[0]?.status).toBe('pass');
  });

  it('does not pass when the resource is declared but has no instance in state', async () => {
    const lab = await loadLabDefinition(TF_001);
    const declaredOnly = JSON.stringify({
      version: 4,
      outputs: { manifest_path: { value: 'build/manifest.txt' } },
      resources: [{ mode: 'managed', type: 'local_file', name: 'manifest', instances: [] }],
    });
    const sandbox = solvedTerraformSandbox().put('terraform/terraform.tfstate', {
      type: 'file',
      content: declaredOnly,
    });

    const result = await verifyLab({ lab, sandbox, namespace: 'ns' });

    expect(result.checks[1]?.status).toBe('fail');
    expect(result.checks[1]?.detail).toContain('the apply did not create it');
  });

  it('names the resources that are in state when the expected one is not', async () => {
    const lab = await loadLabDefinition(TF_001);
    const otherResource = JSON.stringify({
      version: 4,
      outputs: {},
      resources: [
        { mode: 'managed', type: 'random_pet', name: 'name', instances: [{ attributes: {} }] },
      ],
    });
    const sandbox = solvedTerraformSandbox().put('terraform/terraform.tfstate', {
      type: 'file',
      content: otherResource,
    });

    const result = await verifyLab({ lab, sandbox, namespace: 'ns' });

    expect(result.checks[1]?.detail).toContain('random_pet.name');
    expect(result.checks[4]?.detail).toContain('declares no outputs');
  });

  it('reports a wrong output value without revealing the expected one', async () => {
    const lab = await loadLabDefinition(TF_001);
    const wrongOutput = JSON.parse(SOLVED_STATE) as {
      outputs: Record<string, { value: string }>;
    };
    wrongOutput.outputs.manifest_path = { value: 'manifest.txt' };
    const sandbox = solvedTerraformSandbox().put('terraform/terraform.tfstate', {
      type: 'file',
      content: JSON.stringify(wrongOutput),
    });

    const result = await verifyLab({ lab, sandbox, namespace: 'ns' });

    expect(result.checks[4]?.status).toBe('fail');
    expect(result.checks[4]?.detail).toBe("Output 'manifest_path' is 'manifest.txt'");
  });

  it('treats unparseable state as "nothing applied", not as a crash', async () => {
    const lab = await loadLabDefinition(TF_001);
    const sandbox = solvedTerraformSandbox().put('terraform/terraform.tfstate', {
      type: 'file',
      content: 'this is not json',
    });

    const result = await verifyLab({ lab, sandbox, namespace: 'ns' });

    expect(result.checks[1]?.status).toBe('fail');
    expect(result.checks[1]?.detail).toContain('No readable Terraform state');
  });
});

// --- dispatch ---------------------------------------------------------------

describe('the engine dispatches by requirement family', () => {
  it('skips, rather than fails, a check whose reader is not available', async () => {
    const lab = await loadLabDefinition(LINUX_002);
    // No sandbox reader supplied at all — a platform problem, not the student's.
    const result = await verifyLab({ lab, namespace: 'jtt-lab-000000000001' });

    expect(result.checks.every((c) => c.status === 'skipped')).toBe(true);
    expect(result.checks[0]?.detail).toContain('no sandbox filesystem');
    expect(result.passed).toBe(false);
  });

  it('reports the sandbox it checked', async () => {
    const lab = await loadLabDefinition(LINUX_002);
    const result = await verifyLab({
      lab,
      sandbox: solvedLinuxSandbox(),
      namespace: 'jtt-lab-000000000001',
    });

    expect(result.sandboxRef).toBe('jtt-lab-000000000001');
    expect(result.labId).toBe('LINUX-002');
  });
});
