/**
 * Docker labs: grading and reset defects found by the 2026-09-21 lab product
 * audit, pinned so they stay closed. Real catalog, real provider, real
 * verifyLab, FakeDockerEngines as in docker-labs.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SESSION_POLICY,
  DockerLabProvider,
  InMemoryWorkspace,
  type LoadedLabDefinition,
} from '@jumptotech/lab-orchestrator';
import { FakeDockerEngines, containerSpec } from '@jumptotech/lab-orchestrator/testing';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';
import { verifyLab } from '../src/index.js';

const SANDBOX = 'jtt-lab-0000000000aa';
const SESSION = 'sess-000000000000000a';

async function started(labId: string) {
  const registry = await realCatalog();
  const lab = registry.get(labId);
  const engines = new FakeDockerEngines({ images: ['docker:27-dind'] });
  const workspace = new InMemoryWorkspace();
  const provider = new DockerLabProvider({ engines, workspace, sleep: async () => undefined });
  const context = {
    sessionId: SESSION,
    labId: lab.id,
    sandboxRef: SANDBOX,
    namespace: SANDBOX,
    serviceAccountName: DEFAULT_SESSION_POLICY.serviceAccountName,
    lab,
    expiresAtMs: Date.now() + 60 * 60_000,
    policy: DEFAULT_SESSION_POLICY,
  };
  const created = await provider.create(context);
  expect(created.ok).toBe(true);
  return { lab, workspace, provider, context, daemon: engines.daemon(SANDBOX) };
}

type Started = Awaited<ReturnType<typeof started>>;

async function failing({ lab, workspace, daemon }: Pick<Started, 'workspace' | 'daemon'> & { lab: LoadedLabDefinition }) {
  const result = await verifyLab({
    lab,
    namespace: SANDBOX,
    docker: daemon,
    workspace: { port: workspace, sessionId: SESSION },
  });
  expect(result.error).toBeUndefined();
  return result.checks.filter((c) => c.status !== 'pass').map((c) => c.label);
}

async function checkStatus(s: Pick<Started, 'workspace' | 'daemon'> & { lab: LoadedLabDefinition }, label: string) {
  const result = await verifyLab({ lab: s.lab, namespace: SANDBOX, docker: s.daemon, workspace: { port: s.workspace, sessionId: SESSION } });
  return result.checks.find((c) => c.label === label)?.status;
}

// ---------------------------------------------------------------- DOCKER-003
describe('DOCKER-003 — Reset Lab removes every name the student gave an image', () => {
  it('leaves neither the pulled image nor its new tag behind', async () => {
    const s = await started('DOCKER-003');
    // docker pull busybox:1.36 ; docker tag busybox:1.36 jumptotech/toolbox:1.0
    await s.daemon.pullImage('busybox:1.36');
    s.daemon.tagImage('busybox:1.36', 'jumptotech/toolbox:1.0');
    expect(await failing(s)).toEqual([]);

    const reset = await s.provider.reset(s.context);
    expect(reset.ok).toBe(true);

    // Before: only busybox:1.36 was untagged, and "jumptotech/toolbox:1.0
    // exists" still passed on the retry.
    const tags = (await s.daemon.listImages()).flatMap((i) => i.tags);
    expect(tags).not.toContain('busybox:1.36');
    expect(tags).not.toContain('jumptotech/toolbox:1.0');
    expect((await failing(s)).length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------- DOCKER-013
describe('DOCKER-013 — a rebuild replaces the source layer; a stacked build does not count', () => {
  const BASE = ['sha256:alpine', 'sha256:workdir'];
  const LABEL = 'The source-only rebuild reused the dependency layers';

  async function withImages(before: string[], after: string[]) {
    const s = await started('DOCKER-013');
    s.daemon.addImage('jumptotech/greeter:1.0', { layers: before });
    s.daemon.addImage('jumptotech/greeter:1.1', { layers: after });
    s.daemon.addContainer(containerSpec({ name: 'greeter', image: 'jumptotech/greeter:1.1', detach: false }), 'exited', 0);
    return s;
  }

  it('refuses 1.1 built FROM 1.0 plus one layer, with the cache-hostile Dockerfile unchanged', async () => {
    // Before: passed every check. `docker commit` gives the same layer shape.
    const hostile10 = [...BASE, 'sha256:all-v1', 'sha256:deps-1'];
    const s = await withImages(hostile10, [...hostile10, 'sha256:src-v2']);
    expect(await failing(s)).toEqual([LABEL]);
  });

  it('passes the layer check for a real source-only rebuild of a cache-friendly Dockerfile', async () => {
    const s = await withImages(
      [...BASE, 'sha256:deps-1', 'sha256:src-v1'],
      [...BASE, 'sha256:deps-1', 'sha256:src-v2'],
    );
    expect(await checkStatus(s, LABEL)).toBe('pass');
  });

  it('still refuses the cache-hostile ordering rebuilt normally', async () => {
    const s = await withImages(
      [...BASE, 'sha256:all-v1', 'sha256:deps-1'],
      [...BASE, 'sha256:all-v2', 'sha256:deps-2'],
    );
    expect(await failing(s)).toEqual([LABEL]);
  });
});

// ---------------------------------------------------------------- DOCKER-006
describe('DOCKER-006 — the two containers run the images the task names', () => {
  async function on(images: { api: string; worker: string }) {
    const s = await started('DOCKER-006');
    await s.daemon.createNetwork({ name: 'ledger-net' });
    s.daemon.addContainer(containerSpec({ name: 'ledger-api', image: images.api, network: 'ledger-net' }), 'running');
    s.daemon.addContainer(
      containerSpec({ name: 'ledger-worker', image: images.worker, command: ['sleep', '3600'], network: 'ledger-net' }),
      'running',
    );
    return failing(s);
  }

  it('passes nginx:1.27-alpine and alpine:3.20 on ledger-net', async () => {
    expect(await on({ api: 'nginx:1.27-alpine', worker: 'alpine:3.20' })).toEqual([]);
  });

  it('refuses ledger-api running alpine, which serves nothing at http://ledger-api', async () => {
    // Before: two alpine `sleep` containers on the network passed.
    expect(await on({ api: 'alpine:3.20', worker: 'alpine:3.20' })).toEqual(['ledger-api runs the nginx:1.27-alpine image']);
  });
});

// ---------------------------------------------------------------- DOCKER-008
describe('DOCKER-008 — the stack is the one Compose brought up', () => {
  const COMPOSE = (services: string) => `services:
  api:
    image: nginx:1.27-alpine
    container_name: ledger-api
    networks: [ledger-net]
${services}
networks:
  ledger-net:
    name: ledger-net
    driver: bridge
`;
  const WORKER = `  worker:
    image: alpine:3.20
    container_name: ledger-worker
    command: ["sleep", "infinity"]
    environment:
      LEDGER_API_URL: http://ledger-api
    networks: [ledger-net]
`;

  async function stack(file: string, labels: { api?: string; worker?: string }) {
    const s = await started('DOCKER-008');
    s.workspace.write(SESSION, 'compose.yaml', file);
    await s.daemon.createNetwork({ name: 'ledger-net' });
    const compose = (service?: string): Record<string, string> => (service ? { 'com.docker.compose.service': service } : {});
    s.daemon.addContainer(
      containerSpec({ name: 'ledger-api', image: 'nginx:1.27-alpine', network: 'ledger-net', labels: compose(labels.api) }),
      'running',
    );
    s.daemon.addContainer(
      containerSpec({
        name: 'ledger-worker',
        image: 'alpine:3.20',
        command: ['sleep', 'infinity'],
        network: 'ledger-net',
        env: { LEDGER_API_URL: 'http://ledger-api' },
        labels: compose(labels.worker),
      }),
      'running',
    );
    return failing(s);
  }

  it('passes the stack docker compose up created', async () => {
    expect(await stack(COMPOSE(WORKER), { api: 'api', worker: 'worker' })).toEqual([]);
  });

  it('refuses containers started by hand beside a file that only mentions ledger-worker in a comment', async () => {
    // Before: passed every check.
    expect(await stack(COMPOSE('  # TODO ledger-worker\n'), {})).toEqual([
      'Container ledger-api is running, started by Compose',
      'Container ledger-worker is running, started by Compose as the worker service',
    ]);
  });
});
