/**
 * Builds the kubeconfig a student's terminal uses.
 *
 * It contains exactly one cluster, one user (a per-session ServiceAccount
 * token), and one context whose `namespace` is the session namespace — which
 * is why `kubectl get pods` works without anyone typing `-n lab-…`.
 *
 * It never contains the platform's cluster-admin credentials, and it never
 * reaches the browser: the API hands it to the terminal service over an
 * internal, service-authenticated call.
 */
import { stringify as stringifyYaml } from 'yaml';
import type { ClusterEndpoint } from './port.js';

export interface StudentKubeconfigInput {
  endpoint: ClusterEndpoint;
  namespace: string;
  token: string;
  /** Display names only; they carry no authority. */
  clusterName?: string;
  userName?: string;
  contextName?: string;
}

export function buildStudentKubeconfig(input: StudentKubeconfigInput): string {
  const clusterName = input.clusterName ?? 'jumptotech-labs';
  const userName = input.userName ?? 'student';
  const contextName = input.contextName ?? 'lab';

  const cluster: Record<string, unknown> = { server: input.endpoint.server };
  if (input.endpoint.certificateAuthorityData) {
    cluster['certificate-authority-data'] = input.endpoint.certificateAuthorityData;
  } else if (input.endpoint.insecureSkipTlsVerify) {
    cluster['insecure-skip-tls-verify'] = true;
  }

  return stringifyYaml({
    apiVersion: 'v1',
    kind: 'Config',
    'current-context': contextName,
    clusters: [{ name: clusterName, cluster }],
    users: [{ name: userName, user: { token: input.token } }],
    contexts: [
      {
        name: contextName,
        context: { cluster: clusterName, user: userName, namespace: input.namespace },
      },
    ],
    preferences: {},
  });
}
