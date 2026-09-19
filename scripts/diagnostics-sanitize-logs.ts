/**
 * Sanitise one service's log for the support bundle: stdin → stdout.
 *
 *   docker compose logs --no-color --no-log-prefix api \
 *     | npx tsx scripts/diagnostics-sanitize-logs.ts --source structured --max-lines 300 --env-file .env
 *
 * Called by scripts/private-beta-diagnostics.sh; the rules are in
 * services/observability/src/support-bundle.ts.
 *
 * `--env-file` is read as data, never sourced and never printed: the values of
 * the secrets named in infrastructure/secret-distribution.json are registered
 * with the redactor, so one of this deployment's own secrets is replaced even
 * if it reached a log line in a shape no pattern recognises.
 *
 * One summary line goes to stderr. Exit 0, or 2 on a usage error.
 *
 *   npx tsx scripts/diagnostics-sanitize-logs.ts --scan-dir DIR --env-file .env
 *
 * is the gate the bundle passes before it is packaged: every file under DIR is
 * searched for the configured secrets' literal values and for shapes that are
 * never innocent (`findSecretLeaks`). Exit 1 names the file and the kind found,
 * never the value.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerSecretValues } from '../services/observability/src/redact.js';
import { findSecretLeaks, sanitizeLogLines, type LogSource } from '../services/observability/src/support-bundle.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The last assignment of each name wins, as in Compose. Quotes are removed. */
export function envValues(text: string, names: readonly string[]): string[] {
  const wanted = new Set(names);
  const values = new Map<string, string>();
  for (const line of text.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.replace(/\r$/, ''));
    if (!match || !wanted.has(match[1]!)) continue;
    let value = match[2]!;
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
    values.set(match[1]!, value);
  }
  return [...values.values()];
}

function fail(message: string): never {
  process.stderr.write(`diagnostics-sanitize-logs: ${message}\n`);
  process.exit(2);
}

function configuredSecrets(envFile: string | undefined): string[] {
  if (!envFile) return [];
  const names = (JSON.parse(readFileSync(path.join(repo, 'infrastructure/secret-distribution.json'), 'utf8')) as {
    secrets: string[];
  }).secrets;
  return envValues(readFileSync(envFile, 'utf8'), names).filter((value) => value.trim().length >= 8);
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
}

function scan(dir: string, envFile: string | undefined): never {
  let literals: string[] = [];
  try {
    literals = configuredSecrets(envFile);
  } catch {
    process.stderr.write('diagnostics-sanitize-logs: configured secrets unreadable; scanning for shapes only\n');
  }
  let leaks = 0;
  for (const file of filesUnder(dir)) {
    const kinds = findSecretLeaks(readFileSync(file, 'utf8'), literals);
    if (kinds.length > 0) {
      leaks += 1;
      process.stderr.write(`LEAK ${path.relative(dir, file)}: ${kinds.join(', ')}\n`);
    }
  }
  process.stderr.write(`scanned ${dir}: ${leaks === 0 ? 'no secret found' : `${leaks} file(s) hold a secret`}\n`);
  process.exit(leaks === 0 ? 0 : 1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const scanAt = args.indexOf('--scan-dir');
  if (scanAt >= 0) {
    const dir = args[scanAt + 1];
    const envAt = args.indexOf('--env-file');
    if (!dir) fail('--scan-dir needs a directory');
    scan(dir, envAt >= 0 ? args[envAt + 1] : undefined);
  }
  let source: LogSource | undefined;
  let maxLines = 300;
  let envFile: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const value = args[i + 1];
    if (arg === '--source' && value) {
      if (value !== 'structured' && value !== 'postgres' && value !== 'nginx') fail(`unknown source ${value}`);
      source = value;
      i += 1;
    } else if (arg === '--max-lines' && value && /^\d{1,5}$/.test(value)) {
      maxLines = Number(value);
      i += 1;
    } else if (arg === '--env-file' && value) {
      envFile = value;
      i += 1;
    } else {
      fail(`unknown or incomplete argument ${arg ?? ''}`);
    }
  }
  if (!source) fail('--source structured|postgres|nginx is required');

  if (envFile) {
    try {
      registerSecretValues(configuredSecrets(envFile));
    } catch {
      // No .env or no policy file: the pattern redaction still runs.
      process.stderr.write('diagnostics-sanitize-logs: configured secrets not registered (env file unreadable)\n');
    }
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const input = Buffer.concat(chunks).toString('utf8').split('\n');
  const result = sanitizeLogLines(input, { source: source!, maxLines });
  for (const line of result.lines) process.stdout.write(`${line}\n`);
  process.stderr.write(
    `read ${result.read}, kept ${result.lines.length} of ${result.matched} matching, ${result.unrecognised} unrecognised (dropped)\n`,
  );
}

const invokedDirectly = process.argv[1] !== undefined && /diagnostics-sanitize-logs\.[cm]?[jt]s$/.test(process.argv[1]);
if (invokedDirectly) void main();
