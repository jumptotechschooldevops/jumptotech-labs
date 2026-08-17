/**
 * The Linux sandbox provider, at the provider seam.
 *
 * `container-provider.test.ts` pins what every container-backed provider does —
 * the guardrail flags, the ownership gates, reset, destroy, cleanup. This file
 * pins what is specific to *Linux*: the capability grant that makes an
 * administration lab teachable, the seed-script mechanism that stages one, and
 * the inspection reads the `linux` requirement family depends on.
 *
 * Everything here runs against `FakeContainerRuntime`, which models what the
 * provider can observe and deliberately does **not** simulate container
 * behaviour. It cannot prove that `--cap-drop ALL` is enforced, that a pids
 * limit holds, or that a seed script really created a group — only that the
 * provider asked for the right thing, in the right sandbox, as the right user.
 * The properties that depend on the runtime itself are asserted against real
 * Docker in `apps/api/test/sandbox-integration.test.ts`, so that no test here
 * can "prove" a security property against a mock.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  DEFAULT_LINUX_SANDBOX_IMAGE,
  DEFAULT_SESSION_POLICY,
  GRANTABLE_CAPABILITIES,
  LINUX_SANDBOX_CAPABILITIES,
  LinuxLabProvider,
  TerraformLabProvider,
  loadLabDefinition,
  type LabSessionContext,
  type LoadedLabDefinition,
} from '../src/index.js';
import { FakeContainerRuntime } from './container-fakes.js';
import { LABS_DIR, sessionContext } from './helpers.js';

const LINUX_001 = path.join(LABS_DIR, 'linux', 'linux-001-files', 'lab.yaml');
const LINUX_003 = path.join(LABS_DIR, 'linux', 'linux-003-users-groups', 'lab.yaml');
const SANDBOX_A = 'jtt-lab-000000000001';
const SANDBOX_B = 'jtt-lab-000000000002';

function contextFor(lab: LoadedLabDefinition, sandboxRef = SANDBOX_A): LabSessionContext {
  return sessionContext(lab, {
    sandboxRef,
    sessionId: sandboxRef === SANDBOX_A ? 'sess-000000000000000a' : 'sess-000000000000000b',
  });
}

// ------------------------------------------------------- the sandbox shape

describe('the Linux sandbox', () => {
  it('is built from the controlled training image and nothing else', async () => {
    const lab = await loadLabDefinition(LINUX_001);
    const runtime = new FakeContainerRuntime();
    const provider = new LinuxLabProvider({ runtime });

    const result = await provider.create(contextFor(lab));

    expect(result.ok).toBe(true);
    expect(runtime.created.at(-1)!.image).toBe(DEFAULT_LINUX_SANDBOX_IMAGE);
    expect(result.environment.image).toBe(DEFAULT_LINUX_SANDBOX_IMAGE);
  });

  it('reports a missing training image as an environment problem, not a failed lab', async () => {
    const runtime = new FakeContainerRuntime({ images: [] });
    const provider = new LinuxLabProvider({ runtime });

    const availability = await provider.availability();

    expect(availability.available).toBe(false);
    expect(availability.reason).toMatch(/has not been built/);
    // An operator is told what to do, rather than a student being told they failed.
    expect(availability.remediation).toMatch(/sandbox:build/);
  });

  it('reports an unreachable container runtime as unreachable', async () => {
    const runtime = new FakeContainerRuntime({ unreachable: 'Cannot connect to the Docker daemon' });
    const provider = new LinuxLabProvider({ runtime });

    const availability = await provider.availability();

    expect(availability.available).toBe(false);
    expect(availability.reason).toMatch(/no container runtime is reachable/);
  });

  it('grants back only the capabilities an administration lab needs', async () => {
    const lab = await loadLabDefinition(LINUX_001);
    const runtime = new FakeContainerRuntime();

    await new LinuxLabProvider({ runtime }).create(contextFor(lab));

    const spec = runtime.created.at(-1)!;
    expect(spec.capAdd).toEqual([...LINUX_SANDBOX_CAPABILITIES]);
    // The grant is bounded by the runtime's own closed list, so it cannot be
    // widened into something host-reaching by editing the provider alone.
    for (const capability of spec.capAdd!) {
      expect(GRANTABLE_CAPABILITIES.has(capability)).toBe(true);
    }
    for (const forbidden of ['SYS_ADMIN', 'NET_ADMIN', 'SYS_PTRACE', 'MKNOD', 'SYS_MODULE', 'SYS_BOOT']) {
      expect(GRANTABLE_CAPABILITIES.has(forbidden)).toBe(false);
    }
  });

  it('keeps every boundary that does not stand in the way of teaching', async () => {
    const lab = await loadLabDefinition(LINUX_001);
    const runtime = new FakeContainerRuntime();

    await new LinuxLabProvider({ runtime }).create(contextFor(lab));

    const spec = runtime.created.at(-1)!;
    // No network, and the ceilings the session policy set.
    expect(spec.network).toBe('none');
    expect(spec.cpus).toBe(DEFAULT_SESSION_POLICY.sandbox.cpus);
    expect(spec.memory).toBe(DEFAULT_SESSION_POLICY.sandbox.memory);
    expect(spec.pidsLimit).toBe(DEFAULT_SESSION_POLICY.sandbox.pidsLimit);
    // Nothing about the Docker socket, and nothing about a host path, is in
    // the spec at all — there is no field here that could carry one.
    expect(JSON.stringify(spec)).not.toMatch(/docker\.sock|\/var\/run|bind|mount/i);
  });

  it('leaves a Terraform sandbox on the strict profile', async () => {
    const lab = await loadLabDefinition(
      path.join(LABS_DIR, 'terraform', 'tf-001-init-plan-apply', 'lab.yaml'),
    );
    const runtime = new FakeContainerRuntime();

    await new TerraformLabProvider({ runtime }).create(contextFor(lab));

    const spec = runtime.created.at(-1)!;
    // The relaxation is the Linux provider's, and only the Linux provider's.
    expect(spec.capAdd).toBeUndefined();
    expect(spec.noNewPrivileges).not.toBe(false);
    expect(spec.user).toBe(DEFAULT_SESSION_POLICY.sandbox.user);
  });
});

// ------------------------------------------------------------ seed scripts

describe('lab baseline seeding', () => {
  it('installs, runs and removes a lab’s seed scripts, as the sandbox’s root', async () => {
    const lab = await loadLabDefinition(LINUX_003);
    const runtime = new FakeContainerRuntime();
    const provider = new LinuxLabProvider({ runtime });

    const result = await provider.create(contextFor(lab));

    expect(result.ok).toBe(true);
    expect(runtime.seedScriptsRun).toEqual(['seed.sh']);

    const seedExecs = runtime.execs.filter((e) =>
      JSON.stringify(e.request.argv).includes('/opt/jumptotech/seed'),
    );
    expect(seedExecs.length).toBeGreaterThan(0);
    expect(seedExecs.every((e) => e.container === SANDBOX_A)).toBe(true);
    expect(seedExecs.every((e) => e.request.user === 'root')).toBe(true);

    // The script content travelled on stdin, never in a command line — so
    // there was nothing to quote and nothing that could become syntax.
    const write = seedExecs.find((e) => e.request.argv[0] === '/usr/bin/tee');
    expect(write?.request.stdin?.startsWith('#!')).toBe(true);
    expect(JSON.stringify(write?.request.argv)).not.toContain('#!');
  });

  it('clears the seed directory even when a script fails', async () => {
    const lab = await loadLabDefinition(LINUX_003);
    const runtime = new FakeContainerRuntime({
      failingSeedScripts: { 'seed.sh': { exitCode: 3, stderr: 'groupadd: permission denied' } },
    });
    const provider = new LinuxLabProvider({ runtime });

    const result = await provider.create(contextFor(lab));

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('SETUP_FAILED');
    // A troubleshooting lab's seed script describes the fault it injects, and
    // the student is root in here — so it must not survive a failed start.
    const cleared = runtime.execs.find(
      (e) => e.request.argv[0] === '/bin/rm' && e.request.argv.includes('/opt/jumptotech/seed'),
    );
    expect(cleared).toBeDefined();
    expect(cleared!.request.user).toBe('root');
  });

  it('reports the script that failed rather than a generic setup error', async () => {
    const lab = await loadLabDefinition(LINUX_003);
    const runtime = new FakeContainerRuntime({
      failingSeedScripts: { 'seed.sh': { exitCode: 3, stderr: 'groupadd: permission denied' } },
    });

    const result = await new LinuxLabProvider({ runtime }).create(contextFor(lab));

    expect(result.error?.message).toContain('setup/seed.sh');
    expect(result.error?.message).toContain('groupadd: permission denied');
    expect(result.error?.remediation).toContain('LINUX-003');
  });

  it('reruns the baseline when the lab is reset', async () => {
    const lab = await loadLabDefinition(LINUX_003);
    const runtime = new FakeContainerRuntime();
    const provider = new LinuxLabProvider({ runtime });
    const context = contextFor(lab);
    await provider.create(context);

    const result = await provider.reset(context);

    expect(result.ok).toBe(true);
    expect(runtime.seedScriptsRun).toEqual(['seed.sh', 'seed.sh']);
    expect(result.restored).toContain('setup/seed.sh');
  });
});

// ------------------------------------------------ inspection, for the verifier

describe('inspection reads for the verifier', () => {
  async function started(lab: LoadedLabDefinition, runtime: FakeContainerRuntime) {
    const provider = new LinuxLabProvider({ runtime });
    const context = contextFor(lab);
    await provider.create(context);
    return { provider, context };
  }

  it('answers an allow-listed inspection command inside the session’s own sandbox', async () => {
    const lab = await loadLabDefinition(LINUX_001);
    const runtime = new FakeContainerRuntime({ processes: ['  42 student /usr/local/bin/ledger-sync'] });
    const { provider, context } = await started(lab, runtime);

    const result = await provider.inspectSandbox(context, 'ps', ['-eo', 'pid=,user=,args=']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('ledger-sync');
    const ps = runtime.execs.filter((e) => e.request.argv[0] === 'ps');
    expect(ps.every((e) => e.container === SANDBOX_A)).toBe(true);
    // Observed as the student, so a check sees exactly what the student sees.
    expect(ps.every((e) => e.request.user === DEFAULT_SESSION_POLICY.sandbox.user)).toBe(true);
  });

  it('refuses a command outside the closed inspection allow-list', async () => {
    const lab = await loadLabDefinition(LINUX_001);
    const runtime = new FakeContainerRuntime();
    const { provider, context } = await started(lab, runtime);

    for (const forbidden of ['rm', 'bash', 'sh', 'chmod', 'useradd']) {
      await expect(provider.inspectSandbox(context, forbidden, [])).rejects.toThrow(
        /not an inspection command/,
      );
    }
    // Nothing was attempted against the runtime either.
    expect(runtime.execs.some((e) => e.request.argv[0] === 'rm')).toBe(false);
  });

  it('does not offer inspection at all on a provider whose labs do not need it', async () => {
    const lab = await loadLabDefinition(
      path.join(LABS_DIR, 'terraform', 'tf-001-init-plan-apply', 'lab.yaml'),
    );
    const runtime = new FakeContainerRuntime();
    const provider = new TerraformLabProvider({ runtime });
    const context = contextFor(lab);
    await provider.create(context);

    await expect(provider.inspectSandbox(context, 'ps', [])).rejects.toThrow(
      /does not offer|not an inspection command/,
    );
    await expect(provider.runSandboxScript(context, 'report.sh', [])).rejects.toThrow(
      /does not run scripts/,
    );
  });

  it('runs a student’s script by path, as the student, with no shell interpolation', async () => {
    const lab = await loadLabDefinition(LINUX_001);
    const runtime = new FakeContainerRuntime();
    const { provider, context } = await started(lab, runtime);
    runtime.put(SANDBOX_A, '/home/student/report.sh', { content: 'ok\n', mode: '750' });

    const result = await provider.runSandboxScript(context, 'report.sh', ['--verbose']);

    expect(result.exitCode).toBe(0);
    const run = runtime.execs.at(-1)!;
    expect(run.container).toBe(SANDBOX_A);
    expect(run.request.user).toBe(DEFAULT_SESSION_POLICY.sandbox.user);
    // The path arrives as an argv element, never as command text.
    expect(run.request.argv).toEqual([
      '/bin/sh',
      '-c',
      'exec "$0" "$@"',
      '/home/student/report.sh',
      '--verbose',
    ]);
  });

  it('refuses a script path that would escape the sandbox', async () => {
    const lab = await loadLabDefinition(LINUX_001);
    const runtime = new FakeContainerRuntime();
    const { provider, context } = await started(lab, runtime);

    for (const bad of ['../../etc/passwd', '~/.ssh/id_rsa', 'a/../../root/x.sh']) {
      await expect(provider.runSandboxScript(context, bad, [])).rejects.toThrow(
        /Invalid sandbox path/,
      );
    }
  });
});

// ------------------------------------------------------------- isolation

describe('one session never reaches another’s sandbox', () => {
  it('scopes every command to the sandbox it was given', async () => {
    const lab = await loadLabDefinition(LINUX_001);
    const runtime = new FakeContainerRuntime();
    const provider = new LinuxLabProvider({ runtime });

    const a = contextFor(lab, SANDBOX_A);
    const b = contextFor(lab, SANDBOX_B);
    await provider.create(a);
    await provider.create(b);
    runtime.execs.length = 0;

    await provider.inspectSandbox(a, 'ps', ['-eo', 'pid=,user=,args=']);
    await provider.readSandboxPath!(a, 'project');

    // Everything since went to A's container. There is no argument anywhere in
    // these calls that names a container: it is derived from the context.
    expect(runtime.execs.every((e) => e.container === SANDBOX_A)).toBe(true);
  });

  it('refuses to destroy a sandbox belonging to a different session', async () => {
    const lab = await loadLabDefinition(LINUX_001);
    const runtime = new FakeContainerRuntime();
    const provider = new LinuxLabProvider({ runtime });
    const a = contextFor(lab, SANDBOX_A);
    await provider.create(a);

    const outcome = await provider.destroySandbox(SANDBOX_A, 'sess-000000000000000b');

    expect(outcome.ok).toBe(false);
    expect(runtime.containers.has(SANDBOX_A)).toBe(true);
  });

  it('refuses any handle that is not a sandbox name this platform issues', async () => {
    const runtime = new FakeContainerRuntime();
    const provider = new LinuxLabProvider({ runtime });

    for (const bad of ['postgres', 'jtt-lab-', 'jtt-lab-ZZZZ', '../etc', 'lab-0000000000aa']) {
      const outcome = await provider.destroySandbox(bad);
      expect(outcome.ok, bad).toBe(false);
    }
    expect(runtime.removed).toEqual([]);
  });

  it('never reports a foreign container as one of its own', async () => {
    const lab = await loadLabDefinition(LINUX_001);
    const runtime = new FakeContainerRuntime();
    const provider = new LinuxLabProvider({ runtime });
    await provider.create(contextFor(lab));
    // Same name shape, no ownership labels.
    runtime.addForeignContainer('jtt-lab-cafecafecafe');

    const managed = await provider.listManagedSandboxes();

    expect(managed.map((m) => m.sandboxRef)).toEqual([SANDBOX_A]);
    expect(managed[0]!.providerId).toBe('linux');
    expect(managed[0]!.sandboxKind).toBe('container');
    expect(managed[0]!.expiresAtMs).toBeGreaterThan(0);
  });
});
