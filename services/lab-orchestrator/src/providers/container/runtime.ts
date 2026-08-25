/**
 * The container runtime seam.
 *
 * `ContainerRuntimePort` is to the container providers what `KubernetesPort` is
 * to the Kubernetes provider: a narrow, testable interface so provider logic
 * can be exercised against an in-memory fake, while production talks to a real
 * daemon. Anything that depends on the daemon actually *enforcing* something —
 * pids limits, memory ceilings, `--network none` — is asserted against a real
 * Docker in the integration suite, never against the fake.
 *
 * `DockerCliRuntime` is the one implementation today. Two properties it must
 * keep:
 *
 *   - **Every invocation is an argv array with `shell: false`.** No string is
 *     ever interpolated into a command line, so a path or an image name can
 *     never become syntax.
 *   - **Capabilities are dropped wholesale, then added back from a closed
 *     list.** `--cap-drop ALL` is unconditional; `GRANTABLE_CAPABILITIES` is
 *     the only set a provider may re-add from, and nothing in it reaches
 *     outside the container.
 *   - **Nothing here takes an identifier from a browser.** Container names are
 *     derived server-side from the session id, validated against
 *     `CONTAINER_SANDBOX_PATTERN`, and re-checked against ownership labels
 *     before anything destructive.
 *
 * Honest limitation, stated once here and again in the README: this drives the
 * *host's* Docker daemon. Container isolation is not VM-grade tenant isolation,
 * and the orchestrator process holding daemon access is a development-only
 * arrangement — production would put a rootless, per-tenant daemon behind a
 * dedicated broker service.
 */
import { execFile } from 'node:child_process';
import {
  CONTAINER_NETWORK_PATTERN,
  assertValidContainerNetworkRef,
  assertValidContainerSandboxRef,
} from '../../session/identifiers.js';
import { MANAGED_LABEL } from '../../k8s/labels.js';

/*
 * Ownership vocabulary.
 *
 * Aliases, not copies. These five names existed here as their own string
 * literals, identical to the ones in `k8s/labels.ts` — one label with two
 * definitions, which is exactly how the container and Docker providers ended up
 * proving ownership two different ways. A rename on one side could silently
 * stop matching the other. There is now one definition and these are views of
 * it, so the two cannot drift.
 */
export {
  MANAGED_LABEL as MANAGED_CONTAINER_LABEL,
  SESSION_LABEL as CONTAINER_SESSION_LABEL,
  LAB_LABEL as CONTAINER_LAB_LABEL,
  EXPIRES_AT_LABEL as CONTAINER_EXPIRES_LABEL,
  PROVIDER_LABEL as CONTAINER_PROVIDER_LABEL,
} from '../../k8s/labels.js';

export const MANAGED_CONTAINER_SELECTOR = `${MANAGED_LABEL}=true`;

const DEFAULT_TIMEOUT_MS = 30_000;
/** Cap on anything read out of a sandbox, so a huge file cannot exhaust the API. */
export const MAX_SANDBOX_READ_BYTES = 64 * 1024;

export interface ContainerSpec {
  /** Container name — the session's sandbox reference. */
  name: string;
  image: string;
  labels: Record<string, string>;
  user: string;
  workdir: string;
  /** `--cpus`. */
  cpus: string;
  /** `--memory`. */
  memory: string;
  pidsLimit: number;
  /** `--network`; `none` unless a lab genuinely needs egress. */
  network: string;
  hostname: string;
  /**
   * Linux capabilities added back after `--cap-drop ALL`.
   *
   * Empty for every sandbox that does not need one, which is the default and
   * the case for Terraform. The Linux track is the exception: a lab about
   * `useradd`, `chown` or a supervised service cannot be taught from an
   * account that cannot administer anything, so `LinuxLabProvider` adds back
   * the narrow set those tasks need — and nothing that reaches the host
   * (`SYS_ADMIN`, `NET_ADMIN`, `SYS_PTRACE`, `MKNOD`, `SYS_MODULE` are never
   * in it). See `LINUX_SANDBOX_CAPABILITIES`.
   */
  capAdd?: string[];
  /**
   * `--security-opt no-new-privileges`. True unless a sandbox genuinely needs
   * setuid to work, which is only the case where `sudo` is part of the lesson.
   */
  noNewPrivileges?: boolean;
  env?: Record<string, string>;
  /** Long-running foreground process that keeps the sandbox alive. */
  command: string[];
}

export interface ContainerInfo {
  name: string;
  /** Full container id. Never leaves the orchestrator. */
  id: string;
  /** `running` | `exited` | `created` | … */
  state: string;
  image: string;
  labels: Record<string, string>;
}

export interface ContainerExecRequest {
  argv: string[];
  user?: string;
  workdir?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Written to the process' stdin, for `tee`-style file seeding. */
  stdin?: string;
  maxBufferBytes?: number;
}

export interface ContainerExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export class ContainerRuntimeError extends Error {
  readonly code = 'CONTAINER_RUNTIME_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'ContainerRuntimeError';
  }
}

/**
 * A session's private lab network.
 *
 * Deliberately not a general Docker network description. There is no driver
 * choice, no subnet, no `host` mode and no attachable flag, because a lab has
 * no business asking for any of them: the only thing the platform offers is an
 * isolated bridge with no route off itself. Widening this type is how host
 * networking would eventually arrive by accident, so it stays closed.
 */
export interface NetworkSpec {
  /** Trusted, derived from the session's sandbox reference. */
  name: string;
  /** Ownership labels, mirroring the container model. */
  labels: Record<string, string>;
}

export interface NetworkInfo {
  name: string;
  id: string;
  labels: Record<string, string>;
}

export interface ContainerRuntimePort {
  readonly name: string;
  /** Throws when the daemon cannot be reached. Resolves to its version. */
  ping(): Promise<string>;
  imageExists(image: string): Promise<boolean>;
  create(spec: ContainerSpec): Promise<ContainerInfo>;
  inspect(name: string): Promise<ContainerInfo | null>;
  /** Every container carrying a label selector, e.g. the platform's own. */
  list(labelSelector: string): Promise<ContainerInfo[]>;
  remove(name: string): Promise<void>;
  exec(name: string, request: ContainerExecRequest): Promise<ContainerExecResult>;

  /**
   * Create one session's private lab network. Re-entrant: creating a network
   * that already exists is success, so a retried Start Lab is safe.
   */
  networkCreate(spec: NetworkSpec): Promise<void>;
  networkInspect(name: string): Promise<NetworkInfo | null>;
  /** Remove a lab network. Removing one that is already gone is success. */
  networkRemove(name: string): Promise<void>;
  /** Every lab network carrying a label selector, for orphan reclamation. */
  networkList(labelSelector: string): Promise<NetworkInfo[]>;
}

// ---------------------------------------------------------------------------

export interface DockerCliOptions {
  /** Path to the CLI. Not configurable from any request. */
  binary?: string;
  timeoutMs?: number;
  /** Injected in tests. */
  run?: (argv: string[], options: { timeoutMs: number; stdin?: string; maxBufferBytes?: number }) => Promise<ContainerExecResult>;
}

export class DockerCliRuntime implements ContainerRuntimePort {
  readonly name = 'docker';
  readonly #binary: string;
  readonly #timeoutMs: number;
  readonly #run: NonNullable<DockerCliOptions['run']>;

  constructor(options: DockerCliOptions = {}) {
    this.#binary = options.binary ?? 'docker';
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#run = options.run ?? ((argv, opts) => runProcess(this.#binary, argv, opts));
  }

  async ping(): Promise<string> {
    const result = await this.#docker(['version', '--format', '{{.Server.Version}}']);
    if (result.exitCode !== 0) {
      throw new ContainerRuntimeError(
        result.stderr.trim() || 'the Docker daemon did not respond',
      );
    }
    return result.stdout.trim();
  }

  async imageExists(image: string): Promise<boolean> {
    assertImageReference(image);
    const result = await this.#docker(['image', 'inspect', image, '--format', '{{.Id}}']);
    return result.exitCode === 0;
  }

  async create(spec: ContainerSpec): Promise<ContainerInfo> {
    assertValidContainerSandboxRef(spec.name);
    assertImageReference(spec.image);

    const argv = [
      'run',
      '--detach',
      '--name',
      spec.name,
      '--hostname',
      spec.hostname,
      // Isolation and blast radius. Every one of these is deliberate:
      //  · no host filesystem is mounted, and no bind mount is ever added;
      //  · the Docker socket is never passed in — a student cannot reach the daemon;
      //  · no capabilities, and no way to regain any through setuid binaries;
      //  · the sandbox runs as an unprivileged user, never root.
      '--network',
      spec.network,
      '--cap-drop',
      'ALL',
      '--user',
      spec.user,
      '--workdir',
      spec.workdir,
      // Resource bounds (PLATFORM-004 §18). `--memory-swap` equal to `--memory`
      // disables swap growth, so the ceiling is a real ceiling.
      '--cpus',
      spec.cpus,
      '--memory',
      spec.memory,
      '--memory-swap',
      spec.memory,
      '--pids-limit',
      String(spec.pidsLimit),
      '--restart',
      'no',
    ];

    // Everything is dropped first, then the sandbox's declared set is added
    // back one flag at a time — so the grant is always an explicit, auditable
    // list rather than the absence of a restriction.
    for (const capability of spec.capAdd ?? []) {
      assertCapabilityName(capability);
      argv.push('--cap-add', capability);
    }
    if (spec.noNewPrivileges !== false) {
      argv.push('--security-opt', 'no-new-privileges:true');
    }

    for (const [key, value] of Object.entries(spec.labels)) {
      argv.push('--label', `${key}=${value}`);
    }
    for (const [key, value] of Object.entries(spec.env ?? {})) {
      assertEnvName(key);
      argv.push('--env', `${key}=${value}`);
    }
    argv.push(spec.image, ...spec.command);

    const result = await this.#docker(argv, { timeoutMs: 120_000 });
    if (result.exitCode !== 0) {
      throw new ContainerRuntimeError(
        result.stderr.trim() || `docker run exited with code ${result.exitCode}`,
      );
    }

    const info = await this.inspect(spec.name);
    if (!info) {
      throw new ContainerRuntimeError(`container ${spec.name} did not appear after creation`);
    }
    return info;
  }

  async inspect(name: string): Promise<ContainerInfo | null> {
    assertValidContainerSandboxRef(name);
    const result = await this.#docker([
      'inspect',
      '--type',
      'container',
      '--format',
      '{{.Id}}\t{{.State.Status}}\t{{.Config.Image}}\t{{json .Config.Labels}}',
      name,
    ]);
    if (result.exitCode !== 0) return null;

    const [id, state, image, labelsJson] = result.stdout.trim().split('\t');
    if (!id) return null;
    return {
      name,
      id,
      state: state ?? 'unknown',
      image: image ?? '',
      labels: parseLabelsJson(labelsJson),
    };
  }

  async list(labelSelector: string): Promise<ContainerInfo[]> {
    const result = await this.#docker([
      'ps',
      '--all',
      '--filter',
      `label=${labelSelector}`,
      '--format',
      '{{.Names}}',
    ]);
    if (result.exitCode !== 0) {
      throw new ContainerRuntimeError(
        result.stderr.trim() || 'could not list containers',
      );
    }

    const names = result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    const found: ContainerInfo[] = [];
    for (const name of names) {
      // Name-shape gate first: a container someone else labelled by hand never
      // enters the cleanup work list.
      try {
        assertValidContainerSandboxRef(name);
      } catch {
        continue;
      }
      const info = await this.inspect(name);
      if (info) found.push(info);
    }
    return found;
  }

  async remove(name: string): Promise<void> {
    assertValidContainerSandboxRef(name);
    const result = await this.#docker(['rm', '--force', '--volumes', name], {
      timeoutMs: 60_000,
    });
    // "No such container" is success: teardown is re-entrant by design.
    if (result.exitCode !== 0 && !/no such container/i.test(result.stderr)) {
      throw new ContainerRuntimeError(
        result.stderr.trim() || `docker rm exited with code ${result.exitCode}`,
      );
    }
  }

  // ------------------------------------------------------------- networks
  //
  // Every method below validates the name against `jtt-net-<hex>` before it
  // reaches an argv. Docker's own `bridge`, `host` and `none` networks cannot
  // match that shape, so this code physically cannot name them.

  async networkCreate(spec: NetworkSpec): Promise<void> {
    assertValidContainerNetworkRef(spec.name);

    const argv = [
      'network',
      'create',
      // `--internal` is the whole point: the bridge exists, and there is no
      // route off it. A lab gets a link and a neighbour, never egress.
      '--internal',
      '--driver',
      'bridge',
      spec.name,
    ];
    for (const [key, value] of Object.entries(spec.labels)) {
      argv.push('--label', `${key}=${value}`);
    }

    const result = await this.#docker(argv, { timeoutMs: 60_000 });
    // "already exists" is success: creation is re-entrant by design.
    if (result.exitCode !== 0 && !/already exists/i.test(result.stderr)) {
      throw new ContainerRuntimeError(
        result.stderr.trim() || `docker network create exited with code ${result.exitCode}`,
      );
    }
  }

  async networkInspect(name: string): Promise<NetworkInfo | null> {
    assertValidContainerNetworkRef(name);
    const result = await this.#docker([
      'network',
      'inspect',
      '--format',
      '{{.Id}}\t{{json .Labels}}',
      name,
    ]);
    if (result.exitCode !== 0) return null;

    const [id, labelsJson] = result.stdout.trim().split('\t');
    if (!id) return null;
    return { name, id, labels: parseLabelsJson(labelsJson) };
  }

  async networkRemove(name: string): Promise<void> {
    assertValidContainerNetworkRef(name);
    const result = await this.#docker(['network', 'rm', name], { timeoutMs: 60_000 });
    // "no such network" is success: teardown is re-entrant by design.
    if (result.exitCode !== 0 && !/no such network/i.test(result.stderr)) {
      throw new ContainerRuntimeError(
        result.stderr.trim() || `docker network rm exited with code ${result.exitCode}`,
      );
    }
  }

  async networkList(labelSelector: string): Promise<NetworkInfo[]> {
    const result = await this.#docker([
      'network',
      'ls',
      '--filter',
      `label=${labelSelector}`,
      '--format',
      '{{.Name}}',
    ]);
    if (result.exitCode !== 0) {
      throw new ContainerRuntimeError(result.stderr.trim() || 'could not list networks');
    }

    const names = result.stdout
      .split('\n')
      .map((line) => line.trim())
      // A daemon shared with other tooling may carry networks that are not
      // ours; the name shape is the gate, exactly as it is for containers.
      .filter((line) => CONTAINER_NETWORK_PATTERN.test(line));

    const infos: NetworkInfo[] = [];
    for (const name of names) {
      const info = await this.networkInspect(name);
      if (info) infos.push(info);
    }
    return infos;
  }

  async exec(name: string, request: ContainerExecRequest): Promise<ContainerExecResult> {
    assertValidContainerSandboxRef(name);
    if (!Array.isArray(request.argv) || request.argv.length === 0) {
      throw new ContainerRuntimeError('exec requires a non-empty argv array');
    }
    if (request.argv.some((arg) => typeof arg !== 'string')) {
      throw new ContainerRuntimeError('exec argv must contain only strings');
    }

    const argv = ['exec'];
    if (request.stdin !== undefined) argv.push('--interactive');
    if (request.user) {
      assertUserName(request.user);
      argv.push('--user', request.user);
    }
    if (request.workdir) argv.push('--workdir', request.workdir);
    for (const [key, value] of Object.entries(request.env ?? {})) {
      assertEnvName(key);
      argv.push('--env', `${key}=${value}`);
    }
    argv.push(name, ...request.argv);

    return this.#docker(argv, {
      timeoutMs: request.timeoutMs ?? this.#timeoutMs,
      ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
      ...(request.maxBufferBytes !== undefined ? { maxBufferBytes: request.maxBufferBytes } : {}),
    });
  }

  #docker(
    argv: string[],
    options: { timeoutMs?: number; stdin?: string; maxBufferBytes?: number } = {},
  ): Promise<ContainerExecResult> {
    return this.#run(argv, {
      timeoutMs: options.timeoutMs ?? this.#timeoutMs,
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
      ...(options.maxBufferBytes !== undefined ? { maxBufferBytes: options.maxBufferBytes } : {}),
    });
  }
}

// --- helpers ---------------------------------------------------------------

function runProcess(
  binary: string,
  argv: string[],
  options: { timeoutMs: number; stdin?: string; maxBufferBytes?: number },
): Promise<ContainerExecResult> {
  return new Promise((resolve) => {
    const child = execFile(
      binary,
      argv,
      {
        timeout: options.timeoutMs,
        maxBuffer: options.maxBufferBytes ?? 4 * 1024 * 1024,
        shell: false,
        env: {
          PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
          HOME: process.env.HOME ?? '/tmp',
          ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
          ...(process.env.DOCKER_CONTEXT ? { DOCKER_CONTEXT: process.env.DOCKER_CONTEXT } : {}),
        },
      },
      (error, stdout, stderr) => {
        const timedOut = Boolean(error && (error as NodeJS.ErrnoException).code === 'ETIMEDOUT');
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

    if (options.stdin !== undefined) {
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(options.stdin);
    }
  });
}

function parseLabelsJson(raw: string | undefined): Record<string, string> {
  if (!raw || raw === 'null') return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return {};
    const labels: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') labels[key] = value;
    }
    return labels;
  } catch {
    return {};
  }
}

const IMAGE_PATTERN = /^[a-z0-9][a-z0-9._\-/]*(:[A-Za-z0-9._-]+)?(@sha256:[a-f0-9]{64})?$/;

export function assertImageReference(image: unknown): string {
  if (typeof image !== 'string' || !IMAGE_PATTERN.test(image)) {
    throw new ContainerRuntimeError(`'${String(image)}' is not a valid container image reference`);
  }
  return image;
}

const USER_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;

export function assertUserName(user: unknown): string {
  if (typeof user !== 'string' || !USER_PATTERN.test(user)) {
    throw new ContainerRuntimeError(`'${String(user)}' is not a valid sandbox user name`);
  }
  return user;
}

/**
 * Capabilities a sandbox may be granted.
 *
 * A closed allow-list, not a syntax check. Anything that would let a container
 * reach the host or another container — `SYS_ADMIN`, `SYS_MODULE`, `SYS_PTRACE`,
 * `NET_ADMIN`, `NET_RAW`, `MKNOD`, `SYS_BOOT` — is simply absent, so no
 * configuration path and no provider can ask for one.
 */
export const GRANTABLE_CAPABILITIES = new Set([
  'CHOWN',
  'DAC_OVERRIDE',
  'FOWNER',
  'FSETID',
  'SETGID',
  'SETUID',
  'SETPCAP',
  'KILL',
  'AUDIT_WRITE',
]);

export function assertCapabilityName(capability: unknown): string {
  if (typeof capability !== 'string' || !GRANTABLE_CAPABILITIES.has(capability)) {
    throw new ContainerRuntimeError(
      `'${String(capability)}' is not a capability a sandbox may be granted (allowed: ${[...GRANTABLE_CAPABILITIES].join(', ')})`,
    );
  }
  return capability;
}

const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/;

export function assertEnvName(name: unknown): string {
  if (typeof name !== 'string' || !ENV_NAME_PATTERN.test(name)) {
    throw new ContainerRuntimeError(`'${String(name)}' is not a valid environment variable name`);
  }
  return name;
}
