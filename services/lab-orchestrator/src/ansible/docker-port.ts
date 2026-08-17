/**
 * The narrow Docker surface the Ansible sandbox needs.
 *
 * Defining a port (rather than reaching for the Docker socket wherever a
 * container is needed) buys the same three things the `KubernetesPort` buys:
 * the provider is unit-testable against an in-memory fake, the set of
 * operations the platform can perform on Docker is *finite and readable*, and a
 * different substrate can be dropped in later without touching a caller.
 *
 * Security shape, stated once here because everything else inherits it:
 *
 *   - **No shell, ever.** Every call takes an explicit argv array. Nothing on
 *     this interface accepts a command string, so no value from a lab
 *     definition, a request body, or a student's terminal can become syntax.
 *   - **No student input reaches this port.** Student commands run *inside* a
 *     sandbox container over SSH; they never travel through the orchestrator.
 *   - **Only the orchestrator holds the Docker connection.** It is not mounted
 *     into the terminal service, the web app, or any sandbox container. See
 *     README → Ansible track security.
 */

export interface DockerRunSpec {
  /** Container name. Always derived from the sandbox id. */
  name: string;
  image: string;
  /** User-defined network the container joins. */
  network: string;
  /** DNS names this container answers to inside that network. */
  aliases: string[];
  hostname: string;
  labels: Record<string, string>;
  env: Record<string, string>;
  /** Fractional CPUs, e.g. `0.5`. */
  cpus: number;
  /** e.g. `256m`. */
  memory: string;
  /** Hard process ceiling, so a fork bomb in a lab cannot reach the host. */
  pidsLimit: number;
  /** Linux capabilities to keep. Everything else is dropped. */
  capAdd?: string[];
  /** `127.0.0.1:0:22` publishes the SSH port on an ephemeral loopback port. */
  publish?: string[];
  readOnlyRootfs?: boolean;
  tmpfs?: string[];
}

export interface DockerExecSpec {
  container: string;
  /** Explicit argv. Never joined into a string. */
  argv: string[];
  env?: Record<string, string>;
  user?: string;
  workdir?: string;
  /** Written to the process's stdin, then closed. */
  input?: string;
  timeoutMs?: number;
}

export interface DockerExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface DockerContainerInfo {
  name: string;
  id: string;
  /** `created` | `running` | `exited` | … */
  state: string;
  labels: Record<string, string>;
}

export interface DockerNetworkInfo {
  name: string;
  id: string;
  labels: Record<string, string>;
}

/** A published container port, as seen on the host. */
export interface DockerPortBinding {
  hostIp: string;
  hostPort: number;
  containerPort: number;
}

export class DockerUnavailableError extends Error {
  readonly code = 'ENVIRONMENT_UNREACHABLE';
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'DockerUnavailableError';
  }
}

export class DockerOperationError extends Error {
  readonly code = 'PROVISION_FAILED';
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'DockerOperationError';
  }
}

export interface DockerPort {
  /** Cheap liveness probe against the Docker daemon. Throws when unreachable. */
  ping(): Promise<void>;
  version(): Promise<string>;
  imageExists(image: string): Promise<boolean>;

  createNetwork(name: string, labels: Record<string, string>): Promise<void>;
  removeNetwork(name: string): Promise<void>;
  listNetworks(labelSelector: string): Promise<DockerNetworkInfo[]>;
  networkExists(name: string): Promise<boolean>;

  runContainer(spec: DockerRunSpec): Promise<void>;
  removeContainer(name: string): Promise<void>;
  inspectContainer(name: string): Promise<DockerContainerInfo | null>;
  listContainers(labelSelector: string): Promise<DockerContainerInfo[]>;
  /** Host-side bindings for a container port, e.g. `22/tcp`. */
  publishedPorts(name: string, containerPort: number): Promise<DockerPortBinding[]>;

  exec(spec: DockerExecSpec): Promise<DockerExecResult>;
}
