/**
 * `@jumptotech/observability` — PLATFORM-003.
 *
 * Structured logging, the metric catalogue, and the health/readiness listener.
 *
 * This package knows nothing about labs, sandboxes, Kubernetes, containers, or
 * any provider — the same discipline `services/progress` keeps. Everything
 * domain-specific is a *label value* or a *field* supplied by the caller, which
 * is what lets the label policy and the redaction contract be enforced in one
 * place for the whole platform.
 */
export {
  createLogger,
  silentLogger,
  isLogLevel,
  LOG_LEVELS,
  ALLOWED_LOG_FIELDS,
  type Logger,
  type LogFields,
  type LogLevel,
  type LoggerOptions,
} from './logger.js';

export {
  LOG_EVENTS,
  SECURITY_EVENTS,
  type LogEvent,
  type SecurityEventKind,
} from './events.js';

export {
  redactString,
  redactValue,
  containsSecret,
  assertSecretsAreRedactable,
  registerSecretValues,
  type SecretKind,
} from './redact.js';

export {
  PRODUCTION_SECRET_MIN_LENGTH,
  PLACEHOLDER_MARKERS,
  SecretPolicyError,
  assertProductionSecrets,
  isProductionEnv,
  secretWeakness,
  type SecretRequirement,
  type SecretWeakness,
  type ProductionSecretOptions,
} from './secret-policy.js';

export {
  withContext,
  currentContext,
  currentRequestId,
  enrichContext,
  normaliseRequestId,
  type RequestContext,
} from './context.js';

export {
  PERMITTED_LABELS,
  FORBIDDEN_LABELS,
  LabelPolicyViolation,
  checkLabelNames,
  assertLabelPolicy,
} from './labels.js';

export {
  createRegistry,
  setCollector,
  LAB_START_OUTCOMES,
  LAB_RESET_OUTCOMES,
  LAB_END_OUTCOMES,
  AUTH_CALLBACK_OUTCOMES,
  REAPER_RECOVERY_REASONS,
  REAPER_TEARDOWN_REASONS,
  TLS_EDGE_CHECKS,
  BACKUP_OPERATIONS,
  NETWORK_ATTESTATION_RESULTS,
  createOperationsMetrics,
  type OperationsMetrics,
  createCommonMetrics,
  createSessionMetrics,
  createProviderMetrics,
  createVerificationMetrics,
  createDatabaseMetrics,
  createAuthMetrics,
  createReaperMetrics,
  createTerminalMetrics,
  createSandboxdMetrics,
  promClient,
  type Registry,
  type Counter,
  type Gauge,
  type Histogram,
  type CommonMetrics,
  type SessionMetrics,
  type ProviderMetrics,
  type VerificationMetrics,
  type DatabaseMetrics,
  type AuthMetrics,
  type ReaperMetrics,
  type TerminalMetrics,
  type SandboxdMetrics,
} from './metrics.js';

export {
  evaluateReadiness,
  cachedCheck,
  simpleCheck,
  type HealthCheck,
  type HealthCheckResult,
  type ReadinessReport,
  type ReadinessOptions,
} from './health.js';

export {
  createObservabilityListener,
  ObservabilityConfigError,
  type ObservabilityListenerOptions,
} from './listener.js';

export {
  loadObservabilityConfig,
  assertScrapeTokenIsDistinct,
  type ObservabilityConfig,
} from './config.js';

export {
  httpObservability,
  statusClass,
  routeTemplate,
  type HttpObservabilityOptions,
} from './http-metrics.js';

/*
 * BETA-P0-017's certificate checks, re-exported for the API's periodic edge
 * probe (BETA-P0-018) so that `npm run tls:check` and the Prometheus alert read
 * one implementation and one set of expiry thresholds.
 */
export {
  DEFAULT_EXPIRY_THRESHOLDS,
  exitCodeFor,
  probeHttpRedirect,
  probeHttpsEndpoint,
  publicHostname,
  worstStatus,
  type EndpointProbeOptions,
  type ExpiryThresholds,
  type HttpsProbeResult,
  type TlsFinding,
  type TlsHealthReport,
  type TlsHealthStatus,
} from './tls-certificate-health.js';

/**
 * Correlation headers used between platform services.
 *
 * Named constants because the same two strings are read in the API, written by
 * the broker client, and read again in `sandboxd` and `terminal`. A typo in one
 * of those would break correlation silently — the logs would simply stop
 * joining up, with nothing failing.
 */
export const REQUEST_ID_HEADER = 'x-request-id';
export const SESSION_ID_HEADER = 'x-session-id';
