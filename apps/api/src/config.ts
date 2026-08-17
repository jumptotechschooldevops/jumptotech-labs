/**
 * API configuration.
 *
 * PLATFORM-002 rule: no session lifetime, quota, limit, or concurrency value is
 * hardcoded in application logic. Everything below is read from the
 * environment with a documented development default, so production values can
 * be tuned after load testing without a code change.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_ANSIBLE_SANDBOX_LIMITS,
  DEFAULT_SESSION_POLICY,
  LAB_SUBSTRATES,
  type AnsibleSandboxLimits,
  type LabSubstrate,
  type SessionLifetimeConfig,
  type SessionPolicy,
} from '@jumptotech/lab-orchestrator';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

export interface ApiConfig {
  port: number;
  labsDir: string;
  provider: string;
  clusterName: string;
  kubeconfigPath: string | undefined;
  allowedOrigins: string[];
  terminalSessionSecret: string;
  terminalSessionTtlSeconds: number;
  terminalWsUrl: string;
  /**
   * Base URL of the terminal service's internal control endpoint, used to close
   * a student's shell when their session ends. Optional: when unset, teardown
   * still deletes the namespace and the terminal dies on its own.
   */
  terminalControlUrl: string | undefined;
  /** Shared secret authenticating API ⇄ terminal service calls. */
  internalServiceSecret: string;
  /** Keys the session-id → namespace derivation. */
  namespaceSecret: string;
  lifetimes: SessionLifetimeConfig;
  policy: SessionPolicy;
  reaperIntervalSeconds: number;
  sessionRetentionMinutes: number;
  nodeEnv: string;
  /** Which tracks this deployment can actually provision. */
  substrates: LabSubstrate[];
  ansible: AnsibleTrackConfig;
}

/**
 * Ansible track configuration.
 *
 * Every value is read from the environment with a documented development
 * default, exactly as the Kubernetes guardrails are: production sizing is a
 * configuration decision, not a code change.
 */
export interface AnsibleTrackConfig {
  /** Whether the Ansible substrate is offered at all. */
  enabled: boolean;
  /** Sandbox node image. Build it with `bash scripts/ansible-image-build.sh`. */
  image: string;
  managedNodeCount: number;
  limits: AnsibleSandboxLimits;
  /**
   * Host the terminal service reaches a control node's published SSH port on.
   *
   * The port itself is published to the loopback interface only, so this is
   * `127.0.0.1` when the terminal runs on the same host.
   */
  sshHost: string;
  /** `docker` binary used by the orchestrator. Never taken from a request. */
  dockerBinary: string;
  /** Optional non-default daemon endpoint. */
  dockerHost: string | undefined;
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

function strFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const raw = env[name];
  return raw && raw.trim().length > 0 ? raw.trim() : fallback;
}

function boolFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function floatFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive number, got '${raw}'`);
  }
  return parsed;
}

/** Read the Ansible track's sandbox configuration. */
export function loadAnsibleConfig(env: NodeJS.ProcessEnv = process.env): AnsibleTrackConfig {
  const base = DEFAULT_ANSIBLE_SANDBOX_LIMITS;
  const managedNodeCount = intFromEnv(env, 'ANSIBLE_MANAGED_NODES', 2);
  if (managedNodeCount > 4) {
    throw new Error('ANSIBLE_MANAGED_NODES must be at most 4 — the labs are written for two nodes.');
  }

  return {
    // Off unless explicitly enabled: the Ansible provider needs a Docker
    // connection, and a deployment that has not decided to give it one should
    // not half-start the track.
    enabled: boolFromEnv(env, 'ANSIBLE_TRACK_ENABLED', false),
    image: strFromEnv(env, 'ANSIBLE_LAB_IMAGE', 'jumptotech/ansible-lab:local'),
    managedNodeCount,
    limits: {
      controlCpus: floatFromEnv(env, 'ANSIBLE_CONTROL_CPUS', base.controlCpus),
      controlMemory: strFromEnv(env, 'ANSIBLE_CONTROL_MEMORY', base.controlMemory),
      nodeCpus: floatFromEnv(env, 'ANSIBLE_NODE_CPUS', base.nodeCpus),
      nodeMemory: strFromEnv(env, 'ANSIBLE_NODE_MEMORY', base.nodeMemory),
      pidsLimit: intFromEnv(env, 'ANSIBLE_PIDS_LIMIT', base.pidsLimit),
    },
    sshHost: strFromEnv(env, 'ANSIBLE_SSH_HOST', '127.0.0.1'),
    dockerBinary: strFromEnv(env, 'DOCKER_BINARY', 'docker'),
    dockerHost: env.DOCKER_HOST || undefined,
  };
}

/**
 * Which substrates this deployment serves.
 *
 * Kubernetes is always offered — it is the platform's original track and its
 * absence would break every existing lab. Ansible is added when its track is
 * enabled. A lab whose substrate is not served fails to start with a clear
 * message rather than half-provisioning.
 */
export function loadSubstrates(env: NodeJS.ProcessEnv = process.env): LabSubstrate[] {
  const substrates: LabSubstrate[] = ['kubernetes'];
  if (boolFromEnv(env, 'ANSIBLE_TRACK_ENABLED', false)) substrates.push('ansible');
  return substrates.filter((substrate) => LAB_SUBSTRATES.includes(substrate));
}

/** Build the per-session guardrail policy from the environment. */
export function loadSessionPolicy(env: NodeJS.ProcessEnv = process.env): SessionPolicy {
  const base = DEFAULT_SESSION_POLICY;
  return {
    quotaName: strFromEnv(env, 'SESSION_QUOTA_NAME', base.quotaName),
    quota: {
      pods: strFromEnv(env, 'QUOTA_PODS', base.quota.pods ?? '15'),
      services: strFromEnv(env, 'QUOTA_SERVICES', base.quota.services ?? '10'),
      persistentvolumeclaims: strFromEnv(
        env,
        'QUOTA_PVCS',
        base.quota.persistentvolumeclaims ?? '5',
      ),
      'requests.cpu': strFromEnv(env, 'QUOTA_REQUESTS_CPU', base.quota['requests.cpu'] ?? '2'),
      'requests.memory': strFromEnv(
        env,
        'QUOTA_REQUESTS_MEMORY',
        base.quota['requests.memory'] ?? '2Gi',
      ),
      'limits.cpu': strFromEnv(env, 'QUOTA_LIMITS_CPU', base.quota['limits.cpu'] ?? '4'),
      'limits.memory': strFromEnv(env, 'QUOTA_LIMITS_MEMORY', base.quota['limits.memory'] ?? '4Gi'),
      // Cost safety: not configurable up. A lab may never ask for a cloud
      // load balancer or a node port.
      'services.loadbalancers': '0',
      'services.nodeports': '0',
    },
    limitRange: {
      name: strFromEnv(env, 'SESSION_LIMITRANGE_NAME', base.limitRange.name),
      defaultRequest: {
        cpu: strFromEnv(env, 'LIMITS_DEFAULT_REQUEST_CPU', base.limitRange.defaultRequest.cpu),
        memory: strFromEnv(
          env,
          'LIMITS_DEFAULT_REQUEST_MEMORY',
          base.limitRange.defaultRequest.memory,
        ),
      },
      default: {
        cpu: strFromEnv(env, 'LIMITS_DEFAULT_CPU', base.limitRange.default.cpu),
        memory: strFromEnv(env, 'LIMITS_DEFAULT_MEMORY', base.limitRange.default.memory),
      },
      max: {
        cpu: strFromEnv(env, 'LIMITS_MAX_CPU', base.limitRange.max?.cpu ?? '1'),
        memory: strFromEnv(env, 'LIMITS_MAX_MEMORY', base.limitRange.max?.memory ?? '1Gi'),
      },
    },
    network: {
      name: strFromEnv(env, 'SESSION_NETWORKPOLICY_NAME', base.network.name),
      enabled: boolFromEnv(env, 'NETWORK_POLICY_ENABLED', base.network.enabled),
      dnsNamespace: strFromEnv(env, 'CLUSTER_DNS_NAMESPACE', base.network.dnsNamespace),
      podCidr: strFromEnv(env, 'CLUSTER_POD_CIDR', base.network.podCidr),
      serviceCidr: strFromEnv(env, 'CLUSTER_SERVICE_CIDR', base.network.serviceCidr),
      allowExternalEgress: boolFromEnv(
        env,
        'ALLOW_EXTERNAL_EGRESS',
        base.network.allowExternalEgress,
      ),
    },
    serviceAccountName: strFromEnv(env, 'SESSION_SERVICE_ACCOUNT', base.serviceAccountName),
    credentialTtlSeconds: intFromEnv(
      env,
      'STUDENT_CREDENTIAL_TTL_SECONDS',
      base.credentialTtlSeconds,
    ),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const secret = env.TERMINAL_SESSION_SECRET ?? '';
  if (secret.length < 8) {
    throw new Error(
      'TERMINAL_SESSION_SECRET must be set to at least 8 characters. Copy .env.example to .env and generate one with: openssl rand -hex 32',
    );
  }

  const maxSessionSeconds = intFromEnv(env, 'MAX_SESSION_MINUTES', 60) * 60;
  const idleTimeoutSeconds = intFromEnv(env, 'IDLE_TIMEOUT_MINUTES', 20) * 60;
  const warningSeconds = intFromEnv(env, 'WARNING_MINUTES', 5) * 60;

  if (idleTimeoutSeconds > maxSessionSeconds) {
    throw new Error(
      `IDLE_TIMEOUT_MINUTES (${idleTimeoutSeconds / 60}) must not exceed MAX_SESSION_MINUTES (${maxSessionSeconds / 60}); the absolute deadline is the outer bound.`,
    );
  }

  return {
    port: intFromEnv(env, 'API_PORT', 4000),
    labsDir: env.LABS_DIR ?? path.join(repoRoot, 'labs'),
    provider: env.LAB_PROVIDER ?? 'kind',
    clusterName: env.LAB_CLUSTER_NAME ?? 'jumptotech-labs',
    kubeconfigPath: env.KUBECONFIG || undefined,
    allowedOrigins: (env.ALLOWED_ORIGINS ?? 'http://localhost:3000')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    terminalSessionSecret: secret,
    terminalSessionTtlSeconds: intFromEnv(env, 'TERMINAL_SESSION_TTL_SECONDS', 3600),
    terminalWsUrl: env.VITE_TERMINAL_WS_URL ?? 'ws://localhost:4001',
    terminalControlUrl: env.TERMINAL_CONTROL_URL || undefined,
    // Defaults to the terminal session secret so a single generated secret is
    // enough to run the stack locally; document splitting them in production.
    internalServiceSecret: env.INTERNAL_SERVICE_SECRET || secret,
    namespaceSecret: env.NAMESPACE_DERIVATION_SECRET || secret,
    lifetimes: {
      maxSessionSeconds,
      idleTimeoutSeconds,
      warningSeconds,
      maxActiveSessions: intFromEnv(env, 'MAX_ACTIVE_SESSIONS', 20),
    },
    policy: loadSessionPolicy(env),
    reaperIntervalSeconds: intFromEnv(env, 'CLEANUP_INTERVAL_SECONDS', 60),
    sessionRetentionMinutes: intFromEnv(env, 'SESSION_RETENTION_MINUTES', 15),
    nodeEnv: env.NODE_ENV ?? 'development',
    substrates: loadSubstrates(env),
    ansible: loadAnsibleConfig(env),
  };
}
