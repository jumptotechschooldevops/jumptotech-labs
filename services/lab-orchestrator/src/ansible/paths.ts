/**
 * Path admission for Ansible sandbox reads.
 *
 * Lab definitions name files: `inventory.ini`, `templates/app.conf.j2`,
 * `/etc/jumptotech/app.conf`. Those strings reach a container, so they get the
 * same treatment every other externally-authored value in this platform gets —
 * validated against an allow-list before they are used for anything.
 *
 * Two separate rules, because the two sides answer different questions:
 *
 *   - **Workspace paths** are relative and must resolve inside the student's
 *     own project directory on the control node.
 *   - **Managed-node paths** are absolute and must sit under one of the roots
 *     the labs write into. `/etc/shadow` and `/root/.ssh/id_lab` are not
 *     reachable from a requirement, whatever a lab.yaml says.
 *
 * Both functions normalise first and then re-check the *result*, so `a/../../b`
 * is rejected on what it resolves to rather than on how it is spelled.
 */
import path from 'node:path';
import { ALLOWED_MANAGED_ROOTS, ForbiddenSandboxPathError } from './port.js';

/** Characters a lab-supplied path may contain. Conservative on purpose. */
const SAFE_PATH_CHARS = /^[A-Za-z0-9._/-]+$/;

export const MAX_PATH_LENGTH = 255;

function assertShape(candidate: string, original: string): void {
  if (candidate.length === 0) {
    throw new ForbiddenSandboxPathError(original, 'the path is empty');
  }
  if (candidate.length > MAX_PATH_LENGTH) {
    throw new ForbiddenSandboxPathError(original, `longer than ${MAX_PATH_LENGTH} characters`);
  }
  if (candidate.includes('\0')) {
    throw new ForbiddenSandboxPathError('<null-byte>', 'it contains a null byte');
  }
  if (candidate.includes('\\')) {
    throw new ForbiddenSandboxPathError(original, 'backslashes are not allowed');
  }
  if (!SAFE_PATH_CHARS.test(candidate)) {
    throw new ForbiddenSandboxPathError(
      original,
      'only letters, digits, dot, dash, underscore and / are allowed',
    );
  }
}

/**
 * Resolve a lab-supplied project path inside the control node's workspace.
 *
 * Returns an absolute path guaranteed to sit under `workspaceDir`.
 */
export function resolveWorkspacePath(workspaceDir: string, relative: string): string {
  assertShape(relative, relative);
  if (relative.startsWith('/')) {
    throw new ForbiddenSandboxPathError(relative, 'project paths must be relative');
  }

  const resolved = path.posix.resolve(workspaceDir, relative);
  const root = `${workspaceDir.replace(/\/$/, '')}/`;
  if (!resolved.startsWith(root)) {
    throw new ForbiddenSandboxPathError(relative, 'it resolves outside the lab workspace');
  }
  return resolved;
}

/**
 * Admit an absolute managed-node path.
 *
 * The path must resolve to one of `ALLOWED_MANAGED_ROOTS`, or to something
 * inside one. Equality with a root is allowed so a lab can assert on (or reset)
 * a whole managed directory.
 */
export function resolveManagedPath(absolute: string): string {
  assertShape(absolute, absolute);
  if (!absolute.startsWith('/')) {
    throw new ForbiddenSandboxPathError(absolute, 'managed-node paths must be absolute');
  }

  const resolved = path.posix.resolve(absolute);
  const allowed = ALLOWED_MANAGED_ROOTS.some(
    (root) => resolved === root || resolved.startsWith(`${root}/`),
  );
  if (!allowed) {
    throw new ForbiddenSandboxPathError(
      absolute,
      `managed-node checks are limited to ${ALLOWED_MANAGED_ROOTS.join(', ')}`,
    );
  }
  return resolved;
}

/** Non-throwing variant, for schema-level validation messages. */
export function isAllowedManagedPath(absolute: string): boolean {
  try {
    resolveManagedPath(absolute);
    return true;
  } catch {
    return false;
  }
}

export function isSafeWorkspacePath(relative: string): boolean {
  try {
    resolveWorkspacePath('/home/student/lab', relative);
    return true;
  } catch {
    return false;
  }
}
