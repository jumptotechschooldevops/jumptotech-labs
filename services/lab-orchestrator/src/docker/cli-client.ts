/**
 * `DockerEnginePort` implemented over the Docker CLI.
 *
 * **Why the CLI and not a socket library.** The platform already reaches
 * Kubernetes by allow-listing `kubectl` with an explicit argv array
 * (`KindLabProvider.execute`), and the same discipline applies here: every
 * invocation below is `execFile('docker', [...])` with `shell: false`, so no
 * value — not a lab definition, not a session id, not anything from a request —
 * is ever interpolated into a command line. There is no code path in this file
 * that builds a string and hands it to a shell.
 *
 * **The two-daemon trick.** A session's containers live inside an isolated
 * daemon running in that session's sandbox container. Rather than give the
 * platform that daemon's TLS material, a session-scoped client simply prefixes
 * every invocation:
 *
 * ```text
 *   host client     docker <args>
 *   session client  docker exec <sandbox> docker <args>
 * ```
 *
 * The inner `docker` runs inside the sandbox and talks to that sandbox's own
 * daemon over its local socket. Consequences worth stating:
 *
 *   - the platform holds no session TLS key, so it cannot leak one;
 *   - a session daemon is not addressable from outside its sandbox at all,
 *     because reaching it requires the *host* daemon's exec privilege, which
 *     only the orchestrator has;
 *   - the sandbox name is validated as a lab sandbox name before it can become
 *     an argv element, so it cannot name an arbitrary container.
 */
import { execFile } from 'node:child_process';
import { isLabNamespace } from '../session/identifiers.js';
import {
  DockerCommandError,
  DockerUnreachableError,
  envListToMap,
  type DockerContainerSnapshot,
  type DockerContainerSummary,
  type CreateNetworkSpec,
  type DockerEngineFactory,
  type DockerEnginePort,
  type DockerExecResult,
  type DockerVersion,
  type DockerImageSnapshot,
  type DockerImageSummary,
  type DockerMountSnapshot,
  type DockerNetworkSnapshot,
  type DockerNetworkSummary,
  type DockerPortBindingSnapshot,
  type DockerResourceLimitsSnapshot,
  type RunContainerSpec,
  type DockerVolumeSnapshot,
  type DockerVolumeSummary,
} from './port.js';

const DEFAULT_TIMEOUT_MS = 30_000;
/** Pulls cross a network and are the one genuinely slow operation. */
const DEFAULT_PULL_TIMEOUT_MS = 300_000;
/** `docker inspect` output for a big image is comfortably under this. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export interface DockerCliOptions {
  /** Path to the CLI. Absolute in production images; `docker` resolves via PATH. */
  binary?: string;
  /** `DOCKER_HOST` for the host-level client. Unset means the default socket. */
  dockerHost?: string;
  defaultTimeoutMs?: number;
  /**
   * Argv inserted between the binary and the sub-command.
   *
   * Empty for the host daemon; `['exec', '<sandbox>', 'docker']` for a session
   * daemon. Never derived from untrusted input — see `DockerCliFactory`.
   */
  argvPrefix?: readonly string[];
  /** Injected in tests so no real process is spawned. */
  run?: CliRunner;
}

/** The one primitive everything else in this file is built from. */
export type CliRunner = (
  binary: string,
  argv: string[],
  options: { timeoutMs: number; env: NodeJS.ProcessEnv },
) => Promise<DockerExecResult>;

/** Spawn a process with an explicit argv array. Never a shell. */
export const execFileRunner: CliRunner = (binary, argv, options) =>
  new Promise<DockerExecResult>((resolve) => {
    execFile(
      binary,
      argv,
      {
        timeout: options.timeoutMs,
        env: options.env,
        maxBuffer: MAX_OUTPUT_BYTES,
        shell: false,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const killed = Boolean(error && (error as { killed?: boolean }).killed);
        const timedOut =
          killed || Boolean(error && (error as NodeJS.ErrnoException).code === 'ETIMEDOUT');
        let exitCode = 0;
        if (error) {
          const code = (error as { code?: unknown }).code;
          exitCode = typeof code === 'number' ? code : 1;
        }
        resolve({
          exitCode,
          stdout: String(stdout),
          stderr: String(stderr) || (error && exitCode !== 0 ? error.message : ''),
          timedOut,
        });
      },
    );
  });

/** Daemon-is-down signatures, as distinct from "the daemon said no". */
const UNREACHABLE_PATTERNS = [
  'cannot connect to the docker daemon',
  'is the docker daemon running',
  'error during connect',
  'connection refused',
  'no such host',
  'client version .* is too new',
  'permission denied while trying to connect to the docker daemon socket',
];

function looksUnreachable(stderr: string): boolean {
  const text = stderr.toLowerCase();
  return UNREACHABLE_PATTERNS.some((pattern) => new RegExp(pattern).test(text));
}

/**
 * "No such container/image/volume/network" — a miss, not a failure.
 *
 * The daemon does not phrase these consistently, and the difference matters:
 * an absence that is not recognised here is raised as a `DockerCommandError`,
 * which turns "the network you were asked to create is not there yet" into a
 * thrown verification run rather than a failing check the student can read.
 * Networks are the odd one out — `docker network inspect`/`rm` answer
 * `network <name> not found`, never `no such network` — so both spellings are
 * matched, and the real wording is pinned by `docker-integration.test.ts`.
 */
function looksAbsent(stderr: string): boolean {
  const text = stderr.toLowerCase();
  return (
    text.includes('no such container') ||
    text.includes('no such image') ||
    text.includes('no such volume') ||
    text.includes('no such network') ||
    text.includes('no such object') ||
    /network .+ not found/.test(text) ||
    /error: no such/.test(text)
  );
}

export class DockerCliClient implements DockerEnginePort {
  readonly #binary: string;
  readonly #prefix: readonly string[];
  readonly #timeoutMs: number;
  readonly #run: CliRunner;
  readonly #env: NodeJS.ProcessEnv;

  constructor(options: DockerCliOptions = {}) {
    this.#binary = options.binary ?? 'docker';
    this.#prefix = options.argvPrefix ?? [];
    this.#timeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#run = options.run ?? execFileRunner;
    this.#env = {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: process.env.HOME ?? '/tmp',
      // Interactive niceties would only corrupt machine-readable output.
      DOCKER_CLI_HINTS: 'false',
      ...(options.dockerHost ? { DOCKER_HOST: options.dockerHost } : {}),
    };
  }

  /** Run a docker sub-command, raising on failure. */
  async #docker(argv: string[], timeoutMs = this.#timeoutMs): Promise<string> {
    const result = await this.#tryDocker(argv, timeoutMs);
    if (result.exitCode !== 0) throw this.#toError(argv, result);
    return result.stdout;
  }

  /** Run a docker sub-command, returning the raw result for the caller to judge. */
  async #tryDocker(argv: string[], timeoutMs = this.#timeoutMs): Promise<DockerExecResult> {
    return this.#run(this.#binary, [...this.#prefix, ...argv], {
      timeoutMs,
      env: this.#env,
    });
  }

  #toError(argv: string[], result: DockerExecResult): Error {
    const stderr = result.stderr.trim();
    const what = `docker ${argv[0] ?? ''}`.trim();
    if (result.timedOut) {
      return new DockerUnreachableError(`${what} timed out after ${this.#timeoutMs}ms`);
    }
    if (looksUnreachable(stderr)) {
      return new DockerUnreachableError(`Docker daemon is unreachable: ${stderr || 'no detail'}`);
    }
    return new DockerCommandError(
      `${what} failed (exit ${result.exitCode}): ${stderr || 'no stderr'}`,
      result.exitCode,
      stderr,
    );
  }

  /**
   * `docker inspect`-style read that treats "not found" as `null`.
   *
   * Every absence in this file funnels through here, so a missing object can
   * never be mistaken for an unreachable daemon (or vice versa).
   */
  async #inspect<T>(argv: string[]): Promise<T | null> {
    const result = await this.#tryDocker(argv);
    if (result.exitCode !== 0) {
      if (looksAbsent(result.stderr)) return null;
      throw this.#toError(argv, result);
    }
    const trimmed = result.stdout.trim();
    if (trimmed.length === 0) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (cause) {
      throw new DockerCommandError(
        `docker ${argv[0] ?? 'inspect'} returned output that is not JSON`,
        0,
        String(cause),
      );
    }
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    return (first as T | undefined) ?? null;
  }

  /** Parse the newline-delimited JSON that `--format '{{json .}}'` produces. */
  #parseLines<T>(stdout: string): T[] {
    const out: T[] = [];
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        out.push(JSON.parse(trimmed) as T);
      } catch {
        /* a progress line or a warning; listings are strictly one JSON doc per line */
      }
    }
    return out;
  }

  // --- daemon ---------------------------------------------------------------

  async ping(): Promise<void> {
    const result = await this.#tryDocker(['version', '--format', '{{.Server.Version}}']);
    if (result.exitCode !== 0) {
      throw new DockerUnreachableError(
        `Docker daemon is unreachable: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
      );
    }
  }

  async version(): Promise<DockerVersion> {
    const raw = await this.#docker(['version', '--format', '{{json .}}']);
    const parsed = JSON.parse(raw.trim()) as {
      Client?: { Version?: string; Os?: string; Arch?: string };
      Server?: { Version?: string; ApiVersion?: string; Os?: string; Arch?: string };
    };
    return {
      clientVersion: parsed.Client?.Version ?? 'unknown',
      serverVersion: parsed.Server?.Version ?? 'unknown',
      ...(parsed.Server?.ApiVersion ? { apiVersion: parsed.Server.ApiVersion } : {}),
      ...(parsed.Server?.Os ? { os: parsed.Server.Os } : {}),
      ...(parsed.Server?.Arch ? { arch: parsed.Server.Arch } : {}),
    };
  }

  // --- containers -----------------------------------------------------------

  async inspectContainer(name: string): Promise<DockerContainerSnapshot | null> {
    const raw = await this.#inspect<RawContainer>(['container', 'inspect', name]);
    return raw ? toContainerSnapshot(raw) : null;
  }

  async listContainers(
    options: { all?: boolean; labelSelector?: string } = {},
  ): Promise<DockerContainerSummary[]> {
    const argv = ['container', 'ls', '--no-trunc', '--format', '{{json .}}'];
    if (options.all !== false) argv.push('--all');
    if (options.labelSelector) argv.push('--filter', `label=${options.labelSelector}`);

    const rows = this.#parseLines<{
      ID?: string;
      Names?: string;
      Image?: string;
      State?: string;
      Labels?: string;
    }>(await this.#docker(argv));

    return rows.map((row) => ({
      id: row.ID ?? '',
      // A container can carry several names when linked; the first is its own.
      name: (row.Names ?? '').split(',')[0]?.replace(/^\//, '') ?? '',
      image: row.Image ?? '',
      state: row.State ?? 'unknown',
      labels: parseLabelString(row.Labels),
    }));
  }

  async runContainer(spec: RunContainerSpec): Promise<string> {
    const argv = ['run'];
    if (spec.detach) argv.push('--detach');
    argv.push('--name', spec.name);
    if (spec.hostname) argv.push('--hostname', spec.hostname);
    if (spec.network) argv.push('--network', spec.network);
    if (spec.workingDir) argv.push('--workdir', spec.workingDir);
    if (spec.restartPolicy) argv.push('--restart', spec.restartPolicy);
    if (spec.privileged) argv.push('--privileged');
    if (spec.init) argv.push('--init');
    if (spec.readOnly) argv.push('--read-only');
    if (spec.memory) argv.push('--memory', spec.memory);
    if (spec.cpus) argv.push('--cpus', spec.cpus);
    if (spec.pidsLimit !== undefined) argv.push('--pids-limit', String(spec.pidsLimit));
    if (spec.entrypoint) argv.push('--entrypoint', spec.entrypoint.join(' '));

    for (const [key, value] of Object.entries(spec.env ?? {})) {
      argv.push('--env', `${key}=${value}`);
    }
    for (const [key, value] of Object.entries(spec.labels ?? {})) {
      argv.push('--label', `${key}=${value}`);
    }
    for (const mount of spec.volumes ?? []) {
      argv.push('--volume', `${mount.volume}:${mount.destination}${mount.readOnly ? ':ro' : ''}`);
    }
    for (const port of spec.ports ?? []) {
      const proto = port.protocol ?? 'tcp';
      argv.push(
        '--publish',
        port.hostPort === undefined
          ? `${port.containerPort}/${proto}`
          : `${port.hostPort}:${port.containerPort}/${proto}`,
      );
    }
    for (const opt of spec.storageOpts ?? []) argv.push('--storage-opt', opt);
    for (const target of spec.tmpfs ?? []) argv.push('--tmpfs', target);
    for (const opt of spec.securityOpts ?? []) argv.push('--security-opt', opt);
    for (const cap of spec.capDrop ?? []) argv.push('--cap-drop', cap);

    argv.push(spec.image);
    // Everything after the image is the container's own argv. `--` is not used
    // because Docker already stops parsing its own flags at the image name.
    if (spec.command) argv.push(...spec.command);
    if (spec.args) argv.push(...spec.args);

    const stdout = await this.#docker(argv, DEFAULT_PULL_TIMEOUT_MS);
    return stdout.trim();
  }

  async startContainer(name: string): Promise<void> {
    await this.#docker(['container', 'start', name]);
  }

  async stopContainer(name: string, timeoutSeconds = 10): Promise<void> {
    await this.#docker(['container', 'stop', '--time', String(timeoutSeconds), name], 60_000);
  }

  async removeContainer(
    name: string,
    options: { force?: boolean; volumes?: boolean } = {},
  ): Promise<void> {
    const argv = ['container', 'rm'];
    if (options.force !== false) argv.push('--force');
    if (options.volumes) argv.push('--volumes');
    argv.push(name);

    const result = await this.#tryDocker(argv, 120_000);
    // Removing something that is already gone is the desired end state, which
    // is what makes teardown safe to re-enter.
    if (result.exitCode !== 0 && !looksAbsent(result.stderr)) {
      throw this.#toError(argv, result);
    }
  }

  async containerLogs(name: string, tailLines = 50): Promise<string> {
    const result = await this.#tryDocker(['container', 'logs', '--tail', String(tailLines), name]);
    if (result.exitCode !== 0) return '';
    // Docker writes container stderr to our stderr; both are diagnostics here.
    return `${result.stdout}${result.stderr}`.trim();
  }

  async execInContainer(
    name: string,
    argv: string[],
    options: { timeoutMs?: number; user?: string; workingDir?: string } = {},
  ): Promise<DockerExecResult> {
    if (!Array.isArray(argv) || argv.some((a) => typeof a !== 'string')) {
      throw new TypeError('execInContainer requires argv to be an array of strings');
    }
    const full = ['exec'];
    if (options.user) full.push('--user', options.user);
    if (options.workingDir) full.push('--workdir', options.workingDir);
    full.push(name, ...argv);
    return this.#tryDocker(full, options.timeoutMs ?? this.#timeoutMs);
  }

  // --- images ---------------------------------------------------------------

  async inspectImage(reference: string): Promise<DockerImageSnapshot | null> {
    const raw = await this.#inspect<RawImage>(['image', 'inspect', reference]);
    return raw ? toImageSnapshot(raw) : null;
  }

  async listImages(): Promise<DockerImageSummary[]> {
    const rows = this.#parseLines<{ ID?: string; Repository?: string; Tag?: string; Size?: string }>(
      await this.#docker(['image', 'ls', '--no-trunc', '--format', '{{json .}}']),
    );

    // `docker image ls` emits one row per tag; fold them back into one image.
    const byId = new Map<string, DockerImageSummary>();
    for (const row of rows) {
      const id = row.ID ?? '';
      if (id.length === 0) continue;
      const entry = byId.get(id) ?? { id, tags: [], sizeBytes: 0 };
      if (row.Repository && row.Repository !== '<none>' && row.Tag && row.Tag !== '<none>') {
        entry.tags.push(`${row.Repository}:${row.Tag}`);
      }
      byId.set(id, entry);
    }
    return [...byId.values()];
  }

  async pullImage(reference: string, timeoutMs = DEFAULT_PULL_TIMEOUT_MS): Promise<void> {
    await this.#docker(['image', 'pull', reference], timeoutMs);
  }

  async removeImage(reference: string, force = true): Promise<void> {
    const argv = ['image', 'rm'];
    if (force) argv.push('--force');
    argv.push(reference);
    const result = await this.#tryDocker(argv, 60_000);
    if (result.exitCode !== 0 && !looksAbsent(result.stderr)) {
      // An image still referenced by a container is a normal, expected refusal
      // during reset; the container purge that precedes it decides the order.
      if (!result.stderr.toLowerCase().includes('is being used')) {
        throw this.#toError(argv, result);
      }
    }
  }

  // --- volumes --------------------------------------------------------------

  async inspectVolume(name: string): Promise<DockerVolumeSnapshot | null> {
    const raw = await this.#inspect<RawVolume>(['volume', 'inspect', name]);
    if (!raw) return null;
    return {
      name: raw.Name ?? name,
      driver: raw.Driver ?? 'local',
      mountpoint: raw.Mountpoint ?? '',
      labels: raw.Labels ?? {},
      scope: raw.Scope ?? 'local',
      ...(raw.CreatedAt ? { createdAt: raw.CreatedAt } : {}),
    };
  }

  async listVolumes(): Promise<DockerVolumeSummary[]> {
    const rows = this.#parseLines<{ Name?: string; Driver?: string; Labels?: string }>(
      await this.#docker(['volume', 'ls', '--format', '{{json .}}']),
    );
    return rows
      .filter((row) => Boolean(row.Name))
      .map((row) => ({
        name: row.Name ?? '',
        driver: row.Driver ?? 'local',
        labels: parseLabelString(row.Labels),
      }));
  }

  async createVolume(name: string, labels: Record<string, string> = {}): Promise<void> {
    const argv = ['volume', 'create'];
    for (const [key, value] of Object.entries(labels)) argv.push('--label', `${key}=${value}`);
    argv.push(name);
    await this.#docker(argv);
  }

  async removeVolume(name: string, force = true): Promise<void> {
    const argv = ['volume', 'rm'];
    if (force) argv.push('--force');
    argv.push(name);
    const result = await this.#tryDocker(argv);
    if (result.exitCode !== 0 && !looksAbsent(result.stderr)) {
      if (!result.stderr.toLowerCase().includes('volume is in use')) {
        throw this.#toError(argv, result);
      }
    }
  }

  // --- networks -------------------------------------------------------------

  async inspectNetwork(name: string): Promise<DockerNetworkSnapshot | null> {
    const raw = await this.#inspect<RawNetwork>(['network', 'inspect', name]);
    if (!raw) return null;
    return {
      id: raw.Id ?? '',
      name: raw.Name ?? name,
      driver: raw.Driver ?? '',
      scope: raw.Scope ?? 'local',
      internal: Boolean(raw.Internal),
      labels: raw.Labels ?? {},
      containers: Object.values(raw.Containers ?? {}).map((c) => c?.Name ?? ''),
      subnets: (raw.IPAM?.Config ?? []).map((entry) => entry?.Subnet ?? '').filter(Boolean),
    };
  }

  async listNetworks(): Promise<DockerNetworkSummary[]> {
    const rows = this.#parseLines<{ ID?: string; Name?: string; Driver?: string; Labels?: string }>(
      await this.#docker(['network', 'ls', '--no-trunc', '--format', '{{json .}}']),
    );
    return rows
      .filter((row) => Boolean(row.Name))
      .map((row) => ({
        id: row.ID ?? '',
        name: row.Name ?? '',
        driver: row.Driver ?? '',
        labels: parseLabelString(row.Labels),
      }));
  }

  async createNetwork(spec: CreateNetworkSpec): Promise<void> {
    const argv = ['network', 'create'];
    if (spec.driver) argv.push('--driver', spec.driver);
    if (spec.internal) argv.push('--internal');
    for (const [key, value] of Object.entries(spec.labels ?? {})) {
      argv.push('--label', `${key}=${value}`);
    }
    argv.push(spec.name);

    const result = await this.#tryDocker(argv);
    // Creating a network that already exists is the desired end state.
    if (result.exitCode !== 0 && !result.stderr.toLowerCase().includes('already exists')) {
      throw this.#toError(argv, result);
    }
  }

  async removeNetwork(name: string): Promise<void> {
    const result = await this.#tryDocker(['network', 'rm', name]);
    if (result.exitCode !== 0 && !looksAbsent(result.stderr)) {
      if (!result.stderr.toLowerCase().includes('has active endpoints')) {
        throw this.#toError(['network', 'rm'], result);
      }
    }
  }
}

/**
 * Host client plus session-scoped clients.
 *
 * `session()` is the only place a sandbox name becomes part of an argv, and it
 * validates that name against the lab-sandbox shape first. A caller that
 * somehow obtained an arbitrary container name cannot turn it into
 * `docker exec <that container> …` through this factory.
 */
export class DockerCliFactory implements DockerEngineFactory {
  readonly host: DockerEnginePort;
  readonly #options: DockerCliOptions;
  readonly #sessions = new Map<string, DockerEnginePort>();

  constructor(options: DockerCliOptions = {}) {
    this.#options = options;
    this.host = new DockerCliClient(options);
  }

  session(sandbox: string): DockerEnginePort {
    if (!isLabNamespace(sandbox)) {
      throw new Error(`Refusing to address '${sandbox}': not a JumpToTech lab sandbox name`);
    }
    const cached = this.#sessions.get(sandbox);
    if (cached) return cached;

    const client = new DockerCliClient({
      ...this.#options,
      // The inner `docker` runs inside the sandbox and reaches that sandbox's
      // own daemon over its local socket.
      argvPrefix: [...(this.#options.argvPrefix ?? []), 'exec', sandbox, 'docker'],
    });
    this.#sessions.set(sandbox, client);
    return client;
  }

  /** Drop a cached session client once its sandbox is gone. */
  forget(sandbox: string): void {
    this.#sessions.delete(sandbox);
  }
}

// --- raw `docker inspect` shapes -------------------------------------------
// Only the fields the platform actually reads are declared. Everything is
// optional: a snapshot must survive a daemon that omits a field.

interface RawContainer {
  Id?: string;
  Name?: string;
  Image?: string;
  Created?: string;
  Path?: string;
  Args?: string[];
  State?: {
    Status?: string;
    Running?: boolean;
    ExitCode?: number;
    Error?: string;
    StartedAt?: string;
    FinishedAt?: string;
  };
  Config?: {
    Image?: string;
    Env?: string[];
    Labels?: Record<string, string>;
    Cmd?: string[] | null;
    Entrypoint?: string[] | null;
    WorkingDir?: string;
  };
  HostConfig?: {
    RestartPolicy?: { Name?: string };
    Memory?: number;
    MemoryReservation?: number;
    NanoCpus?: number;
    CpuShares?: number;
    PidsLimit?: number | null;
  };
  Mounts?: Array<{
    Type?: string;
    Name?: string;
    Source?: string;
    Destination?: string;
    RW?: boolean;
  }>;
  NetworkSettings?: {
    Networks?: Record<string, unknown>;
    Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
  };
}

interface RawImage {
  Id?: string;
  RepoTags?: string[] | null;
  RepoDigests?: string[] | null;
  Created?: string;
  Size?: number;
  Architecture?: string;
  Os?: string;
  Config?: {
    Env?: string[] | null;
    Labels?: Record<string, string> | null;
    Cmd?: string[] | null;
    Entrypoint?: string[] | null;
    WorkingDir?: string;
    ExposedPorts?: Record<string, unknown> | null;
  };
}

interface RawVolume {
  Name?: string;
  Driver?: string;
  Mountpoint?: string;
  Labels?: Record<string, string>;
  Scope?: string;
  CreatedAt?: string;
}

interface RawNetwork {
  Id?: string;
  Name?: string;
  Driver?: string;
  Scope?: string;
  Internal?: boolean;
  Labels?: Record<string, string>;
  Containers?: Record<string, { Name?: string } | undefined>;
  IPAM?: { Config?: Array<{ Subnet?: string } | undefined> };
}

/** `docker ps --format` renders labels as `a=1,b=2`. */
function parseLabelString(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (raw ?? '').split(',')) {
    const trimmed = pair.trim();
    if (trimmed.length === 0) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return out;
}

export function toContainerSnapshot(raw: RawContainer): DockerContainerSnapshot {
  const ports: DockerPortBindingSnapshot[] = [];
  for (const [key, bindings] of Object.entries(raw.NetworkSettings?.Ports ?? {})) {
    const [portText, protocol = 'tcp'] = key.split('/');
    const containerPort = Number.parseInt(portText ?? '', 10);
    if (!Number.isFinite(containerPort)) continue;

    // A null binding list means EXPOSEd but not published; still worth
    // reporting so a lab can distinguish "exposed" from "published".
    if (!bindings || bindings.length === 0) {
      ports.push({ containerPort, protocol });
      continue;
    }
    for (const binding of bindings) {
      const hostPort = Number.parseInt(binding?.HostPort ?? '', 10);
      ports.push({
        containerPort,
        protocol,
        ...(Number.isFinite(hostPort) ? { hostPort } : {}),
        ...(binding?.HostIp ? { hostIp: binding.HostIp } : {}),
      });
    }
  }

  const mounts: DockerMountSnapshot[] = (raw.Mounts ?? []).map((mount) => ({
    type: mount.Type ?? 'bind',
    // Volume mounts carry `Name`; bind mounts carry only `Source`.
    source: mount.Name ?? mount.Source ?? '',
    destination: mount.Destination ?? '',
    readWrite: mount.RW !== false,
  }));

  const limits: DockerResourceLimitsSnapshot = {
    memoryBytes: raw.HostConfig?.Memory ?? 0,
    memoryReservationBytes: raw.HostConfig?.MemoryReservation ?? 0,
    nanoCpus: raw.HostConfig?.NanoCpus ?? 0,
    cpuShares: raw.HostConfig?.CpuShares ?? 0,
    pidsLimit: raw.HostConfig?.PidsLimit ?? 0,
  };

  const state = raw.State?.Status ?? 'unknown';
  return {
    id: raw.Id ?? '',
    name: (raw.Name ?? '').replace(/^\//, ''),
    image: raw.Config?.Image ?? '',
    imageId: raw.Image ?? '',
    state,
    running: raw.State?.Running ?? state === 'running',
    exitCode: raw.State?.ExitCode ?? 0,
    ...(raw.State?.Error ? { errorMessage: raw.State.Error } : {}),
    restartPolicy: raw.HostConfig?.RestartPolicy?.Name || 'no',
    env: envListToMap(raw.Config?.Env),
    labels: raw.Config?.Labels ?? {},
    networks: Object.keys(raw.NetworkSettings?.Networks ?? {}),
    ports,
    mounts,
    limits,
    command: raw.Config?.Cmd ?? [],
    entrypoint: raw.Config?.Entrypoint ?? [],
    workingDir: raw.Config?.WorkingDir ?? '',
    createdAt: raw.Created ?? '',
    ...(raw.State?.StartedAt ? { startedAt: raw.State.StartedAt } : {}),
    ...(raw.State?.FinishedAt ? { finishedAt: raw.State.FinishedAt } : {}),
  };
}

export function toImageSnapshot(raw: RawImage): DockerImageSnapshot {
  return {
    id: raw.Id ?? '',
    tags: (raw.RepoTags ?? []).filter((tag) => tag && tag !== '<none>:<none>'),
    digests: raw.RepoDigests ?? [],
    env: envListToMap(raw.Config?.Env),
    labels: raw.Config?.Labels ?? {},
    cmd: raw.Config?.Cmd ?? [],
    entrypoint: raw.Config?.Entrypoint ?? [],
    workingDir: raw.Config?.WorkingDir ?? '',
    exposedPorts: Object.keys(raw.Config?.ExposedPorts ?? {}),
    ...(raw.Architecture ? { architecture: raw.Architecture } : {}),
    ...(raw.Os ? { os: raw.Os } : {}),
    sizeBytes: raw.Size ?? 0,
    createdAt: raw.Created ?? '',
  };
}
