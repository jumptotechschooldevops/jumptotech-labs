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
  DEFAULT_LINUX_SANDBOX_IMAGE,
  DEFAULT_DOCKER_SANDBOX_IMAGE,
  DEFAULT_SESSION_POLICY,
  DEFAULT_POD_SECURITY,
  assertPodSecurityConfig,
  type PodSecurityConfig,
  DEFAULT_ANSIBLE_SANDBOX_IMAGE,
  DEFAULT_CICD_SANDBOX_IMAGE,
  DEFAULT_TERRAFORM_SANDBOX_IMAGE,
  assertValidNetworkPolicyConfig,
  type NetworkPolicyConfig,
  type DockerSandboxPolicy,
  type SessionLifetimeConfig,
  type SessionPolicy,
  resolveRuntimeOwner,
  type RuntimeOwnerSource,
  assertTlsVerificationEnabled,
  resolveBrokerClientTransport,
  type BrokerClientTransport,
} from '@jumptotech/lab-orchestrator';
import {
  DEFAULT_DEV_STUDENT_ID,
  loadDatabaseConfig,
  resolveDatabaseTransport,
  type DatabaseConfig,
  type DatabaseTransportMode,
} from '@jumptotech/progress';
import { DEFAULT_AUTH_SESSION_TTL_SECONDS } from './auth/browser-session.js';
import {
  MAX_AUTH_SESSION_TTL_SECONDS,
  MIN_AUTH_SESSION_TTL_SECONDS,
  assertProductionAuthConfig,
  scopeProblems,
} from './auth/production-auth.js';
import { isValidCookieName } from './auth/cookies.js';
import {
  loadObservabilityConfig,
  assertProductionSecrets,
  assertScrapeTokenIsDistinct,
  isProductionEnv,
  type ObservabilityConfig,
} from '@jumptotech/observability';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

/**
 * How the browser session cookie is written (PLATFORM-010).
 *
 * Every attribute here is a security decision made once, in configuration,
 * rather than at each call site — which is how one `Set-Cookie` ends up missing
 * `Secure`.
 */
export interface AuthCookieConfig {
  name: string;
  /**
   * Off only for a plain-HTTP localhost deployment.
   *
   * Derived rather than defaulted to `false`: a deployment that forgets to set
   * it gets `Secure`, and the only way to lose it is to be visibly on
   * `http://localhost`.
   */
  secure: boolean;
  /** Unset means host-only, which is the safer default. */
  domain: string | undefined;
  /** Browser session lifetime. There is no refresh; this is the whole budget. */
  ttlSeconds: number;
}

/** Authentication configuration (PLATFORM-009, extended by PLATFORM-010). */
export interface AuthConfig {
  /**
   * `oidc` in any real deployment. `development` accepts whoever the caller
   * says they are and exists only for local runs and the test suite; the
   * default is deliberately `oidc`, so a missing value fails closed rather than
   * opening the platform.
   */
  mode: 'oidc' | 'development';
  /** Present when `mode` is `oidc`. */
  oidc: { issuer: string; clientId: string; audience: string; jwksUri?: string } | null;
  /**
   * The confidential-client half, present only when the browser sign-in flow is
   * configured (PLATFORM-010).
   *
   * `clientSecret` lives here and **only** here: it is read from the API's
   * environment, used in a server-to-server POST to the token endpoint, and is
   * never serialised into any response, any log line, or anything the frontend
   * can reach.
   */
  browserFlow: {
    clientSecret: string;
    redirectUri: string;
    /** Where the browser lands after sign-in and after sign-out. */
    appUrl: string;
    scopes: string[];
  } | null;
  cookie: AuthCookieConfig;
  /** Mirrors NODE_ENV, so the startup gate can see the deployment kind. */
  nodeEnv: string | undefined;
}

export interface ApiConfig {
  /** Structured logging, metrics, and the health listener (PLATFORM-003). */
  observability: ObservabilityConfig;
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
  /**
   * Secrets that were not configured and were filled from
   * `TERMINAL_SESSION_SECRET` instead — BETA-P0-010.
   *
   * Development only, and logged as such at startup. Under `NODE_ENV=production`
   * the list is always empty, because `loadConfig` refuses to start rather than
   * fall back: three secrets with one value are one secret, and a leaked
   * terminal session key would then also open `/internal` and invert namespace
   * names back into session ids.
   */
  developmentSecretFallbacks: string[];
  lifetimes: SessionLifetimeConfig;
  policy: SessionPolicy;
  /** Container-backed sandbox providers (PLATFORM-004). */
  sandbox: SandboxProviderConfig;
  /** Persistent learning state (PLATFORM-005). */
  /**
   * `databaseTransport` is resolved by `loadConfig` after the secret gate
   * (BETA-P0-012): null exactly when no database is configured.
   */
  progress: ProgressConfig & { databaseTransport: DatabaseTransportMode | null };
  reaperIntervalSeconds: number;
  sessionRetentionMinutes: number;
  nodeEnv: string;
  /**
   * Whether the Docker track can start sessions.
   *
   * Off still loads Docker lab definitions and lists them in the catalog; only
   * Start Lab refuses, with a message naming what *is* configured. That is the
   * honest behaviour on a host whose Docker daemon this service cannot reach.
   */
  dockerEnabled: boolean;
  /** `DOCKER_HOST` the orchestrator uses to manage sandboxes. Unset = default socket. */
  dockerHost: string | undefined;
  /**
   * Optional browser-facing origin (`https://labs.example.com`).
   *
   * When set, start-lab responses point the terminal WebSocket at this host
   * (via the web proxy). When unset, the API infers the origin from proxy
   * headers (`X-Forwarded-Proto`, `X-Forwarded-Host`).
   */
  publicOrigin: string | undefined;
  auth: AuthConfig;
}

/**
 * Where learning history is kept, and who it is attributed to.
 *
 * `database` is null when nothing is configured, and the API then runs on the
 * in-memory store and says so — on startup and on `/health`. It never invents a
 * connection string: there is no default host, user or password anywhere in
 * this codebase.
 */
export interface ProgressConfig {
  database: DatabaseConfig | null;
  /**
   * Apply pending migrations at startup.
   *
   * Forward-only and idempotent — it applies migration files this database has
   * not seen and does nothing else. It is emphatically not a "drop and recreate
   * the schema on boot" scheme; see services/progress/src/postgres/migrator.ts.
   * Deployments that migrate from a pipeline instead can switch it off.
   */
  autoMigrate: boolean;
  /** The development identity every request is attributed to. NOT a login. */
  devStudentId: string;
  /**
   * Whether `x-dev-student-id` may select a different student.
   *
   * Development only, and off by default. It exists so two browser tabs can act
   * as two students before authentication exists — which also means anyone who
   * can reach the API can read anyone's progress, so it must stay off anywhere
   * that holds real learner data.
   */
  allowStudentHeader: boolean;
}

/**
 * Which container-backed tracks this deployment offers, and from which images.
 *
 * The images are built on the host by `npm run sandbox:build`, deliberately not
 * by this process: building an image needs the container socket, and the same
 * rule that keeps kind cluster creation out of the API applies here. A provider
 * whose image is missing reports itself unavailable and its labs are marked as
 * such in the catalog — nothing pretends to be runnable.
 */
export interface SandboxProviderConfig {
  /** Container CLI to drive. Never taken from a request. */
  containerBinary: string;
  /**
   * Which runtime owns the sandboxes and namespaces this deployment creates.
   *
   * Resolved by `resolveRuntimeOwner` from `RUNTIME_OWNER_ID` — the same
   * function sandboxd uses — and handed to every provider, Kubernetes included.
   * Required under `NODE_ENV=production`; see docs/runtime-ownership.md.
   */
  runtimeOwner: string;
  /** Whether `runtimeOwner` was configured or is the development default. */
  runtimeOwnerSource: RuntimeOwnerSource;
  /**
   * The container runtime the per-session sandboxes live on.
   *
   * Empty means "this process' ambient Docker", which is what a laptop wants
   * and what every existing test assumes. A deployment sets it to a dedicated
   * runtime node — `tcp://sandbox-engine:2376` — so that creating a student's
   * sandbox does not require this web-facing service to hold the *host's*
   * daemon. It is deliberately separate from `DOCKER_HOST`: the Docker track's
   * `dind` engines and the container tracks' sandboxes can then live on
   * different daemons, which is the whole point.
   */
  runtimeHost: string;
  /** `DOCKER_CERT_PATH` for `runtimeHost`, when it speaks TLS. */
  runtimeCertPath: string;
  /**
   * The runtime broker's base URL, e.g. `http://sandboxd:4002`.
   *
   * Set, and this service creates and destroys student sandboxes **without
   * holding a container runtime at all** — it asks `sandboxd`, which is the
   * only process in the deployment with one. That is what makes the
   * container-backed tracks deployable without mounting the host Docker socket
   * into the service a browser can reach.
   *
   * Takes precedence over `runtimeHost`: a deployment that has a broker must
   * never quietly fall back to driving a daemon itself.
   */
  runtimeBrokerUrl: string;
  /**
   * How `runtimeBrokerUrl` is reached, and why that was allowed — BETA-P0-011.
   *
   * `null` without a broker. Carries the CA bundle trusted for this one
   * connection when the broker is `https://`. See `broker-transport.ts`.
   */
  runtimeBrokerTransport?: BrokerClientTransport | null;
  /**
   * This service's credentials for the broker, one per capability it uses.
   *
   * The API needs `runtime` (create, inspect and destroy sandboxes) and
   * `docker` (the Docker track's daemons). It is never given `attach`: opening
   * a student's shell is the terminal's job, and a credential this service
   * does not hold is one a bug here cannot use. See sandboxd's `scopes.ts`.
   */
  runtimeBrokerCredential: string;
  dockerBrokerCredential: string;
  linuxEnabled: boolean;
  linuxImage: string;
  terraformEnabled: boolean;
  terraformImage: string;
  ansibleEnabled: boolean;
  ansibleImage: string;
  cicdEnabled: boolean;
  cicdImage: string;
  /** Registered but never enabled — see providers.ts and README → Docker. */
  dockerImage: string;
}

/**
 * Secrets the API must never be given — BETA-P0-010.
 *
 * Opening a student's shell in a sandbox is the terminal's capability. A
 * credential this service never holds is one no bug here can use, so a
 * production API that finds it in its environment refuses to start rather than
 * quietly carrying it.
 */
export const API_FORBIDDEN_SECRETS: readonly string[] = ['SANDBOXD_ATTACH_SECRET'];

/**
 * Minimum length for credentials this platform receives rather than generates:
 * an identity provider's client secret, a managed database's password.
 */
const EXTERNAL_SECRET_MIN_LENGTH = 16;

/**
 * The database password, wherever the deployment put it.
 *
 * Compose hands the API a `DATABASE_URL` with the password inline; other
 * deployments inject `POSTGRES_PASSWORD` separately. Both are the same secret,
 * and the startup gates and the log redactor need the value either way. Never
 * logged, and the source is named so a refusal says which variable to fix.
 */
export function databasePasswordOf(database: DatabaseConfig | null): {
  source: string;
  value: string | undefined;
} {
  if (!database) return { source: 'POSTGRES_PASSWORD', value: undefined };
  if (database.url) {
    try {
      const raw = new URL(database.url).password;
      return { source: 'the password in DATABASE_URL', value: raw ? decodeURIComponent(raw) : undefined };
    } catch {
      return { source: 'the password in DATABASE_URL', value: undefined };
    }
  }
  return { source: 'POSTGRES_PASSWORD', value: database.password };
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


/**
 * Refuse to serve a production deployment from a localhost origin.
 *
 * Three values are derived from the app URL, and every one of them is something
 * a student's browser has to be able to reach:
 *
 *   · the OIDC `redirect_uri` — where the identity provider sends them back;
 *   · the post-logout redirect;
 *   · the terminal WebSocket URL handed out by Start Lab.
 *
 * All three defaulted to `http://localhost:3000` when nothing was configured,
 * and a default is exactly the wrong shape for them: a deployment that forgot
 * `PUBLIC_ORIGIN` did not fail to start, it started and issued sign-in links
 * pointing at the student's own machine. The symptom is a login loop and a
 * terminal that never connects, and neither says why.
 *
 * So in production the localhost default is not a default at all — it is a
 * refusal, in the same spirit as `AUTH_MODE=development` being refused there.
 * Development is untouched: `looksLocal` is the normal case on a laptop.
 */
export function assertPublicOriginConfigured(options: {
  nodeEnv: string;
  appUrl: string;
  looksLocal: boolean;
}): void {
  if (options.nodeEnv !== 'production' || !options.looksLocal) return;
  throw new Error(
    `NODE_ENV=production but the public origin resolved to '${options.appUrl}'. ` +
      'A production deployment cannot serve OIDC callbacks, logout redirects or ' +
      'terminal WebSocket URLs from localhost. ' +
      'Set PUBLIC_ORIGIN to the origin students use in the browser ' +
      '(and ALLOWED_ORIGINS to match), e.g. PUBLIC_ORIGIN=https://labs.example.com.',
  );
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

/** `k=v,k2=v2` → labels. Refuses anything else rather than guessing. */
function labelsFromEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: Record<string, string>,
): Record<string, string> {
  const raw = env[name]?.trim();
  if (!raw) return { ...fallback };
  const labels: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const match = /^\s*([A-Za-z0-9./_-]+)=([A-Za-z0-9._-]*)\s*$/.exec(pair);
    if (!match) throw new Error(`${name}: '${pair}' is not a label=value pair`);
    labels[match[1]!] = match[2]!;
  }
  return labels;
}

function listFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: string[]): string[] {
  const raw = env[name]?.trim();
  if (!raw) return [...fallback];
  return raw
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * BETA-P0-015 — the session network contract.
 *
 * Validated here, so a mistyped CIDR or an empty DNS selector stops the API at
 * startup instead of quietly widening what a student's Pods can reach.
 *
 * Under NODE_ENV=production two things are not negotiable:
 *   - NetworkPolicy is created (`NETWORK_POLICY_ENABLED=false` is refused), and
 *   - no student is admitted until the cluster carries a current PASS from the
 *     behavioural enforcement probe (`NETWORK_POLICY_ATTESTATION_REQUIRED`
 *     defaults on and `false` is refused). A cluster accepting NetworkPolicy
 *     objects is not evidence that anything enforces them.
 */
export function loadNetworkPolicyConfig(env: NodeJS.ProcessEnv = process.env): NetworkPolicyConfig {
  const base = DEFAULT_SESSION_POLICY.network;
  const production = isProductionEnv(env);
  const network: NetworkPolicyConfig = {
    name: strFromEnv(env, 'SESSION_NETWORKPOLICY_NAME', base.name),
    enabled: boolFromEnv(env, 'NETWORK_POLICY_ENABLED', base.enabled),
    dnsNamespace: strFromEnv(env, 'CLUSTER_DNS_NAMESPACE', base.dnsNamespace),
    dnsPodSelector: labelsFromEnv(env, 'CLUSTER_DNS_POD_SELECTOR', base.dnsPodSelector),
    podCidr: strFromEnv(env, 'CLUSTER_POD_CIDR', base.podCidr),
    serviceCidr: strFromEnv(env, 'CLUSTER_SERVICE_CIDR', base.serviceCidr),
    allowExternalEgress: boolFromEnv(env, 'ALLOW_EXTERNAL_EGRESS', base.allowExternalEgress),
    additionalDeniedEgressCidrs: listFromEnv(env, 'CLUSTER_EGRESS_DENY_CIDRS', base.additionalDeniedEgressCidrs),
    attestation: {
      required: boolFromEnv(env, 'NETWORK_POLICY_ATTESTATION_REQUIRED', production || base.attestation.required),
      maxAgeSeconds: intFromEnv(env, 'NETWORK_POLICY_ATTESTATION_MAX_AGE_SECONDS', base.attestation.maxAgeSeconds),
    },
  };
  assertValidNetworkPolicyConfig(network);

  if (production && !network.enabled) {
    throw new Error(
      'NODE_ENV=production refuses NETWORK_POLICY_ENABLED=false: every session namespace must be deny-by-default. ' +
        'If this cluster cannot enforce NetworkPolicy it cannot host students — see docs/kubernetes-network-security.md.',
    );
  }
  if (production && !network.attestation.required) {
    throw new Error(
      'NODE_ENV=production refuses NETWORK_POLICY_ATTESTATION_REQUIRED=false: students are admitted only after the ' +
        'enforcement probe has passed on this cluster (npm run verify:network-policy -- --write-attestation).',
    );
  }
  return network;
}

/**
 * Pod Security Admission levels for Kubernetes session namespaces (BETA-P0-016).
 *
 *   POD_SECURITY_ENFORCE   baseline | restricted   default baseline
 *   POD_SECURITY_WARN      baseline | restricted   default: the enforce level
 *   POD_SECURITY_AUDIT     baseline | restricted   default restricted
 *   POD_SECURITY_VERSION   v1.<minor> | latest     default v1.34
 *
 * `privileged` is not accepted anywhere, a warn or audit level weaker than the
 * enforce level is refused, and `latest` is refused under NODE_ENV=production —
 * see `assertPodSecurityConfig` and docs/pod-security.md.
 */
export function loadPodSecurityConfig(env: NodeJS.ProcessEnv = process.env): PodSecurityConfig {
  const base = DEFAULT_POD_SECURITY;
  const enforce = strFromEnv(env, 'POD_SECURITY_ENFORCE', base.enforce);
  const config = {
    enforce,
    warn: strFromEnv(env, 'POD_SECURITY_WARN', enforce),
    audit: strFromEnv(env, 'POD_SECURITY_AUDIT', base.audit),
    version: strFromEnv(env, 'POD_SECURITY_VERSION', base.version),
  } as PodSecurityConfig;
  assertPodSecurityConfig(config, { production: isProductionEnv(env) });
  return config;
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
    network: loadNetworkPolicyConfig(env),
    serviceAccountName: strFromEnv(env, 'SESSION_SERVICE_ACCOUNT', base.serviceAccountName),
    podSecurity: loadPodSecurityConfig(env),
    credentialTtlSeconds: intFromEnv(
      env,
      'STUDENT_CREDENTIAL_TTL_SECONDS',
      base.credentialTtlSeconds,
    ),
    /*
     * Container sandbox bounds — the Linux/Terraform analogue of the
     * ResourceQuota and LimitRange above, and configurable for the same
     * reason: production values belong in configuration, not in provider code.
     */
    sandbox: {
      cpus: strFromEnv(env, 'SANDBOX_CPUS', base.sandbox.cpus),
      memory: strFromEnv(env, 'SANDBOX_MEMORY', base.sandbox.memory),
      pidsLimit: intFromEnv(env, 'SANDBOX_PIDS_LIMIT', base.sandbox.pidsLimit),
      tmpfsSize: strFromEnv(env, 'SANDBOX_TMPFS_SIZE', base.sandbox.tmpfsSize),
      user: strFromEnv(env, 'SANDBOX_USER', base.sandbox.user),
      home: strFromEnv(env, 'SANDBOX_HOME', base.sandbox.home),
      // Not raised casually: a lab that needs egress is a cost and a security
      // decision, not a convenience.
      network: strFromEnv(env, 'SANDBOX_NETWORK', base.sandbox.network),
    },
    docker: loadDockerSandboxPolicy(env),
  };
}

/**
 * Resource controls for Docker sandboxes.
 *
 * Same rule as everything else here: no limit is hardcoded in provider code.
 * The sandbox container's memory, CPU, and process caps bound the *whole*
 * session, because every container a student starts is a child of that one
 * process tree — so these three values are the limits that actually bind.
 */
export function loadDockerSandboxPolicy(
  env: NodeJS.ProcessEnv = process.env,
): DockerSandboxPolicy {
  const base = DEFAULT_SESSION_POLICY.docker;
  const mirror = strFromEnv(env, 'DOCKER_SANDBOX_REGISTRY_MIRROR', '');

  return {
    image: strFromEnv(env, 'DOCKER_SANDBOX_IMAGE', base.image),
    // Docker-in-Docker cannot run unprivileged. The flag is exposed so an
    // operator can *turn it off* on a host with a rootless alternative, and so
    // that the requirement is visible in configuration rather than buried.
    privileged: boolFromEnv(env, 'DOCKER_SANDBOX_PRIVILEGED', base.privileged),
    memory: strFromEnv(env, 'DOCKER_SANDBOX_MEMORY', base.memory),
    cpus: strFromEnv(env, 'DOCKER_SANDBOX_CPUS', base.cpus),
    pidsLimit: intFromEnv(env, 'DOCKER_SANDBOX_PIDS_LIMIT', base.pidsLimit),
    maxContainers: intFromEnv(env, 'DOCKER_SANDBOX_MAX_CONTAINERS', base.maxContainers),
    network: strFromEnv(env, 'DOCKER_SANDBOX_NETWORK', base.network),
    daemonPort: intFromEnv(env, 'DOCKER_SANDBOX_DAEMON_PORT', base.daemonPort),
    readyTimeoutSeconds: intFromEnv(
      env,
      'DOCKER_SANDBOX_READY_TIMEOUT_SECONDS',
      base.readyTimeoutSeconds,
    ),
    restartAttempts: intFromEnv(env, 'DOCKER_SANDBOX_RESTART_ATTEMPTS', base.restartAttempts),
    ...(mirror ? { registryMirror: mirror } : {}),
  };
}

/** Persistence + development identity settings. */
export function loadProgressConfig(env: NodeJS.ProcessEnv = process.env): ProgressConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  return {
    database: loadDatabaseConfig(env),
    autoMigrate: boolFromEnv(env, 'DATABASE_AUTO_MIGRATE', true),
    devStudentId: strFromEnv(env, 'DEV_STUDENT_ID', DEFAULT_DEV_STUDENT_ID),
    // Opt-in, and never on by default in production even if someone forgets.
    allowStudentHeader:
      nodeEnv === 'production'
        ? boolFromEnv(env, 'DEV_STUDENT_HEADER_ENABLED', false)
        : boolFromEnv(env, 'DEV_STUDENT_HEADER_ENABLED', true),
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

  const authMode = strFromEnv(env, 'AUTH_MODE', 'oidc');
  if (authMode !== 'oidc' && authMode !== 'development') {
    throw new Error(`AUTH_MODE must be 'oidc' or 'development', not '${authMode}'.`);
  }
  const issuer = strFromEnv(env, 'OIDC_ISSUER', '');
  const audience = strFromEnv(env, 'OIDC_AUDIENCE', '');
  const jwksUri = strFromEnv(env, 'OIDC_JWKS_URI', '');

  const observability = loadObservabilityConfig({ service: 'api', defaultPort: 9400, env });

  /*
   * The scrape token is read-only and is handed to a monitoring system; the
   * secrets below authorise privileged internal operations. Sharing one value
   * would collapse that boundary — the same argument `sandboxd` already makes
   * about its three scope secrets, applied across services.
   */
  assertScrapeTokenIsDistinct(observability.scrapeToken, {
    TERMINAL_SESSION_SECRET: secret,
    INTERNAL_SERVICE_SECRET: env.INTERNAL_SERVICE_SECRET,
    NAMESPACE_DERIVATION_SECRET: env.NAMESPACE_DERIVATION_SECRET,
    SANDBOXD_RUNTIME_SECRET: env.SANDBOXD_RUNTIME_SECRET,
    SANDBOXD_DOCKER_SECRET: env.SANDBOXD_DOCKER_SECRET,
    SANDBOXD_ATTACH_SECRET: env.SANDBOXD_ATTACH_SECRET,
    OIDC_CLIENT_SECRET: env.OIDC_CLIENT_SECRET,
    POSTGRES_PASSWORD: env.POSTGRES_PASSWORD,
  });

  const publicOrigin = env.PUBLIC_ORIGIN?.trim() || undefined;
  const allowedOrigins = (env.ALLOWED_ORIGINS ?? 'http://localhost:3000')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  /*
   * Where the browser lives, so the callback knows where to send it back to.
   *
   * PUBLIC_ORIGIN when set, otherwise the first allowed origin — which is the
   * only origin a cookie-carrying browser could have come from anyway, since
   * CORS refuses the rest.
   */
  const appUrl = (publicOrigin ?? allowedOrigins[0] ?? 'http://localhost:3000').replace(/\/$/, '');
  const clientSecret = strFromEnv(env, 'OIDC_CLIENT_SECRET', '');
  const redirectUri = strFromEnv(env, 'OIDC_REDIRECT_URI', '') || `${appUrl}/auth/callback`;

  /*
   * `Secure` unless this is demonstrably a plain-HTTP localhost run.
   *
   * The failure mode to avoid is a production deployment that forgets the
   * setting and silently ships a cookie a proxy can read. So the default is on,
   * and losing it requires the app URL itself to say `http://localhost`.
   */
  const looksLocal = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(appUrl);
  const cookieSecure = boolFromEnv(env, 'AUTH_COOKIE_SECURE', !looksLocal);

  /*
   * BETA-P0-014 — rules on the browser session that hold in every environment.
   *
   * A lifetime is a security bound only if it is bounded: an operator who sets
   * a year has built a remember-me token without meaning to. A cookie name is
   * checked here, at startup, rather than at the first sign-in that would throw.
   */
  const cookieName = strFromEnv(env, 'AUTH_COOKIE_NAME', 'jtt_session');
  if (!isValidCookieName(cookieName)) {
    throw new Error(`AUTH_COOKIE_NAME '${cookieName}' is not a valid cookie name.`);
  }
  const authSessionTtlSeconds = intFromEnv(env, 'AUTH_SESSION_TTL_SECONDS', DEFAULT_AUTH_SESSION_TTL_SECONDS);
  if (authSessionTtlSeconds < MIN_AUTH_SESSION_TTL_SECONDS || authSessionTtlSeconds > MAX_AUTH_SESSION_TTL_SECONDS) {
    throw new Error(
      `AUTH_SESSION_TTL_SECONDS must be between ${MIN_AUTH_SESSION_TTL_SECONDS} and ${MAX_AUTH_SESSION_TTL_SECONDS}, got ${authSessionTtlSeconds}.`,
    );
  }
  const scopes = strFromEnv(env, 'OIDC_SCOPES', 'openid profile email')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (authMode === 'oidc' && clientSecret) {
    const problems = scopeProblems(scopes);
    if (problems.length > 0) throw new Error(problems.join(' '));
  }

  assertPublicOriginConfigured({ nodeEnv: env.NODE_ENV ?? 'development', appUrl, looksLocal });

  // Fails closed in production: a missing owner is a refusal to start, not a
  // default the API could disagree with sandboxd about.
  const runtimeOwner = resolveRuntimeOwner(env);

  /*
   * BETA-P0-010 — every secret is its own value, and production says so.
   *
   * INTERNAL_SERVICE_SECRET and NAMESPACE_DERIVATION_SECRET used to *default* to
   * TERMINAL_SESSION_SECRET, in code and in compose alike. That made the one
   * value the terminal holds to verify browser tokens also the key to
   * `/internal` (anyone's kubeconfig) and the key that hides session ids behind
   * namespace names. The fallback survives for a laptop running
   * `npm run dev:api` with one generated value, is reported at startup, and is
   * refused outright in production.
   */
  const explicitInternalSecret = env.INTERNAL_SERVICE_SECRET?.trim() ?? '';
  const explicitNamespaceSecret = env.NAMESPACE_DERIVATION_SECRET?.trim() ?? '';
  const developmentSecretFallbacks = [
    ...(explicitInternalSecret ? [] : ['INTERNAL_SERVICE_SECRET']),
    ...(explicitNamespaceSecret ? [] : ['NAMESPACE_DERIVATION_SECRET']),
  ];

  const runtimeBrokerUrl = strFromEnv(env, 'SANDBOX_BROKER_URL', '');
  const runtimeBrokerCredential = strFromEnv(env, 'SANDBOXD_RUNTIME_SECRET', '');
  const dockerBrokerCredential = strFromEnv(env, 'SANDBOXD_DOCKER_SECRET', '');
  const dockerEnabled = boolFromEnv(env, 'DOCKER_TRACK_ENABLED', true);
  const progress = loadProgressConfig(env);

  if (isProductionEnv(env)) {
    const databasePassword = databasePasswordOf(progress.database);
    assertProductionSecrets({
      service: 'api',
      env,
      secrets: [
        { name: 'TERMINAL_SESSION_SECRET', value: secret, required: true },
        { name: 'INTERNAL_SERVICE_SECRET', value: explicitInternalSecret, required: true },
        { name: 'NAMESPACE_DERIVATION_SECRET', value: explicitNamespaceSecret, required: true },
        // Only what this service uses: `runtime` whenever sandboxes are
        // brokered, `docker` only when the Docker track is brokered too.
        {
          name: 'SANDBOXD_RUNTIME_SECRET',
          value: runtimeBrokerCredential,
          required: runtimeBrokerUrl !== '',
        },
        {
          name: 'SANDBOXD_DOCKER_SECRET',
          value: dockerBrokerCredential,
          required: runtimeBrokerUrl !== '' && dockerEnabled,
        },
        { name: 'OBSERVABILITY_SCRAPE_TOKEN', value: observability.scrapeToken, required: true },
        // BETA-P0-014: required in production. The API is the confidential
        // client and the browser flow is the only way a student signs in, so a
        // production API without it is one nobody can use. Outside production
        // it stays optional, and browser sign-in is simply off.
        {
          name: 'OIDC_CLIENT_SECRET',
          value: clientSecret,
          required: authMode === 'oidc',
          minLength: EXTERNAL_SECRET_MIN_LENGTH,
        },
        {
          name: databasePassword.source,
          value: databasePassword.value,
          required: progress.database !== null,
          minLength: EXTERNAL_SECRET_MIN_LENGTH,
        },
      ],
      forbidden: API_FORBIDDEN_SECRETS,
    });
  }

  /*
   * BETA-P0-011 — the runtime and Docker capabilities travel to sandboxd, which
   * may be on another host. After the secret gate, so a missing secret is still
   * reported as one. Production refuses plaintext to anything but loopback or a
   * declared single-host bridge; see `broker-transport.ts`.
   */
  assertTlsVerificationEnabled(env, 'api');

  /*
   * BETA-P0-014 — production sign-in fails closed. After the secret and TLS
   * gates, so a weak secret or disabled verification is still reported as
   * itself. See `auth/production-auth.ts` for every rule and why.
   */
  if (isProductionEnv(env)) {
    assertProductionAuthConfig({
      mode: authMode,
      issuer,
      clientId: strFromEnv(env, 'OIDC_CLIENT_ID', ''),
      clientSecretPresent: clientSecret !== '',
      audience,
      jwksUri,
      publicOrigin: publicOrigin ?? '',
      redirectUri,
      allowedOrigins,
      cookieSecure,
      cookieDomain: env.AUTH_COOKIE_DOMAIN?.trim() || undefined,
      scopes,
      devStudentHeaderEnabled: progress.allowStudentHeader,
      // Presence only. Whether it is reached safely is the database transport
      // gate's decision, below (BETA-P0-012).
      databaseConfigured: progress.database !== null,
    });
  }

  const runtimeBrokerTransport = runtimeBrokerUrl
    ? resolveBrokerClientTransport(env, { service: 'api', url: runtimeBrokerUrl })
    : null;

  /*
   * BETA-P0-012 — the database password and every student's history travel to
   * PostgreSQL. Last, so the owner, secret and broker refusals keep their
   * precedence. Production refuses plaintext to anything but a Unix socket,
   * loopback, or a declared single-host bridge, and TLS is always verified; see
   * services/progress/src/postgres/tls.ts.
   */
  const databaseTransport = progress.database
    ? resolveDatabaseTransport(progress.database, env, 'api').mode
    : null;

  return {
    /*
     * `oidc` is the default on purpose.
     *
     * A missing AUTH_MODE must fail closed. If the default were `development`,
     * an environment file that lost the line would not fail to start — it would
     * start with no authentication at all, which is the worst possible outcome
     * and the hardest to notice.
     */
    auth: {
      mode: authMode,
      oidc:
        authMode === 'oidc'
          ? {
              issuer,
              clientId: strFromEnv(env, 'OIDC_CLIENT_ID', ''),
              audience,
              ...(jwksUri ? { jwksUri } : {}),
            }
          : null,
      /*
       * Null unless a client secret is present.
       *
       * The browser flow is opt-in on the secret rather than on a boolean: a
       * deployment cannot accidentally advertise a sign-in route it has no
       * credential to complete, and `/auth/config` can tell the frontend
       * truthfully whether signing in is possible here.
       */
      browserFlow:
        authMode === 'oidc' && clientSecret
          ? {
              clientSecret,
              redirectUri,
              appUrl,
              scopes,
            }
          : null,
      cookie: {
        name: cookieName,
        secure: cookieSecure,
        domain: env.AUTH_COOKIE_DOMAIN?.trim() || undefined,
        ttlSeconds: authSessionTtlSeconds,
      },
      nodeEnv: env.NODE_ENV,
    },
    port: intFromEnv(env, 'API_PORT', 4000),
    labsDir: env.LABS_DIR ?? path.join(repoRoot, 'labs'),
    provider: env.LAB_PROVIDER ?? 'kind',
    clusterName: env.LAB_CLUSTER_NAME ?? 'jumptotech-labs',
    kubeconfigPath: env.KUBECONFIG || undefined,
    allowedOrigins,
    terminalSessionSecret: secret,
    terminalSessionTtlSeconds: intFromEnv(env, 'TERMINAL_SESSION_TTL_SECONDS', 3600),
    terminalWsUrl: env.VITE_TERMINAL_WS_URL ?? 'ws://localhost:4001',
    terminalControlUrl: env.TERMINAL_CONTROL_URL || undefined,
    // The fallback is development-only: production refused above.
    internalServiceSecret: explicitInternalSecret || secret,
    namespaceSecret: explicitNamespaceSecret || secret,
    developmentSecretFallbacks,
    lifetimes: {
      maxSessionSeconds,
      idleTimeoutSeconds,
      warningSeconds,
      maxActiveSessions: intFromEnv(env, 'MAX_ACTIVE_SESSIONS', 20),
      // Private beta policy: one live lab per student. Independent of
      // MAX_ACTIVE_SESSIONS, which still binds on its own — see README → Capacity.
      maxActiveSessionsPerStudent: intFromEnv(env, 'MAX_ACTIVE_SESSIONS_PER_STUDENT', 1),
    },
    policy: loadSessionPolicy(env),
    sandbox: {
      containerBinary: strFromEnv(env, 'SANDBOX_CONTAINER_BINARY', 'docker'),
      runtimeOwner: runtimeOwner.owner,
      runtimeOwnerSource: runtimeOwner.source,
      runtimeHost: strFromEnv(env, 'SANDBOX_RUNTIME_HOST', ''),
      runtimeCertPath: strFromEnv(env, 'SANDBOX_RUNTIME_CERT_PATH', ''),
      runtimeBrokerUrl,
      runtimeBrokerTransport,
      runtimeBrokerCredential,
      dockerBrokerCredential,
      linuxEnabled: boolFromEnv(env, 'LINUX_PROVIDER_ENABLED', true),
      linuxImage: strFromEnv(env, 'LINUX_SANDBOX_IMAGE', DEFAULT_LINUX_SANDBOX_IMAGE),
      terraformEnabled: boolFromEnv(env, 'TERRAFORM_PROVIDER_ENABLED', true),
      terraformImage: strFromEnv(env, 'TERRAFORM_SANDBOX_IMAGE', DEFAULT_TERRAFORM_SANDBOX_IMAGE),
      ansibleEnabled: boolFromEnv(env, 'ANSIBLE_PROVIDER_ENABLED', true),
      ansibleImage: strFromEnv(env, 'ANSIBLE_SANDBOX_IMAGE', DEFAULT_ANSIBLE_SANDBOX_IMAGE),
      cicdEnabled: boolFromEnv(env, 'CICD_PROVIDER_ENABLED', true),
      cicdImage: strFromEnv(env, 'CICD_SANDBOX_IMAGE', DEFAULT_CICD_SANDBOX_IMAGE),
      dockerImage: strFromEnv(env, 'DOCKER_SANDBOX_IMAGE', DEFAULT_DOCKER_SANDBOX_IMAGE),
    },
    progress: { ...progress, databaseTransport },
    reaperIntervalSeconds: intFromEnv(env, 'CLEANUP_INTERVAL_SECONDS', 60),
    sessionRetentionMinutes: intFromEnv(env, 'SESSION_RETENTION_MINUTES', 15),
    nodeEnv: env.NODE_ENV ?? 'development',
    dockerEnabled,
    dockerHost: env.DOCKER_HOST || undefined,
    publicOrigin,
    observability,
  };
}
