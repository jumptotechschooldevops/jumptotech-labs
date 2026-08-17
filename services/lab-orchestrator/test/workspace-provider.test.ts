/**
 * PLATFORM-CICD-001 — the file-backed sandbox.
 *
 * Covers story tests 3 (a session workspace is created), 13 (reset restores
 * the baseline), 14 (End destroys the workspace), 15 (expiry destroys it),
 * 16 (cleanup is idempotent) and 17 (five sessions stay isolated), plus the
 * path-safety and command-allow-list properties the sandbox rests on.
 *
 * Every test runs against a real temporary directory. "The workspace was
 * created" means bytes are on disk; "the workspace was destroyed" means the
 * directory is verifiably gone — nothing here is asserted against a mock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_SESSION_POLICY,
  FsWorkspace,
  InMemorySessionStore,
  InvalidWorkspacePathError,
  LabRegistry,
  SessionManager,
  SessionReaper,
  WorkspaceLabProvider,
  assertSafeRelativePath,
  loadWorkspaceSeed,
  type LabSession,
  type LabSessionContext,
  type LoadedLabDefinition,
} from '../src/index.js';
import { LABS_DIR } from './helpers.js';

/*
 * These tests deliberately spawn real processes — a workspace build, a real
 * test run — so the 5s default meant for pure unit tests does not apply. The
 * budget below is generous on purpose: a timeout here should mean something is
 * genuinely wrong, not that the machine was busy running the rest of the suite.
 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const SECRET = 'a-namespace-derivation-secret';
const LAB_ID = 'CICD-002';

let root: string;
let registry: LabRegistry;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'jtt-workspace-'));
  registry = new LabRegistry(LABS_DIR);
  await registry.load();
  expect(registry.loadErrors).toEqual([]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function contextFor(
  lab: LoadedLabDefinition,
  overrides: { sessionId?: string; namespace?: string; expiresAtMs?: number } = {},
): LabSessionContext {
  return {
    sessionId: overrides.sessionId ?? 'sess-000000000000000a',
    labId: lab.id,
    namespace: overrides.namespace ?? 'lab-0000000000aa',
    serviceAccountName: DEFAULT_SESSION_POLICY.serviceAccountName,
    lab,
    expiresAtMs: overrides.expiresAtMs ?? Date.now() + 3_600_000,
    policy: DEFAULT_SESSION_POLICY,
  };
}

function makeProvider(): WorkspaceLabProvider {
  return new WorkspaceLabProvider({ root });
}

// --------------------------------------------------------------- path safety

describe('workspace path safety', () => {
  it('accepts the paths CI/CD labs actually use', () => {
    expect(assertSafeRelativePath('.github/workflows/ci.yml')).toBe('.github/workflows/ci.yml');
    expect(assertSafeRelativePath('Jenkinsfile')).toBe('Jenkinsfile');
    expect(assertSafeRelativePath('dist/statements.bundle.js')).toBe('dist/statements.bundle.js');
    expect(assertSafeRelativePath('./src/cli.mjs')).toBe('src/cli.mjs');
  });

  it('refuses traversal, absolute paths, and shell metacharacters', () => {
    for (const bad of [
      '../etc/passwd',
      '.github/../../etc/passwd',
      '/etc/passwd',
      'C:\\Windows\\system32',
      'file;rm -rf /',
      'a b/c',
      '$(whoami)',
      'src/../../..',
      '',
    ]) {
      expect(() => assertSafeRelativePath(bad), bad).toThrow(InvalidWorkspacePathError);
    }
  });

  it('reads nothing outside the workspace, even through a symlink', async () => {
    const outside = path.join(root, 'outside-secret.txt');
    await writeFile(outside, 'host secret material');

    const workspaceRoot = path.join(root, 'lab-0000000000aa');
    const provider = makeProvider();
    await provider.create(contextFor(registry.get(LAB_ID)));

    // The student can create the link — they have a shell in this directory.
    await symlink(outside, path.join(workspaceRoot, 'leak.txt'));

    const workspace = new FsWorkspace({ root: workspaceRoot });
    expect(await workspace.readText('leak.txt')).toBeNull();
    expect(await workspace.stat('leak.txt')).toBeNull();
    // ...and the file it points at is genuinely there, so the null above is
    // containment refusing to follow it and not the file being absent.
    expect(await readFile(outside, 'utf8')).toContain('host secret');
  });
});

// ------------------------------------------------------------ task allow-list

describe('workspace tasks', () => {
  it('refuses anything that is not an allow-listed task id', async () => {
    const provider = makeProvider();
    const context = contextFor(registry.get(LAB_ID));
    await provider.create(context);

    await expect(
      provider.execute(context, { command: 'bash', args: ['-c', 'echo hi'] }),
    ).rejects.toThrow(/not an allow-listed workspace task/);
    await expect(
      provider.execute(context, { command: 'node', args: ['-e', 'process.exit(0)'] }),
    ).rejects.toThrow(/not an allow-listed workspace task/);
  });

  it('refuses caller-supplied arguments even for a valid task', async () => {
    const provider = makeProvider();
    const context = contextFor(registry.get(LAB_ID));
    await provider.create(context);

    await expect(
      provider.execute(context, { command: 'app_test', args: ['--reporter=evil'] }),
    ).rejects.toThrow(/take no caller-supplied arguments/);
  });

  it('runs an allow-listed task inside the workspace', async () => {
    const provider = makeProvider();
    const context = contextFor(registry.get(LAB_ID));
    await provider.create(context);

    const result = await provider.execute(context, { command: 'node_version', args: [] });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^v\d+\./);
  });

  it('inherits nothing from the host process environment', async () => {
    const provider = makeProvider();
    const context = contextFor(registry.get(LAB_ID));
    await provider.create(context);
    const workspaceRoot = provider.workspacePath(context.namespace);

    // A task that prints the environment it was given. Written into the
    // workspace as a test file so `app_test` picks it up.
    await writeFile(
      path.join(workspaceRoot, 'env.test.mjs'),
      [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "test('no host secrets leak into a task', () => {",
        "  assert.equal(process.env.INTERNAL_SERVICE_SECRET, undefined);",
        "  assert.equal(process.env.TERMINAL_SESSION_SECRET, undefined);",
        "  assert.equal(process.env.KUBECONFIG, undefined);",
        "  assert.equal(process.env.CI, 'true');",
        '});',
        '',
      ].join('\n'),
    );

    process.env.INTERNAL_SERVICE_SECRET = 'must-not-leak';
    process.env.KUBECONFIG = '/etc/jumptotech/kubeconfig.yaml';
    try {
      const result = await provider.execute(context, { command: 'app_test', args: [] });
      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    } finally {
      delete process.env.INTERNAL_SERVICE_SECRET;
      delete process.env.KUBECONFIG;
    }
  });
});

// ------------------------------------------------------------------ lifecycle

describe('create() — a session workspace is created (story test 3)', () => {
  it('seeds the lab project into a private directory', async () => {
    const lab = registry.get(LAB_ID);
    const provider = makeProvider();
    const context = contextFor(lab);

    const result = await provider.create(context);

    expect(result.ok, JSON.stringify(result.steps)).toBe(true);
    expect(result.environment.phase).toBe('ready');
    expect(result.environment.provider).toBe('workspace');
    expect(result.steps.map((s) => s.id)).toEqual([
      'environment-created',
      'toolchain',
      'lab-initial-state',
    ]);

    const workspaceRoot = provider.workspacePath(context.namespace);
    expect((await stat(workspaceRoot)).isDirectory()).toBe(true);
    expect(await readdir(workspaceRoot)).toEqual(
      expect.arrayContaining(['README.md', 'build.mjs', 'package.json', 'src', 'test']),
    );
    // The seed is byte-identical to what the lab ships.
    const seeded = await readFile(path.join(workspaceRoot, 'src/statements.mjs'), 'utf8');
    const shipped = await readFile(path.join(lab.directory, 'workspace/src/statements.mjs'), 'utf8');
    expect(seeded).toBe(shipped);
  });

  it('keeps the platform ownership record out of the student workspace', async () => {
    const provider = makeProvider();
    const context = contextFor(registry.get(LAB_ID));
    await provider.create(context);

    const entries = await readdir(provider.workspacePath(context.namespace));
    expect(entries).not.toContain('meta.json');
    expect(entries.some((e) => e.includes('.index'))).toBe(false);
    // ...and the record does exist, just not where the student is working.
    expect(await readdir(path.join(root, '.index'))).toEqual([`${context.namespace}.json`]);
  });

  it('is idempotent — creating twice yields the baseline, not a failure', async () => {
    const provider = makeProvider();
    const context = contextFor(registry.get(LAB_ID));
    await provider.create(context);

    const workspaceRoot = provider.workspacePath(context.namespace);
    await writeFile(path.join(workspaceRoot, 'scratch.txt'), 'student work');

    const second = await provider.create(context);
    expect(second.ok).toBe(true);
    expect(await readdir(workspaceRoot)).not.toContain('scratch.txt');
  });

  it('refuses a namespace that is not a lab sandbox name', async () => {
    const provider = makeProvider();
    await expect(
      provider.create(contextFor(registry.get(LAB_ID), { namespace: 'default' })),
    ).rejects.toThrow(/Invalid lab namespace/);
  });
});

describe('reset() — restores the baseline (story test 13)', () => {
  it('removes student files and puts the lab project back', async () => {
    const provider = makeProvider();
    const context = contextFor(registry.get(LAB_ID));
    await provider.create(context);

    const workspaceRoot = provider.workspacePath(context.namespace);
    await writeFile(path.join(workspaceRoot, 'notes.md'), 'my working notes');
    await writeFile(path.join(workspaceRoot, 'README.md'), 'I overwrote the README');
    await rm(path.join(workspaceRoot, 'build.mjs'));

    const result = await provider.reset(context);

    expect(result.ok, JSON.stringify(result.steps)).toBe(true);
    expect(result.removed).toContain('notes.md');
    expect(result.restored).toContain('build.mjs');

    const entries = await readdir(workspaceRoot);
    expect(entries).not.toContain('notes.md');
    expect(entries).toContain('build.mjs');
    expect(await readFile(path.join(workspaceRoot, 'README.md'), 'utf8')).toContain(
      'jumptotech-statements',
    );
  });

  it('keeps the workspace directory itself, so the student keeps their shell', async () => {
    const provider = makeProvider();
    const context = contextFor(registry.get(LAB_ID));
    await provider.create(context);

    const before = await stat(provider.workspacePath(context.namespace));
    await provider.reset(context);
    const after = await stat(provider.workspacePath(context.namespace));

    expect(after.isDirectory()).toBe(true);
    expect(before.isDirectory()).toBe(true);
  });
});

describe('destroy() — the workspace is verifiably gone (story tests 14, 16)', () => {
  it('removes the directory and its ownership record', async () => {
    const provider = makeProvider();
    const context = contextFor(registry.get(LAB_ID));
    await provider.create(context);

    const result = await provider.destroy(context);

    expect(result.ok).toBe(true);
    expect(result.namespaceGone).toBe(true);
    expect(await stat(provider.workspacePath(context.namespace)).catch(() => null)).toBeNull();
    expect(await readdir(path.join(root, '.index'))).toEqual([]);
  });

  it('is idempotent — a second destroy is a success, not an error', async () => {
    const provider = makeProvider();
    const context = contextFor(registry.get(LAB_ID));
    await provider.create(context);

    const first = await provider.destroy(context);
    const second = await provider.destroy(context);
    const third = await provider.destroyNamespace(context.namespace);

    for (const result of [first, second, third]) {
      expect(result.ok).toBe(true);
      expect(result.namespaceGone).toBe(true);
    }
  });

  it('refuses a directory it has no ownership record for', async () => {
    const provider = makeProvider();
    // A directory with a plausible sandbox name that the platform never made.
    await writeFile(path.join(root, 'decoy.txt'), 'x');
    const impostor = path.join(root, 'lab-ffffffffffff');
    await rm(impostor, { recursive: true, force: true });
    await (await import('node:fs/promises')).mkdir(impostor);

    const result = await provider.destroyNamespace('lab-ffffffffffff');

    expect(result.ok).toBe(false);
    expect(result.namespaceGone).toBe(false);
    expect(result.error?.message).toMatch(/no JumpToTech ownership record/);
    expect((await stat(impostor)).isDirectory()).toBe(true);
  });

  it('refuses a name that is not shaped like a lab sandbox', async () => {
    const provider = makeProvider();
    for (const name of ['default', 'kube-system', '..', '.index', 'workspaces']) {
      const result = await provider.destroyNamespace(name);
      expect(result.ok, name).toBe(false);
      expect(result.error?.message, name).toMatch(/Refusing to delete workspace/);
    }
  });

  it('refuses to delete a workspace belonging to another session', async () => {
    const provider = makeProvider();
    const context = contextFor(registry.get(LAB_ID), { sessionId: 'sess-00000000000000aa' });
    await provider.create(context);

    const result = await provider.destroyNamespace(context.namespace, 'sess-00000000000000bb');

    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/different session/);
    expect((await stat(provider.workspacePath(context.namespace))).isDirectory()).toBe(true);
  });
});

// ---------------------------------------------------------------- credentials

describe('issueCredentials()', () => {
  it('hands the shell a workspace and no cluster credential at all', async () => {
    const provider = makeProvider();
    const context = contextFor(registry.get(LAB_ID));
    await provider.create(context);

    const credentials = await provider.issueCredentials(context);

    expect(credentials.kind).toBe('workspace');
    if (credentials.kind !== 'workspace') throw new Error('unreachable');
    expect(credentials.workspacePath).toBe(provider.workspacePath(context.namespace));
    expect(credentials.namespace).toBe(context.namespace);
    expect(credentials.environment).toMatchObject({ CI: 'true', JTT_LAB_ID: LAB_ID });
    expect(JSON.stringify(credentials)).not.toMatch(/kubeconfig|token|BEGIN [A-Z ]*PRIVATE KEY/i);
  });
});

// ------------------------------------------------------------- seed integrity

describe('workspace seeds', () => {
  it('every CI/CD lab ships a loadable seed', async () => {
    for (const lab of registry.list({ track: 'cicd' })) {
      const definition = registry.get(lab.id);
      const seed = await loadWorkspaceSeed(definition);
      expect(seed.length, lab.id).toBeGreaterThan(0);
      for (const file of seed) {
        expect(assertSafeRelativePath(file.path), `${lab.id} ${file.path}`).toBe(file.path);
      }
    }
  });
});

// --------------------------------------------------- five isolated sessions

describe('five simultaneous sessions (story test 17)', () => {
  interface Harness {
    manager: SessionManager;
    provider: WorkspaceLabProvider;
    clock: { now: number };
  }

  async function harness(): Promise<Harness> {
    const clock = { now: 1_700_000_000_000 };
    const provider = new WorkspaceLabProvider({ root, now: () => clock.now });
    const manager = new SessionManager({
      registry,
      provider,
      store: new InMemorySessionStore(),
      policy: DEFAULT_SESSION_POLICY,
      lifetimes: {
        maxSessionSeconds: 3_600,
        idleTimeoutSeconds: 1_200,
        warningSeconds: 300,
        maxActiveSessions: 20,
      },
      namespaceSecret: SECRET,
      now: () => clock.now,
    });
    return { manager, provider, clock };
  }

  /** The path a CICD-002 student creates. */
  const WORKFLOW = '.github/workflows/ci.yml';

  async function writeWorkflow(
    provider: WorkspaceLabProvider,
    session: LabSession,
    body: string,
  ): Promise<void> {
    const dir = path.join(provider.workspacePath(session.namespace), '.github/workflows');
    await (await import('node:fs/promises')).mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'ci.yml'), body);
  }

  it('gives every session its own workspace, and one student never sees another', async () => {
    const { manager, provider } = await harness();

    const sessions: LabSession[] = [];
    for (let i = 0; i < 5; i += 1) {
      const started = await manager.start(LAB_ID);
      sessions.push(started.session);
    }

    // Five distinct sessions, five distinct workspaces, five distinct paths.
    expect(new Set(sessions.map((s) => s.sessionId)).size).toBe(5);
    expect(new Set(sessions.map((s) => s.namespace)).size).toBe(5);
    const roots = sessions.map((s) => provider.workspacePath(s.namespace));
    expect(new Set(roots).size).toBe(5);

    // Each student writes a different workflow.
    for (const [i, session] of sessions.entries()) {
      await writeWorkflow(provider, session, `name: student-${i}\non: push\n`);
    }

    // Nobody sees anybody else's.
    for (const [i, session] of sessions.entries()) {
      const workspace = provider.workspaceFor(session.namespace);
      const text = await workspace.readText(WORKFLOW);
      expect(text, `session ${i}`).toContain(`name: student-${i}`);
      for (let other = 0; other < 5; other += 1) {
        if (other === i) continue;
        expect(text, `session ${i} must not see ${other}`).not.toContain(`student-${other}`);
      }
    }
  });

  it('reset affects only the session that asked for it', async () => {
    const { manager, provider } = await harness();
    const a = (await manager.start(LAB_ID)).session;
    const b = (await manager.start(LAB_ID)).session;

    await writeWorkflow(provider, a, 'name: A\non: push\n');
    await writeWorkflow(provider, b, 'name: B\non: push\n');

    await manager.reset(a.sessionId);

    expect(await provider.workspaceFor(a.namespace).readText(WORKFLOW)).toBeNull();
    expect(await provider.workspaceFor(b.namespace).readText(WORKFLOW)).toContain('name: B');
  });

  it('End Lab destroys one workspace and leaves the others operational', async () => {
    const { manager, provider } = await harness();
    const sessions: LabSession[] = [];
    for (let i = 0; i < 5; i += 1) sessions.push((await manager.start(LAB_ID)).session);

    const [first, ...rest] = sessions;
    if (!first) throw new Error('unreachable');
    for (const [i, session] of sessions.entries()) {
      await writeWorkflow(provider, session, `name: student-${i}\non: push\n`);
    }

    const ended = await manager.end(first.sessionId);

    expect(ended.destroy.namespaceGone).toBe(true);
    expect(ended.session.status).toBe('ENDED');
    expect(await stat(provider.workspacePath(first.namespace)).catch(() => null)).toBeNull();

    for (const [i, session] of rest.entries()) {
      const text = await provider.workspaceFor(session.namespace).readText(WORKFLOW);
      expect(text, `session ${i + 1} still operational`).toContain(`name: student-${i + 1}`);
      const status = await manager.status(session);
      expect(status.phase).toBe('ready');
    }
  });

  it('expiry destroys the workspace, and a repeated sweep changes nothing (story tests 15, 16)', async () => {
    const { manager, provider, clock } = await harness();
    const keep = (await manager.start(LAB_ID)).session;
    const doomed = (await manager.start(LAB_ID)).session;

    const reaper = new SessionReaper({
      sessions: manager,
      provider,
      intervalMs: 60_000,
      retentionMs: 0,
      now: () => clock.now,
      log: () => undefined,
    });

    // Past the absolute deadline of both, but only after one is ended by hand,
    // so the sweep has an expired session and a terminal one to reconcile.
    await manager.end(keep.sessionId);
    clock.now += 3_601_000;

    const first = await reaper.sweep();
    expect(first.removed).toContain(doomed.namespace);
    expect(await stat(provider.workspacePath(doomed.namespace)).catch(() => null)).toBeNull();

    // Idempotence: a second and third pass find nothing left to do and error
    // on nothing.
    const second = await reaper.sweep();
    const third = await reaper.sweep();
    expect(second.removed).toEqual([]);
    expect(second.errors).toEqual([]);
    expect(third.removed).toEqual([]);
    expect(third.errors).toEqual([]);
    expect(await readdir(root)).toEqual(['.index']);
    expect(await readdir(path.join(root, '.index'))).toEqual([]);
  });
});
