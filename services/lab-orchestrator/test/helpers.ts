/** Shared builders for session-shaped test fixtures. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SESSION_POLICY,
  loadLabDefinition,
  type LabSession,
  type LabSessionContext,
  type LoadedLabDefinition,
  type SessionPolicy,
} from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '../../..');
export const LABS_DIR = path.join(REPO_ROOT, 'labs');
export const K8S_001_PATH = path.join(LABS_DIR, 'kubernetes', 'k8s-001-pods', 'lab.yaml');

export function loadK8s001(): Promise<LoadedLabDefinition> {
  return loadLabDefinition(K8S_001_PATH);
}

export const TEST_POLICY: SessionPolicy = DEFAULT_SESSION_POLICY;

export interface ContextOverrides {
  sessionId?: string;
  namespace?: string;
  /** Container sandbox name, for container-backed providers. */
  sandboxRef?: string;
  expiresAtMs?: number;
  policy?: SessionPolicy;
}

export function sessionContext(
  lab: LoadedLabDefinition,
  overrides: ContextOverrides = {},
): LabSessionContext {
  const policy = overrides.policy ?? TEST_POLICY;
  const namespace = overrides.namespace ?? 'lab-0000000000aa';
  return {
    sessionId: overrides.sessionId ?? 'sess-000000000000000a',
    labId: lab.id,
    sandboxRef: overrides.sandboxRef ?? namespace,
    namespace,
    serviceAccountName: policy.serviceAccountName,
    lab,
    expiresAtMs: overrides.expiresAtMs ?? Date.now() + 60 * 60_000,
    policy,
  };
}

export function labSession(overrides: Partial<LabSession> = {}): LabSession {
  const createdAt = overrides.createdAt ?? new Date(1_000_000).toISOString();
  return {
    sessionId: 'sess-000000000000000a',
    labId: 'K8S-001',
    provider: 'kubernetes',
    sandboxKind: 'namespace',
    sandboxRef: overrides.sandboxRef ?? overrides.namespace ?? 'lab-0000000000aa',
    namespace: 'lab-0000000000aa',
    serviceAccountName: 'student',
    status: 'ACTIVE',
    environmentId: 'kind:jumptotech-labs/lab-0000000000aa#K8S-001',
    createdAt,
    lastActivityAt: createdAt,
    expiresAt: new Date(Date.parse(createdAt) + 60 * 60_000).toISOString(),
    idleTimeoutSeconds: 20 * 60,
    idleWarningSeconds: 5 * 60,
    ...overrides,
  };
}
