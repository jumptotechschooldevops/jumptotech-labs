/**
 * The production-host deployment contract, as data and pure checks.
 *
 * The private-beta release gate proved the software on a laptop and on CI
 * runners. A production host adds the part those runs never exercised: the
 * operator's own `.env`, merged by Docker Compose into the five production files,
 * and read by the services' real configuration loaders. This module is the one
 * definition of "that merged configuration is the one the beta was proven with".
 *
 * Deliberately free of I/O: no process, no socket, no file. Two callers feed it:
 *
 *   · scripts/production-config-check.ts, with `docker compose config` output
 *     and the real api/terminal/sandboxd loaders — on the host, and in CI with
 *     sentinel environments (`--self-test`);
 *   · services/observability/test/production-host-contract.test.ts, with
 *     fabricated resolved configurations, in every `npm test`.
 *
 * Nothing here returns or prints a configuration value that could be a secret.
 * A finding names services, variables and ports; a loader refusal is passed
 * through `redactValues` first.
 */
import { BETA_CONTRACT } from './beta-validation-contract.js';

/** The production composition, in the order the runbook's `prod` function uses. */
export const PRODUCTION_COMPOSE_FILES = Object.freeze([
  'docker-compose.yml',
  'docker-compose.runtime.yml',
  'docker-compose.observability.yml',
  'docker-compose.production.yml',
  'docker-compose.production-observability.yml',
] as const);

export const PRODUCTION_COMPOSE_PROFILES = Object.freeze(['observability'] as const);

/** Every service the production command starts. A missing one means a missing file or profile. */
export const PRODUCTION_SERVICES = Object.freeze([
  'alertmanager',
  'api',
  'grafana',
  'postgres',
  'prometheus',
  'sandboxd',
  'terminal',
  'web',
] as const);

/** The three services whose configuration loaders enforce the production gates. */
export const GATED_SERVICES = Object.freeze(['api', 'terminal', 'sandboxd'] as const);
export type GatedService = (typeof GATED_SERVICES)[number];

/** What `publishedPorts.production` + `operatorLoopback` in infrastructure/secret-distribution.json allow. */
export const PRODUCTION_PUBLICATIONS = Object.freeze([
  { service: 'web', published: 443, target: 8443, loopbackOnly: false },
  { service: 'web', published: 80, target: 8080, loopbackOnly: false },
  // Grafana, inside Prometheus's network namespace, for an operator's SSH tunnel.
  { service: 'prometheus', published: undefined, target: 3000, loopbackOnly: true },
] as const);

/**
 * The one restart policy production uses (docker-compose.production.yml,
 * BETA-overnight hardening, pinned by private-beta-operations.test.ts).
 * `unless-stopped`, never `always`: `prod stop web` is the runbook's only way to
 * take the site down, and `always` would undo it at the next daemon restart.
 */
export const PRODUCTION_RESTART_POLICY = 'unless-stopped';

/**
 * The host names the web edge's certificate gate accepts from PUBLIC_ORIGIN
 * (infrastructure/docker/nginx/tls-preflight.sh, `public_host`): lower-case DNS
 * labels, at least two of them, the last starting with a letter — so no IP
 * address, no port and no single-label name such as `localhost`. The api's own
 * loader accepts all three, so without this the check passed a configuration
 * whose edge then exits at every start. Kept identical to the gate's pattern by
 * production-host-contract.test.ts.
 */
export const EDGE_PUBLIC_HOST_PATTERN = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** How the api reads a boolean variable (apps/api/src/config.ts `boolFromEnv`). */
const isTrue = (value: string | undefined): boolean => ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());

export type CheckStatus = 'PASS' | 'FAIL' | 'WARN' | 'MANUAL' | 'INFO';

export interface CheckResult {
  /** Stable, dotted, greppable: `exposure.published-ports`. */
  id: string;
  status: CheckStatus;
  /** Names and numbers only. Never a configuration value that could be a secret. */
  detail: string;
}

/** The subset of `docker compose config --format json` this contract reads. */
export interface ResolvedPort {
  target: number | string;
  published?: number | string;
  host_ip?: string;
  protocol?: string;
}

export interface ResolvedVolume {
  type: string;
  source?: string;
  target: string;
  read_only?: boolean;
}

export interface ResolvedService {
  environment?: Record<string, string | null>;
  ports?: ResolvedPort[];
  volumes?: ResolvedVolume[];
  networks?: Record<string, unknown>;
  network_mode?: string;
  privileged?: boolean;
  cap_add?: string[];
  restart?: string;
  healthcheck?: { test?: string[] | string; disable?: boolean };
  command?: string[] | string;
  group_add?: Array<string | number>;
}

export interface ResolvedCompose {
  services?: Record<string, ResolvedService>;
  networks?: Record<string, { internal?: boolean; external?: boolean; name?: string }>;
  volumes?: Record<string, { name?: string; external?: boolean }>;
}

export interface CompositionOptions {
  /** Absolute path of the checkout, to recognise the in-checkout backup-status default. */
  repoRoot?: string;
  /** The gid owning the host's /var/run/docker.sock, when the caller could read it. */
  hostDockerSocketGid?: number;
}

const env = (service: ResolvedService | undefined, name: string): string | undefined => {
  const value = service?.environment?.[name];
  return value === null || value === undefined ? undefined : String(value);
};

const commandOf = (service: ResolvedService | undefined): string[] =>
  Array.isArray(service?.command) ? service.command.map(String) : service?.command ? [String(service.command)] : [];

const pass = (id: string, detail: string): CheckResult => ({ id, status: 'PASS', detail });
const fail = (id: string, detail: string): CheckResult => ({ id, status: 'FAIL', detail });
const warn = (id: string, detail: string): CheckResult => ({ id, status: 'WARN', detail });

function one(id: string, problems: string[], ok: string): CheckResult {
  return problems.length === 0 ? pass(id, ok) : fail(id, problems.join('; '));
}

/**
 * Every check this contract makes on a resolved production composition.
 *
 * Order is the order an operator should fix things in: shape, exposure,
 * privilege, then the gates, then durability.
 */
export function evaluateProductionComposition(config: ResolvedCompose, options: CompositionOptions = {}): CheckResult[] {
  const services = config.services ?? {};
  const results: CheckResult[] = [];

  // --- shape -------------------------------------------------------------------
  const missing = PRODUCTION_SERVICES.filter((name) => !services[name]);
  const unexpected = Object.keys(services).filter((name) => !(PRODUCTION_SERVICES as readonly string[]).includes(name));
  results.push(
    one(
      'compose.services',
      [
        ...(missing.length ? [`missing ${missing.join(', ')} (a compose file or --profile observability was left out)`] : []),
        ...(unexpected.length ? [`unexpected ${unexpected.join(', ')} (not part of the reviewed production stack)`] : []),
      ],
      `${PRODUCTION_SERVICES.length} services: ${PRODUCTION_SERVICES.join(', ')}`,
    ),
  );

  // --- public exposure ---------------------------------------------------------
  const exposure: string[] = [];
  const seen = new Set<string>();
  for (const [name, service] of Object.entries(services)) {
    for (const port of service.ports ?? []) {
      const target = Number(port.target);
      const published = port.published === undefined || port.published === '' ? undefined : Number(port.published);
      const hostIp = port.host_ip ?? '';
      const allowed = PRODUCTION_PUBLICATIONS.find(
        (entry) =>
          entry.service === name &&
          entry.target === target &&
          (entry.published === undefined || entry.published === published),
      );
      const where = `${hostIp || 'every interface'}:${published ?? '?'} -> ${name}:${target}`;
      if (!allowed) {
        exposure.push(`${where} is not an allowed publication`);
      } else if (allowed.loopbackOnly && hostIp !== '127.0.0.1') {
        exposure.push(`${where} must bind 127.0.0.1`);
      } else {
        seen.add(`${name}:${target}`);
      }
    }
  }
  for (const entry of PRODUCTION_PUBLICATIONS) {
    if (!seen.has(`${entry.service}:${entry.target}`) && services[entry.service]) {
      exposure.push(`${entry.service}:${entry.target} is not published (${entry.loopbackOnly ? '127.0.0.1 operator port' : `host ${entry.published}`})`);
    }
  }
  results.push(one('exposure.published-ports', exposure, 'only 443 -> web:8443, 80 -> web:8080 and 127.0.0.1 -> grafana:3000'));

  const database = config.networks?.database;
  const databaseMembers = Object.entries(services)
    .filter(([, service]) => Object.keys(service.networks ?? {}).includes('database'))
    .map(([name]) => name)
    .sort();
  results.push(
    one(
      'exposure.database',
      [
        ...((services.postgres?.ports ?? []).length ? ['postgres publishes a host port'] : []),
        ...(database?.internal === true ? [] : ['the database network is not internal: true']),
        ...(databaseMembers.join(',') === 'api,postgres' ? [] : [`database network members are ${databaseMembers.join(', ') || 'none'}, not api, postgres`]),
      ],
      'postgres publishes nothing and shares an internal network with the api only',
    ),
  );

  const observabilityProblems: string[] = [];
  const prometheusCommand = commandOf(services.prometheus);
  const alertmanagerCommand = commandOf(services.alertmanager);
  if (services.prometheus) {
    if (!prometheusCommand.includes('--web.listen-address=127.0.0.1:9090')) observabilityProblems.push('prometheus does not listen on 127.0.0.1 only');
    if (prometheusCommand.includes('--web.enable-lifecycle')) observabilityProblems.push('prometheus has its lifecycle API on');
  }
  if (services.alertmanager) {
    if (!alertmanagerCommand.includes('--web.listen-address=127.0.0.1:9093')) observabilityProblems.push('alertmanager does not listen on 127.0.0.1 only');
    if (services.alertmanager.network_mode !== 'service:prometheus') observabilityProblems.push("alertmanager is not in prometheus's network namespace");
  }
  if (services.grafana) {
    if (services.grafana.network_mode !== 'service:prometheus') observabilityProblems.push("grafana is not in prometheus's network namespace");
    if (env(services.grafana, 'GF_AUTH_ANONYMOUS_ENABLED') !== 'false') observabilityProblems.push('grafana anonymous access is not off');
    if (env(services.grafana, 'GF_AUTH_BASIC_ENABLED') !== 'false') observabilityProblems.push('grafana basic-auth API is not off');
  }
  results.push(one('exposure.observability', observabilityProblems, 'prometheus and alertmanager on loopback in one namespace; grafana behind a login'));

  // --- privilege ---------------------------------------------------------------
  const socketHolders = Object.entries(services)
    .filter(([, service]) => (service.volumes ?? []).some((volume) => volume.source === '/var/run/docker.sock' || volume.target === '/var/run/docker.sock'))
    .map(([name]) => name);
  results.push(
    one(
      'privilege.docker-socket',
      socketHolders.join(',') === 'sandboxd' ? [] : [`the Docker socket is mounted into ${socketHolders.join(', ') || 'no service'}; only sandboxd may hold it`],
      'only sandboxd mounts /var/run/docker.sock',
    ),
  );

  const privilegeProblems: string[] = [];
  for (const [name, service] of Object.entries(services)) {
    if (service.privileged === true) privilegeProblems.push(`${name} is privileged`);
    const added = (service.cap_add ?? []).map((cap) => cap.toUpperCase().replace(/^CAP_/, '')).sort();
    const allowedAdds = name === 'terminal' ? ['SETGID', 'SETUID'] : [];
    const extra = added.filter((cap) => !allowedAdds.includes(cap));
    if (extra.length) privilegeProblems.push(`${name} adds ${extra.join(', ')}`);
    if (service.network_mode === 'host') privilegeProblems.push(`${name} uses the host network`);
  }
  results.push(one('privilege.containers', privilegeProblems, 'no compose service is privileged, on the host network, or given a capability beyond the terminal SETUID/SETGID drop'));

  if (options.hostDockerSocketGid !== undefined && services.sandboxd) {
    const groups = (services.sandboxd.group_add ?? []).map(String);
    results.push(
      groups.includes(String(options.hostDockerSocketGid))
        ? pass('runtime.docker-socket-gid', `sandboxd joins gid ${options.hostDockerSocketGid}, the socket's group`)
        : fail(
            'runtime.docker-socket-gid',
            `sandboxd joins gid ${groups.join(', ') || 'none'} but /var/run/docker.sock belongs to gid ${options.hostDockerSocketGid}; set DOCKER_SOCKET_GID=${options.hostDockerSocketGid} in .env`,
          ),
    );
  }

  // --- the production gates ----------------------------------------------------
  results.push(
    one(
      'gates.node-env',
      GATED_SERVICES.filter((name) => services[name] && env(services[name], 'NODE_ENV') !== 'production').map(
        (name) => `${name} does not run with NODE_ENV=production`,
      ),
      'api, terminal and sandboxd run with NODE_ENV=production',
    ),
  );

  results.push(
    one(
      'gates.authentication',
      [
        ...(env(services.api, 'AUTH_MODE') === 'oidc' ? [] : ['the api is not pinned to AUTH_MODE=oidc']),
        ...(env(services.api, 'DEV_STUDENT_HEADER_ENABLED') === 'true' ? ['DEV_STUDENT_HEADER_ENABLED=true would let a header name any student'] : []),
      ],
      'AUTH_MODE=oidc pinned; the development student header is off',
    ),
  );

  // Values the api loader accepts that break or widen sign-in (apps/api/src/routes/auth.ts, index.ts).
  const cookieName = env(services.api, 'AUTH_COOKIE_NAME') ?? '';
  const clientId = env(services.api, 'OIDC_CLIENT_ID');
  const audience = env(services.api, 'OIDC_AUDIENCE');
  const redirectUri = env(services.api, 'OIDC_REDIRECT_URI')?.trim();
  const publicOrigin = env(services.api, 'PUBLIC_ORIGIN') ?? '';
  const oidcFailures = /^__host-/i.test(cookieName)
    ? [
        `AUTH_COOKIE_NAME ${cookieName} uses the __Host- prefix: the sign-in transaction cookie derived from it is set with Path=/auth, which browsers refuse for a __Host- cookie, so every sign-in would fail`,
      ]
    : [];
  const oidcWarnings = [
    ...(clientId && audience && clientId === audience
      ? [
          'OIDC_AUDIENCE equals OIDC_CLIENT_ID: every ID token the provider issues to this client is also accepted as an API bearer token. Use a dedicated API audience (.env.example: jumptotech-api) and restrict which clients may request it',
        ]
      : []),
    ...(redirectUri && publicOrigin && redirectUri !== `${publicOrigin}/auth/callback`
      ? [
          `OIDC_REDIRECT_URI is not exactly ${publicOrigin}/auth/callback: the api accepts it, but it is sent to the identity provider as written, and providers compare it byte for byte with the registered one`,
        ]
      : []),
  ];
  results.push(
    oidcFailures.length
      ? fail('gates.oidc-client', [...oidcFailures, ...oidcWarnings].join('; '))
      : oidcWarnings.length
        ? warn('gates.oidc-client', oidcWarnings.join('; '))
        : pass('gates.oidc-client', 'a dedicated API audience, a literal callback URI and a sign-in cookie browsers accept'),
  );

  const apiOrigin = env(services.api, 'PUBLIC_ORIGIN') ?? '';
  const webOrigin = env(services.web, 'PUBLIC_ORIGIN') ?? '';
  const healthcheck = services.web?.healthcheck?.test;
  const healthText = Array.isArray(healthcheck) ? healthcheck.join(' ') : healthcheck ?? '';
  results.push(
    one(
      'gates.tls-edge',
      [
        ...(env(services.web, 'WEB_TLS') === 'required' ? [] : ['web is not pinned to WEB_TLS=required']),
        ...(/^https:\/\/[^/]+$/.test(apiOrigin) ? [] : ['PUBLIC_ORIGIN is not a bare https:// origin']),
        ...(!/^https:\/\/[^/]+$/.test(apiOrigin) || EDGE_PUBLIC_HOST_PATTERN.test(apiOrigin.slice('https://'.length))
          ? []
          : [
              "PUBLIC_ORIGIN's host is not a lower-case DNS name without a port (an IP address, a port or a single-label name such as localhost): the web edge's certificate gate refuses it, so web would restart in a loop and never serve 443",
            ]),
        ...(apiOrigin === webOrigin ? [] : ['the api and web see different PUBLIC_ORIGIN values']),
        ...(healthText.includes('jtt-tls-preflight') ? [] : ['web has no served-certificate health check']),
      ],
      'the certificate gate is pinned and PUBLIC_ORIGIN is an https origin the edge accepts',
    ),
  );

  // The api probes its own edge (apps/api/src/config.ts loadOperationsConfig):
  // certificate expiry, the served certificate, the redirect. It is on by
  // default in production, and EDGE_PROBE_ENABLED=false turns it off with no
  // error — which also silences every TLS alert, since TlsEdgeCheckNotRunning
  // only watches a probe that is enabled. The shipped compose files do not pass
  // the variable through, so .env cannot do this; a compose edit could.
  const edgeProbe = env(services.api, 'EDGE_PROBE_ENABLED');
  results.push(
    edgeProbe !== undefined && edgeProbe.trim() !== '' && !isTrue(edgeProbe)
      ? warn(
          'observability.edge-probe',
          'EDGE_PROBE_ENABLED is off: nothing measures the certificate or the edge, and TlsCertificateRenewalDue, TlsCertificateExpiresWithin7Days, TlsEdgeUnhealthy and TlsEdgeCheckNotRunning cannot fire',
        )
      : pass('observability.edge-probe', 'the api probes its own TLS edge (certificate expiry and health alerts can fire)'),
  );

  // Every ALLOWED_ORIGINS entry is trusted three times over: credentialed CORS
  // reads, the CSRF origin guard on every state-changing request, and the
  // terminal's WebSocket origin check. The api accepts any https origin there;
  // the beta was proven with exactly one, this deployment's own. A cookie Domain
  // likewise sends the session cookie to every host under it.
  const extraOrigins = (env(services.api, 'ALLOWED_ORIGINS') ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter((origin) => origin && origin !== apiOrigin);
  const cookieDomain = env(services.api, 'AUTH_COOKIE_DOMAIN')?.trim();
  // Named only when it is a bare origin: a malformed entry is exactly where a
  // pasted credential (`https://user:secret@host`) would sit, and the loader
  // refuses it anyway (loader.api).
  const bareExtras = [...new Set(extraOrigins.filter((origin) => /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origin)))];
  const otherExtras = extraOrigins.length - extraOrigins.filter((origin) => bareExtras.includes(origin)).length;
  const trustWidened = [
    ...(extraOrigins.length
      ? [
          `ALLOWED_ORIGINS also trusts ${[...bareExtras, ...(otherExtras ? [`${otherExtras} ${otherExtras === 1 ? 'entry that is not a bare origin' : 'entries that are not bare origins'} (not printed)`] : [])].join(', ')}: each can read signed-in responses, pass the CSRF guard and open terminal WebSockets. Remove any you do not operate`,
        ]
      : []),
    ...(cookieDomain
      ? [`AUTH_COOKIE_DOMAIN is set: the session cookie is also sent to every host under ${cookieDomain}. The beta was proven with a host-only cookie`]
      : []),
  ];
  results.push(
    trustWidened.length
      ? warn('gates.origins', trustWidened.join('; '))
      : pass('gates.origins', 'ALLOWED_ORIGINS is PUBLIC_ORIGIN alone and the session cookie is host-only'),
  );

  results.push(
    one(
      'gates.network-policy',
      [
        ...(env(services.api, 'NETWORK_POLICY_ENABLED') === 'false' ? ['NETWORK_POLICY_ENABLED=false'] : []),
        ...(env(services.api, 'NETWORK_POLICY_ATTESTATION_REQUIRED') === 'false' ? ['NETWORK_POLICY_ATTESTATION_REQUIRED=false'] : []),
      ],
      'session NetworkPolicy on; the enforcement attestation is required',
    ),
  );

  const max = env(services.api, 'MAX_ACTIVE_SESSIONS');
  const perStudent = env(services.api, 'MAX_ACTIVE_SESSIONS_PER_STUDENT');
  results.push(
    one(
      'capacity.beta-contract',
      [
        ...(max === String(BETA_CONTRACT.maxActiveSessions)
          ? []
          : [`MAX_ACTIVE_SESSIONS resolves to ${max ?? 'unset'}, not the proven ${BETA_CONTRACT.maxActiveSessions}`]),
        ...(perStudent === String(BETA_CONTRACT.maxActiveSessionsPerStudent)
          ? []
          : [`MAX_ACTIVE_SESSIONS_PER_STUDENT resolves to ${perStudent ?? 'unset'}, not the proven ${BETA_CONTRACT.maxActiveSessionsPerStudent}`]),
      ],
      `MAX_ACTIVE_SESSIONS=${BETA_CONTRACT.maxActiveSessions}, MAX_ACTIVE_SESSIONS_PER_STUDENT=${BETA_CONTRACT.maxActiveSessionsPerStudent} — the five-student contract`,
    ),
  );

  // The api admits MAX_ACTIVE_SESSIONS labs, but each lab's shell is a PTY the
  // terminal holds and, for the container tracks, one sandboxd holds too. Each
  // refuses a connection at its own ceiling, so a lower ceiling there admits the
  // lab and then gives the last students a dead terminal. Loader defaults (16,
  // 32) apply when compose leaves a value unset.
  const seats = Number(max);
  const shellCeilings = [
    ['terminal', 'TERMINAL_MAX_SESSIONS', 16],
    ['sandboxd', 'SANDBOXD_MAX_SESSIONS', 32],
  ] as const;
  const shortShells = Number.isInteger(seats)
    ? shellCeilings
        .filter(([service]) => services[service])
        .map(([service, name, fallback]) => [service, name, env(services[service], name) ?? String(fallback)] as const)
        .filter(([, , ceiling]) => !(Number(ceiling) >= seats))
        .map(([service, name, ceiling]) => `${service} ${name}=${ceiling} is below MAX_ACTIVE_SESSIONS=${seats}: past it, a started lab gets no shell`)
    : [];
  results.push(one('capacity.shell-ceilings', shortShells, 'the terminal and sandboxd accept at least MAX_ACTIVE_SESSIONS shells'));

  results.push(
    isTrue(env(services.api, 'LAB_LAUNCHES_PAUSED'))
      ? warn('capacity.launches', 'LAB_LAUNCHES_PAUSED is on: the stack starts refusing every Start Lab (runbook §3). Intended only while an incident is open')
      : pass('capacity.launches', 'new labs can start (LAB_LAUNCHES_PAUSED is off)'),
  );

  // --- durability ----------------------------------------------------------------
  const durability: string[] = [];
  const postgresData = (services.postgres?.volumes ?? []).find((volume) => volume.target === '/var/lib/postgresql/data');
  if (!postgresData || postgresData.type !== 'volume') durability.push('postgres data is not a named volume');
  for (const [service, target] of [
    ['prometheus', '/prometheus'],
    ['alertmanager', '/alertmanager'],
    ['grafana', '/var/lib/grafana'],
  ] as const) {
    if (services[service] && !(services[service]!.volumes ?? []).some((volume) => volume.type === 'volume' && volume.target === target)) {
      durability.push(`${service} ${target} is not a named volume`);
    }
  }
  results.push(one('durability.volumes', durability, 'postgres, prometheus, alertmanager and grafana data are named volumes'));

  const healthless = ['postgres', 'api', 'terminal', 'web'].filter(
    (name) => services[name] && (!services[name]!.healthcheck || services[name]!.healthcheck!.disable === true),
  );
  results.push(
    one(
      'durability.healthchecks',
      healthless.map((name) => `${name} has no compose health check`),
      'postgres, api, terminal and web have health checks (sandboxd has its image HEALTHCHECK)',
    ),
  );

  const wrongRestart = Object.entries(services)
    .filter(([, service]) => service.restart !== PRODUCTION_RESTART_POLICY)
    .map(([name, service]) => `${name} (${service.restart ?? 'none'})`)
    .sort();
  results.push(
    one(
      'durability.restart-policy',
      wrongRestart.length
        ? [
            `${wrongRestart.join(', ')}: every production service must be restart: ${PRODUCTION_RESTART_POLICY} — none leaves the platform down after a crash or reboot, always would undo \`prod stop web\``,
          ]
        : [],
      `every service is restart: ${PRODUCTION_RESTART_POLICY}`,
    ),
  );

  const status = (services.api?.volumes ?? []).find((volume) => volume.target === '/var/lib/jumptotech/backup-status');
  if (!status || !status.source) {
    results.push(fail('backup.status-dir', 'the api does not mount the backup status directory (docker-compose.production-observability.yml)'));
  } else if (!status.source.startsWith('/')) {
    results.push(fail('backup.status-dir', 'the backup status directory does not resolve to an absolute host path'));
  } else if (options.repoRoot && status.source === `${options.repoRoot.replace(/\/$/, '')}/backups/status`) {
    results.push(
      warn(
        'backup.status-dir',
        'BACKUP_STATUS_DIR is the in-checkout default; set it to the dedicated host path the backup cron job uses (private-beta-operations.md §1.2)',
      ),
    );
  } else if (status.read_only !== true) {
    results.push(fail('backup.status-dir', 'the backup status directory is not mounted read-only'));
  } else {
    results.push(pass('backup.status-dir', 'the api reads a dedicated host backup-status directory, read-only'));
  }

  return results;
}

/**
 * Replace every configured secret value in `text` with `[REDACTED]`.
 *
 * The loaders already promise never to echo a value. This is the second line,
 * because the check hands loader messages to a terminal on a production host.
 * Values shorter than 6 characters are ignored: they cannot be real secrets
 * under the production policy, and replacing them would mangle the message.
 */
export function redactValues(text: string, values: Iterable<string | undefined>): string {
  let out = text;
  const unique = [...new Set([...values].filter((value): value is string => typeof value === 'string' && value.length >= 6))];
  // Longest first, so a secret that contains another is removed whole.
  unique.sort((a, b) => b.length - a.length);
  for (const value of unique) out = out.split(value).join('[REDACTED]');
  return out;
}

/** Variables whose values are treated as secret when redacting, beyond the declared list. */
const SECRETISH = /(SECRET|PASSWORD|TOKEN|PRIVATE|KEY$|DATABASE_URL)/;

/** Every value in a service environment that could be a secret: named ones, and the password inside DATABASE_URL. */
export function secretValuesOf(environment: Record<string, string | null> | undefined, secretNames: readonly string[]): string[] {
  const values: string[] = [];
  for (const [name, value] of Object.entries(environment ?? {})) {
    if (value === null || value === undefined) continue;
    if (secretNames.includes(name) || SECRETISH.test(name)) values.push(String(value));
    if (name === 'DATABASE_URL') {
      try {
        const password = decodeURIComponent(new URL(String(value)).password);
        if (password) values.push(password, encodeURIComponent(password));
      } catch {
        // Not a URL: the whole value is already listed.
      }
    }
  }
  return values;
}

export type ServiceLoader = (environment: NodeJS.ProcessEnv) => unknown;

/**
 * Run each gated service's real configuration loader against the environment
 * Compose resolved for it. A loader that throws is exactly a container that
 * would exit at startup; its message is redacted before it is returned.
 */
export function evaluateServiceLoaders(
  config: ResolvedCompose,
  loaders: Readonly<Record<GatedService, ServiceLoader>>,
  secretNames: readonly string[],
): CheckResult[] {
  return GATED_SERVICES.map((name) => {
    const service = config.services?.[name];
    const id = `loader.${name}`;
    if (!service) return fail(id, `${name} is not in the resolved configuration`);
    const environment = Object.fromEntries(
      Object.entries(service.environment ?? {}).filter(([, value]) => value !== null && value !== undefined).map(([key, value]) => [key, String(value)]),
    );
    try {
      loaders[name](environment);
      return pass(id, `${name} accepts its production configuration (the same loader the container runs at startup)`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const redacted = redactValues(message, secretValuesOf(service.environment, secretNames));
      return fail(id, `${name} would refuse to start: ${redacted.replace(/\s*\n\s*/g, ' ').trim()}`);
    }
  });
}

/** One line per result, `STATUS  id  detail`; MANUAL spelled out so it cannot be mistaken for a pass. */
export function formatResult(result: CheckResult): string {
  const label = result.status === 'MANUAL' ? 'MANUAL CHECK REQUIRED' : result.status;
  return `${label.padEnd(5)}  ${result.id}  ${result.detail}`;
}

export function summarise(results: readonly CheckResult[]): Record<CheckStatus, number> {
  const counts: Record<CheckStatus, number> = { PASS: 0, FAIL: 0, WARN: 0, MANUAL: 0, INFO: 0 };
  for (const result of results) counts[result.status] += 1;
  return counts;
}
