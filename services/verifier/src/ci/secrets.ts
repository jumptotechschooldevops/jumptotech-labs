/**
 * Detecting a credential written in plain text.
 *
 * CICD-008 teaches that a pipeline references a secret; it never contains one.
 * Grading that needs a check that fails a hardcoded value — and the check has
 * to work *without the lab definition containing a secret to compare against*,
 * because putting one there would be the same mistake the lab is warning about.
 *
 * So the rule is structural, not a word list:
 *
 *   a key that **names** a credential      (`DEPLOY_TOKEN`, `db_password`, …)
 *   assigned a **literal**                 (not a reference to a secret store)
 *   ⇒ hardcoded.
 *
 * Everything a real pipeline uses to reference a secret is recognised as safe:
 * `${{ secrets.NAME }}`, `credentials('id')`, `$VAR`, `${VAR}`, `${env.VAR}`,
 * `vault(...)`, a `withCredentials` binding. A value that is one of those is a
 * reference, whatever its key is called. A value that is `''` is nothing at all
 * and is likewise not a leaked secret.
 *
 * False positives are possible in principle — a variable called `TOKEN_PATH`
 * holding a filename would trip it. The key patterns below are therefore
 * matched against the credential *noun*, and path-ish suffixes are excluded, so
 * the labs that use this check grade what they say they grade.
 */

/** A key/value pair to judge, from a workflow `env:` or a Jenkins `environment`. */
export interface CandidateAssignment {
  key: string;
  /** The value as written. `null` for a non-scalar, which is never a literal. */
  value: string | null;
  /** Where it was declared, quoted back to the student. */
  location: string;
}

export interface SecretFinding {
  key: string;
  location: string;
  reason: string;
}

/**
 * Key names that denote a credential.
 *
 * Anchored on the final word so `REGISTRY_PASSWORD` matches and `PASSWORD_FILE`
 * — a path to where a credential lives, which is not itself one — does not.
 */
const CREDENTIAL_KEY = /(^|[_-])(password|passwd|secret|token|apikey|api_key|credential|credentials|privatekey|private_key|access_key|auth)s?$/i;

/** Values that are references rather than the credential itself. */
const REFERENCE_PATTERNS: readonly RegExp[] = [
  // GitHub Actions expression: ${{ secrets.NAME }}, ${{ vars.NAME }}
  /\$\{\{\s*(secrets|vars|inputs)\./i,
  // Jenkins declarative credentials binding: credentials('id')
  /\bcredentials\s*\(/i,
  // Jenkins/HashiCorp vault helper
  /\bvault\s*\(/i,
  // Shell / Groovy variable interpolation: $VAR, ${VAR}, ${env.VAR}
  /^\$\{?[A-Za-z_][A-Za-z0-9_.]*\}?$/,
  // A whole value that is only an expression
  /^\$\{\{[^}]*\}\}$/,
];

/**
 * Values that are obviously not a credential even under a credential-ish key.
 *
 * A key alone should not fail a student who wrote `TOKEN_TYPE: bearer`.
 */
const HARMLESS_VALUES = /^(|true|false|none|null|bearer|basic|0|1)$/i;

export function isSecretReference(value: string): boolean {
  const trimmed = value.trim().replace(/^['"]|['"]$/g, '');
  return REFERENCE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function namesACredential(key: string): boolean {
  return CREDENTIAL_KEY.test(key);
}

/**
 * Judge a set of assignments.
 *
 * Returns one finding per hardcoded credential. The finding names the *key* and
 * where it was written, and deliberately never echoes the value: a check that
 * printed the secret it found would be its own vulnerability, and the message
 * has to survive being screenshotted into a support ticket.
 */
export function findHardcodedSecrets(
  assignments: readonly CandidateAssignment[],
): SecretFinding[] {
  const findings: SecretFinding[] = [];

  for (const assignment of assignments) {
    if (!namesACredential(assignment.key)) continue;
    if (assignment.value === null) continue;

    const value = assignment.value.trim().replace(/^['"]|['"]$/g, '');
    if (HARMLESS_VALUES.test(value)) continue;
    if (isSecretReference(assignment.value)) continue;

    findings.push({
      key: assignment.key,
      location: assignment.location,
      reason: `${assignment.key} is set to a literal value in ${assignment.location} instead of a reference to a secret store`,
    });
  }

  return findings;
}

/**
 * Scan a plain text file for credential-shaped assignments.
 *
 * The fallback for files with no dedicated parser — a shell script, a
 * `docker-compose.yml`, a config file a student added. Line-oriented and
 * deliberately simple: it looks for `KEY=value` and `KEY: value` and hands what
 * it finds to the same judgement above, so one rule governs every file type.
 */
export function scanTextForAssignments(text: string, location: string): CandidateAssignment[] {
  const assignments: CandidateAssignment[] = [];

  for (const [i, line] of text.split('\n').entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith('#') || trimmed.startsWith('//')) continue;

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_-]*)\s*[:=]\s*(.+?)\s*$/.exec(trimmed);
    if (!match?.[1] || !match[2]) continue;

    assignments.push({
      key: match[1],
      value: match[2],
      location: `${location}:${i + 1}`,
    });
  }

  return assignments;
}
