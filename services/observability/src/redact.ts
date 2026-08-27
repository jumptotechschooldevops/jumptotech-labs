/**
 * Redaction — PLATFORM-003, gate two.
 *
 * ## Why a scanner exists at all when the logger is already typed
 *
 * `logger.ts` accepts a typed field set and drops everything it does not know
 * (gate one). That stops a developer leaking `{ token }` by naming it. It does
 * *not* stop a secret arriving inside a field that is legitimately a string:
 * an `Error.message` quoting a connection string, a provider's `reason` echoing
 * a `docker` invocation that carried `--password`, a `msg` built by template
 * literal. Gate one is about which *keys* survive; this is about which *values*
 * do.
 *
 * The two are independent on purpose. That is the same shape the verifier uses
 * for sandbox path safety — a schema check and a resolved-path re-check — and
 * for the same reason: either gate alone is one oversight away from being
 * bypassed, and the pair is not.
 *
 * ## Fail-closed
 *
 * Every pattern replaces with `[REDACTED:<kind>]` rather than dropping the
 * value, so a redacted line is visibly redacted rather than mysteriously empty.
 * An operator who sees `[REDACTED:dsn]` knows a connection string was there and
 * that the platform caught it; a blank field teaches nothing.
 *
 * ## Complexity
 *
 * Every pattern below is linear: no nested quantifier, no backtracking-prone
 * alternation over an unbounded run. A log line is attacker-influenced in
 * places (an error message quoting a request field), so a catastrophic-
 * backtracking regex here would be a denial of service on the logger itself.
 * `redact-complexity.test.ts` pins that with adversarial input and a time
 * ceiling.
 */

/** What was found. Present in the output, so redaction is auditable. */
export type SecretKind =
  | 'jwt'
  | 'authorization'
  | 'pem'
  | 'dsn'
  | 'cookie'
  | 'hex-secret'
  | 'base64-secret'
  | 'aws-key'
  | 'oauth'
  | 'email'
  | 'kubeconfig';

interface Pattern {
  kind: SecretKind;
  re: RegExp;
}

/**
 * Ordered most-specific first.
 *
 * Order matters: a JWT is also a run of base64-ish characters, and labelling it
 * `jwt` is more useful to an operator than `base64-secret`. Once a region is
 * replaced the replacement text contains no characters a later pattern matches,
 * so earlier patterns win by construction.
 */
const PATTERNS: readonly Pattern[] = [
  // A JSON Web Token: three base64url segments, the first of which decodes to
  // `{"alg"...`. Matching the literal `eyJ` prefix plus a dot is enough and
  // avoids decoding anything.
  { kind: 'jwt', re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*)?/g },

  // PEM material of any kind — private keys, certificates, kubeconfig inlines.
  { kind: 'pem', re: /-----BEGIN [A-Z0-9 ]{0,40}(?:KEY|CERTIFICATE)-----[\s\S]{0,4096}?-----END [A-Z0-9 ]{0,40}(?:KEY|CERTIFICATE)-----/g },

  // A kubeconfig's inline credential fields. The file itself never reaches a
  // log line, but an error quoting one can.
  { kind: 'kubeconfig', re: /\b(?:client-key-data|client-certificate-data|certificate-authority-data|token)\s*:\s*\S+/gi },

  // An HTTP credential header value, however it was spelled.
  { kind: 'authorization', re: /\b(?:Bearer|Basic|Negotiate|Digest)\s+[A-Za-z0-9._~+/=-]{4,}/g },

  // A database or cache URL carrying an inline password.
  { kind: 'dsn', re: /\b(?:postgres|postgresql|mysql|mongodb|redis|amqp)(?:\+\w+)?:\/\/[^\s:/@]{1,128}:[^\s@]{1,256}@/gi },

  // This platform's own session cookie, and the common Express one.
  { kind: 'cookie', re: /\b(?:jtt_session|connect\.sid|JSESSIONID)=[^;\s"']{1,512}/g },

  // OAuth/OIDC exchange parameters. `code` is short-lived but single-use and
  // still a credential while it lives.
  { kind: 'oauth', re: /\b(?:client_secret|refresh_token|id_token|access_token|code_verifier|code)=[^&\s"']{4,}/gi },

  { kind: 'aws-key', re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[0-9A-Z]{16}\b/g },

  // A long run of hex is how every secret this repository generates looks:
  // `openssl rand -hex 24` and `-hex 32` are what `make setup` writes for
  // TERMINAL_SESSION_SECRET, the three SANDBOXD_* scope secrets and
  // POSTGRES_PASSWORD. 32 is the shortest of those (hex 16).
  { kind: 'hex-secret', re: /\b[0-9a-f]{32,}\b/gi },

  // Long base64. Deliberately last among the secret patterns: it is the
  // broadest and would otherwise swallow more specific kinds.
  { kind: 'base64-secret', re: /\b[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/=])/g },

  // Not a credential, but personal data, and this platform holds real students'
  // addresses from an identity provider. `users.email` is descriptive-only by
  // design (migration 003) and there is no operational question that needs it.
  { kind: 'email', re: /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,4}\b/g },
];

/**
 * A run-length guard.
 *
 * A single log value is never legitimately larger than this, and scanning a
 * megabyte of attacker-supplied text with ten regexes is itself the denial of
 * service. Anything longer is truncated *before* scanning, so cost is bounded
 * regardless of input.
 */
const MAX_SCANNED_CHARS = 8192;

/** Replace every recognised secret in `value`. */
export function redactString(value: string): string {
  const input = value.length > MAX_SCANNED_CHARS
    ? `${value.slice(0, MAX_SCANNED_CHARS)}…[truncated ${value.length - MAX_SCANNED_CHARS} chars]`
    : value;

  let out = input;
  for (const { kind, re } of PATTERNS) {
    // `lastIndex` is reset because these are module-level /g regexes reused
    // across calls; a stale index silently skips the head of the next string.
    re.lastIndex = 0;
    out = out.replace(re, `[REDACTED:${kind}]`);
  }
  return out;
}

/** True when `value` contains something the scanner would replace. */
export function containsSecret(value: string): boolean {
  return redactString(value) !== value;
}

/**
 * Recursively redact a value of any shape.
 *
 * Depth- and breadth-bounded: a log field is data, not a graph to walk, and an
 * unbounded recursion here would turn a cyclic object into a crash inside the
 * logger — the one component that must never throw.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[REDACTED:depth]';
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    return value.slice(0, 64).map((entry) => redactValue(entry, depth + 1));
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      ...(typeof (value as { code?: unknown }).code === 'string'
        ? { code: redactString((value as unknown as { code: string }).code) }
        : {}),
    };
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    let seen = 0;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (seen >= 64) break;
      seen += 1;
      out[redactString(key)] = redactValue(entry, depth + 1);
    }
    return out;
  }
  // Functions, symbols, bigints: never legitimate log data.
  return `[REDACTED:unsupported]`;
}

/**
 * The startup self-test — gate three.
 *
 * A deployment's own secrets are the only ones whose shape actually matters,
 * and they are knowable at boot. Passing each through the scanner and refusing
 * to start when one survives converts "we think the patterns cover it" into a
 * fact about *this* deployment. A future secret generated in some other shape
 * — a base32 token, a short passphrase — fails the boot rather than being
 * discovered in a log file.
 *
 * Values are never echoed, not even in the failure. The error names the
 * variable, which is what an operator needs, and nothing else.
 *
 * @param secrets Named configured secrets. Undefined/empty entries are skipped:
 *                an unset optional secret is not a leak risk.
 */
export function assertSecretsAreRedactable(
  secrets: Readonly<Record<string, string | undefined>>,
): void {
  const undetected: string[] = [];
  for (const [name, value] of Object.entries(secrets)) {
    if (!value || value.trim().length === 0) continue;
    // A short development placeholder is not something the scanner can
    // recognise by shape, and refusing to boot on it would make the local
    // stack unusable. Production configuration is separately gated on
    // NODE_ENV by each service's config loader.
    if (value.length < 16) continue;
    if (!containsSecret(value)) undetected.push(name);
  }

  if (undetected.length > 0) {
    throw new Error(
      [
        `The log redactor does not recognise the shape of: ${undetected.join(', ')}.`,
        '',
        'These values would reach a log line intact if anything ever interpolated',
        'them into a message or an error. Refusing to start is the safe answer.',
        '',
        'Fix it one of these ways:',
        '  · regenerate the secret in a recognised shape — `openssl rand -hex 32`',
        '    is what `make setup` uses and what the hex-secret pattern covers;',
        '  · add a pattern for the new shape in services/observability/src/redact.ts',
        '    and cover it in test/redact.test.ts.',
      ].join('\n'),
    );
  }
}
