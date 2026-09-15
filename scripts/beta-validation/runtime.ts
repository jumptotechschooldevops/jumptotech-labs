/**
 * BETA-P0-019 — read-mostly views of the real runtime, from the host.
 *
 * Everything the harness asserts about sandboxes is read from the source of
 * truth — the Docker daemon, the kind API server, PostgreSQL, Prometheus —
 * never from the API that is under test. The only writes are the run-scoped
 * sentinels (created, and removed, by name) and the API restart in the
 * recovery phase, which the private-beta runbook documents as safe.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const MANAGED_LABEL = 'jumptotech.io/managed';
export const OWNER_LABEL = 'jumptotech.io/runtime-owner';
export const SESSION_LABEL = 'jumptotech.io/session-id';

export async function sh(
  file: string,
  args: readonly string[],
  timeoutMs = 120_000,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const { stdout } = await run(file, [...args], {
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    ...(env ? { env } : {}),
  });
  return stdout;
}

export interface OwnedContainer {
  id: string;
  name: string;
  sessionId: string | undefined;
  state: string;
}

export async function ownedContainers(owner: string): Promise<OwnedContainer[]> {
  const out = await sh('docker', [
    'ps', '-a', '--no-trunc',
    '--filter', `label=${MANAGED_LABEL}=true`,
    '--filter', `label=${OWNER_LABEL}=${owner}`,
    '--format', `{{.ID}}\t{{.Names}}\t{{.Label "${SESSION_LABEL}"}}\t{{.State}}`,
  ]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, name, sessionId, state] = line.split('\t');
      return { id: id!, name: name!, sessionId: sessionId || undefined, state: state! };
    });
}

export async function ownedNetworks(owner: string): Promise<string[]> {
  const out = await sh('docker', [
    'network', 'ls',
    '--filter', `label=${MANAGED_LABEL}=true`,
    '--filter', `label=${OWNER_LABEL}=${owner}`,
    '--format', '{{.Name}}',
  ]);
  return out.split('\n').filter(Boolean);
}

export interface OwnedNamespace {
  name: string;
  uid: string;
  sessionId: string | undefined;
  phase: string;
}

export class Kube {
  constructor(readonly kubeconfig: string) {}

  kubectl(args: readonly string[], timeoutMs = 60_000): Promise<string> {
    return sh('kubectl', ['--kubeconfig', this.kubeconfig, ...args], timeoutMs);
  }

  async context(): Promise<{ context: string; server: string }> {
    const context = (await this.kubectl(['config', 'current-context'])).trim();
    const server = (await this.kubectl(['config', 'view', '--minify', '-o', 'jsonpath={.clusters[0].cluster.server}'])).trim();
    return { context, server };
  }

  async ownedNamespaces(owner: string): Promise<OwnedNamespace[]> {
    const out = await this.kubectl(['get', 'namespaces', '-l', `${MANAGED_LABEL}=true,${OWNER_LABEL}=${owner}`, '-o', 'json']);
    const items = (JSON.parse(out) as { items: Array<{ metadata: { name: string; uid: string; labels?: Record<string, string> }; status?: { phase?: string } }> }).items;
    return items.map((ns) => ({
      name: ns.metadata.name,
      uid: ns.metadata.uid,
      sessionId: ns.metadata.labels?.[SESSION_LABEL],
      phase: ns.status?.phase ?? 'Unknown',
    }));
  }
}

/** `docker compose` names a service's container by these two labels; ask the daemon, never guess. */
export async function composeContainer(project: string, service: string): Promise<string> {
  const out = await sh('docker', [
    'ps', '--filter', `label=com.docker.compose.project=${project}`,
    '--filter', `label=com.docker.compose.service=${service}`,
    '--format', '{{.Names}}',
  ]);
  const name = out.split('\n').filter(Boolean)[0];
  if (!name) throw new Error(`no running '${service}' container in compose project '${project}'`);
  return name;
}

/**
 * One SQL query through the postgres container's local socket — the P0-013
 * pattern: no password is read, passed or printed.
 */
export async function psql(container: string, sql: string): Promise<string[][]> {
  const out = await sh('docker', [
    'exec', container, 'sh', '-c',
    'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -AtF "\t" -v ON_ERROR_STOP=1 -c "$1"', 'psql', sql,
  ]);
  return out.split('\n').filter(Boolean).map((line) => line.split('\t'));
}

/** Prometheus is loopback-only inside its own namespace (P0-018), so ask it from inside. */
export async function promQuery(container: string, expr: string): Promise<string> {
  return sh('docker', ['exec', container, 'promtool', 'query', 'instant', 'http://127.0.0.1:9090', expr]);
}

export interface ContainerStat {
  name: string;
  cpuPercent: number;
  memBytes: number;
}

const UNITS: Record<string, number> = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, kB: 1000, MB: 1000 ** 2, GB: 1000 ** 3 };

export async function containerStats(names: readonly string[]): Promise<ContainerStat[]> {
  if (names.length === 0) return [];
  const out = await sh('docker', ['stats', '--no-stream', '--format', '{{json .}}', ...names], 60_000);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const row = JSON.parse(line) as { Name: string; CPUPerc: string; MemUsage: string };
      const used = /^([\d.]+)\s*([A-Za-z]+)/.exec(row.MemUsage);
      return {
        name: row.Name,
        cpuPercent: Number.parseFloat(row.CPUPerc),
        memBytes: used ? Number(used[1]) * (UNITS[used[2]!] ?? 1) : Number.NaN,
      };
    });
}

export async function containerIdentity(name: string): Promise<string | undefined> {
  try {
    return (await sh('docker', ['inspect', '--format', '{{.Id}}', name])).trim();
  } catch {
    return undefined;
  }
}

/**
 * Run-scoped resources that look like another deployment's sandboxes: labelled
 * managed, carrying a *different* runtime owner. Nothing in this run may remove
 * them; the harness itself does, by exact name, at the end.
 */
export async function createSentinels(kube: Kube, opts: { owner: string; runId: string; image: string }) {
  const container = `jtt-lab-${opts.runId}5e17`;
  const namespace = `jtt-p0019-sentinel-${opts.runId}`;
  const foreignOwner = `${opts.owner}-sentinel`;
  await sh('docker', [
    'run', '--detach', '--name', container, '--network', 'none',
    '--label', `${MANAGED_LABEL}=true`, '--label', `${OWNER_LABEL}=${foreignOwner}`,
    '--label', `jumptotech.io/test-run=${opts.runId}`,
    opts.image, 'sleep', 'infinity',
  ]);
  const manifest = JSON.stringify({
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: {
      name: namespace,
      labels: {
        [MANAGED_LABEL]: 'true',
        [OWNER_LABEL]: foreignOwner,
        'jumptotech.io/test-run': opts.runId,
        'pod-security.kubernetes.io/enforce': 'baseline',
        'pod-security.kubernetes.io/enforce-version': 'v1.34',
      },
    },
  });
  await sh('bash', ['-c', `printf '%s' "$1" | kubectl --kubeconfig "$2" apply -f - >/dev/null`, 'apply', manifest, kube.kubeconfig]);
  return { container, namespace };
}

export async function sentinelsPresent(kube: Kube, sentinels: { container: string; namespace: string }) {
  const container = (await containerIdentity(sentinels.container)) !== undefined;
  let namespace = false;
  try {
    namespace = (await kube.kubectl(['get', 'namespace', sentinels.namespace, '-o', 'jsonpath={.status.phase}'])).trim() === 'Active';
  } catch {
    namespace = false;
  }
  return { container, namespace };
}

export async function removeSentinels(kube: Kube, sentinels: { container: string; namespace: string }, runId: string) {
  if (!sentinels.container.includes(runId) || !sentinels.namespace.includes(runId)) {
    throw new Error('refusing to remove a sentinel this run did not name');
  }
  await sh('docker', ['rm', '--force', sentinels.container]).catch(() => undefined);
  await kube.kubectl(['delete', 'namespace', sentinels.namespace, '--wait=false']).catch(() => undefined);
}
