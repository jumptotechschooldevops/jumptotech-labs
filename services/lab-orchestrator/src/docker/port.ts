/**
 * The narrow Docker surface the lab engine needs.
 *
 * This is the Docker counterpart of `k8s/port.ts`, and it exists for the same
 * reason: defining a port rather than passing a Docker client around means the
 * provider, the session lifecycle, the cleanup reaper, and the verifier
 * registry can all be unit-tested against an in-memory fake, while production
 * code talks to a real daemon.
 *
 * **Two daemons, one interface.** The platform speaks to two different Docker
 * daemons through this same port:
 *
 * ```text
 *   host daemon      ← creates / destroys the per-session sandbox containers
 *   session daemon   ← the isolated daemon INSIDE one sandbox; holds the
 *                      student's containers, images, volumes and networks
 * ```
 *
 * A session daemon is reached by executing the Docker CLI *inside* that
 * session's sandbox container, so the platform never needs the session's TLS
 * material and a session daemon can never be addressed by name from outside its
 * own sandbox. See `cli-client.ts`.
 *
 * Every reader below returns a *snapshot*: a normalised, minimal view. Verifier
 * handlers reason about snapshots only, so they cannot accidentally depend on
 * the shape of `docker inspect` output.
 */

/** Client and server versions reported by a daemon. */
export interface DockerVersion {
  clientVersion: string;
  serverVersion: string;
  apiVersion?: string;
  os?: string;
  arch?: string;
}

/** One published port mapping on a container. */
export interface DockerPortBindingSnapshot {
  /** Port inside the container. */
  containerPort: number;
  /** `tcp` | `udp` | `sctp`. */
  protocol: string;
  /** Port on the daemon's host side. Absent when the port is exposed but unpublished. */
  hostPort?: number;
  hostIp?: string;
}

/** One filesystem mount attached to a container. */
export interface DockerMountSnapshot {
  /** `volume` | `bind` | `tmpfs`. */
  type: string;
  /** Volume name for `volume` mounts; host path for `bind` mounts. */
  source: string;
  /** Path inside the container. */
  destination: string;
  readWrite: boolean;
}

/**
 * Resource controls actually applied to a container.
 *
 * Read from the container's HostConfig — what the daemon enforces — rather
 * than from anything the student typed, which is what a resource-limits lab has
 * to grade.
 */
export interface DockerResourceLimitsSnapshot {
  /** `--memory`, in bytes. 0 means unlimited. */
  memoryBytes: number;
  /** `--memory-reservation`, in bytes. 0 when unset. */
  memoryReservationBytes: number;
  /** `--cpus` expressed as NanoCPUs (1 CPU = 1e9). 0 when unset. */
  nanoCpus: number;
  /** `--cpu-shares`. 0 when unset. */
  cpuShares: number;
  /** `--pids-limit`. 0 or absent means unlimited. */
  pidsLimit: number;
}

export interface DockerContainerSnapshot {
  id: string;
  /** Container name without the leading slash Docker stores it with. */
  name: string;
  /** Image reference as requested when the container was created. */
  image: string;
  /** Resolved image id (`sha256:…`), which survives a retag. */
  imageId: string;
  /** `created` | `running` | `paused` | `restarting` | `removing` | `exited` | `dead`. */
  state: string;
  running: boolean;
  /** Exit code of the last run. 0 while the container has never exited. */
  exitCode: number;
  /**
   * True when the kernel's OOM killer stopped the container's **last run**.
   *
   * This is the daemon's own report of a cgroup memory-limit kill, and it is
   * the only field that distinguishes one from an ordinary SIGKILL: `docker
   * kill`, a `docker stop` that escalates past its grace period, and an
   * application that exits 137 on its own all produce exit code 137 with this
   * flag `false`. Exit code alone proves nothing.
   *
   * Per-run, not cumulative: a container that was OOM-killed and is then
   * started again reports `false` for the new run.
   */
  oomKilled: boolean;
  /** Set when the container stopped because of an error. */
  errorMessage?: string;
  /** `--restart` policy name, e.g. `no`, `always`, `on-failure`. */
  restartPolicy: string;
  /** Full environment as the daemon holds it, split into key/value. */
  env: Record<string, string>;
  labels: Record<string, string>;
  /** Networks the container is attached to, by network name. */
  networks: string[];
  ports: DockerPortBindingSnapshot[];
  mounts: DockerMountSnapshot[];
  limits: DockerResourceLimitsSnapshot;
  /** Entrypoint + command as the daemon resolved them. */
  command: string[];
  entrypoint: string[];
  workingDir: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

/** A container as it appears in a listing — cheap fields only. */
export interface DockerContainerSummary {
  id: string;
  name: string;
  image: string;
  state: string;
  labels: Record<string, string>;
}

export interface DockerImageSnapshot {
  id: string;
  /** Every `repository:tag` pointing at this image. */
  tags: string[];
  /** Every `repository@sha256:…` digest pointing at this image. */
  digests: string[];
  /** `Config.Env` from the image, split into key/value. */
  env: Record<string, string>;
  labels: Record<string, string>;
  cmd: string[];
  entrypoint: string[];
  workingDir: string;
  /** Ports the image declares with EXPOSE, e.g. `8080/tcp`. */
  exposedPorts: string[];
  architecture?: string;
  os?: string;
  sizeBytes: number;
  /**
   * The image's filesystem layers, as content digests, **bottom to top**.
   *
   * `RootFS.Layers` from the daemon: immutable identifiers the daemon computes,
   * not names the student chose. Two images built from the same instructions
   * over the same inputs share a leading run of these, which is what makes
   * build-cache reuse observable as state rather than as build output.
   */
  layers: string[];
  createdAt: string;
}

export interface DockerImageSummary {
  id: string;
  tags: string[];
  sizeBytes: number;
}

export interface DockerVolumeSnapshot {
  name: string;
  driver: string;
  mountpoint: string;
  labels: Record<string, string>;
  scope: string;
  createdAt?: string;
}

export interface DockerNetworkSnapshot {
  id: string;
  name: string;
  driver: string;
  scope: string;
  internal: boolean;
  labels: Record<string, string>;
  /** Names of the containers currently attached to this network. */
  containers: string[];
  /** Subnets configured on the network, e.g. `172.20.0.0/16`. */
  subnets: string[];
}

export interface DockerVolumeSummary {
  name: string;
  driver: string;
  labels: Record<string, string>;
}

export interface DockerNetworkSummary {
  id: string;
  name: string;
  driver: string;
  labels: Record<string, string>;
}

/**
 * One file read out of a container through the archive endpoint.
 *
 * Deliberately not a directory listing and not a stream: the reader asks for
 * one path and gets at most one regular file back. See `copyFileFromContainer`.
 */
export interface DockerFileRead {
  /** The file's bytes, truncated to the caller's cap. */
  content: Buffer;
  /** Size the tar header declared, before any cap was applied. */
  declaredSize: number;
  /** True when the file was larger than the cap, so `content` is a prefix. */
  truncated: boolean;
}

/** Result of running one command inside a container. */
export interface DockerExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * A container the platform is about to create.
 *
 * Deliberately a structured record rather than a command line: nothing in a lab
 * definition, and nothing arriving from the network, ever becomes shell syntax.
 * `cli-client.ts` turns this into an explicit argv array.
 */
export interface RunContainerSpec {
  name: string;
  image: string;
  /** Detached (`-d`) when true, which is how every platform-created container runs. */
  detach: boolean;
  hostname?: string;
  network?: string;
  env?: Record<string, string>;
  labels?: Record<string, string>;
  /** Argv appended after the image, i.e. the container command. */
  command?: string[];
  entrypoint?: string[];
  workingDir?: string;
  /** `name:/path` volume mounts. Bind mounts are deliberately not expressible. */
  volumes?: Array<{ volume: string; destination: string; readOnly?: boolean }>;
  ports?: Array<{ containerPort: number; hostPort?: number; protocol?: string }>;
  /** `--restart`. */
  restartPolicy?: string;
  /** `--privileged`. Only ever set for the platform's own sandbox containers. */
  privileged?: boolean;
  /** `--memory`, e.g. `2g`. */
  memory?: string;
  /** `--cpus`, e.g. `1.5`. */
  cpus?: string;
  /** `--pids-limit`. */
  pidsLimit?: number;
  /** `--storage-opt`, e.g. `size=10G` where the storage driver supports it. */
  storageOpts?: string[];
  /** `--tmpfs` targets. */
  tmpfs?: string[];
  /** `--security-opt`, e.g. `no-new-privileges:true`. */
  securityOpts?: string[];
  /** `--cap-drop`. */
  capDrop?: string[];
  /** Extra daemon flags passed *after* the image, for images like dind. */
  args?: string[];
  /** `--init`. */
  init?: boolean;
  /** `--read-only`. */
  readOnly?: boolean;
}

export interface CreateNetworkSpec {
  name: string;
  driver?: string;
  /** `--internal`: no external connectivity from this network. */
  internal?: boolean;
  labels?: Record<string, string>;
}

/** The daemon could not be reached at all. Not a failed lab — a broken environment. */
export class DockerUnreachableError extends Error {
  readonly code = 'ENVIRONMENT_UNREACHABLE';
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'DockerUnreachableError';
  }
}

/** The daemon was reached and refused the request. */
export class DockerCommandError extends Error {
  readonly code = 'DOCKER_COMMAND_FAILED';
  constructor(
    message: string,
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'DockerCommandError';
  }
}

/** A lab's declared initial Docker state could not be created. */
export class DockerSetupError extends Error {
  readonly code = 'SETUP_FAILED';
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'DockerSetupError';
  }
}

/**
 * The Docker operations the platform performs.
 *
 * Reads dominate: verification is entirely reads, and the only writes are the
 * ones the platform itself makes to build, seed, reset, and destroy a sandbox.
 * There is deliberately no method that takes a command string.
 */
export interface DockerEnginePort {
  // --- daemon -------------------------------------------------------------

  /** Cheap liveness probe. Throws `DockerUnreachableError` when the daemon is down. */
  ping(): Promise<void>;
  version(): Promise<DockerVersion>;

  // --- containers ---------------------------------------------------------

  /** Returns `null` when no such container exists. */
  inspectContainer(name: string): Promise<DockerContainerSnapshot | null>;
  /**
   * List containers. `labelSelector` is a `key=value` pair matched by the
   * daemon, which is how the platform finds the sandboxes it owns.
   */
  listContainers(options?: { all?: boolean; labelSelector?: string }): Promise<DockerContainerSummary[]>;
  runContainer(spec: RunContainerSpec): Promise<string>;
  startContainer(name: string): Promise<void>;
  stopContainer(name: string, timeoutSeconds?: number): Promise<void>;
  /** Remove a container. Absent containers are not an error. */
  removeContainer(name: string, options?: { force?: boolean; volumes?: boolean }): Promise<void>;
  /** Tail of a container's logs, used for setup diagnostics. Never shown to students. */
  containerLogs(name: string, tailLines?: number): Promise<string>;

  /**
   * Read one regular file out of a container, without executing anything in it.
   *
   * Uses the daemon's archive endpoint (`docker cp <name>:<path> -`), which
   * matters for three reasons: nothing runs inside the student's container, it
   * works on a **stopped** container, and it does not depend on the image
   * containing `cat` or a shell at all.
   *
   * Deliberately narrow. It reads the one path it is given and returns at most
   * one regular file: a directory, a symlink, or an archive carrying more than
   * one entry is refused rather than walked, so this can never become a
   * filesystem browser. Returns `null` when the container or the path is
   * absent — an absence is an answer, not an error.
   */
  copyFileFromContainer(
    name: string,
    path: string,
    options?: { maxBytes?: number; timeoutMs?: number },
  ): Promise<DockerFileRead | null>;

  /**
   * Run one command inside a container with an explicit argv array.
   *
   * There is no shell: `argv` is passed straight to `execve`, so argument
   * content can never become syntax. Used to reach a session's own daemon and
   * to read a session's workspace files.
   */
  execInContainer(
    name: string,
    argv: string[],
    options?: { timeoutMs?: number; user?: string; workingDir?: string },
  ): Promise<DockerExecResult>;

  // --- images -------------------------------------------------------------

  inspectImage(reference: string): Promise<DockerImageSnapshot | null>;
  listImages(): Promise<DockerImageSummary[]>;
  pullImage(reference: string, timeoutMs?: number): Promise<void>;
  removeImage(reference: string, force?: boolean): Promise<void>;

  // --- volumes ------------------------------------------------------------

  inspectVolume(name: string): Promise<DockerVolumeSnapshot | null>;
  listVolumes(): Promise<DockerVolumeSummary[]>;
  createVolume(name: string, labels?: Record<string, string>): Promise<void>;
  removeVolume(name: string, force?: boolean): Promise<void>;

  // --- networks -----------------------------------------------------------

  inspectNetwork(name: string): Promise<DockerNetworkSnapshot | null>;
  listNetworks(): Promise<DockerNetworkSummary[]>;
  createNetwork(spec: CreateNetworkSpec): Promise<void>;
  removeNetwork(name: string): Promise<void>;
}

/**
 * How the platform obtains a port bound to one session's isolated daemon.
 *
 * The host port creates and destroys sandbox containers; a session port speaks
 * to the daemon running inside one of them. Keeping this a factory is what lets
 * tests substitute a fake for both levels.
 */
export interface DockerEngineFactory {
  /** The daemon that hosts the sandbox containers themselves. */
  readonly host: DockerEnginePort;
  /** A port bound to the isolated daemon inside one sandbox container. */
  session(sandbox: string): DockerEnginePort;
}

/** Split a `KEY=value` env list, as `docker inspect` reports it, into a map. */
export function envListToMap(list: readonly string[] | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of list ?? []) {
    if (typeof entry !== 'string') continue;
    const eq = entry.indexOf('=');
    if (eq <= 0) {
      out[entry] = '';
      continue;
    }
    out[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return out;
}
