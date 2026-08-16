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

type CheckableKind = 'pod' | 'deployment' | 'service' | 'configmap' | 'secret' | 'job' | 'cronjob';

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
