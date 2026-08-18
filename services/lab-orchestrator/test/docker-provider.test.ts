/**
 * PLATFORM-DOCKER — the Docker lab provider.
 *
 * The Kubernetes provider's counterpart suite. It covers the five things a
 * `LabProvider` owes the session layer — create, status, reset, destroy, issue
 * credentials — plus the two the platform owes its operator: cleanup only ever
 * touches what it created, and a session's resource controls actually reach the
 * daemon.
 *
 * Everything here runs against `FakeDockerEngines`, which models the two-level
 * topology (host daemon → one isolated daemon per sandbox) but simulates no
 * kernel behaviour. The properties a fake cannot honestly establish — that
 * separate daemons and per-sandbox mutual TLS genuinely separate two students —
 * are asserted against a real daemon in `docker-integration.test.ts`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DockerLabProvider,
  InMemoryWorkspace,
  SANDBOX_LABELS,
  asTerminalContext,
  type TerminalContext,
  parseLabDefinition,
  type LabSessionContext,
  type LoadedLabDefinition,
} from '../src/index.js';
import { FakeDockerEngines } from './docker-fakes.js';
import { TEST_POLICY, loadDocker001, sessionContext } from './helpers.js';

/** The Docker variant of the terminal binding, or a loud failure. */
function asDockerContext(context: TerminalContext) {
  return asTerminalContext(context, 'docker-daemon');
}


// Container sandboxes carry the platform's own prefix — see
// `CONTAINER_SANDBOX_PATTERN`. A Docker sandbox is one, so these are the names
// the provider will actually be handed.
const SANDBOX_A = 'jtt-lab-0000000000aa';
const SANDBOX_B = 'jtt-lab-0000000000bb';

let docker001: LoadedLabDefinition;

beforeEach(async () => {
  docker001 = await loadDocker001();
});

/** A provider wired to a fresh fake host daemon, with a workspace attached. */
function build(options: { workspace?: InMemoryWorkspace } = {}) {
  const engines = new FakeDockerEngines({ images: ['docker:27-dind'] });
  const workspace = options.workspace ?? new InMemoryWorkspace();
  const provider = new DockerLabProvider({
    engines,
    workspace,
    // No real waiting: every test that cares about timing drives the clock.
    sleep: async () => undefined,
  });
  return { engines, workspace, provider };
}

function contextFor(
  lab: LoadedLabDefinition,
  overrides: Parameters<typeof sessionContext>[1] = {},
): LabSessionContext {
  return sessionContext(lab, { sandboxRef: SANDBOX_A, ...overrides });
}

/** A Docker lab definition built inline, for setup shapes no shipped lab uses. */
function dockerLab(extra: string): LoadedLabDefinition {
  const yaml = `
id: DOCKER-901
slug: docker-901-fixture
title: Fixture Lab
track: docker
topic: containers
difficulty: beginner
duration_minutes: 15
environment:
  provider: docker
  isolation: container
story: A fixture lab used only by the provider tests.
objectives:
  - Exercise the provider
task:
  summary: Do the thing.
  description: A longer description of the thing.
${extra}
requirements:
  - type: docker_container_exists
    name: web
    label: Container web exists
references:
  - title: Docker CLI reference
    url: https://docs.docker.com/reference/cli/docker/
skills:
  - docker.containers.run
hints:
  - level: 1
    text: Think about what a container is started from.
  - level: 2
    text: Consult the official Docker CLI reference.
`;
  return { ...parseLabDefinition(yaml), sourcePath: '<inline>' } as LoadedLabDefinition;
}

// ---------------------------------------------------------------- create

describe('docker provider — create', () => {
  it('provisions a sandbox and reports every step', async () => {
    const { provider, engines } = build();

    const result = await provider.create(contextFor(docker001));

    expect(result.ok).toBe(true);
    expect(result.environment.phase).toBe('ready');
    expect(result.environment.providerId).toBe('docker');
    expect(result.environment.provider).toBe('docker-sandbox');
    expect(result.environment.namespace).toBe(SANDBOX_A);
    expect(result.steps.map((s) => s.id)).toEqual([
      'sandbox-network',
      'environment-created',
      'docker-daemon',
      'lab-initial-state',
      'docker-cli',
    ]);
    expect(result.steps.every((s) => s.status === 'ok')).toBe(true);

    // The sandbox exists on the host daemon, and it brought its own daemon.
    expect(await engines.host.inspectContainer(SANDBOX_A)).not.toBeNull();
    expect(engines.daemon(SANDBOX_A)).toBeDefined();
  });

  it('names the environment so its owner survives the lab being edited', async () => {
    const { provider } = build();

    const id = provider.environmentId(contextFor(docker001));

    // `<provider>:<host>/<sandbox>#<lab>` — the leading segment is what lets a
    // session be torn down after its lab definition has changed or gone away.
    expect(id).toBe(`docker-sandbox:local/${SANDBOX_A}#DOCKER-001`);
  });

  it('applies the session resource controls to the sandbox container', async () => {
    const { provider, engines } = build();

    await provider.create(contextFor(docker001));
    const spec = engines.host.runs.find((r) => r.name === SANDBOX_A);

    // These three are the limits that actually bind a Docker session: every
    // container the student starts is a child of this one process tree.
    expect(spec).toMatchObject({
      image: TEST_POLICY.docker.image,
      memory: TEST_POLICY.docker.memory,
      cpus: TEST_POLICY.docker.cpus,
      pidsLimit: TEST_POLICY.docker.pidsLimit,
      network: TEST_POLICY.docker.network,
      privileged: true,
      hostname: SANDBOX_A,
      restartPolicy: `on-failure:${TEST_POLICY.docker.restartAttempts}`,
    });
  });

  it('gives the sandbox a dedicated volume for the inner image store', async () => {
    const { provider, engines } = build();

    await provider.create(contextFor(docker001));

    const volume = DockerLabProvider.dataVolume(SANDBOX_A);
    expect(await engines.host.inspectVolume(volume)).not.toBeNull();
    expect(engines.host.runs.find((r) => r.name === SANDBOX_A)?.volumes).toEqual([
      { volume, destination: '/var/lib/docker' },
    ]);
  });

  it('labels the sandbox so cleanup can recognise it later', async () => {
    const { provider, engines } = build();
    const context = contextFor(docker001, { expiresAtMs: 1_700_000_000_000 });

    await provider.create(context);
    const labels = (await engines.host.inspectContainer(SANDBOX_A))?.labels ?? {};

    expect(labels[SANDBOX_LABELS.managed]).toBe('true');
    expect(labels[SANDBOX_LABELS.session]).toBe(context.sessionId);
    expect(labels[SANDBOX_LABELS.lab]).toBe('DOCKER-001');
    expect(labels[SANDBOX_LABELS.expiresAt]).toBe('1700000000000');
  });

  it('builds the lab initial state inside the session daemon, not the host', async () => {
    const { provider, engines } = build();
    const lab = dockerLab(`
setup:
  docker:
    images:
      - alpine:3.20
    networks:
      - name: ledger-net
    volumes:
      - name: ledger-data
    containers:
      - name: ledger-api
        image: alpine:3.20
        command: [ "sleep", "3600" ]
        network: ledger-net
        state: running
  verify:
    - type: docker_container_running
      name: ledger-api
      label: ledger-api is running
`);

    const result = await provider.create(contextFor(lab));
    expect(result.ok).toBe(true);

    const session = engines.daemon(SANDBOX_A);
    expect(await session.inspectContainer('ledger-api')).toMatchObject({ running: true });
    expect(await session.inspectNetwork('ledger-net')).not.toBeNull();
    expect(await session.inspectVolume('ledger-data')).not.toBeNull();

    // The host daemon holds the sandbox and nothing else — a lab's initial
    // state can never reach the daemon the platform itself runs on.
    expect(await engines.host.inspectContainer('ledger-api')).toBeNull();
    expect(await engines.host.inspectNetwork('ledger-net')).toBeNull();
  });

  it('pre-pulls the images a lab needs rather than letting a run trigger one', async () => {
    const { provider, engines } = build();
    const lab = dockerLab(`
setup:
  docker:
    images:
      - alpine:3.20
    containers:
      - name: worker
        image: busybox:1.36
        command: [ "sleep", "60" ]
  verify:
    - type: docker_container_running
      name: worker
      label: worker is running
`);

    await provider.create(contextFor(lab));

    // Both the declared image and the one only a container mentions.
    expect(engines.daemon(SANDBOX_A).pulls).toEqual(['alpine:3.20', 'busybox:1.36']);
  });

  it('seeds workspace files a lab declares', async () => {
    const workspace = new InMemoryWorkspace();
    const { provider } = build({ workspace });
    const lab = dockerLab(`
setup:
  docker:
    files:
      - path: Dockerfile
        content: "FROM alpine:3.20\\n"
  verify:
    - type: workspace_file_exists
      path: Dockerfile
      label: Dockerfile exists
`);
    const context = contextFor(lab);

    await provider.create(context);

    expect(await workspace.read(context.sessionId, 'Dockerfile')).toBe('FROM alpine:3.20\n');
  });

  it('re-creating a sandbox re-initialises it rather than failing', async () => {
    const { provider, engines } = build();
    const context = contextFor(docker001);

    await provider.create(context);
    engines.daemon(SANDBOX_A).addContainer({ name: 'leftover', image: 'alpine', detach: true });

    const again = await provider.create(context);

    expect(again.ok).toBe(true);
    // A fresh daemon, so nothing the previous occupant made survives.
    expect(await engines.daemon(SANDBOX_A).inspectContainer('leftover')).toBeNull();
  });
});

// --------------------------------------------------------- create failures

describe('docker provider — create failures are classified, not swallowed', () => {
  it('reports a daemon that never comes up as an unreachable environment', async () => {
    const engines = new FakeDockerEngines();
    // No dind image match means no nested daemon, so the sandbox never answers.
    const provider = new DockerLabProvider({
      engines,
      sleep: async () => undefined,
      now: (() => {
        // Two reads per poll (deadline check and loop guard); jumping the clock
        // straight past the budget makes the timeout deterministic.
        let t = 0;
        return () => (t += 100_000);
      })(),
    });
    const context = contextFor(docker001, {
      policy: { ...TEST_POLICY, docker: { ...TEST_POLICY.docker, image: 'alpine:3.20' } },
    });

    const result = await provider.create(context);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('ENVIRONMENT_UNREACHABLE');
    expect(result.steps.find((s) => s.id === 'docker-daemon')?.status).toBe('failed');
    expect(result.error?.remediation).toMatch(/DOCKER_SANDBOX_READY_TIMEOUT_SECONDS/);
  });

  it('reports a host that refuses privileged containers with actionable remediation', async () => {
    const { provider, engines } = build();
    engines.host.failOn = { runContainer: 'privileged containers are not permitted on this host' };

    const result = await provider.create(contextFor(docker001));

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('PROVISION_FAILED');
    expect(result.error?.remediation).toMatch(/privileged containers/i);
    expect(result.environment.phase).toBe('error');
  });

  it('marks a lab whose declared state cannot be built as SETUP_FAILED and degraded', async () => {
    // An unreachable registry, the way a lab's image pull actually fails.
    const engines = new FakeDockerEngines({
      images: ['docker:27-dind'],
      sessionFailOn: { pullImage: 'failed to resolve reference: registry unreachable' },
    });
    const provider = new DockerLabProvider({ engines, sleep: async () => undefined });
    const lab = dockerLab(`
setup:
  docker:
    images:
      - nowhere.example/does-not-exist:1
  verify:
    - type: docker_image_exists
      image: nowhere.example/does-not-exist:1
      label: the image is present
`);

    const result = await provider.create(contextFor(lab));

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('SETUP_FAILED');
    // The message names the lab, so an operator knows which definition to fix.
    expect(result.error?.message).toMatch(/DOCKER-901/);
    expect(result.error?.remediation).toMatch(/setup\.docker/);
    // Degraded, not error: the sandbox itself is up and the student's terminal
    // would work — it is the lab's starting condition that is missing.
    expect(result.environment.phase).toBe('degraded');
    expect(result.steps.find((s) => s.id === 'lab-initial-state')?.status).toBe('failed');
  });
});

// ---------------------------------------------------------------- status

describe('docker provider — status', () => {
  it('reports a sandbox that was never created', async () => {
    const { provider } = build();

    const info = await provider.status(contextFor(docker001));

    expect(info.phase).toBe('not_created');
    expect(info.message).toContain(SANDBOX_A);
  });

  it('reports a stopped sandbox as degraded', async () => {
    const { provider, engines } = build();
    await provider.create(contextFor(docker001));
    await engines.host.stopContainer(SANDBOX_A);

    const info = await provider.status(contextFor(docker001));

    expect(info.phase).toBe('degraded');
    expect(info.message).toContain('exited');
  });

  it('reports a running sandbox whose daemon is not answering as degraded', async () => {
    const { provider, engines } = build();
    await provider.create(contextFor(docker001));
    engines.daemon(SANDBOX_A).unreachable = 'daemon restarting';

    const info = await provider.status(contextFor(docker001));

    // Container up ≠ daemon serving. A sandbox mid-restart must not read ready.
    expect(info.phase).toBe('degraded');
    expect(info.message).toMatch(/daemon not answering/);
  });

  it('reports a healthy sandbox as ready, with its engine version', async () => {
    const { provider } = build();
    await provider.create(contextFor(docker001));

    const info = await provider.status(contextFor(docker001));

    expect(info.phase).toBe('ready');
    expect(info.kubernetesVersion).toBe('27.3.1');
  });
});

// ----------------------------------------------------------------- reset

describe('docker provider — reset', () => {
  it('removes what the student made and keeps the sandbox itself', async () => {
    const { provider, engines } = build();
    const context = contextFor(docker001);
    await provider.create(context);

    const session = engines.daemon(SANDBOX_A);
    session.addContainer({ name: 'student-web', image: 'nginx:1.27-alpine', detach: true });
    await session.createVolume('student-data');
    await session.createNetwork({ name: 'student-net' });

    const result = await provider.reset(context);

    expect(result.ok).toBe(true);
    expect(result.removed).toEqual(
      expect.arrayContaining(['container/student-web', 'volume/student-data', 'network/student-net']),
    );
    expect(await session.inspectContainer('student-web')).toBeNull();
    expect(await session.inspectVolume('student-data')).toBeNull();
    expect(await session.inspectNetwork('student-net')).toBeNull();

    // The sandbox survives, so the session, its terminal, and its credentials do.
    expect(await engines.host.inspectContainer(SANDBOX_A)).not.toBeNull();
  });

  it('never removes the three networks Docker provides itself', async () => {
    const { provider, engines } = build();
    const context = contextFor(docker001);
    await provider.create(context);

    const result = await provider.reset(context);

    expect(result.ok).toBe(true);
    const remaining = (await engines.daemon(SANDBOX_A).listNetworks()).map((n) => n.name);
    expect(remaining).toEqual(expect.arrayContaining(['bridge', 'host', 'none']));
  });

  it("keeps the lab's own images by default, so a reset stays fast", async () => {
    const { provider, engines } = build();
    const context = contextFor(docker001);
    await provider.create(context);

    const session = engines.daemon(SANDBOX_A);
    session.addImage('student-built:1');

    await provider.reset(context);

    // DOCKER-001 declares `images: false`, so nothing is removed at all — the
    // lab's base image stays, and so does anything else in the store.
    expect((await session.listImages()).flatMap((i) => i.tags)).toContain('nginx:1.27-alpine');
  });

  it('removes student images but keeps the lab\'s when the lab opts in', async () => {
    const { provider, engines } = build();
    const lab = dockerLab(`
setup:
  docker:
    images:
      - alpine:3.20
  verify:
    - type: docker_image_exists
      image: alpine:3.20
      label: the image is present
reset:
  docker:
    images: true
`);
    const context = contextFor(lab);
    await provider.create(context);

    const session = engines.daemon(SANDBOX_A);
    session.addImage('student-built:1');

    const result = await provider.reset(context);

    const tags = (await session.listImages()).flatMap((i) => i.tags);
    expect(tags).toContain('alpine:3.20');
    expect(tags).not.toContain('student-built:1');
    expect(result.removed).toContain('image/student-built:1');
  });

  it('restores the workspace, discarding the student\'s edits', async () => {
    const workspace = new InMemoryWorkspace();
    const { provider } = build({ workspace });
    const lab = dockerLab(`
setup:
  docker:
    files:
      - path: Dockerfile
        content: "FROM alpine:3.20\\n"
  verify:
    - type: workspace_file_exists
      path: Dockerfile
      label: Dockerfile exists
`);
    const context = contextFor(lab);
    await provider.create(context);

    workspace.write(context.sessionId, 'Dockerfile', 'FROM broken\n');
    await provider.reset(context);

    expect(await workspace.read(context.sessionId, 'Dockerfile')).toBe('FROM alpine:3.20\n');
  });

  it('rebuilds the lab\'s initial state after purging', async () => {
    const { provider, engines } = build();
    const lab = dockerLab(`
setup:
  docker:
    images:
      - alpine:3.20
    containers:
      - name: ledger-api
        image: alpine:3.20
        command: [ "sleep", "3600" ]
        state: running
  verify:
    - type: docker_container_running
      name: ledger-api
      label: ledger-api is running
`);
    const context = contextFor(lab);
    await provider.create(context);

    const result = await provider.reset(context);

    expect(result.ok).toBe(true);
    expect(result.restored).toEqual(['container/ledger-api']);
    expect(await engines.daemon(SANDBOX_A).inspectContainer('ledger-api')).toMatchObject({
      running: true,
    });
  });

  it('reports a reset that could not finish rather than claiming success', async () => {
    const { provider, engines } = build();
    const context = contextFor(docker001);
    await provider.create(context);

    engines.daemon(SANDBOX_A).failOn = { removeContainer: 'device or resource busy' };
    engines.daemon(SANDBOX_A).addContainer({ name: 'stuck', image: 'alpine', detach: true });

    const result = await provider.reset(context);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('RESET_FAILED');
    expect(result.steps.find((s) => s.id === 'purge')?.status).toBe('failed');
  });
});

// --------------------------------------------------------------- destroy

describe('docker provider — destroy only ever removes what it created', () => {
  it('refuses a name that is not a lab sandbox', async () => {
    const { provider, engines } = build();
    engines.host.addContainer({ name: 'production-db', image: 'postgres:16', detach: true });

    const result = await provider.destroySandbox('production-db');

    expect(result.ok).toBe(false);
    expect(result.namespaceGone).toBe(false);
    expect(result.error?.message).toMatch(/not a JumpToTech lab sandbox name/);
    expect(await engines.host.inspectContainer('production-db')).not.toBeNull();
  });

  it('refuses a correctly-named container that carries no managed label', async () => {
    const { provider, engines } = build();
    // Right shape, wrong provenance: somebody else's container, named like ours.
    engines.host.addContainer({ name: SANDBOX_A, image: 'alpine', detach: true, labels: {} });

    const result = await provider.destroySandbox(SANDBOX_A);

    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/Refusing to delete sandbox/);
    expect(await engines.host.inspectContainer(SANDBOX_A)).not.toBeNull();
  });

  it('refuses when the session id does not match the sandbox\'s label', async () => {
    const { provider, engines } = build();
    await provider.create(contextFor(docker001));

    const result = await provider.destroySandbox(SANDBOX_A, 'sess-00000000000000ff');

    expect(result.ok).toBe(false);
    expect(await engines.host.inspectContainer(SANDBOX_A)).not.toBeNull();
  });

  it('removes the sandbox, its data volume, and its whole daemon', async () => {
    const { provider, engines } = build();
    const context = contextFor(docker001);
    await provider.create(context);
    engines.daemon(SANDBOX_A).addContainer({ name: 'student-web', image: 'nginx', detach: true });

    const result = await provider.destroy(context);

    expect(result.ok).toBe(true);
    expect(result.namespaceGone).toBe(true);
    expect(await engines.host.inspectContainer(SANDBOX_A)).toBeNull();
    expect(await engines.host.inspectVolume(DockerLabProvider.dataVolume(SANDBOX_A))).toBeNull();
    // Nothing has to enumerate the student's containers: they lived in a daemon
    // that no longer exists.
    expect(engines.host.daemonFor(SANDBOX_A)).toBeUndefined();
  });

  it('destroys the session workspace with the session', async () => {
    const workspace = new InMemoryWorkspace();
    const { provider } = build({ workspace });
    const lab = dockerLab(`
setup:
  docker:
    files:
      - path: Dockerfile
        content: "FROM alpine:3.20\\n"
  verify:
    - type: workspace_file_exists
      path: Dockerfile
      label: Dockerfile exists
`);
    const context = contextFor(lab);
    await provider.create(context);

    await provider.destroy(context);

    expect(await workspace.read(context.sessionId, 'Dockerfile')).toBeNull();
  });

  it('treats an already-absent sandbox as done, so teardown can be re-entered', async () => {
    const { provider } = build();

    const first = await provider.destroySandbox(SANDBOX_A);
    const second = await provider.destroySandbox(SANDBOX_A);

    for (const result of [first, second]) {
      expect(result.ok).toBe(true);
      expect(result.namespaceGone).toBe(true);
    }
  });

  it('sweeps the data volume even when the container is already gone', async () => {
    const { provider, engines } = build();
    await provider.create(contextFor(docker001));
    // A crash between the two removals would otherwise leak the volume forever.
    await engines.host.removeContainer(SANDBOX_A);

    await provider.destroySandbox(SANDBOX_A);

    expect(await engines.host.inspectVolume(DockerLabProvider.dataVolume(SANDBOX_A))).toBeNull();
  });
});

// ----------------------------------------------------------- credentials

describe('docker provider — student credentials', () => {
  it('issues certificates read from the sandbox that minted them', async () => {
    const { provider } = build();
    const context = contextFor(docker001);
    await provider.create(context);

    const credentials = asDockerContext(await provider.getTerminalContext(context));

    expect(credentials.kind).toBe('docker-daemon');
    expect(credentials.dockerHost).toBe(`tcp://${SANDBOX_A}:${TEST_POLICY.docker.daemonPort}`);
    expect(credentials.sandboxRef).toBe(SANDBOX_A);
    expect(credentials.ca).toContain('BEGIN CERTIFICATE');
    expect(credentials.clientCert).toContain('BEGIN CERTIFICATE');
    expect(credentials.clientKey).toContain('BEGIN PRIVATE KEY');
  });

  it('issues material that is distinct per sandbox', async () => {
    const { provider } = build();
    const a = contextFor(docker001);
    const b = contextFor(docker001, { sessionId: 'sess-000000000000000b', sandboxRef: SANDBOX_B });
    await provider.create(a);
    await provider.create(b);

    const credA = asDockerContext(await provider.getTerminalContext(a));
    const credB = asDockerContext(await provider.getTerminalContext(b));

    // Each sandbox generates its own CA at startup. That is what makes one
    // session's certificate cryptographically unusable against another's daemon,
    // rather than merely unauthorised — the real property is proved against a
    // live daemon in the integration suite.
    expect(credA.ca).not.toBe(credB.ca);
    expect(credA.clientKey).not.toBe(credB.clientKey);
    expect(credA.dockerHost).not.toBe(credB.dockerHost);
  });

  it('bounds the credential lifetime by the session deadline', async () => {
    const now = 1_000_000;
    const engines = new FakeDockerEngines({ images: ['docker:27-dind'] });
    const provider = new DockerLabProvider({ engines, sleep: async () => undefined, now: () => now });
    const context = contextFor(docker001, { expiresAtMs: now + 5 * 60_000 });

    await provider.create(context);
    const credentials = asDockerContext(await provider.getTerminalContext(context));

    // Five minutes left on the session, not the hour the policy would allow: a
    // credential must never outlive the sandbox it addresses.
    expect(Date.parse(credentials.expiresAt)).toBe(now + 5 * 60_000);
    expect(TEST_POLICY.credentialTtlSeconds).toBeGreaterThan(5 * 60);
  });

  it('carries the workspace baseline so the terminal can seed it', async () => {
    const { provider } = build();
    const lab = dockerLab(`
setup:
  docker:
    files:
      - path: Dockerfile
        content: "FROM alpine:3.20\\n"
  verify:
    - type: workspace_file_exists
      path: Dockerfile
      label: Dockerfile exists
`);
    const context = contextFor(lab);
    await provider.create(context);

    const credentials = asDockerContext(await provider.getTerminalContext(context));

    expect(credentials.workspaceFiles).toEqual([
      { path: 'Dockerfile', content: 'FROM alpine:3.20\n' },
    ]);
  });

  it('refuses to issue credentials for anything but a lab sandbox name', async () => {
    const { provider } = build();

    await expect(
      provider.getTerminalContext(contextFor(docker001, { sandboxRef: 'kube-system' })),
    ).rejects.toThrow(/Invalid sandbox reference/);
  });
});

// --------------------------------------------------------------- cleanup

describe('docker provider — cleanup discovery', () => {
  it('lists only sandboxes it labelled and named', async () => {
    const { provider, engines } = build();
    await provider.create(contextFor(docker001));
    // Somebody else's container, and a hand-labelled impostor with a bad name.
    engines.host.addContainer({ name: 'jenkins', image: 'jenkins:lts', detach: true });
    engines.host.addContainer({
      name: 'not-a-sandbox',
      image: 'alpine',
      detach: true,
      labels: { 'jumptotech.io/managed': 'true' },
    });

    const managed = await provider.listManagedSandboxes();

    expect(managed.map((m) => m.sandboxRef)).toEqual([SANDBOX_A]);
    expect(managed[0]).toMatchObject({ labId: 'DOCKER-001', phase: 'Active' });
    expect(managed[0]?.expiresAtMs).toBeGreaterThan(0);
  });

  /*
   * A Docker daemon is a flat namespace shared with everything else the
   * platform runs on that host, unlike a Kubernetes namespace which only ever
   * holds one session's objects. `lab-<hash>-control` is a well-formed `lab-…`
   * DNS label, so a per-session cluster node carrying the managed label would
   * satisfy every gate except the component one — and removing it would take
   * out a running cluster.
   */
  it("ignores another component's container, even when it is managed and lab-named", async () => {
    const { provider, engines } = build();
    await provider.create(contextFor(docker001));
    engines.host.addContainer({
      name: 'jtt-lab-0000000000cc',
      image: 'kindest/node:v1.34.0',
      detach: true,
      labels: {
        [SANDBOX_LABELS.managed]: 'true',
        [SANDBOX_LABELS.session]: 'sess-000000000000000c',
        [SANDBOX_LABELS.component]: 'kind-node',
      },
    });

    expect((await provider.listManagedSandboxes()).map((m) => m.sandboxRef)).toEqual([SANDBOX_A]);
  });

  it("refuses to destroy another component's container", async () => {
    const { provider, engines } = build();
    engines.host.addContainer({
      name: 'jtt-lab-0000000000cc',
      image: 'kindest/node:v1.34.0',
      detach: true,
      labels: {
        [SANDBOX_LABELS.managed]: 'true',
        [SANDBOX_LABELS.component]: 'kind-node',
      },
    });

    const result = await provider.destroySandbox('jtt-lab-0000000000cc');

    expect(result.ok).toBe(false);
    expect(result.namespaceGone).toBe(false);
    expect(result.error?.message).toContain(SANDBOX_LABELS.component);
    // Untouched.
    expect(await engines.host.inspectContainer('jtt-lab-0000000000cc')).not.toBeNull();
  });

  it('refuses to destroy a managed container carrying no component label at all', async () => {
    const { provider, engines } = build();
    engines.host.addContainer({
      name: 'jtt-lab-0000000000dd',
      image: 'alpine:3.20',
      detach: true,
      labels: { [SANDBOX_LABELS.managed]: 'true' },
    });

    const result = await provider.destroySandbox('jtt-lab-0000000000dd');

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('<unset>');
    expect(await engines.host.inspectContainer('jtt-lab-0000000000dd')).not.toBeNull();
  });

  it('still destroys a sandbox it created, which carries the component label', async () => {
    const { provider, engines } = build();
    const context = contextFor(docker001);
    await provider.create(context);

    const sandbox = await engines.host.inspectContainer(SANDBOX_A);
    expect(sandbox?.labels[SANDBOX_LABELS.component]).toBe(SANDBOX_LABELS.componentValue);

    const result = await provider.destroy(context);
    expect(result.ok).toBe(true);
    expect(result.namespaceGone).toBe(true);
  });
});

// --------------------------------------------------------------- execute

describe('docker provider — provider-side exec is allow-listed', () => {
  it('permits docker and nothing else', async () => {
    const { provider } = build();
    const context = contextFor(docker001);
    await provider.create(context);

    await expect(
      provider.execute(context, { command: 'sh', args: ['-c', 'echo hi'] }),
    ).rejects.toThrow(/not allow-listed/);
    await expect(provider.execute(context, { command: 'curl', args: ['x'] })).rejects.toThrow(
      /not allow-listed/,
    );

    const ok = await provider.execute(context, { command: 'docker', args: ['version'] });
    expect(ok.exitCode).toBe(0);
  });

  it('requires argv to be an array of strings, never a command line', async () => {
    const { provider } = build();
    const context = contextFor(docker001);
    await provider.create(context);

    await expect(
      provider.execute(context, {
        command: 'docker',
        args: 'ps; rm -rf /' as unknown as string[],
      }),
    ).rejects.toThrow(/array of strings/);
  });
});

// -------------------------------------------------------------- isolation

describe('docker provider — two sessions do not share a daemon', () => {
  it('gives each session its own container list', async () => {
    const { provider, engines } = build();
    const a = contextFor(docker001);
    const b = contextFor(docker001, { sessionId: 'sess-000000000000000b', sandboxRef: SANDBOX_B });
    await provider.create(a);
    await provider.create(b);

    engines.daemon(SANDBOX_A).addContainer({ name: 'web', image: 'nginx', detach: true });

    // Not a filtered view of one list — a different daemon with a different
    // store. `docker ps` in session B has nothing to filter out.
    expect((await engines.daemon(SANDBOX_A).listContainers()).map((c) => c.name)).toEqual(['web']);
    expect(await engines.daemon(SANDBOX_B).listContainers()).toEqual([]);
  });

  it('a reset in one session leaves the other untouched', async () => {
    const { provider, engines } = build();
    const a = contextFor(docker001);
    const b = contextFor(docker001, { sessionId: 'sess-000000000000000b', sandboxRef: SANDBOX_B });
    await provider.create(a);
    await provider.create(b);

    engines.daemon(SANDBOX_A).addContainer({ name: 'web', image: 'nginx', detach: true });
    engines.daemon(SANDBOX_B).addContainer({ name: 'web', image: 'nginx', detach: true });

    await provider.reset(a);

    expect(await engines.daemon(SANDBOX_A).inspectContainer('web')).toBeNull();
    expect(await engines.daemon(SANDBOX_B).inspectContainer('web')).not.toBeNull();
  });

  it('destroying one session leaves the other running', async () => {
    const { provider, engines } = build();
    const a = contextFor(docker001);
    const b = contextFor(docker001, { sessionId: 'sess-000000000000000b', sandboxRef: SANDBOX_B });
    await provider.create(a);
    await provider.create(b);

    await provider.destroy(a);

    expect(await engines.host.inspectContainer(SANDBOX_A)).toBeNull();
    expect(await engines.host.inspectContainer(SANDBOX_B)).not.toBeNull();
    expect((await provider.status(b)).phase).toBe('ready');
  });
});
