/**
 * PLATFORM-004 — real sandbox integration (story section 26).
 *
 * These tests drive a **real container runtime**. Nothing here is mocked: the
 * containers exist, the commands run inside them, the files are real files, and
 * the verifier reads them back through the same path the API uses.
 *
 * That matters because the properties worth asserting are the ones only a real
 * daemon can demonstrate:
 *
 *   · the sandbox genuinely has no network, no capabilities and no host mounts;
 *   · `terraform init` genuinely resolves offline from the baked mirror;
 *   · LINUX-001 and TF-001 are genuinely solvable by an unprivileged user, and
 *     genuinely fail before the work is done;
 *   · Reset genuinely returns the environment to its baseline, and End Lab
 *     genuinely removes the container.
 *
 * A fake could "prove" all of that and prove nothing.
 *
 * Requirements: Docker, plus the sandbox images (`npm run sandbox:build`). The
 * suite skips itself with an explanation when either is absent rather than
 * failing a developer who has not built them.
 *
 * ```bash
 * npm run sandbox:build
 * RUN_INTEGRATION_TESTS=1 npx vitest run test/sandbox-integration.test.ts --root apps/api
 * ```
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import type { Express } from 'express';
import {
  DEFAULT_LINUX_SANDBOX_IMAGE,
  DEFAULT_TERRAFORM_SANDBOX_IMAGE,
  DockerCliRuntime,
  InMemorySessionStore,
  KubernetesClient,
  LabRegistry,
  LinuxLabProvider,
  ProviderRegistry,
  SessionManager,
  SessionReaper,
  TerraformLabProvider,
  type LabSession,
} from '@jumptotech/lab-orchestrator';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const exec = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SECRET = 'sandbox-integration-test-secret';
const HOME = '/home/student';

/** The commands a student would type to solve LINUX-001. */
const LINUX_SOLUTION = `
set -e
mkdir -p deploy/releases
printf 'service=ledger-api\\nversion=4.2.0\\n' > deploy/release.txt
chgrp deployers deploy
chmod 750 deploy
chmod 640 deploy/release.txt
`;

/** The configuration a student would write to solve TF-001, plus the workflow. */
const TERRAFORM_SOLUTION = `
set -e
cd terraform
cat > main.tf <<'HCL'
resource "local_file" "manifest" {
  filename = "build/manifest.txt"
  content  = "service=ledger-api\\nenvironment=lab\\n"
}

output "manifest_path" {
  value = "build/manifest.txt"
}
HCL
terraform init -no-color -input=false
terraform plan -no-color -input=false
terraform apply -auto-approve -no-color -input=false
`;

let enabled = false;
let skipReason = '';
const runtime = new DockerCliRuntime();

async function dockerAvailable(): Promise<string> {
  if (process.env.RUN_INTEGRATION_TESTS !== '1') {
    return 'set RUN_INTEGRATION_TESTS=1 to run the real sandbox suite';
  }
  try {
    await runtime.ping();
  } catch (error) {
    return `no container runtime is reachable (${(error as Error).message})`;
  }
  for (const image of [DEFAULT_LINUX_SANDBOX_IMAGE, DEFAULT_TERRAFORM_SANDBOX_IMAGE]) {
    if (!(await runtime.imageExists(image))) {
      return `sandbox image '${image}' is not built — run: npm run sandbox:build`;
    }
  }
  return '';
}

interface Harness {
  app: Express;
  sessions: SessionManager;
  providers: ProviderRegistry;
}

async function harness(options: { now?: () => number } = {}): Promise<Harness> {
  const registry = new LabRegistry(path.join(repoRoot, 'labs'));
  await registry.load();

  const config = loadConfig({
    TERMINAL_SESSION_SECRET: SECRET,
    LABS_DIR: path.join(repoRoot, 'labs'),
  } as NodeJS.ProcessEnv);

  const providers = new ProviderRegistry({ availabilityTtlMs: 0 });
  providers.register({ provider: new LinuxLabProvider({ runtime }) });
  providers.register({ provider: new TerraformLabProvider({ runtime }) });

  const sessions = new SessionManager({
    registry,
    providers,
    store: new InMemorySessionStore(),
    policy: config.policy,
    lifetimes: config.lifetimes,
    namespaceSecret: SECRET,
    ...(options.now ? { now: options.now } : {}),
  });

  // The Kubernetes client is only constructed so the app can be assembled; no
  // test in this file touches a cluster.
  const k8s = new KubernetesClient({});
  return { app: createApp({ registry, sessions, k8s, config }), sessions, providers };
}

/** Track every sandbox this suite creates, so nothing is left behind. */
const created = new Set<string>();

async function startLab(app: Express, labId: string) {
  const response = await request(app).post(`/api/labs/${labId}/start`);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const session = response.body.data.session as LabSession & { sandboxRef: string };
  created.add(session.sandboxRef);
  return session;
}

/** Run a shell script inside a sandbox, as the student would. */
async function asStudent(sandboxRef: string, script: string) {
  const result = await runtime.exec(sandboxRef, {
    argv: ['/bin/bash', '-lc', script],
    user: 'student',
    workdir: HOME,
    timeoutMs: 180_000,
  });
  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  return result;
}

async function check(app: Express, sessionId: string) {
  const response = await request(app).post(`/api/sessions/${sessionId}/check`);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data as {
    passed: boolean;
    summary: string;
    checks: Array<{ label: string; status: string; detail?: string }>;
  };
}

beforeAll(async () => {
  skipReason = await dockerAvailable();
  enabled = skipReason === '';
  if (!enabled) console.log(`[sandbox-integration] skipped — ${skipReason}`);
}, 120_000);

afterAll(async () => {
  // Belt and braces: the tests end their own sessions, but a failure mid-test
  // must not leave a container running on a developer's machine.
  for (const ref of created) {
    await runtime.remove(ref).catch(() => undefined);
  }
}, 120_000);

describe.runIf(process.env.RUN_INTEGRATION_TESTS === '1')('real Linux sandbox', () => {
  it('creates a container with no network, no capabilities and bounded resources', async () => {
    if (!enabled) return;
    const { app, sessions } = await harness();
    const session = await startLab(app, 'LINUX-001');

    const { stdout } = await exec('docker', [
      'inspect',
      session.sandboxRef,
      '--format',
      '{{.HostConfig.NetworkMode}}|{{.HostConfig.CapDrop}}|{{.HostConfig.PidsLimit}}|{{.HostConfig.Memory}}|{{.Config.User}}|{{len .Mounts}}|{{.HostConfig.Privileged}}|{{.HostConfig.SecurityOpt}}',
    ]);
    const [network, capDrop, pids, memory, user, mounts, privileged, securityOpt] = stdout
      .trim()
      .split('|');

    expect(network).toBe('none');
    expect(capDrop).toContain('ALL');
    expect(Number(pids)).toBe(sessions.policy.sandbox.pidsLimit);
    expect(Number(memory)).toBeGreaterThan(0);
    expect(user).toBe('student');
    expect(privileged).toBe('false');
    expect(securityOpt).toContain('no-new-privileges');
    // No host filesystem is mounted, and in particular no Docker socket.
    expect(Number(mounts)).toBe(0);

    await request(app).delete(`/api/sessions/${session.sessionId}`);
  }, 180_000);

  it('runs real Linux commands as an unprivileged user with no daemon access', async () => {
    if (!enabled) return;
    const { app } = await harness();
    const session = await startLab(app, 'LINUX-001');

    const id = await asStudent(session.sandboxRef, 'id -un && id -Gn');
    expect(id.stdout).toContain('student');
    expect(id.stdout).toContain('deployers');

    const ls = await asStudent(session.sandboxRef, 'ls -la ~ && pwd');
    expect(ls.stdout).toContain(HOME);

    // The student cannot reach a container runtime from inside the sandbox.
    const docker = await runtime.exec(session.sandboxRef, {
      argv: ['/bin/bash', '-lc', 'command -v docker; ls /var/run/docker.sock'],
      user: 'student',
      workdir: HOME,
    });
    expect(docker.exitCode).not.toBe(0);

    // And cannot give a file away to another user: there is no CAP_CHOWN.
    const chown = await runtime.exec(session.sandboxRef, {
      argv: ['/bin/bash', '-lc', 'touch f && chown root f'],
      user: 'student',
      workdir: HOME,
    });
    expect(chown.exitCode).not.toBe(0);
    expect(chown.stderr).toMatch(/not permitted/i);

    await request(app).delete(`/api/sessions/${session.sessionId}`);
  }, 180_000);

  it('fails LINUX-001 before the work and passes it after, on real state', async () => {
    if (!enabled) return;
    const { app } = await harness();
    const session = await startLab(app, 'LINUX-001');

    const before = await check(app, session.sessionId);
    expect(before.passed).toBe(false);
    expect(before.summary).toBe('LAB NOT COMPLETE');
    expect(before.checks.every((c) => c.status === 'fail')).toBe(true);

    await asStudent(session.sandboxRef, LINUX_SOLUTION);

    const after = await check(app, session.sessionId);
    expect(after.passed, JSON.stringify(after.checks, null, 2)).toBe(true);
    expect(after.summary).toBe('LAB PASSED');

    await request(app).delete(`/api/sessions/${session.sessionId}`);
  }, 180_000);

  it('restores the baseline on Reset and destroys the sandbox on End', async () => {
    if (!enabled) return;
    const { app } = await harness();
    const session = await startLab(app, 'LINUX-001');

    await asStudent(session.sandboxRef, LINUX_SOLUTION);
    expect((await check(app, session.sessionId)).passed).toBe(true);

    const reset = await request(app).post(`/api/sessions/${session.sessionId}/reset`);
    expect(reset.status, JSON.stringify(reset.body)).toBe(200);
    expect(reset.body.data.reconnectTerminal).toBe(true);

    // The student's work is genuinely gone from a genuinely new container.
    // (The home still has the shell dotfiles the image ships — a fresh
    // container from the image, which is exactly what a baseline is.)
    const afterReset = await check(app, session.sessionId);
    expect(afterReset.passed).toBe(false);
    const listing = await runtime.exec(session.sandboxRef, {
      argv: ['/bin/bash', '-lc', 'ls -A'],
      user: 'student',
      workdir: HOME,
    });
    expect(listing.stdout).not.toContain('deploy');

    // And the lab is solvable again in the fresh sandbox.
    await asStudent(session.sandboxRef, LINUX_SOLUTION);
    expect((await check(app, session.sessionId)).passed).toBe(true);

    const ended = await request(app).delete(`/api/sessions/${session.sessionId}`);
    expect(ended.status).toBe(200);
    expect(await runtime.inspect(session.sandboxRef)).toBeNull();
  }, 240_000);

  it('keeps two students in two sandboxes', async () => {
    if (!enabled) return;
    const { app } = await harness();
    const a = await startLab(app, 'LINUX-001');
    const b = await startLab(app, 'LINUX-001');

    expect(a.sandboxRef).not.toBe(b.sandboxRef);
    await asStudent(a.sandboxRef, LINUX_SOLUTION);

    // A passes; B is untouched and still fails.
    expect((await check(app, a.sessionId)).passed).toBe(true);
    expect((await check(app, b.sessionId)).passed).toBe(false);

    // B's sandbox genuinely does not contain A's work.
    const listing = await runtime.exec(b.sandboxRef, {
      argv: ['/bin/bash', '-lc', 'ls -A'],
      user: 'student',
      workdir: HOME,
    });
    expect(listing.stdout).not.toContain('deploy');

    // Ending A leaves B alone.
    await request(app).delete(`/api/sessions/${a.sessionId}`);
    expect(await runtime.inspect(a.sandboxRef)).toBeNull();
    expect(await runtime.inspect(b.sandboxRef)).not.toBeNull();

    await request(app).delete(`/api/sessions/${b.sessionId}`);
  }, 240_000);

  it('reclaims an expired sandbox without anyone asking', async () => {
    if (!enabled) return;
    let now = Date.now();
    const { app, sessions, providers } = await harness({ now: () => now });
    const session = await startLab(app, 'LINUX-001');
    expect(await runtime.inspect(session.sandboxRef)).not.toBeNull();

    const reaper = new SessionReaper({
      sessions,
      providers,
      intervalMs: 60_000,
      now: () => now,
      log: () => undefined,
    });

    // Nothing to do inside the deadline.
    expect((await reaper.sweep()).removed).toEqual([]);

    now += sessions.lifetimes.maxSessionSeconds * 1000 + 1000;
    const sweep = await reaper.sweep();

    expect(sweep.removed).toContain(session.sandboxRef);
    expect(await runtime.inspect(session.sandboxRef)).toBeNull();
    expect((await sessions.get(session.sessionId))?.status).toBe('EXPIRED');
  }, 240_000);

  it('refuses to delete a container it does not own', async () => {
    if (!enabled) return;
    const { providers } = await harness();
    const linux = providers.peek('linux')!;
    const foreign = 'jtt-lab-ffffffffdead';

    // A container with a name that would pass the shape gate, created outside
    // the platform and therefore carrying none of its labels.
    await exec('docker', [
      'run', '--detach', '--name', foreign, '--network', 'none',
      DEFAULT_LINUX_SANDBOX_IMAGE, 'sleep', '120',
    ]);
    try {
      const result = await linux.destroySandbox(foreign);
      expect(result.ok).toBe(false);
      expect(result.error?.message).toContain('is not labelled jumptotech.io/managed=true');
      expect(await runtime.inspect(foreign)).not.toBeNull();

      // And it is not in the reaper's work list at all.
      const managed = await linux.listManagedSandboxes();
      expect(managed.map((s) => s.sandboxRef)).not.toContain(foreign);
    } finally {
      await exec('docker', ['rm', '--force', foreign]).catch(() => undefined);
    }
  }, 180_000);
});

describe.runIf(process.env.RUN_INTEGRATION_TESTS === '1')('real Terraform sandbox', () => {
  it('ships a working terraform CLI and the lab starter files', async () => {
    if (!enabled) return;
    const { app } = await harness();
    const session = await startLab(app, 'TF-001');

    const version = await asStudent(session.sandboxRef, 'terraform version');
    expect(version.stdout).toMatch(/Terraform v\d+\.\d+\.\d+/);

    const starter = await asStudent(session.sandboxRef, 'cat terraform/versions.tf');
    expect(starter.stdout).toContain('required_providers');
    expect(starter.stdout).toContain('hashicorp/local');

    await request(app).delete(`/api/sessions/${session.sessionId}`);
  }, 240_000);

  it('runs init, plan and apply offline, and passes TF-001 on real state', async () => {
    if (!enabled) return;
    const { app } = await harness();
    const session = await startLab(app, 'TF-001');

    const before = await check(app, session.sessionId);
    expect(before.passed).toBe(false);
    expect(before.checks[0]?.detail).toContain('Terraform has not been initialized here');

    // The whole workflow, with no network and no credentials.
    const run = await asStudent(session.sandboxRef, TERRAFORM_SOLUTION);
    expect(run.stdout).toContain('Terraform has been successfully initialized');
    expect(run.stdout).toMatch(/Apply complete!/);

    const after = await check(app, session.sessionId);
    expect(after.passed, JSON.stringify(after.checks, null, 2)).toBe(true);

    // The state the checks read is a real state file from a real apply.
    const state = await asStudent(session.sandboxRef, 'cat terraform/terraform.tfstate');
    expect(state.stdout).toContain('local_file');
    expect(state.stdout).toContain('manifest_path');

    await request(app).delete(`/api/sessions/${session.sessionId}`);
  }, 300_000);

  it('restores the starter configuration on Reset and removes the sandbox on End', async () => {
    if (!enabled) return;
    const { app } = await harness();
    const session = await startLab(app, 'TF-001');

    await asStudent(session.sandboxRef, TERRAFORM_SOLUTION);
    expect((await check(app, session.sessionId)).passed).toBe(true);

    const reset = await request(app).post(`/api/sessions/${session.sessionId}/reset`);
    expect(reset.status, JSON.stringify(reset.body)).toBe(200);
    expect(reset.body.data.restored).toEqual(['terraform/versions.tf']);

    // The starter file is back and the student's work is gone.
    const listing = await asStudent(session.sandboxRef, 'ls -A terraform');
    expect(listing.stdout.trim()).toBe('versions.tf');
    expect((await check(app, session.sessionId)).passed).toBe(false);

    await request(app).delete(`/api/sessions/${session.sessionId}`);
    expect(await runtime.inspect(session.sandboxRef)).toBeNull();
  }, 300_000);

  it('runs a Linux and a Terraform sandbox side by side, isolated', async () => {
    if (!enabled) return;
    const { app } = await harness();
    const linux = await startLab(app, 'LINUX-001');
    const terraform = await startLab(app, 'TF-001');

    await asStudent(linux.sandboxRef, LINUX_SOLUTION);
    await asStudent(terraform.sandboxRef, TERRAFORM_SOLUTION);

    expect((await check(app, linux.sessionId)).passed).toBe(true);
    expect((await check(app, terraform.sessionId)).passed).toBe(true);

    // Neither sandbox can see the other's work.
    const linuxListing = await asStudent(linux.sandboxRef, 'ls -A');
    expect(linuxListing.stdout).not.toContain('terraform');
    const terraformListing = await asStudent(terraform.sandboxRef, 'ls -A');
    expect(terraformListing.stdout).not.toContain('deploy');

    await request(app).delete(`/api/sessions/${linux.sessionId}`);
    await request(app).delete(`/api/sessions/${terraform.sessionId}`);
  }, 420_000);
});
