/**
 * Kind-agnostic handlers.
 *
 * `resource_absent` is the only requirement that passes when an object is
 * *missing*, which makes it the one check a student satisfies by deleting
 * something — clean-up tasks, and troubleshooting labs where the fix is to
 * remove a broken object rather than edit it.
 */
import type { VerifierHandler } from '../contract.js';
import { fail, pass } from '../contract.js';
import type { VerifyReader } from '../reader.js';

type CheckableKind =
  | 'pod'
  | 'deployment'
  | 'service'
  | 'configmap'
  | 'secret'
  | 'job'
  | 'cronjob'
  | 'statefulset'
  | 'daemonset'
  | 'ingress'
  | 'persistentvolumeclaim'
  | 'role'
  | 'rolebinding'
  | 'networkpolicy'
  | 'horizontalpodautoscaler'
  | 'serviceaccount';

/** How each kind is read, and how it is named in student-facing text. */
const LOOKUPS: Record<
  CheckableKind,
  { title: string; read: (reader: VerifyReader, name: string) => Promise<unknown | null> }
> = {
  pod: { title: 'Pod', read: (reader, name) => reader.pod(name) },
  deployment: { title: 'Deployment', read: (reader, name) => reader.deployment(name) },
  service: { title: 'Service', read: (reader, name) => reader.service(name) },
  configmap: { title: 'ConfigMap', read: (reader, name) => reader.configMap(name) },
  secret: { title: 'Secret', read: (reader, name) => reader.secret(name) },
  job: { title: 'Job', read: (reader, name) => reader.job(name) },
  cronjob: { title: 'CronJob', read: (reader, name) => reader.cronJob(name) },
  statefulset: { title: 'StatefulSet', read: (reader, name) => reader.statefulSet(name) },
  daemonset: { title: 'DaemonSet', read: (reader, name) => reader.daemonSet(name) },
  ingress: { title: 'Ingress', read: (reader, name) => reader.ingress(name) },
  persistentvolumeclaim: {
    title: 'PersistentVolumeClaim',
    read: (reader, name) => reader.persistentVolumeClaim(name),
  },
  role: { title: 'Role', read: (reader, name) => reader.role(name) },
  rolebinding: { title: 'RoleBinding', read: (reader, name) => reader.roleBinding(name) },
  networkpolicy: { title: 'NetworkPolicy', read: (reader, name) => reader.networkPolicy(name) },
  horizontalpodautoscaler: {
    title: 'HorizontalPodAutoscaler',
    read: (reader, name) => reader.horizontalPodAutoscaler(name),
  },
  serviceaccount: { title: 'ServiceAccount', read: (reader, name) => reader.serviceAccount(name) },
};

export const resourceAbsent: VerifierHandler<'resource_absent'> = {
  type: 'resource_absent',
  label: (r) => `${LOOKUPS[r.kind].title} ${r.name} no longer exists`,
  async run(r, reader) {
    const lookup = LOOKUPS[r.kind];
    const found = await lookup.read(reader, r.name);
    return found === null
      ? pass()
      : fail(`${lookup.title} '${r.name}' still exists in namespace '${reader.namespace}'`);
  },
};
