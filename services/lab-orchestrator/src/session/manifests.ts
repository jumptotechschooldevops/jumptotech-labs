/**
 * Setup-manifest loading.
 *
 * Labs that begin from an existing state declare it declaratively:
 *
 *   setup:
 *     manifests:
 *       - initial/deployment.yaml
 *
 * Those files are plain Kubernetes YAML, restricted to an allow-list of
 * namespaced kinds. A lab cannot ship a manifest that creates a Namespace,
 * grants RBAC, or edits the session's own quota — that would let lab content
 * dismantle the guardrails the platform put around it.
 */
import { readFile } from 'node:fs/promises';
import { parseAllDocuments } from 'yaml';
import {
  LabDefinitionError,
  resolveManifestPath,
  type LoadedLabDefinition,
} from '../lab-definition.js';
import type { KubernetesManifestObject } from '../k8s/port.js';

/**
 * Kinds a lab's initial state may contain.
 *
 * Everything here is namespaced and disposable. Cluster-scoped kinds, RBAC,
 * and the platform's own guardrail kinds (ResourceQuota, LimitRange,
 * NetworkPolicy) are deliberately absent.
 */
export const ALLOWED_SETUP_KINDS: readonly string[] = [
  'Pod',
  'Deployment',
  'ReplicaSet',
  'StatefulSet',
  'DaemonSet',
  'Job',
  'CronJob',
  'Service',
  'ConfigMap',
  'Secret',
  'Ingress',
  'PersistentVolumeClaim',
  'ServiceAccount',
];

function assertManifestObject(
  value: unknown,
  source: string,
  index: number,
  lab: LoadedLabDefinition,
): KubernetesManifestObject {
  const fail = (reason: string): never => {
    throw new LabDefinitionError(
      `setup manifest ${source} (document ${index + 1}): ${reason}`,
      lab.sourcePath,
      [],
      lab.id,
    );
  };

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail('must be a YAML mapping');
  }

  const doc = value as Record<string, unknown>;
  if (typeof doc.apiVersion !== 'string' || doc.apiVersion.length === 0) {
    return fail('missing apiVersion');
  }
  if (typeof doc.kind !== 'string' || doc.kind.length === 0) {
    return fail('missing kind');
  }
  if (!ALLOWED_SETUP_KINDS.includes(doc.kind)) {
    return fail(
      `kind '${doc.kind}' is not allowed in lab setup (allowed: ${ALLOWED_SETUP_KINDS.join(', ')})`,
    );
  }

  const metadata = doc.metadata as { name?: unknown; namespace?: unknown } | undefined;
  if (!metadata || typeof metadata.name !== 'string' || metadata.name.length === 0) {
    return fail('missing metadata.name');
  }
  if (metadata.namespace !== undefined) {
    return fail(
      'must not set metadata.namespace — the platform places setup resources in the session namespace',
    );
  }

  return doc as unknown as KubernetesManifestObject;
}

/**
 * Read and validate every setup manifest a lab declares.
 *
 * Returns objects in declaration order; `applyObjects` preserves that order so
 * a lab can rely on, say, a ConfigMap existing before the Deployment that
 * mounts it.
 */
export async function loadSetupManifests(
  lab: LoadedLabDefinition,
): Promise<KubernetesManifestObject[]> {
  const objects: KubernetesManifestObject[] = [];

  for (const relative of lab.setup.manifests) {
    const absolute = resolveManifestPath(lab, relative);

    let text: string;
    try {
      text = await readFile(absolute, 'utf8');
    } catch (cause) {
      throw new LabDefinitionError(
        `Cannot read setup manifest '${relative}': ${(cause as Error).message}`,
        lab.sourcePath,
        [],
        lab.id,
      );
    }

    const documents = parseAllDocuments(text);
    documents.forEach((document, index) => {
      if (document.errors.length > 0) {
        throw new LabDefinitionError(
          `setup manifest ${relative} (document ${index + 1}): ${document.errors[0]?.message}`,
          lab.sourcePath,
          [],
          lab.id,
        );
      }
      const parsed = document.toJS() as unknown;
      // A trailing `---` produces an empty document; skip rather than fail.
      if (parsed === null || parsed === undefined) return;
      objects.push(assertManifestObject(parsed, relative, index, lab));
    });
  }

  return objects;
}
