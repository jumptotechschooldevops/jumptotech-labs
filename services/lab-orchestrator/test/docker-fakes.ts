/**
 * Shared in-memory Docker fake.
 *
 * The Docker counterpart of `fakes.ts`, and it exists for the same reason and
 * with the same caveat. It implements the whole `DockerEnginePort` so that the
 * provider, the session lifecycle, the reaper, and every verifier handler can be
 * exercised without a daemon. What it deliberately does **not** simulate is the
 * one thing a fake cannot honestly prove: that separate daemons and mutual TLS
 * actually keep two sessions apart. That is asserted against a real Docker
 * daemon in `docker-integration.test.ts`.
 *
 * What it *does* model faithfully is the two-level topology the design rests on:
 *
 * ```text
 *   FakeDockerEngines.host          ← sandbox containers live here
 *        └── session('lab-…')       ← a SEPARATE daemon, created when the
 *                                      sandbox container is created
 * ```
 *
 * `session(sandbox)` returns a distinct `FakeDockerDaemon` per sandbox and
 * refuses to answer at all until that sandbox exists and is running — so a test
 * that forgets to create a sandbox fails the way production would, and a test
 * asserting isolation is asserting against genuinely separate object stores
 * rather than a filtered view of one.
 */
import {
  DockerUnreachableError,
  type CreateNetworkSpec,
  type DockerContainerSnapshot,
  type DockerContainerSummary,
  type DockerEngineFactory,
  type DockerEnginePort,
  type DockerExecResult,
  type DockerImageSnapshot,
  type DockerImageSummary,
  type DockerNetworkSnapshot,
  type DockerNetworkSummary,
  type DockerVersion,
  type DockerVolumeSnapshot,
  type DockerVolumeSummary,
  type RunContainerSpec,
} from '../src/index.js';

/** Where the dind image writes the TLS material it generates for itself. */
const CERT_DIR = '/certs/client';

export interface FakeDockerOptions {
  /** Client/server versions this daemon reports. */
  version?: Partial<DockerVersion>;
  /** Images present before anything runs, as `repository:tag`. */
  images?: string[];
  /** Networks present before anything runs. Bridge/host/none always exist. */
  networks?: string[];
  /** When set, every call rejects with `DockerUnreachableError`. */
  unreachable?: string;
  /** Sub-commands that should fail, keyed by operation name. */
  failOn?: Partial<Record<FakeDockerOperation, string>>;
  /** Marks this daemon as the platform's host daemon, which nests sandboxes. */
  isHost?: boolean;
  /**
   * Failures applied to every sandbox daemon this host creates.
   *
   * A session daemon does not exist until its sandbox is created, so a test that
   * needs one to misbehave has to say so before `create()` runs.
   */
  sessionFailOn?: Partial<Record<FakeDockerOperation, string>>;
}

export type FakeDockerOperation =
  | 'createNetwork'
  | 'createVolume'
  | 'runContainer'
  | 'removeContainer'
  | 'removeVolume'
  | 'removeNetwork'
  | 'removeImage'
  | 'pullImage'
  | 'execInContainer'
  | 'version';

interface FakeContainer {
  spec: RunContainerSpec;
  id: string;
  state: string;
  exitCode: number;
  /** Whether the kernel OOM-killed the last run. Never set by `runContainer`. */
  oomKilled?: boolean;
  createdAt: string;
  /** Files readable with `execInContainer(['cat', path])`. */
  files: Map<string, string>;
}

interface FakeImage {
  id: string;
  tags: string[];
  env: Record<string, string>;
  labels: Record<string, string>;
  cmd: string[];
  entrypoint: string[];
  workingDir: string;
  exposedPorts: string[];
}

let idCounter = 0;
const nextId = (prefix: string): string => `${prefix}${(idCounter += 1).toString(16).padStart(12, '0')}`;

/** Networks Docker itself provides. Present on every daemon, removable by none. */
const PREDEFINED_NETWORKS = ['bridge', 'host', 'none'];

export class FakeDockerDaemon implements DockerEnginePort {
  readonly containers = new Map<string, FakeContainer>();
  readonly images = new Map<string, FakeImage>();
  readonly volumes = new Map<string, { labels: Record<string, string>; driver: string }>();
  readonly networks = new Map<string, { id: string; driver: string; internal: boolean; labels: Record<string, string> }>();

  /** Observability for assertions: every container spec this daemon was asked to run. */
  readonly runs: RunContainerSpec[] = [];
  /** Every argv this daemon was asked to exec, as `<container>: <argv joined>`. */
  readonly execs: string[] = [];
  /** Images this daemon was asked to pull, in order. */
  readonly pulls: string[] = [];
  /** Names removed, as `<kind>/<name>`. */
  readonly removed: string[] = [];

  unreachable: string | undefined;
  failOn: Partial<Record<FakeDockerOperation, string>>;

  readonly #version: DockerVersion;
  readonly #isHost: boolean;
  readonly #sessionFailOn: Partial<Record<FakeDockerOperation, string>>;
  /** Sandbox name → the isolated daemon inside it. Only populated on a host. */
  readonly nested = new Map<string, FakeDockerDaemon>();

  constructor(options: FakeDockerOptions = {}) {
    this.#version = {
      clientVersion: '27.3.1',
      serverVersion: '27.3.1',
      apiVersion: '1.47',
      ...options.version,
    };
    this.#isHost = options.isHost ?? false;
    this.#sessionFailOn = { ...options.sessionFailOn };
    this.unreachable = options.unreachable;
    this.failOn = { ...options.failOn };

    for (const name of [...PREDEFINED_NETWORKS, ...(options.networks ?? [])]) {
      this.networks.set(name, {
        id: nextId('net'),
        driver: name === 'bridge' ? 'bridge' : name,
        internal: false,
        labels: {},
      });
    }
    for (const tag of options.images ?? []) this.addImage(tag);
  }

  // --- test helpers ---------------------------------------------------------

  /** Pretend an image is present, optionally with the config a lab grades. */
  addImage(tag: string, config: Partial<Omit<FakeImage, 'id' | 'tags'>> = {}): FakeImage {
    const image: FakeImage = {
      id: `sha256:${nextId('')}`,
      tags: [tag],
      env: config.env ?? {},
      labels: config.labels ?? {},
      cmd: config.cmd ?? [],
      entrypoint: config.entrypoint ?? [],
      workingDir: config.workingDir ?? '',
      exposedPorts: config.exposedPorts ?? [],
    };
    this.images.set(normalizeTag(tag), image);
    return image;
  }

  /** Pretend a container exists in whatever state a test needs. */
  addContainer(spec: RunContainerSpec, state = 'running', exitCode = 0, oomKilled = false): void {
    this.containers.set(spec.name, {
      spec,
      id: nextId('c'),
      state,
      exitCode,
      // Per-run, exactly as the daemon reports it: a test that wants a real
      // OOM says so, and every other way of reaching exit 137 leaves it false.
      oomKilled,
      createdAt: new Date(0).toISOString(),
      files: new Map(),
    });
  }

  /** The isolated daemon inside a sandbox this host created. */
  daemonFor(sandbox: string): FakeDockerDaemon | undefined {
    return this.nested.get(sandbox);
  }

  #guard(operation?: FakeDockerOperation): void {
    if (this.unreachable) throw new DockerUnreachableError(this.unreachable);
    if (operation && this.failOn[operation]) {
      throw new Error(this.failOn[operation] as string);
    }
  }

  // --- daemon ---------------------------------------------------------------

  async ping(): Promise<void> {
    this.#guard();
  }

  async version(): Promise<DockerVersion> {
    this.#guard('version');
    return this.#version;
  }

  // --- containers -----------------------------------------------------------

  async inspectContainer(name: string): Promise<DockerContainerSnapshot | null> {
    this.#guard();
    const found = this.containers.get(name);
    return found ? toSnapshot(found) : null;
  }

  async listContainers(
    options: { all?: boolean; labelSelector?: string } = {},
  ): Promise<DockerContainerSummary[]> {
    this.#guard();
    const [key, value] = (options.labelSelector ?? '').split('=');

    return [...this.containers.values()]
      .filter((c) => options.all !== false || c.state === 'running')
      .filter((c) => (key ? (c.spec.labels ?? {})[key] === value : true))
      .map((c) => ({
        id: c.id,
        name: c.spec.name,
        image: c.spec.image,
        state: c.state,
        labels: { ...(c.spec.labels ?? {}) },
      }));
  }

  async runContainer(spec: RunContainerSpec): Promise<string> {
    this.#guard('runContainer');
    this.runs.push(spec);

    const container: FakeContainer = {
      spec,
      id: nextId('c'),
      state: spec.detach ? 'running' : 'exited',
      exitCode: 0,
      createdAt: new Date(0).toISOString(),
      files: new Map(),
    };
    this.containers.set(spec.name, container);

    /*
     * A Docker-in-Docker container brings a whole daemon with it, and that is
     * the fact the whole design rests on — so the fake models it literally: a
     * *separate* object store, reachable only through this sandbox.
     */
    if (this.#isHost && /dind/.test(spec.image)) {
      this.nested.set(
        spec.name,
        new FakeDockerDaemon({ version: this.#version, failOn: this.#sessionFailOn }),
      );
      // The image mints its own CA at startup; that per-sandbox material is
      // exactly what makes one session's certificates useless against another.
      for (const [file, body] of [
        ['ca.pem', `-----BEGIN CERTIFICATE-----\nca-for-${spec.name}\n-----END CERTIFICATE-----\n`],
        ['cert.pem', `-----BEGIN CERTIFICATE-----\ncert-for-${spec.name}\n-----END CERTIFICATE-----\n`],
        ['key.pem', `-----BEGIN PRIVATE KEY-----\nkey-for-${spec.name}\n-----END PRIVATE KEY-----\n`],
      ] as const) {
        container.files.set(`${CERT_DIR}/${file}`, body);
      }
    }

    return container.id;
  }

  async startContainer(name: string): Promise<void> {
    this.#guard();
    const found = this.containers.get(name);
    if (found) found.state = 'running';
  }

  async stopContainer(name: string): Promise<void> {
    this.#guard();
    const found = this.containers.get(name);
    if (found) {
      found.state = 'exited';
      found.exitCode = 0;
    }
  }

  async removeContainer(name: string): Promise<void> {
    this.#guard('removeContainer');
    if (this.containers.delete(name)) this.removed.push(`container/${name}`);
    // A sandbox's daemon dies with the sandbox, which is what makes teardown
    // reclaim everything the student made without enumerating any of it.
    this.nested.delete(name);
  }

  async containerLogs(name: string): Promise<string> {
    this.#guard();
    return this.containers.has(name) ? `logs for ${name}` : '';
  }

  async execInContainer(name: string, argv: string[]): Promise<DockerExecResult> {
    this.#guard('execInContainer');
    this.execs.push(`${name}: ${argv.join(' ')}`);

    const container = this.containers.get(name);
    if (!container) {
      return { exitCode: 1, stdout: '', stderr: `Error: No such container: ${name}`, timedOut: false };
    }

    if (argv[0] === 'cat') {
      const body = container.files.get(argv[1] ?? '');
      return body === undefined
        ? { exitCode: 1, stdout: '', stderr: `cat: ${argv[1]}: No such file`, timedOut: false }
        : { exitCode: 0, stdout: body, stderr: '', timedOut: false };
    }

    // `docker …` inside a sandbox reaches that sandbox's own daemon. Only the
    // handful of sub-commands the platform actually issues this way are modelled.
    if (argv[0] === 'docker') {
      const nested = this.nested.get(name);
      if (!nested) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: 'Cannot connect to the Docker daemon',
          timedOut: false,
        };
      }
      if (argv[1] === 'version') {
        const v = await nested.version();
        return {
          exitCode: 0,
          stdout: `${argv.includes('{{.Client.Version}}') ? v.clientVersion : v.serverVersion}\n`,
          stderr: '',
          timedOut: false,
        };
      }
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    }

    return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
  }

  // --- images ---------------------------------------------------------------

  async inspectImage(reference: string): Promise<DockerImageSnapshot | null> {
    this.#guard();
    const found = this.images.get(normalizeTag(reference));
    if (!found) return null;
    return {
      id: found.id,
      tags: [...found.tags],
      digests: [],
      env: { ...found.env },
      labels: { ...found.labels },
      cmd: [...found.cmd],
      entrypoint: [...found.entrypoint],
      workingDir: found.workingDir,
      exposedPorts: [...found.exposedPorts],
      sizeBytes: 1_000_000,
      createdAt: new Date(0).toISOString(),
    };
  }

  async listImages(): Promise<DockerImageSummary[]> {
    this.#guard();
    const byId = new Map<string, DockerImageSummary>();
    for (const image of this.images.values()) {
      const entry = byId.get(image.id) ?? { id: image.id, tags: [], sizeBytes: 1_000_000 };
      for (const tag of image.tags) if (!entry.tags.includes(tag)) entry.tags.push(tag);
      byId.set(image.id, entry);
    }
    return [...byId.values()];
  }

  async pullImage(reference: string): Promise<void> {
    this.#guard('pullImage');
    this.pulls.push(reference);
    if (!this.images.has(normalizeTag(reference))) this.addImage(reference);
  }

  async removeImage(reference: string): Promise<void> {
    this.#guard('removeImage');
    const key = normalizeTag(reference);
    for (const [tag, image] of [...this.images.entries()]) {
      if (tag === key || image.id === reference) {
        this.images.delete(tag);
        this.removed.push(`image/${tag}`);
      }
    }
  }

  // --- volumes --------------------------------------------------------------

  async inspectVolume(name: string): Promise<DockerVolumeSnapshot | null> {
    this.#guard();
    const found = this.volumes.get(name);
    return found
      ? {
          name,
          driver: found.driver,
          mountpoint: `/var/lib/docker/volumes/${name}/_data`,
          labels: { ...found.labels },
          scope: 'local',
        }
      : null;
  }

  async listVolumes(): Promise<DockerVolumeSummary[]> {
    this.#guard();
    return [...this.volumes.entries()].map(([name, v]) => ({
      name,
      driver: v.driver,
      labels: { ...v.labels },
    }));
  }

  async createVolume(name: string, labels: Record<string, string> = {}): Promise<void> {
    this.#guard('createVolume');
    this.volumes.set(name, { labels, driver: 'local' });
  }

  async removeVolume(name: string): Promise<void> {
    this.#guard('removeVolume');
    if (this.volumes.delete(name)) this.removed.push(`volume/${name}`);
  }

  // --- networks -------------------------------------------------------------

  async inspectNetwork(name: string): Promise<DockerNetworkSnapshot | null> {
    this.#guard();
    const found = this.networks.get(name);
    if (!found) return null;
    return {
      id: found.id,
      name,
      driver: found.driver,
      scope: 'local',
      internal: found.internal,
      labels: { ...found.labels },
      containers: [...this.containers.values()]
        .filter((c) => c.spec.network === name)
        .map((c) => c.spec.name),
      subnets: ['172.20.0.0/16'],
    };
  }

  async listNetworks(): Promise<DockerNetworkSummary[]> {
    this.#guard();
    return [...this.networks.entries()].map(([name, n]) => ({
      id: n.id,
      name,
      driver: n.driver,
      labels: { ...n.labels },
    }));
  }

  async createNetwork(spec: CreateNetworkSpec): Promise<void> {
    this.#guard('createNetwork');
    if (this.networks.has(spec.name)) return;
    this.networks.set(spec.name, {
      id: nextId('net'),
      driver: spec.driver ?? 'bridge',
      internal: spec.internal ?? false,
      labels: spec.labels ?? {},
    });
  }

  async removeNetwork(name: string): Promise<void> {
    this.#guard('removeNetwork');
    if (PREDEFINED_NETWORKS.includes(name)) {
      throw new Error(`${name} is a pre-defined network and cannot be removed`);
    }
    if (this.networks.delete(name)) this.removed.push(`network/${name}`);
  }
}

/**
 * Host daemon plus one isolated daemon per sandbox.
 *
 * `session()` refuses a sandbox that does not exist or is not running, exactly
 * as the real client would: reaching a session daemon means executing inside its
 * sandbox, and there is nothing to execute in until the sandbox is up.
 */
export class FakeDockerEngines implements DockerEngineFactory {
  readonly host: FakeDockerDaemon;

  constructor(options: Omit<FakeDockerOptions, 'isHost'> = {}) {
    this.host = new FakeDockerDaemon({ ...options, isHost: true });
  }

  session(sandbox: string): DockerEnginePort {
    const nested = this.host.daemonFor(sandbox);
    if (!nested) {
      // Modelled as unreachable rather than empty on purpose: a missing sandbox
      // must never look like a session whose containers happen to be gone.
      return unreachableDaemon(`sandbox ${sandbox} has no running daemon`);
    }
    return nested;
  }

  /** The isolated daemon inside a sandbox, for assertions. */
  daemon(sandbox: string): FakeDockerDaemon {
    const nested = this.host.daemonFor(sandbox);
    if (!nested) throw new Error(`no sandbox named '${sandbox}' has been created`);
    return nested;
  }
}

/** A port that reports the daemon is down, whatever is asked of it. */
function unreachableDaemon(reason: string): DockerEnginePort {
  const daemon = new FakeDockerDaemon();
  daemon.unreachable = reason;
  return daemon;
}

/** `alpine` and `alpine:latest` are the same image. */
function normalizeTag(reference: string): string {
  if (reference.includes('@') || reference.includes(':')) return reference;
  return `${reference}:latest`;
}

/** Bytes for a Docker memory string such as `512m`. */
export function fakeMemoryBytes(value: string | undefined): number {
  if (!value) return 0;
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*([bkmg]?)b?$/i.exec(value.trim());
  if (!match) return 0;
  const scale: Record<string, number> = { '': 1, b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };
  return Math.round(Number(match[1]) * (scale[(match[2] ?? '').toLowerCase()] ?? 1));
}

function toSnapshot(container: FakeContainer): DockerContainerSnapshot {
  const spec = container.spec;
  return {
    id: container.id,
    name: spec.name,
    image: spec.image,
    imageId: `sha256:image-${spec.image}`,
    state: container.state,
    running: container.state === 'running',
    exitCode: container.exitCode,
    oomKilled: container.oomKilled ?? false,
    restartPolicy: spec.restartPolicy ?? 'no',
    env: { ...(spec.env ?? {}) },
    labels: { ...(spec.labels ?? {}) },
    networks: spec.network ? [spec.network] : ['bridge'],
    ports: (spec.ports ?? []).map((p) => ({
      containerPort: p.containerPort,
      protocol: p.protocol ?? 'tcp',
      ...(p.hostPort !== undefined ? { hostPort: p.hostPort } : {}),
    })),
    mounts: (spec.volumes ?? []).map((v) => ({
      type: 'volume',
      source: v.volume,
      destination: v.destination,
      readWrite: !v.readOnly,
    })),
    limits: {
      memoryBytes: fakeMemoryBytes(spec.memory),
      memoryReservationBytes: 0,
      nanoCpus: spec.cpus ? Math.round(Number(spec.cpus) * 1e9) : 0,
      cpuShares: 0,
      pidsLimit: spec.pidsLimit ?? 0,
    },
    command: spec.command ?? [],
    entrypoint: spec.entrypoint ?? [],
    workingDir: spec.workingDir ?? '',
    createdAt: container.createdAt,
  };
}

/** Convenience builder for a container spec, so tests state only what they mean. */
export function containerSpec(overrides: Partial<RunContainerSpec> = {}): RunContainerSpec {
  return {
    name: 'web',
    image: 'nginx:1.27-alpine',
    detach: true,
    ...overrides,
  };
}
