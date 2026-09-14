/**
 * Production secret policy — BETA-P0-010.
 *
 * Every service already refused *some* bad secrets: `sandboxd` refuses two equal
 * scope secrets, every service refuses a scrape token equal to a privileged
 * secret, and the terminal and API refuse a session secret shorter than eight
 * characters. What none of them refused was the value `.env.example` ships —
 * `dev-only-insecure-secret-change-me` is 34 characters and passed every check —
 * and nothing stopped `INTERNAL_SERVICE_SECRET` and `NAMESPACE_DERIVATION_SECRET`
 * from silently *being* `TERMINAL_SESSION_SECRET`, because that was the default.
 *
 * This module is the one place those rules live, so the three services cannot
 * drift apart on what "a production secret" means:
 *
 *   · **present** when the service needs it;
 *   · **not a placeholder** — no `change-me`, `dev-only`, `example`…;
 *   · **long enough** — 32 characters for secrets this platform generates
 *     (`openssl rand -hex 16` is the shortest `make setup` writes);
 *   · **not low-entropy** — a long run of one or two characters is not a key;
 *   · **distinct** — two secrets with one value are one secret;
 *   · **not held at all** when the service has no use for it. A credential a
 *     process never receives is one a bug in that process cannot leak.
 *
 * Only ever applied under `NODE_ENV=production`. Development keeps its
 * placeholders and fallbacks, and says so at startup.
 *
 * No value is ever echoed. Every message names the variable and the rule it
 * broke, which is what an operator needs, and nothing else.
 */

/** Shortest acceptable production secret the platform itself generates. */
export const PRODUCTION_SECRET_MIN_LENGTH = 32;

/**
 * Fragments that mark a value as a stand-in rather than a key.
 *
 * Matched case-insensitively anywhere in the value. Each is long or punctuated
 * enough that it does not occur by chance in `openssl rand -hex` or base64
 * output, so a real generated secret cannot trip it.
 */
export const PLACEHOLDER_MARKERS: readonly string[] = [
  'change-me',
  'changeme',
  'change_me',
  'dev-only',
  'dev_only',
  'insecure',
  'placeholder',
  'example',
  'replace-me',
  'replaceme',
  'your-',
  'not-a-secret',
  'default',
];

/** Fewer distinct characters than this is a pattern, not a key. */
const MIN_DISTINCT_CHARACTERS = 8;

export type SecretWeakness = 'missing' | 'placeholder' | 'too-short' | 'low-entropy';

const WEAKNESS_TEXT: Readonly<Record<SecretWeakness, string>> = {
  missing: 'is not set',
  placeholder: 'is a placeholder value',
  'too-short': 'is too short',
  'low-entropy': 'has too little variety to be a generated secret',
};

/** Why `value` is not acceptable as a production secret, or `null` when it is. */
export function secretWeakness(
  value: string | undefined,
  minLength: number = PRODUCTION_SECRET_MIN_LENGTH,
): SecretWeakness | null {
  const trimmed = value?.trim() ?? '';
  if (trimmed.length === 0) return 'missing';
  const lower = trimmed.toLowerCase();
  if (PLACEHOLDER_MARKERS.some((marker) => lower.includes(marker))) return 'placeholder';
  if (trimmed.length < minLength) return 'too-short';
  if (new Set(trimmed).size < MIN_DISTINCT_CHARACTERS) return 'low-entropy';
  return null;
}

export function isProductionEnv(env: NodeJS.ProcessEnv): boolean {
  return (env.NODE_ENV ?? '').trim() === 'production';
}

export interface SecretRequirement {
  /** The environment variable, or a description when the value is embedded in one. */
  name: string;
  value: string | undefined;
  /** A required secret must be present; an optional one is checked only when set. */
  required: boolean;
  /**
   * Override for credentials this platform does not generate — an identity
   * provider's client secret, a managed database's password.
   */
  minLength?: number;
}

export interface ProductionSecretOptions {
  service: string;
  env: NodeJS.ProcessEnv;
  secrets: readonly SecretRequirement[];
  /**
   * Variables this service must never be given at all.
   *
   * An exact denylist on top of the compose allowlist: the compose contract
   * test proves what the shipped stack hands out, and this proves what the
   * process refuses to run with however it was deployed.
   */
  forbidden: readonly string[];
}

export class SecretPolicyError extends Error {
  readonly code = 'SECRET_POLICY_VIOLATION';
  constructor(
    readonly service: string,
    readonly problems: readonly string[],
  ) {
    super(
      [
        `${service} refuses to start with NODE_ENV=production:`,
        ...problems.map((problem) => `  · ${problem}`),
        '',
        'Generate each secret separately (`openssl rand -hex 32`) and give every',
        'service only the secrets it uses — see docs/secret-boundaries.md.',
      ].join('\n'),
    );
    this.name = 'SecretPolicyError';
  }
}

/**
 * Refuse a production configuration that breaks any rule above.
 *
 * Collects every problem before throwing, so an operator fixes the environment
 * once rather than one restart per variable.
 */
export function assertProductionSecrets(options: ProductionSecretOptions): void {
  const problems: string[] = [];

  for (const secret of options.secrets) {
    const present = (secret.value?.trim() ?? '').length > 0;
    if (!present && !secret.required) continue;
    const weakness = secretWeakness(secret.value, secret.minLength);
    if (weakness) problems.push(`${secret.name} ${WEAKNESS_TEXT[weakness]}`);
  }

  const owners = new Map<string, string>();
  for (const secret of options.secrets) {
    const value = secret.value?.trim() ?? '';
    if (!value) continue;
    const owner = owners.get(value);
    if (owner) {
      problems.push(`${secret.name} and ${owner} are the same value; each must be generated separately`);
    } else {
      owners.set(value, secret.name);
    }
  }

  for (const name of options.forbidden) {
    if ((options.env[name]?.trim() ?? '').length > 0) {
      problems.push(`${name} is set, but ${options.service} has no use for it and must not hold it`);
    }
  }

  if (problems.length > 0) throw new SecretPolicyError(options.service, problems);
}
