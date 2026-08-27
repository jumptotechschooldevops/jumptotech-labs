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
  DEFAULT_ANSIBLE_SANDBOX_IMAGE,
  DEFAULT_CICD_SANDBOX_IMAGE,
  DEFAULT_TERRAFORM_SANDBOX_IMAGE,
  type DockerSandboxPolicy,
  type SessionLifetimeConfig,
  type SessionPolicy,
  DEFAULT_RUNTIME_OWNER,
} from '@jumptotech/lab-orchestrator';
import {
  DEFAULT_DEV_STUDENT_ID,
  loadDatabaseConfig,
  type DatabaseConfig,
} from '@jumptotech/progress';
import { DEFAULT_AUTH_SESSION_TTL_SECONDS } from './auth/browser-session.js';

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
  /** Container-backed sandbox providers (PLATFORM-004). */
  sandbox: SandboxProviderConfig;
  /** Persistent learning state (PLATFORM-005). */
  progress: ProgressConfig;
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
   * Which runtime owns the sandboxes this deployment creates.
   *
   * One production deployment is one runtime and never sets this. It exists for
   * the case where several run against one Docker daemon — seven curriculum
   * worktrees on a laptop — so that each reaps only what it created.
   */
  runtimeOwner: string;
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

  assertPublicOriginConfigured({ nodeEnv: env.NODE_ENV ?? 'development', appUrl, looksLocal });

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
              scopes: strFromEnv(env, 'OIDC_SCOPES', 'openid profile email')
                .split(/[\s,]+/)
                .map((s) => s.trim())
                .filter(Boolean),
            }
          : null,
      cookie: {
        name: strFromEnv(env, 'AUTH_COOKIE_NAME', 'jtt_session'),
        secure: cookieSecure,
        domain: env.AUTH_COOKIE_DOMAIN?.trim() || undefined,
        ttlSeconds: intFromEnv(env, 'AUTH_SESSION_TTL_SECONDS', DEFAULT_AUTH_SESSION_TTL_SECONDS),
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
    sandbox: {
      containerBinary: strFromEnv(env, 'SANDBOX_CONTAINER_BINARY', 'docker'),
      runtimeOwner: strFromEnv(env, 'RUNTIME_OWNER_ID', DEFAULT_RUNTIME_OWNER),
      runtimeHost: strFromEnv(env, 'SANDBOX_RUNTIME_HOST', ''),
      runtimeCertPath: strFromEnv(env, 'SANDBOX_RUNTIME_CERT_PATH', ''),
      runtimeBrokerUrl: strFromEnv(env, 'SANDBOX_BROKER_URL', ''),
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
    progress: loadProgressConfig(env),
    reaperIntervalSeconds: intFromEnv(env, 'CLEANUP_INTERVAL_SECONDS', 60),
    sessionRetentionMinutes: intFromEnv(env, 'SESSION_RETENTION_MINUTES', 15),
    nodeEnv: env.NODE_ENV ?? 'development',
    dockerEnabled: boolFromEnv(env, 'DOCKER_TRACK_ENABLED', true),
    dockerHost: env.DOCKER_HOST || undefined,
    publicOrigin,
  };
}
