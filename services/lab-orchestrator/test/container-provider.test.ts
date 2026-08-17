/**
 * PLATFORM-004 — the container-backed providers.
 *
 * Covers the lifecycle (create / status / reset / destroy), the terminal
 * binding, the cleanup-safety gates, and the sandbox read path the verifier
 * uses. What it deliberately does *not* cover is whether Docker actually
 * enforces `--cap-drop`, `--pids-limit` or `--network none`: a fake that
 * "enforced" those would prove nothing, so they are asserted against a real
 * daemon in `sandbox-integration.test.ts`. What is asserted here is that the
 * provider *asks* for them, which is the part that lives in this code.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  DEFAULT_SESSION_POLICY,
  LinuxLabProvider,
  TerraformLabProvider,
  loadLabDefinition,
  type LabSessionContext,
  type LoadedLabDefinition,
} from '../src/index.js';
import { FakeContainerRuntime } from './container-fakes.js';
import { LABS_DIR, sessionContext } from './helpers.js';

const SANDBOX_A = 'jtt-lab-000000000001';
const SANDBOX_B = 'jtt-lab-000000000002';
const HOME = DEFAULT_SESSION_POLICY.sandbox.home;

const LINUX_001 = path.join(LABS_DIR, 'linux', 'linux-001-files-permissions', 'lab.yaml');
const TF_001 = path.join(LABS_DIR, 'terraform', 'tf-001-init-plan-apply', 'lab.yaml');

function contextFor(
  lab: LoadedLabDefinition,
  overrides: { sessionId?: string; sandboxRef?: string } = {},
): LabSessionContext {
  return sessionContext(lab, {
    sessionId: overrides.sessionId ?? 'sess-000000000000000a',
    sandboxRef: overrides.sandboxRef ?? SANDBOX_A,
  });
}

describe('LinuxLabProvider — create', () => {
  it('creates one hardened container per session, labelled with its owner', async () => {
    const lab = await loadLabDefinition(LINUX_001);
    const runtime = new FakeContainerRuntime();
    const provider = new LinuxLabProvider({ runtime });

    const result = await provider.create(contextFor(lab));

    expect(result.ok).toBe(true);
    expect(result.environment.phase).toBe('ready');
    expect(result.environment.sandboxKind).toBe('container');
    expect(result.environment.sandboxRef).toBe(SANDBOX_A);

    const spec = runtime.created.at(-1)!;
    expect(spec.name).toBe(SANDBOX_A);
    expect(spec.image).toBe('jumptotech/lab-linux:latest');
    // The guardrails the provider asks the runtime for.
    expect(spec.network).toBe('none');
    expect(spec.user).toBe('student');
    expect(spec.pidsLimit).toBe(DEFAULT_SESSION_POLICY.sandbox.pidsLimit);
    expect(spec.cpus).toBe(DEFAULT_SESSION_POLICY.sandbox.cpus);
    expect(spec.memory).toBe(DEFAULT_SESSION_POLICY.sandbox.memory);
    // Ownership labels, which are what makes cleanup exact.
    expect(spec.labels['jumptotech.io/managed']).toBe('true');
    expect(spec.labels['jumptotech.io/session-id']).toBe('sess-000000000000000a');
    expect(spec.labels['jumptotech.io/lab-id']).toBe('LINUX-001');
    expect(spec.labels['jumptotech.io/provider']).toBe('linux');
    expect(Number(spec.labels['jumptotech.io/expires-at'])).toBeGreaterThan(0);
  });

  it('gives two sessions two separate containers', async () => {
    const lab = await loadLabDefinition(LINUX_001);
    const runtime = new FakeContainerRuntime();
    const provider = new LinuxLabProvider({ runtime });

    await provider.create(contextFor(lab, { sessionId: 'sess-00000000000000aa', sandboxRef: SANDBOX_A }));
    await provider.create(contextFor(lab, { sessionId: 'sess-00000000000000bb', sandboxRef: SANDBOX_B }));

    expect([...runtime.containers.keys()].sort()).toEqual([SANDBOX_A, SANDBOX_B]);
  });

  it('replaces an existing sandbox rather than failing, so a retried start works', async () => {
    const lab = await loadLabDefinition(LINUX_001);
    const runtime = new FakeContainerRuntime();
    const provider = new LinuxLabProvider({ runtime });

    await provider.create(contextFor(lab));
    const second = await provider.create(contextFor(lab));

    expect(second.ok).toBe(true);
    expect(runtime.removed).toContain(SANDBOX_A);
    expect(runtime.containers.size).toBe(1);
  });

  it('fails with a real reason when the sandbox image is missing', async () => {
    const lab = await loadLabDefinition(LINUX_001);
    const runtime = new FakeContainerRuntime({ images: [] });
    const provider = new LinuxLabProvider({ runtime });

    const result = await provider.create(contextFor(lab));

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('Unable to find image');
    expect(result.error?.remediation).toContain('npm run sandbox:build');
  });
});

describe('TerraformLabProvider — create', () => {
  it('seeds the lab starter files into the sandbox home', async () => {
    const lab = await loadLabDefinition(TF_001);
    const runtime = new FakeContainerRuntime();
    const provider = new TerraformLabProvider({ runtime });

    const result = await provider.create(contextFor(lab));

    expect(result.ok).toBe(true);
    const seeded = runtime.entry(SANDBOX_A, `${HOME}/terraform/versions.tf`);
    expect(seeded?.type).toBe('file');
    expect(seeded?.content).toContain('required_providers');
    expect(result.steps.map((s) => s.id)).toContain('lab-initial-state');
  });

  it('refuses to hand over a Terraform sandbox with no terraform in it', async () => {
    const lab = await loadLabDefinition(TF_001);
    // The Linux image has no terraform; pointing the Terraform provider at it
    // is the shape of "the image was built wrong".
    const runtime = new FakeContainerRuntime();
    const provider = new TerraformLabProvider({ runtime, image: 'jumptotech/lab-linux:latest' });

    const result = await provider.create(contextFor(lab));

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("'terraform' is not usable");
    // A sandbox that failed provisioning is not left behind.
    expect(runtime.containers.has(SANDBOX_A)).toBe(false);
  });
});

describe('reset', () => {
  it('replaces the sandbox and re-seeds the starter files', async () => {
    const lab = await loadLabDefinition(TF_001);
    const runtime = new FakeContainerRuntime();
    const provider = new TerraformLabProvider({ runtime });
    const context = contextFor(lab);

    await provider.create(context);
    runtime.put(SANDBOX_A, `${HOME}/terraform/main.tf`, { content: 'resource "local_file" "manifest" {}' });
    runtime.put(SANDBOX_A, `${HOME}/scratch.txt`, { content: 'work in progress' });

    const result = await provider.reset(context);

    expect(result.ok).toBe(true);
    expect(result.removed).toContain(`container/${SANDBOX_A}`);
    expect(result.restored).toEqual(['terraform/versions.tf']);
    // The student's own work is gone…
    expect(runtime.entry(SANDBOX_A, `${HOME}/terraform/main.tf`)).toBeUndefined();
    expect(runtime.entry(SANDBOX_A, `${HOME}/scratch.txt`)).toBeUndefined();
    // …and the baseline is back.
    expect(runtime.entry(SANDBOX_A, `${HOME}/terraform/versions.tf`)?.content).toContain(
      'required_providers',
    );
  });

  it('refuses to reset a sandbox belonging to another session', async () => {
    const lab = await loadLabDefinition(LINUX_001);
    const runtime = new FakeContainerRuntime();
    const provider = new LinuxLabProvider({ runtime });

    await provider.create(contextFor(lab, { sessionId: 'sess-00000000000000aa' }));
    const intruder = contextFor(lab, { sessionId: 'sess-00000000000000bb' });

    const result = await provider.reset(intruder);

    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/belongs to sess-00000000000000aa/);
    expect(runtime.containers.has(SANDBOX_A)).toBe(true);
  });
});

describe('destroy and cleanup safety', () => {
  it('deletes its own sandbox and confirms it is gone', async () => {
    const lab = await loadLabDefinition(LINUX_001);
    const runtime = new FakeContainerRuntime();
    const provider = new LinuxLabProvider({ runtime });
    const context = contextFor(lab);

    await provider.create(context);
    const result = await provider.destroy(context);

    expect(result.ok).toBe(true);
    expect(result.namespaceGone).toBe(true);
    expect(runtime.containers.has(SANDBOX_A)).toBe(false);
  });

  it('treats an already-absent sandbox as deleted, so teardown is re-entrant', async () => {
    const runtime = new FakeContainerRuntime();
    const provider = new LinuxLabProvider({ runtime });

    const first = await provider.destroySandbox(SANDBOX_A);
    const second = await provider.destroySandbox(SANDBOX_A);

    expect(first.namespaceGone).toBe(true);
    expect(second.namespaceGone).toBe(true);
  });

  it('refuses a name that is not shaped like a JumpToTech sandbox', async () => {
    const runtime = new FakeContainerRuntime();
    runtime.addForeignContainer('postgres', { 'jumptotech.io/managed': 'true' });
    const provider = new LinuxLabProvider({ runtime });

    const result = await provider.destroySandbox('postgres');

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('not a JumpToTech sandbox container name');
    expect(runtime.containers.has('postgres')).toBe(true);
  });

  it('refuses a correctly named container that this platform does not own', async () => {
    const runtime = new FakeContainerRuntime();
    runtime.addForeignContainer(SANDBOX_B, {});
    const provider = new LinuxLabProvider({ runtime });

    const result = await provider.destroySandbox(SANDBOX_B);

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('is not labelled jumptotech.io/managed=true');
    expect(runtime.containers.has(SANDBOX_B)).toBe(true);
  });

  it("refuses to delete another session's sandbox when a session is named", async () => {
    const lab = await loadLabDefinition(LINUX_001);
    const runtime = new FakeContainerRuntime();
    const provider = new LinuxLabProvider({ runtime });
    await provider.create(contextFor(lab, { sessionId: 'sess-00000000000000aa' }));

    const result = await provider.destroySandbox(SANDBOX_A, 'sess-00000000000000bb');

    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/belongs to sess-00000000000000aa/);
    expect(runtime.containers.has(SANDBOX_A)).toBe(true);
  });

  it('lists only the sandboxes it owns, ignoring foreign containers', async () => {
    const lab = await loadLabDefinition(LINUX_001);
    const runtime = new FakeContainerRuntime();
    const linux = new LinuxLabProvider({ runtime });
    const terraform = new TerraformLabProvider({ runtime });

    await linux.create(contextFor(lab, { sandboxRef: SANDBOX_A }));
    await terraform.create(contextFor(await loadLabDefinition(TF_001), { sandboxRef: SANDBOX_B }));
    runtime.addForeignContainer('my-database', { 'jumptotech.io/managed': 'true' });

    const owned = await linux.listManagedSandboxes();
    expect(owned.map((s) => s.sandboxRef)).toEqual([SANDBOX_A]);
    expect(owned[0]?.providerId).toBe('linux');
    expect(owned[0]?.expiresAtMs).toBeGreaterThan(0);

    const terraformOwned = await terraform.listManagedSandboxes();
    expect(terraformOwned.map((s) => s.sandboxRef)).toEqual([SANDBOX_B]);
  });
});

describe('terminal binding', () => {
  it('resolves the container from the session, as the unprivileged user', async () => {
    const lab = await loadLabDefinition(LINUX_001);
    const runtime = new FakeContainerRuntime();
    const provider = new LinuxLabProvider({ runtime });
    const context = contextFor(lab);
    await provider.create(context);

    const terminal = await provider.getTerminalContext(context);

    expect(terminal.kind).toBe('container-exec');
    if (terminal.kind !== 'container-exec') throw new Error('unreachable');
    expect(terminal.containerRef).toBe(SANDBOX_A);
    expect(terminal.user).toBe('student');
    expect(terminal.workdir).toBe(HOME);
    expect(terminal.runtime).toBe('docker');
    // Nothing credential-shaped crosses this boundary for a container sandbox.
    expect(JSON.stringify(terminal)).not.toMatch(/token|kubeconfig|secret/i);
  });

  it("refuses to bind a terminal to another session's container", async () => {
    const lab = await loadLabDefinition(LINUX_001);
    const runtime = new FakeContainerRuntime();
    const provider = new LinuxLabProvider({ runtime });
    await provider.create(contextFor(lab, { sessionId: 'sess-00000000000000aa' }));

    await expect(
      provider.getTerminalContext(contextFor(lab, { sessionId: 'sess-00000000000000bb' })),
    ).rejects.toThrow(/belongs to sess-00000000000000aa/);
  });
});

describe('sandbox reads for the verifier', () => {
  it('reads a file back with its mode, owner and group, as the student user', async () => {
    const lab = await loadLabDefinition(LINUX_001);
    const runtime = new FakeContainerRuntime();
    const provider = new LinuxLabProvider({ runtime });
    const context = contextFor(lab);
    await provider.create(context);

    runtime.put(SANDBOX_A, `${HOME}/deploy/release.txt`, {
      content: 'service=ledger-api\n',
      mode: '640',
      owner: 'student',
      group: 'deployers',
    });

    const read = await provider.readSandboxPath(context, 'deploy/release.txt');

    expect(read).toEqual({
      type: 'file',
      mode: '640',
      owner: 'student',
      group: 'deployers',
      sizeBytes: 'service=ledger-api\n'.length,
      content: 'service=ledger-api\n',
    });

    // Reads run as the unprivileged student, not as root: the check must see
    // exactly what the student can see.
    const statCall = runtime.execs.find((e) => e.request.argv[0] === '/usr/bin/stat');
    expect(statCall?.request.user).toBe('student');
  });

  it('returns null for a path that does not exist', async () => {
    const lab = await loadLabDefinition(LINUX_001);
    const runtime = new FakeContainerRuntime();
    const provider = new LinuxLabProvider({ runtime });
    const context = contextFor(lab);
    await provider.create(context);

    expect(await provider.readSandboxPath(context, 'deploy/missing.txt')).toBeNull();
  });

  it('refuses a path that would escape the sandbox home', async () => {
    const lab = await loadLabDefinition(LINUX_001);
    const runtime = new FakeContainerRuntime();
    const provider = new LinuxLabProvider({ runtime });
    const context = contextFor(lab);
    await provider.create(context);

    for (const bad of ['../../etc/passwd', '/etc/shadow', '~/.ssh/id_rsa', 'deploy/../../etc/hosts']) {
      await expect(provider.readSandboxPath(context, bad)).rejects.toThrow(/Invalid sandbox path/);
    }
    // Nothing was even attempted against the runtime.
    expect(runtime.execs.some((e) => JSON.stringify(e.request.argv).includes('passwd'))).toBe(false);
  });
});
