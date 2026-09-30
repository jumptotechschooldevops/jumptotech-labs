/**
 * The operator CLI, run the way an operator runs it — TEST ONLY.
 *
 * `docker exec` into this stack's api container and the real `operator-cli.ts`
 * over the real operator socket: the supported way to give an account a role
 * (private-beta-operations.md §7.4). No SQL, no injected rows.
 */
import { execFileSync } from 'node:child_process';
import { requiredEnv } from './env.js';

function apiContainer(): string {
  const project = requiredEnv('E2E_PROJECT');
  const id = execFileSync(
    'docker',
    ['ps', '-q', '--filter', `label=com.docker.compose.project=${project}`, '--filter', 'label=com.docker.compose.service=api'],
    { encoding: 'utf8', timeout: 15_000 },
  ).trim();
  if (!id || id.includes('\n')) throw new Error(`expected exactly one api container in project ${project}, found: ${JSON.stringify(id)}`);
  return id;
}

/** `ops <args…> --json`, parsed. Throws with the CLI's output when it fails. */
export function ops(...args: string[]): { ok: boolean; data?: any; error?: { code: string; message: string } } {
  const out = execFileSync(
    'docker',
    ['exec', apiContainer(), 'node', '/app/node_modules/.bin/tsx', 'apps/api/src/operator-cli.ts', ...args, '--json'],
    { encoding: 'utf8', timeout: 60_000 },
  );
  return JSON.parse(out);
}

/** The internal user id of an account that has signed in, by the email the test provider gives it. */
export function userIdFor(username: string): string {
  const found = ops('access', 'find', '--email', `${username}@e2e.jumptotech.test`);
  const account = found.data?.accounts?.[0];
  if (!account?.userId) throw new Error(`no account for ${username}: ${JSON.stringify(found)}`);
  return account.userId as string;
}

export function setRole(username: string, role: 'STUDENT' | 'INSTRUCTOR' | 'ADMIN'): void {
  const result = ops('role', 'set', userIdFor(username), role, '--by', 'e2e-suite', '--reason', 'classroom view e2e');
  if (!result.ok) throw new Error(`role set failed: ${JSON.stringify(result)}`);
}
