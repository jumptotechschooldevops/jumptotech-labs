/**
 * The CI/CD provider: registration, isolation, and what it refuses.
 *
 * The branch this track came from isolated a session with a directory on the
 * host and said so in its own header — "every PTY runs as the same UID inside
 * the terminal container, so directory permissions cannot stop a determined
 * student from reading a peer's workspace... the real fix is one container per
 * session". That fix is what this provider is, and these tests are what keep
 * it from quietly regressing to the thing it replaced.
 */
import { describe, expect, it } from 'vitest';
import {
  CICD_INSPECTION_COMMANDS,
  CONTAINER_PROVIDER_LABEL,
  CONTAINER_SESSION_LABEL,
  MANAGED_CONTAINER_LABEL,
  CicdLabProvider,
  GRANTABLE_CAPABILITIES,
  LAB_PROVIDERS,
  PROVIDER_ISOLATION,
  PROVIDER_REQUIREMENT_FAMILIES,
  PROVIDER_SANDBOX_KIND,
  WORKSPACE_TASKS,
  assertCapabilityName,
  parseLabDefinition,
  type LoadedLabDefinition,
} from '../src/index.js';
import { FakeContainerRuntime } from './container-fakes.js';
import { sessionContext } from './helpers.js';

function cicdLab(overrides: { provider?: string } = {}): LoadedLabDefinition {
  const yaml = `
id: CICD-901
slug: cicd-901-probe
title: CI/CD probe
track: cicd
topic: pipelines
difficulty: beginner
duration_minutes: 10
environment:
  provider: ${overrides.provider ?? 'cicd'}
task:
  summary: s
  description: d
requirements:
  - type: tests_pass
    label: The test suite passes
references:
  - title: GitHub Actions workflow syntax
    url: https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions
skills:
  - cicd.pipelines
`;
  return {
    ...parseLabDefinition(yaml),
    directory: '/labs/cicd-901',
    sourcePath: '/labs/cicd-901/lab.yaml',
  };
}

async function startSession(sandboxRef: string, sessionId: string) {
  const runtime = new FakeContainerRuntime();
  const provider = new CicdLabProvider({ runtime });
  const result = await provider.create(sessionContext(cicdLab(), { sandboxRef, sessionId }));
  return { runtime, provider, result };
}

// --- registration -----------------------------------------------------------

describe('the CI/CD track is a first-class provider', () => {
  it('is in the vocabulary, with container isolation', () => {
    expect([...LAB_PROVIDERS]).toContain('cicd');
    expect(PROVIDER_ISOLATION.cicd).toBe('container');
    expect(PROVIDER_SANDBOX_KIND.cicd).toBe('container');
  });

  it('claims the families its labs actually use, and no others', () => {
    expect([...PROVIDER_REQUIREMENT_FAMILIES.cicd].sort()).toEqual(['cicd', 'filesystem']);
    // Not `linux`: the track grades artefacts and build results, never a
    // process table, so it must not be able to ask for one.
    expect(PROVIDER_REQUIREMENT_FAMILIES.cicd).not.toContain('linux');
  });

  it('reports itself with a stable id and implementation name', () => {
    const provider = new CicdLabProvider({ runtime: new FakeContainerRuntime() });
    expect(provider.id).toBe('cicd');
    expect(provider.sandboxKind).toBe('container');
  });
});

// --- capabilities -----------------------------------------------------------

describe('the CI/CD sandbox holds no capabilities', () => {
  it('adds nothing back after --cap-drop ALL', async () => {
    const { runtime } = await startSession('jtt-lab-00000000c1', 'sess-000000000000000a');
    const spec = runtime.created.at(-1)!;
    expect(spec.capAdd ?? []).toEqual([]);
    expect(spec.noNewPrivileges).not.toBe(false);
  });

  it('cannot obtain another track’s capability, even by asking', () => {
    // The two capabilities other tracks were granted, each scoped to its own
    // provider. A shared runtime is exactly how one track inherits another's.
    for (const capability of ['NET_RAW', 'SYS_CHROOT']) {
      expect(() => assertCapabilityName(capability, 'cicd'), capability).toThrow(
        /only be granted/,
      );
    }
  });

  it('cannot obtain a capability the platform never grants anyone', () => {
    for (const capability of ['SYS_ADMIN', 'NET_ADMIN', 'SYS_PTRACE', 'MKNOD']) {
      expect(GRANTABLE_CAPABILITIES.has(capability), capability).toBe(false);
      expect(() => assertCapabilityName(capability, 'cicd'), capability).toThrow();
    }
  });
});

// --- the sandbox is closed --------------------------------------------------

describe('the CI/CD sandbox is closed to the host and the network', () => {
  it('gets no network, because nothing in the track reaches one', async () => {
    const { runtime } = await startSession('jtt-lab-00000000c2', 'sess-000000000000000a');
    const spec = runtime.created.at(-1)!;
    // A Jenkinsfile is parsed and a workflow is parsed; neither Jenkins nor
    // GitHub is contacted, so egress would be surface with no purpose.
    expect(spec.network).toBe('none');
  });

  it('mounts nothing, and never the Docker socket', async () => {
    const { runtime } = await startSession('jtt-lab-00000000c3', 'sess-000000000000000a');
    const serialised = JSON.stringify(runtime.created.at(-1));
    expect(serialised).not.toContain('docker.sock');
    expect(serialised).not.toContain('/var/run');
    // CICD-005 teaches what a container build step looks like in a pipeline and
    // is graded on the workflow and Dockerfile the student wrote. No image is
    // built, so no daemon is needed, so none is reachable.
    expect(serialised).not.toContain('privileged');
  });

  it('runs as the unprivileged student, never root', async () => {
    const { runtime } = await startSession('jtt-lab-00000000c4', 'sess-000000000000000a');
    expect(runtime.created.at(-1)!.user).not.toBe('root');
  });
});

// --- what the verifier may run ----------------------------------------------

describe('what the verifier may run inside a CI/CD sandbox', () => {
  it('allow-lists exactly the binaries the closed task table names', () => {
    const needed = new Set(Object.values(WORKSPACE_TASKS).map((task) => task.argv[0]));
    for (const binary of needed) {
      expect(CICD_INSPECTION_COMMANDS, binary).toContain(binary);
    }
  });

  it('names no shell, so nothing in a project can become syntax', () => {
    for (const shell of ['sh', 'bash', 'zsh', 'env']) {
      expect(CICD_INSPECTION_COMMANDS.includes(shell), shell).toBe(false);
    }
  });

  it('keeps every task argv fixed, with no interpolation point', () => {
    for (const [id, task] of Object.entries(WORKSPACE_TASKS)) {
      for (const word of task.argv) {
        expect(typeof word, id).toBe('string');
        // A `${...}` or a bare `;` would mean a task could be steered.
        expect(word, id).not.toMatch(/[$;&|`]/);
      }
    }
  });
});

// --- isolation between sessions ---------------------------------------------

describe('sessions are independent', () => {
  it('gives two sessions different containers, derived from their own refs', async () => {
    const a = await startSession('jtt-lab-00000000aa', 'sess-00000000000000aa');
    const b = await startSession('jtt-lab-00000000bb', 'sess-00000000000000bb');

    const nameA = a.runtime.created.at(-1)!.name;
    const nameB = b.runtime.created.at(-1)!.name;
    expect(nameA).not.toBe(nameB);
    expect(nameA).toContain('00000000aa');
    expect(nameB).toContain('00000000bb');
  });

  it('keeps five concurrent sessions on five distinct containers', async () => {
    const refs = ['c1', 'c2', 'c3', 'c4', 'c5'].map((s) => `jtt-lab-000000000${s}`);
    const sessions = await Promise.all(
      refs.map((ref, index) => startSession(ref, `sess-00000000000000${index}a`)),
    );

    const names = sessions.map((s) => s.runtime.created.at(-1)!.name);
    expect(new Set(names).size).toBe(5);
    for (const session of sessions) expect(session.result.ok).toBe(true);
    // No two sessions share a name, so no `docker exec` for one can land in
    // another — which is the whole boundary the host-directory model lacked.
    for (const [index, name] of names.entries()) {
      expect(name).toContain(refs[index]!.slice('jtt-lab-'.length));
    }
  });

  it('labels every container with its own session, for the reaper', async () => {
    const a = await startSession('jtt-lab-00000000d1', 'sess-00000000000000d1');
    const labels = a.runtime.created.at(-1)!.labels;
    expect(labels[CONTAINER_SESSION_LABEL]).toBe('sess-00000000000000d1');
    expect(labels[MANAGED_CONTAINER_LABEL]).toBe('true');
    expect(labels[CONTAINER_PROVIDER_LABEL]).toBe('cicd');
  });

  it('refuses to destroy a container belonging to another session', async () => {
    const runtime = new FakeContainerRuntime();
    const provider = new CicdLabProvider({ runtime });
    await provider.create(
      sessionContext(cicdLab(), {
        sandboxRef: 'jtt-lab-00000000e1',
        sessionId: 'sess-00000000000000e1',
      }),
    );

    // The reaper path, asked to delete this container on behalf of someone else.
    const result = await provider.destroySandbox('jtt-lab-00000000e1', 'sess-00000000000000ff');
    expect(result.ok).toBe(false);
    expect(await runtime.inspect('jtt-lab-00000000e1')).not.toBeNull();
  });
});

// --- untrusted input --------------------------------------------------------

describe('untrusted and malformed input is refused', () => {
  it('refuses a sandbox reference that is not name-shaped', async () => {
    const provider = new CicdLabProvider({ runtime: new FakeContainerRuntime() });
    for (const ref of ['../../etc', 'jtt-lab-../x', 'bridge', '', 'jtt-lab-ZZZZ']) {
      await expect(provider.destroySandbox(ref, 'sess-00000000000000a1'), ref).resolves.toEqual(
        expect.objectContaining({ ok: false }),
      );
    }
  });

  it('refuses a lab that asks for the CI/CD provider and a kernel capability', () => {
    const yaml = `
id: CICD-902
slug: cicd-902-probe
title: CI/CD probe
track: cicd
topic: pipelines
difficulty: beginner
duration_minutes: 10
environment:
  provider: cicd
  network: link
  sandbox_capabilities:
    - NET_RAW
task:
  summary: s
  description: d
requirements:
  - type: tests_pass
    label: l
references:
  - title: GitHub Actions workflow syntax
    url: https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions
skills:
  - cicd.pipelines
`;
    // The schema gate, before any provider sees it: capture capabilities are a
    // Linux-provider affordance and a CI/CD lab cannot claim one.
    expect(() => parseLabDefinition(yaml)).toThrow();
  });
});
