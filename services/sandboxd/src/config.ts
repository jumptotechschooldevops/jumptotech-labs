/**
 * `sandboxd` configuration.
 *
 * Everything here is deployment configuration. Nothing in this file can be
 * influenced by a request: the container binary, the runtime owner and the
 * derivation secret are read once at startup, and the attach path takes only a
 * session id from the network.
 */

import type { DockerSandboxPolicy } from '@jumptotech/lab-orchestrator';

export interface SandboxdConfig {
  port: number;
  /** Loopback in development; `0.0.0.0` when the callers are other containers. */
  bindAddress: string;
  /**
   * Shared secret every caller must present. The same value the API and the
   * terminal already use for `/internal` — one internal trust domain, one
   * secret, rotated together.
   */
  internalServiceSecret: string;
  /**
   * The HMAC key a sandbox reference is derived from.
   *
   * Must equal the API's `NAMESPACE_DERIVATION_SECRET`, because that is the
   * whole mechanism: this service re-derives the container name from the
   * session id rather than being told one. A mismatch fails closed — the
   * derived name simply will not exist.
   */
  derivationSecret: string;
  /** Which runtime owner's sandboxes this broker will touch. See `RUNTIME_OWNER_LABEL`. */
  runtimeOwner: string;
  /** Container CLI. Configuration, never a value from the network. */
  containerBinary: string;
  /** Shell opened inside a sandbox. Configuration, never a value from the network. */
  shell: string;
  /**
   * The account a student's shell runs as — `SANDBOX_USER`, the same policy
   * value the API applies.
   *
   * Deliberately *not* read back from the container. `Config.User` is the
   * account the container's foreground process runs as, and a Linux sandbox
   * runs a real service supervisor there as `root`. Attaching with that gave
   * every Linux, CS, Networking and AWS student a root shell. See attach.ts.
   */
  sandboxUser: string;
  /** The student's working directory — `SANDBOX_HOME`. */
  sandboxHome: string;
  /** Concurrent PTYs this broker will host. */
  maxSessions: number;
  /**
   * Docker-track sandbox shape.
   *
   * Read here rather than sent by the API, and that is the whole point: the
   * image, the `--privileged` flag, the memory, the CPU and the pids limit of a
   * `docker:dind` sandbox are this process' configuration. No caller can name
   * any of them, so no caller can ask for a different image or for privilege on
   * something that is not a sandbox. See `docker-ops.ts`.
   *
   * `null` when the Docker track is off, and then `/v1/docker` answers 503
   * rather than existing half-wired.
   */
  docker: DockerSandboxPolicy | null;
  /** A PTY with no traffic for this long is closed. */
  idleTimeoutMs: number;
  /** Hard ceiling on one PTY, whatever the traffic. */
  maxSessionMs: number;
}

function boolFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/**
 * The Docker sandbox shape, from this process' own environment.
 *
 * Must match the API's `DOCKER_SANDBOX_*` values, because the API reports the
 * ceilings to the student and this process is what actually applies them. They
 * are set on both services from the same variables in compose.
 */
function loadDockerPolicy(env: NodeJS.ProcessEnv): DockerSandboxPolicy {
  const mirror = env.DOCKER_SANDBOX_REGISTRY_MIRROR?.trim() ?? '';
  return {
    image: env.DOCKER_SANDBOX_IMAGE?.trim() || 'docker:27-dind',
    // Exposed so an operator can switch it *off* on a host with a rootless
    // alternative — and so the requirement is visible in configuration rather
    // than buried in provider code.
    privileged: boolFromEnv(env, 'DOCKER_SANDBOX_PRIVILEGED', true),
    memory: env.DOCKER_SANDBOX_MEMORY?.trim() || '2g',
    cpus: env.DOCKER_SANDBOX_CPUS?.trim() || '2',
    pidsLimit: intFromEnv(env, 'DOCKER_SANDBOX_PIDS_LIMIT', 512),
    maxContainers: intFromEnv(env, 'DOCKER_SANDBOX_MAX_CONTAINERS', 10),
    network: env.DOCKER_SANDBOX_NETWORK?.trim() || 'jumptotech-sandboxes',
    daemonPort: intFromEnv(env, 'DOCKER_SANDBOX_DAEMON_PORT', 2376),
    readyTimeoutSeconds: intFromEnv(env, 'DOCKER_SANDBOX_READY_TIMEOUT_SECONDS', 180),
    restartAttempts: intFromEnv(env, 'DOCKER_SANDBOX_RESTART_ATTEMPTS', 5),
    ...(mirror ? { registryMirror: mirror } : {}),
  };
}

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer, got '${raw}'`);
  }
  return parsed;
}

export function loadSandboxdConfig(env: NodeJS.ProcessEnv = process.env): SandboxdConfig {
  const internalServiceSecret = env.INTERNAL_SERVICE_SECRET ?? '';
  if (internalServiceSecret.length < 8) {
    throw new Error(
      'INTERNAL_SERVICE_SECRET must be set to at least 8 characters and must match the API and terminal services.',
    );
  }

  /*
   * Fails closed rather than defaulting. A broker that derived references from
   * a different key than the API would refuse every attach — confusing but
   * safe — and one that silently fell back to the *internal* secret would make
   * two unrelated secrets load-bearing for each other. Say so at startup.
   */
  const derivationSecret = env.NAMESPACE_DERIVATION_SECRET ?? '';
  if (derivationSecret.length < 8) {
    throw new Error(
      'NAMESPACE_DERIVATION_SECRET must be set to at least 8 characters and must match the API exactly; sandbox references are derived from it.',
    );
  }

  return {
    port: intFromEnv(env, 'SANDBOXD_PORT', 4002),
    bindAddress: env.SANDBOXD_BIND ?? '127.0.0.1',
    internalServiceSecret,
    derivationSecret,
    runtimeOwner: env.RUNTIME_OWNER_ID ?? 'jumptotech',
    containerBinary: env.SANDBOX_CONTAINER_BINARY ?? 'docker',
    shell: env.SANDBOXD_SHELL ?? '/bin/bash',
    // Must match the API's SANDBOX_USER / SANDBOX_HOME: the API tells the
    // student's browser which sandbox they have, and this service decides who
    // they are inside it. Disagreement is a shell with the wrong identity.
    docker: boolFromEnv(env, 'DOCKER_TRACK_ENABLED', false) ? loadDockerPolicy(env) : null,
    sandboxUser: env.SANDBOX_USER?.trim() || 'student',
    sandboxHome: env.SANDBOX_HOME?.trim() || '/home/student',
    maxSessions: intFromEnv(env, 'SANDBOXD_MAX_SESSIONS', 32),
    idleTimeoutMs: intFromEnv(env, 'SANDBOXD_IDLE_TIMEOUT_SECONDS', 1800) * 1000,
    maxSessionMs: intFromEnv(env, 'SANDBOXD_MAX_SESSION_SECONDS', 7200) * 1000,
  };
}
