/**
 * PLATFORM-007 — the Docker provider proves ownership the same way as the rest.
 *
 * The Docker provider drives a `docker:dind` sandbox on the *host* daemon, so
 * its blast radius is the widest of any provider: a mistaken delete there takes
 * out a container that may belong to another session, another provider, or a
 * developer. Before this it proved ownership through the component label while
 * every container provider used the provider label — two mechanisms answering
 * one question, which is how they drift.
 *
 * The cast mirrors `sandbox-ownership.test.ts`, on one shared host daemon.
 */
import { describe, expect, it } from 'vitest';
import {
  COMPONENT_LABEL,
  DockerLabProvider,
  EXPIRES_AT_LABEL,
  LAB_LABEL,
  MANAGED_LABEL,
  PROVIDER_LABEL,
  SESSION_LABEL,
} from '../src/index.js';
import { FakeDockerEngines } from './docker-fakes.js';

const HOUR = 3_600_000;
const OURS = 'jtt-lab-aaaaaaaaaaaa';
const OTHER_SESSION = 'jtt-lab-bbbbbbbbbbbb';
const UNMANAGED = 'my-dev-redis';
const OTHER_PROVIDER = 'jtt-lab-dddddddddddd';
const LOOKALIKE = 'jtt-lab-eeeeeeeeeeee';

function engines() {
  return new FakeDockerEngines();
}

function provider(e: FakeDockerEngines) {
  return new DockerLabProvider({ engines: e, sandboxDaemonAvailable: true });
}

/** Put a container on the host daemon with exactly these labels. */
async function place(
  e: FakeDockerEngines,
  name: string,
  labels: Record<string, string>,
): Promise<void> {
  await e.host.runContainer({ name, image: 'x', labels } as never);
}

function dockerSandboxLabels(sessionId: string, expiresAtMs: number) {
  return {
    [MANAGED_LABEL]: 'true',
    [SESSION_LABEL]: sessionId,
    [LAB_LABEL]: 'DOCKER-001',
    [EXPIRES_AT_LABEL]: String(expiresAtMs),
    [COMPONENT_LABEL]: 'docker-sandbox',
    [PROVIDER_LABEL]: 'docker',
  };
}

async function populated() {
  const e = engines();
  const now = Date.now();
  await place(e, OURS, dockerSandboxLabels('sess-00000000000000aa', now + HOUR));
  await place(e, OTHER_SESSION, dockerSandboxLabels('sess-00000000000000bb', now + HOUR));
  await place(e, UNMANAGED, {});
  // Another provider's sandbox: managed, correctly labelled, simply not ours.
  await place(e, OTHER_PROVIDER, {
    [MANAGED_LABEL]: 'true',
    [SESSION_LABEL]: 'sess-00000000000000dd',
    [EXPIRES_AT_LABEL]: String(now + HOUR),
    [PROVIDER_LABEL]: 'linux',
  });
  // Our name shape, none of our metadata.
  await place(e, LOOKALIKE, {});
  return { e, provider: provider(e) };
}

const names = (e: FakeDockerEngines) =>
  [...e.host.containers.values()].map((c) => c.spec.name).sort();

describe('Docker sandbox discovery is proof-based', () => {
  it('returns only sandboxes this provider can prove are its own', async () => {
    const { provider: p } = await populated();

    const refs = (await p.listManagedSandboxes()).map((s) => s.sandboxRef).sort();

    expect(refs).toEqual([OURS, OTHER_SESSION].sort());
    expect(refs).not.toContain(UNMANAGED);
    expect(refs).not.toContain(OTHER_PROVIDER);
    expect(refs).not.toContain(LOOKALIKE);
  });

  it('stamps the provider label when it creates a sandbox', async () => {
    // The label has to be written, or filtering on it would quietly match
    // nothing and discovery would fall back to the component alone.
    const e = engines();
    const spec = { sessionId: 'sess-0000000000000abc', labId: 'DOCKER-001' };
    const labels = {
      [MANAGED_LABEL]: 'true',
      [SESSION_LABEL]: spec.sessionId,
      [COMPONENT_LABEL]: 'docker-sandbox',
      [PROVIDER_LABEL]: 'docker',
      [EXPIRES_AT_LABEL]: String(Date.now() + HOUR),
    };
    await place(e, OURS, labels);

    const found = await provider(e).listManagedSandboxes();
    expect(found[0]?.providerId).toBe('docker');
  });

  it('excludes a sandbox that carries our component but another provider’s label', async () => {
    /*
     * The case the provider label exists for, and the one the component label
     * alone could not decide. A container can legitimately carry
     * `component=docker-sandbox` — that is what the Docker provider stamps —
     * while belonging to a different provider entirely. Filtering on the
     * component alone would claim it; filtering on the provider does not.
     */
    const e = engines();
    await place(e, OTHER_PROVIDER, {
      [MANAGED_LABEL]: 'true',
      [SESSION_LABEL]: 'sess-00000000000000dd',
      [COMPONENT_LABEL]: 'docker-sandbox',
      [PROVIDER_LABEL]: 'linux',
      [EXPIRES_AT_LABEL]: String(Date.now() + HOUR),
    });

    const refs = (await provider(e).listManagedSandboxes()).map((s) => s.sandboxRef);
    expect(refs).toEqual([]);
  });

  it('still finds a sandbox created before the provider label existed', async () => {
    // Backward compatibility: an unlabelled provider defaults to this one, so a
    // sandbox from an older build stays reapable instead of leaking forever.
    const e = engines();
    await place(e, OURS, {
      [MANAGED_LABEL]: 'true',
      [SESSION_LABEL]: 'sess-0000000000000old',
      [COMPONENT_LABEL]: 'docker-sandbox',
      [EXPIRES_AT_LABEL]: String(Date.now() + HOUR),
    });

    const refs = (await provider(e).listManagedSandboxes()).map((s) => s.sandboxRef);
    expect(refs).toEqual([OURS]);
  });
});

describe('Docker destroy refuses everything it cannot prove', () => {
  it('refuses an unmanaged container and removes nothing', async () => {
    const { e, provider: p } = await populated();
    const before = names(e);

    const result = await p.destroySandbox(UNMANAGED);

    expect(result.ok).toBe(false);
    expect(names(e)).toEqual(before);
  });

  it('refuses a lookalike carrying our name shape and no metadata', async () => {
    const { e, provider: p } = await populated();
    const before = names(e);

    const result = await p.destroySandbox(LOOKALIKE);

    expect(result.ok).toBe(false);
    expect(names(e)).toEqual(before);
  });

  it('refuses another session’s sandbox when a session is named', async () => {
    const { e, provider: p } = await populated();
    const before = names(e);

    const result = await p.destroySandbox(OTHER_SESSION, 'sess-00000000000000aa');

    expect(result.ok).toBe(false);
    expect(result.error?.message ?? '').toMatch(/belongs to|not/i);
    expect(names(e)).toEqual(before);
  });

  it('refuses a container that is managed but not a Docker sandbox', async () => {
    const { e, provider: p } = await populated();
    const before = names(e);

    // Managed and correctly labelled — for another provider.
    const result = await p.destroySandbox(OTHER_PROVIDER);

    expect(result.ok).toBe(false);
    expect(names(e)).toEqual(before);
  });

  it('removes its own sandbox and leaves every other container standing', async () => {
    const { e, provider: p } = await populated();

    const result = await p.destroySandbox(OURS, 'sess-00000000000000aa');

    expect(result.ok, JSON.stringify(result.steps)).toBe(true);
    expect(names(e)).toEqual([OTHER_SESSION, UNMANAGED, OTHER_PROVIDER, LOOKALIKE].sort());
  });
});

describe('Docker ownership cannot be spoofed by partial metadata', () => {
  it('refuses every partial or malformed ownership shape', async () => {
    const now = Date.now();
    const cases: Array<[string, Record<string, string>]> = [
      ['no labels at all', {}],
      ['managed only', { [MANAGED_LABEL]: 'true' }],
      ['managed but wrong value', { [MANAGED_LABEL]: 'false', [COMPONENT_LABEL]: 'docker-sandbox' }],
      ['component without managed', { [COMPONENT_LABEL]: 'docker-sandbox' }],
      [
        'managed + wrong component',
        { [MANAGED_LABEL]: 'true', [COMPONENT_LABEL]: 'something-else' },
      ],
      [
        'every label but managed spelled wrong',
        {
          'jumptotech.io/manage': 'true',
          [SESSION_LABEL]: 'sess-00000000000000aa',
          [COMPONENT_LABEL]: 'docker-sandbox',
          [EXPIRES_AT_LABEL]: String(now + HOUR),
        },
      ],
    ];

    for (const [label, labels] of cases) {
      const e = engines();
      await place(e, LOOKALIKE, labels);
      const before = names(e);

      const result = await provider(e).destroySandbox(LOOKALIKE);

      expect(result.ok, label).toBe(false);
      expect(names(e), label).toEqual(before);
    }
  });
});

describe('ownership metadata is platform-controlled, not student-controlled', () => {
  it('a student labelling their own container cannot make it visible to the reaper', async () => {
    /*
     * The only party who could spoof these labels is one who can write to the
     * daemon the platform reads. A Docker-lab student is given a *nested*
     * daemon inside their own sandbox — `DOCKER_HOST=tcp://<sandbox>:2376` —
     * and every ownership decision is made against the host daemon, which they
     * never hold a handle to. So a student can label a container anything at
     * all and it stays inside their sandbox.
     */
    const e = engines();
    // A real sandbox, so the student has a real nested daemon to act on.
    await e.host.runContainer({
      name: OURS,
      image: 'docker:27-dind',
      labels: dockerSandboxLabels('sess-00000000000000aa', Date.now() + HOUR),
    } as never);
    const student = e.session(OURS);

    // The student does their worst: perfect ownership labels, on a container
    // named to look like somebody else's sandbox.
    await student.runContainer({
      name: OTHER_SESSION,
      image: 'x',
      labels: dockerSandboxLabels('sess-00000000000000bb', Date.now() - HOUR),
    } as never);

    // The platform's view of the world is unchanged: it reads the host daemon.
    const refs = (await provider(e).listManagedSandboxes()).map((s) => s.sandboxRef);
    expect(refs).toEqual([OURS]);
    expect(refs).not.toContain(OTHER_SESSION);

    // And the two daemons really are distinct, which is what makes that true.
    const hostNames = [...e.host.containers.values()].map((c) => c.spec.name);
    expect(hostNames).not.toContain(OTHER_SESSION);
  });
});
