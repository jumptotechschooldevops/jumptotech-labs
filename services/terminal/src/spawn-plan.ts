/**
 * Turning a terminal context into something to spawn.
 *
 * This module is the security boundary of the generic terminal binding. The API
 * tells this service *which sandbox* a session has; it never tells it what to
 * run. Everything executable is decided here, from a closed set of shapes:
 *
 * ```text
 *   kubernetes      → bash, with KUBECONFIG pointing at this session's file
 *   container-exec  → docker exec -u <user> -w <dir> <container> bash
 *   docker-daemon   → bash, with DOCKER_HOST pointing at this session's daemon
 * ```
 *
 * Every field that reaches an argv is re-validated first, against the same
 * patterns the orchestrator uses when it mints them:
 *
 *   · the container reference must match `jtt-lab-<hex>`;
 *   · the user must be a POSIX user name;
 *   · the working directory must be a plain absolute path;
 *   · environment names and values must be ordinary, single-line strings.
 *
 * A context that fails any of these is rejected outright rather than sanitised.
 * The API and this service are separate processes, and this is the check that
 * holds even if the other one is wrong — the whole point of validating on both
 * sides of a trust boundary rather than only where the value is produced.
 *
 * Nothing goes through a shell: `node-pty` is given a program and an argv array.
 */
import { CONTAINER_SANDBOX_PATTERN } from '@jumptotech/lab-orchestrator';

/** Re-exported for tests that import from this module. */
export const CONTAINER_REF_PATTERN = CONTAINER_SANDBOX_PATTERN;

const USER_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;
const WORKDIR_PATTERN = /^\/[A-Za-z0-9._\-/]{0,255}$/;
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/;
const ENV_VALUE_PATTERN = /^[^\n\r\0]{0,512}$/;

export class TerminalContextError extends Error {
  readonly code = 'INVALID_TERMINAL_CONTEXT';
  constructor(message: string) {
    super(message);
    this.name = 'TerminalContextError';
  }
}

export interface SpawnPlan {
  /** Program to exec. Always one of this service's own constants. */
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  /** What the terminal pane header shows: `namespace` / `container`. */
  sandboxKind: 'namespace' | 'container';
  sandboxRef: string;
}

/** `tcp://jtt-lab-<hex>:<port>` and nothing else. */
export const DOCKER_HOST_PATTERN = /^tcp:\/\/jtt-lab-[0-9a-f]{6,40}:\d{2,5}$/;

export interface SpawnPlanOptions {
  shell: string;
  /** Container CLI. Configuration, never a value from the network. */
  containerBinary: string;
  /** HOME and cwd for a local shell. */
  workDir: string;
  promptUser: string;
  promptHost: string;
  labId: string;
}

/** Extra environment a context may contribute, after validation. */
function safeEnv(env: Record<string, string> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (!ENV_NAME_PATTERN.test(key)) {
      throw new TerminalContextError(`'${key}' is not a valid environment variable name`);
    }
    if (typeof value !== 'string' || !ENV_VALUE_PATTERN.test(value)) {
      throw new TerminalContextError(`the value of '${key}' is not a valid environment value`);
    }
    result[key] = value;
  }
  return result;
}

function prompt(user: string, host: string): string {
  return `\\[\\e[32m\\]${user}@${host}\\[\\e[0m\\]:\\[\\e[34m\\]\\w\\[\\e[0m\\]$ `;
}

/**
 * A local PTY holding this session's namespace-scoped kubeconfig.
 *
 * Unchanged from PLATFORM-002: a deliberately minimal environment, and no
 * ambient cluster credential for the shell to inherit — this process has none.
 */
export function kubernetesSpawnPlan(
  context: { namespace: string; env?: Record<string, string> },
  kubeconfigPath: string,
  options: SpawnPlanOptions,
): SpawnPlan {
  return {
    command: options.shell,
    args: ['--norc', '--noprofile'],
    cwd: options.workDir,
    sandboxKind: 'namespace',
    sandboxRef: context.namespace,
    env: {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: options.workDir,
      TERM: 'xterm-256color',
      LANG: 'C.UTF-8',
      SHELL: options.shell,
      USER: options.promptUser,
      HOSTNAME: options.promptHost,
      PS1: prompt(options.promptUser, options.promptHost),
      KUBECONFIG: kubeconfigPath,
      JTT_LAB_ID: options.labId,
      JTT_NAMESPACE: context.namespace,
      ...safeEnv(context.env),
    },
  };
}

/**
 * A PTY attached to this session's sandbox container.
 *
 * `docker exec` rather than a shell in this container: the student's filesystem,
 * processes and tools live inside their own sandbox, and this service holds no
 * part of it. Note what is *not* passed — no `--privileged`, no bind mount, no
 * socket, no capability. Those are properties of the container the orchestrator
 * created, and nothing here can add to them.
 */
export function containerSpawnPlan(
  context: {
    runtime: string;
    containerRef: string;
    user: string;
    workdir: string;
    env?: Record<string, string>;
  },
  options: SpawnPlanOptions,
): SpawnPlan {
  if (context.runtime !== 'docker') {
    throw new TerminalContextError(
      `container runtime '${String(context.runtime)}' is not supported by this terminal service`,
    );
  }
  if (!CONTAINER_REF_PATTERN.test(context.containerRef)) {
    throw new TerminalContextError(
      `'${String(context.containerRef)}' is not a JumpToTech sandbox container name`,
    );
  }
  if (!USER_PATTERN.test(context.user)) {
    throw new TerminalContextError(`'${String(context.user)}' is not a valid sandbox user name`);
  }
  if (!WORKDIR_PATTERN.test(context.workdir)) {
    throw new TerminalContextError(
      `'${String(context.workdir)}' is not a valid sandbox working directory`,
    );
  }

  const extra = safeEnv(context.env);
  const inner: Record<string, string> = {
    TERM: 'xterm-256color',
    LANG: 'C.UTF-8',
    PS1: prompt(options.promptUser, options.promptHost),
    JTT_LAB_ID: options.labId,
    ...extra,
  };

  const args = [
    'exec',
    '--interactive',
    '--tty',
    '--user',
    context.user,
    '--workdir',
    context.workdir,
  ];
  for (const [key, value] of Object.entries(inner)) {
    args.push('--env', `${key}=${value}`);
  }
  args.push(context.containerRef, options.shell, '--norc', '--noprofile');

  return {
    command: options.containerBinary,
    args,
    cwd: options.workDir,
    sandboxKind: 'container',
    sandboxRef: context.containerRef,
    // The environment of the `docker exec` *client*, not of the student's
    // shell: deliberately minimal, and carrying no credential of any kind.
    env: {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: options.workDir,
      TERM: 'xterm-256color',
      ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
      ...(process.env.DOCKER_CONTEXT ? { DOCKER_CONTEXT: process.env.DOCKER_CONTEXT } : {}),
    },
  };
}

/**
 * A local PTY pointed at this session's own Docker daemon.
 *
 * Deliberately *not* `docker exec`. A Docker lab's student needs a daemon to
 * build against and run containers on, so the shell runs here and `DOCKER_HOST`
 * addresses the session's private `docker:dind` sandbox over mutual TLS.
 *
 * What makes that safe is `DOCKER_TLS_VERIFY`: it is what makes the client
 * check the daemon's certificate against *this session's* CA. Without it the
 * client would talk to any daemon that answered, which is precisely the
 * cross-session confusion the per-sandbox CA exists to prevent. The certificate
 * directory is written 0700 by `writeSessionDockerCerts` and removed when the
 * shell ends; this service holds no ambient Docker credential of its own.
 *
 * `cwd` is the session's workspace — the directory the student authors in and
 * the build context `docker build .` picks up.
 */
export function dockerSpawnPlan(
  context: {
    dockerHost: string;
    sandboxRef: string;
    env?: Record<string, string>;
  },
  certDir: string,
  workspaceDir: string,
  options: SpawnPlanOptions,
): SpawnPlan {
  if (!CONTAINER_REF_PATTERN.test(context.sandboxRef)) {
    throw new TerminalContextError(
      `'${String(context.sandboxRef)}' is not a JumpToTech sandbox container name`,
    );
  }
  if (!DOCKER_HOST_PATTERN.test(context.dockerHost)) {
    throw new TerminalContextError(
      `'${String(context.dockerHost)}' is not a JumpToTech sandbox daemon address`,
    );
  }
  if (!WORKDIR_PATTERN.test(workspaceDir)) {
    throw new TerminalContextError(`'${String(workspaceDir)}' is not a valid workspace directory`);
  }

  return {
    command: options.shell,
    args: ['--norc', '--noprofile'],
    cwd: workspaceDir,
    sandboxKind: 'container',
    sandboxRef: context.sandboxRef,
    env: {
      // A deliberately minimal environment: nothing from the host process leaks
      // into the student shell except what is listed here. In particular there
      // is no inherited KUBECONFIG and no inherited DOCKER_HOST.
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: workspaceDir,
      TERM: 'xterm-256color',
      LANG: 'C.UTF-8',
      SHELL: options.shell,
      USER: options.promptUser,
      HOSTNAME: options.promptHost,
      PS1: prompt(options.promptUser, options.promptHost),
      DOCKER_HOST: context.dockerHost,
      DOCKER_TLS_VERIFY: '1',
      DOCKER_CERT_PATH: certDir,
      JTT_LAB_ID: options.labId,
      JTT_WORKSPACE: workspaceDir,
      ...safeEnv(context.env),
    },
  };
}
