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
  type SecretKind,
} from './redact.js';

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
