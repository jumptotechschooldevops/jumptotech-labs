/**
 * Behavioural NetworkPolicy enforcement probe (BETA-P0-015).
 *
 * Reading policies back proves the API server stored them. It says nothing
 * about whether the network implementation acts on them, and a cluster whose
 * CNI ignores NetworkPolicy accepts every object without complaint. So this
 * probe measures connections, and every "blocked" it reports is paired with a
 * negative control showing the *same* connection succeeding without the policy:
 *
 *   without-policy  Three namespaces A, B, C, each with a server and a client.
 *                   Cross-namespace connections, and the public target, must
 *                   succeed. If they do not, a later "blocked" would prove
 *                   nothing, so the run is INCONCLUSIVE — never PASS.
 *
 *   with-policy     A and B receive exactly the platform's session policies
 *                   (`networkPolicyManifests`, the same builder the provider
 *                   applies); C stays unfenced. The same connections must now
 *                   be refused, while same-namespace traffic, cluster DNS and
 *                   the API server keep working, and C still reaches itself.
 *
 * Verdict: any connection that should be blocked but is reachable → FAIL. Any
 * failed control → INCONCLUSIVE. Any allowance the contract promises that does
 * not work → FAIL. Otherwise PASS.
 *
 * Measured and reported but never part of the verdict: a session Pod reaching
 * its node's kubelet. NetworkPolicy does not govern pod-to-node traffic on
 * common CNIs; the report says what was observed rather than implying a
 * boundary that does not exist.
 *
 * The probe drives `kubectl` through an injected runner, so it runs identically
 * from the operator CLI, the integration suite, and a hermetic unit test.
 */
import type { ApiServerEndpoint } from './port.js';
import { networkPolicyContractDigest, networkPolicyManifests } from '../session/network-policy.js';
import type { SessionPolicy } from '../session/types.js';
import type { EnforcementVerdict, NetworkEnforcementAttestation } from './network-attestation.js';

export const NETWORK_PROBE_VERSION = 'beta-p0-015.1';
export const DEFAULT_NETWORK_PROBE_IMAGE = 'busybox:1.36';
export const NETWORK_PROBE_LABEL = 'jumptotech.io/network-probe';
export const DEFAULT_PUBLIC_PROBE_TARGET: ProbeTarget = { host: '1.1.1.1', port: 443 };
export const NETWORK_PROBE_SERVER_PORT = 8080;
export const NETWORK_PROBE_MARKER = 'jtt-network-probe-ok';

export interface KubectlResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type KubectlRunner = (
  args: string[],
  options?: { input?: string; timeoutMs?: number },
) => Promise<KubectlResult>;

export type Reachability = 'reachable' | 'blocked';
export type ProbePhase = 'without-policy' | 'with-policy';
/**
 * `control` — must hold for the run to mean anything.
 * `assertion` — the contract itself.
 * `informational` — measured and reported, not judged.
 */
export type ProbeCheckRole = 'control' | 'assertion' | 'informational';

export interface ProbeCheck {
  name: string;
  phase: ProbePhase;
  role: ProbeCheckRole;
  expected: Reachability | null;
  observed: Reachability;
}

export interface ProbeTarget {
  host: string;
  port: number;
}

export interface NetworkProbeOptions {
  kubectl: KubectlRunner;
  /** The deployment's session policy; its `network` is what gets measured. */
  policy: SessionPolicy;
  /** Lowercase alphanumeric, ≤20 chars; names the probe namespaces. */
  runId: string;
  image?: string;
  /** A public address that the unfenced control namespace can reach. */
  publicTarget?: ProbeTarget;
  /** Optional private address (node network, application tier) sessions must not reach. */
  privateTarget?: ProbeTarget;
  /** How long to wait for policies to take effect. Default 60s. */
  settleTimeoutMs?: number;
  keepNamespaces?: boolean;
  log?: (line: string) => void;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export interface NetworkProbeReport {
  verdict: EnforcementVerdict;
  reasons: string[];
  checks: ProbeCheck[];
  clusterUid: string;
  kubernetesVersion: string;
  policyDigest: string;
  externalEgressPermitted: boolean;
  nodeLocalEgress: Reachability | 'not-measured';
  namespaces: string[];
  startedAt: string;
  finishedAt: string;
}

/** Pure verdict over a set of checks — see the module header for the rules. */
export function probeVerdict(checks: readonly ProbeCheck[]): {
  verdict: EnforcementVerdict;
  reasons: string[];
} {
  const describe = (c: ProbeCheck) => `${c.phase} ${c.name}: expected ${c.expected}, observed ${c.observed}`;
  const judged = checks.filter((c) => c.role !== 'informational');
  const mismatched = (c: ProbeCheck) => c.expected !== null && c.observed !== c.expected;

  const leaks = judged.filter((c) => c.role === 'assertion' && c.expected === 'blocked' && c.observed === 'reachable');
  if (leaks.length > 0) return { verdict: 'FAIL', reasons: leaks.map(describe) };

  const failedControls = judged.filter((c) => c.role === 'control' && mismatched(c));
  if (failedControls.length > 0) {
    return { verdict: 'INCONCLUSIVE', reasons: failedControls.map((c) => `control failed — ${describe(c)}`) };
  }

  const broken = judged.filter((c) => c.role === 'assertion' && mismatched(c));
  if (broken.length > 0) return { verdict: 'FAIL', reasons: broken.map(describe) };

  if (!judged.some((c) => c.role === 'assertion' && c.expected === 'blocked')) {
    return { verdict: 'INCONCLUSIVE', reasons: ['no isolation assertion was measured'] };
  }
  return { verdict: 'PASS', reasons: [] };
}

export function probeReportToAttestation(report: NetworkProbeReport): NetworkEnforcementAttestation {
  return {
    verdict: report.verdict,
    clusterUid: report.clusterUid,
    policyDigest: report.policyDigest,
    verifiedAt: report.finishedAt,
    probeVersion: NETWORK_PROBE_VERSION,
    kubernetesVersion: report.kubernetesVersion,
    checks: report.checks
      .map((c) => `${c.phase} ${c.role} ${c.name} expected=${c.expected ?? '-'} observed=${c.observed}`)
      .join('\n'),
    nodeLocalEgress: report.nodeLocalEgress,
  };
}

/** Ready endpoints from `kubectl get endpointslices -o json` for default/kubernetes. */
export function parseApiServerEndpointSlices(json: string): ApiServerEndpoint[] {
  const parsed = JSON.parse(json) as {
    items?: Array<{
      ports?: Array<{ name?: string; port?: number }>;
      endpoints?: Array<{ addresses?: string[]; conditions?: { ready?: boolean } }>;
    }>;
  };
  const endpoints: ApiServerEndpoint[] = [];
  for (const slice of parsed.items ?? []) {
    const port = slice.ports?.find((p) => p.name === 'https')?.port ?? slice.ports?.[0]?.port;
    if (typeof port !== 'number') continue;
    for (const endpoint of slice.endpoints ?? []) {
      if (endpoint.conditions?.ready === false) continue;
      for (const ip of endpoint.addresses ?? []) endpoints.push({ ip, port });
    }
  }
  return endpoints;
}

/** Namespace, server Pod + Service, and client Pod — restricted-profile compatible. */
export function probeWorkload(namespace: string, image: string, runId: string): Record<string, unknown> {
  const labels = { [NETWORK_PROBE_LABEL]: runId };
  const pod = (name: string, command: string[], extraLabels: Record<string, string> = {}) => ({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, namespace, labels: { ...labels, ...extraLabels } },
    spec: {
      automountServiceAccountToken: false,
      terminationGracePeriodSeconds: 0,
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 65534,
        runAsGroup: 65534,
        seccompProfile: { type: 'RuntimeDefault' },
      },
      containers: [
        {
          name,
          image,
          command,
          securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
          resources: {
            requests: { cpu: '10m', memory: '16Mi' },
            limits: { cpu: '100m', memory: '64Mi' },
          },
        },
      ],
    },
  });
  return {
    apiVersion: 'v1',
    kind: 'List',
    items: [
      { apiVersion: 'v1', kind: 'Namespace', metadata: { name: namespace, labels } },
      pod(
        'srv',
        [
          'sh',
          '-c',
          `mkdir -p /tmp/www && echo ${NETWORK_PROBE_MARKER} > /tmp/www/index.html && exec httpd -f -p ${NETWORK_PROBE_SERVER_PORT} -h /tmp/www`,
        ],
        { app: 'jtt-probe-srv' },
      ),
      {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name: 'srv', namespace, labels },
        spec: {
          selector: { app: 'jtt-probe-srv' },
          ports: [{ port: NETWORK_PROBE_SERVER_PORT, targetPort: NETWORK_PROBE_SERVER_PORT }],
        },
      },
      pod('cli', ['sleep', '3600']),
    ],
  };
}

const SAFE_HOST = /^[A-Za-z0-9.:-]+$/;

export async function runNetworkEnforcementProbe(options: NetworkProbeOptions): Promise<NetworkProbeReport> {
  const { kubectl, policy } = options;
  const network = policy.network;
  const log = options.log ?? (() => undefined);
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const image = options.image ?? DEFAULT_NETWORK_PROBE_IMAGE;
  const publicTarget = options.publicTarget ?? DEFAULT_PUBLIC_PROBE_TARGET;
  const privateTarget = options.privateTarget;
  const settleTimeoutMs = options.settleTimeoutMs ?? 60_000;

  if (!/^[a-z0-9]{1,20}$/.test(options.runId)) {
    throw new Error(`probe runId '${options.runId}' must be 1-20 lowercase letters or digits`);
  }
  if (!network.enabled) {
    throw new Error('NETWORK_POLICY_ENABLED=false: there are no session policies to measure');
  }
  for (const target of [publicTarget, privateTarget]) {
    if (target && (!SAFE_HOST.test(target.host) || !Number.isInteger(target.port))) {
      throw new Error(`probe target '${target.host}:${target.port}' is not a host and port`);
    }
  }

  const ns = {
    a: `jtt-netprobe-${options.runId}-a`,
    b: `jtt-netprobe-${options.runId}-b`,
    c: `jtt-netprobe-${options.runId}-c`,
  };
  const startedAt = now().toISOString();
  const checks: ProbeCheck[] = [];

  const run = (args: string[], input?: string, timeoutMs = 30_000) =>
    kubectl(args, { ...(input !== undefined ? { input } : {}), timeoutMs });
  const must = async (what: string, args: string[], input?: string, timeoutMs?: number) => {
    const result = await run(args, input, timeoutMs);
    if (result.code !== 0) {
      throw new Error(`${what}: kubectl ${args.slice(0, 3).join(' ')} exited ${result.code}: ${result.stderr.trim()}`);
    }
    return result.stdout;
  };

  const clusterUid = (await must('reading kube-system', ['get', 'namespace', 'kube-system', '-o', 'jsonpath={.metadata.uid}'])).trim();
  let kubernetesVersion = 'unknown';
  try {
    const version = JSON.parse(await must('reading the server version', ['version', '-o', 'json'])) as {
      serverVersion?: { gitVersion?: string };
    };
    kubernetesVersion = version.serverVersion?.gitVersion ?? 'unknown';
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  const apiServerEndpoints = parseApiServerEndpointSlices(
    await must('reading API server endpoints', [
      'get', 'endpointslices', '-n', 'default', '-l', 'kubernetes.io/service-name=kubernetes', '-o', 'json',
    ]),
  );
  const nodeIp = (
    await must('reading nodes', ['get', 'nodes', '-o', 'jsonpath={.items[0].status.addresses[?(@.type=="InternalIP")].address}'])
  ).trim().split(/\s+/)[0] ?? '';
  const dnsSelector = Object.entries(network.dnsPodSelector).map(([k, v]) => `${k}=${v}`).join(',');
  const dnsPodIp = (
    await must('reading DNS pods', ['get', 'pods', '-n', network.dnsNamespace, '-l', dnsSelector, '-o', 'jsonpath={.items[0].status.podIP}'])
  ).trim();

  const exec = (from: string, command: string[]) => run(['exec', '-n', from, 'cli', '--', ...command], undefined, 25_000);
  const http = async (from: string, host: string) => {
    const result = await exec(from, ['wget', '-q', '-T', '3', '-O', '-', `http://${host}:${NETWORK_PROBE_SERVER_PORT}/`]);
    return result.code === 0 && result.stdout.includes(NETWORK_PROBE_MARKER);
  };
  const tcp = async (from: string, target: ProbeTarget) => {
    if (!SAFE_HOST.test(target.host)) return false;
    return (await exec(from, ['sh', '-c', `echo | nc -w 3 ${target.host} ${target.port}`])).code === 0;
  };
  const dns = async (from: string, name: string) => (await exec(from, ['nslookup', name])).code === 0;

  const check = async (
    name: string,
    phase: ProbePhase,
    role: ProbeCheckRole,
    expected: Reachability | null,
    attempt: () => Promise<boolean>,
  ): Promise<Reachability> => {
    // An allowance gets three tries, so a slow first packet is not a failure;
    // a denial gets two, and a single success anywhere is a leak.
    const tries = expected === 'reachable' ? 3 : 2;
    let observed: Reachability = 'blocked';
    for (let i = 0; i < tries && observed === 'blocked'; i += 1) {
      if (await attempt()) observed = 'reachable';
    }
    checks.push({ name, phase, role, expected, observed });
    log(`${phase.padEnd(14)} ${role.padEnd(13)} ${name} — expected ${expected ?? '(not judged)'}, observed ${observed}`);
    return observed;
  };

  let nodeLocalEgress: Reachability | 'not-measured' = 'not-measured';
  const pub = `${publicTarget.host}:${publicTarget.port}`;
  const priv = privateTarget ? `${privateTarget.host}:${privateTarget.port}` : '';

  try {
    for (const name of Object.values(ns)) {
      await must(`creating ${name}`, ['apply', '-f', '-'], JSON.stringify(probeWorkload(name, image, options.runId)));
    }
    for (const name of Object.values(ns)) {
      await must(`waiting for Pods in ${name}`, ['wait', '--for=condition=Ready', 'pod', '--all', '-n', name, '--timeout=240s'], undefined, 260_000);
    }

    const podIp = async (n: string) => (await must(`reading ${n}/srv`, ['get', 'pod', 'srv', '-n', n, '-o', 'jsonpath={.status.podIP}'])).trim();
    const svcIp = async (n: string) => (await must(`reading ${n}/srv service`, ['get', 'service', 'srv', '-n', n, '-o', 'jsonpath={.spec.clusterIP}'])).trim();
    const ip = { a: await podIp(ns.a), b: await podIp(ns.b), c: await podIp(ns.c) };
    const serviceB = await svcIp(ns.b);

    // --- negative control: the same connections, no policy anywhere --------
    const W = 'without-policy';
    await check('session A -> session B pod', W, 'control', 'reachable', () => http(ns.a, ip.b));
    await check('session A -> session B service', W, 'control', 'reachable', () => http(ns.a, serviceB));
    await check('session B -> session A pod', W, 'control', 'reachable', () => http(ns.b, ip.a));
    await check('unfenced C -> session A pod', W, 'control', 'reachable', () => http(ns.c, ip.a));
    await check('session A -> unfenced C pod', W, 'control', 'reachable', () => http(ns.a, ip.c));
    await check(`session A -> public ${pub}`, W, 'control', 'reachable', () => tcp(ns.a, publicTarget));
    if (privateTarget) {
      await check(`session A -> private ${priv}`, W, 'control', 'reachable', () => tcp(ns.a, privateTarget));
    }
    // Not every DNS implementation listens on :8181. Only where the control
    // shows a listener is "the DNS rule opens port 53 and nothing else" judged.
    const dnsSidePort = dnsPodIp
      ? await check(`session A -> DNS pod ${dnsPodIp}:8181 (non-DNS port)`, W, 'informational', null, () =>
          tcp(ns.a, { host: dnsPodIp, port: 8181 }))
      : 'blocked';

    // --- the platform's policies on A and B; C stays unfenced --------------
    const policiesA = networkPolicyManifests(policy, { apiServerEndpoints });
    const policiesB = networkPolicyManifests(policy, {
      apiServerEndpoints,
      capabilities: network.allowExternalEgress ? ['external_egress'] : [],
    });
    await must('applying session policies to A', ['apply', '-n', ns.a, '-f', '-'], JSON.stringify({ apiVersion: 'v1', kind: 'List', items: policiesA }));
    await must('applying session policies to B', ['apply', '-n', ns.b, '-f', '-'], JSON.stringify({ apiVersion: 'v1', kind: 'List', items: policiesB }));

    // Enforcement is programmed asynchronously. Wait until the first denial
    // appears (or the deadline passes, in which case the assertion reports it).
    const deadline = Date.now() + settleTimeoutMs;
    while (Date.now() < deadline && (await http(ns.a, ip.b))) await sleep(2_000);

    const P = 'with-policy';
    await check('session A -> own pod', P, 'assertion', 'reachable', () => http(ns.a, ip.a));
    await check('session A -> own service by DNS name', P, 'assertion', 'reachable', () => http(ns.a, `srv.${ns.a}.svc.cluster.local`));
    await check('session A resolves cluster DNS', P, 'assertion', 'reachable', () => dns(ns.a, 'kubernetes.default.svc.cluster.local'));
    await check('session B -> own pod', P, 'assertion', 'reachable', () => http(ns.b, ip.b));
    for (const endpoint of apiServerEndpoints.filter((e) => !e.ip.includes(':'))) {
      await check(`session A -> API server ${endpoint.ip}:${endpoint.port}`, P, 'assertion', 'reachable', () =>
        tcp(ns.a, { host: endpoint.ip, port: endpoint.port }));
    }
    await check('session A -> session B pod', P, 'assertion', 'blocked', () => http(ns.a, ip.b));
    await check('session A -> session B service', P, 'assertion', 'blocked', () => http(ns.a, serviceB));
    await check('session B -> session A pod', P, 'assertion', 'blocked', () => http(ns.b, ip.a));
    await check('unfenced C -> session A pod', P, 'assertion', 'blocked', () => http(ns.c, ip.a));
    await check('session A -> unfenced C pod', P, 'assertion', 'blocked', () => http(ns.a, ip.c));
    await check(`session A -> public ${pub}`, P, 'assertion', 'blocked', () => tcp(ns.a, publicTarget));
    if (privateTarget) {
      await check(`session A -> private ${priv}`, P, 'assertion', 'blocked', () => tcp(ns.a, privateTarget));
    }
    if (dnsPodIp && dnsSidePort === 'reachable') {
      await check(`session A -> DNS pod ${dnsPodIp}:8181 (non-DNS port)`, P, 'assertion', 'blocked', () =>
        tcp(ns.a, { host: dnsPodIp, port: 8181 }));
    }
    if (network.allowExternalEgress) {
      await check(`external-egress session B -> public ${pub}`, P, 'assertion', 'reachable', () => tcp(ns.b, publicTarget));
      await check('external-egress session B -> unfenced C pod', P, 'assertion', 'blocked', () => http(ns.b, ip.c));
      if (privateTarget) {
        await check(`external-egress session B -> private ${priv}`, P, 'assertion', 'blocked', () => tcp(ns.b, privateTarget));
      }
    }
    // The server C reaches is still up and the cluster network still works, so
    // the denials above are the policy and not an outage.
    await check('unfenced C -> own pod', P, 'control', 'reachable', () => http(ns.c, ip.c));
    await check(`unfenced C -> public ${pub}`, P, 'control', 'reachable', () => tcp(ns.c, publicTarget));
    if (nodeIp) {
      nodeLocalEgress = await check(
        `session A -> node ${nodeIp}:10250 (pod-to-node; not governed by NetworkPolicy)`,
        P,
        'informational',
        null,
        () => tcp(ns.a, { host: nodeIp, port: 10250 }),
      );
    }
  } finally {
    if (!options.keepNamespaces) {
      for (const name of Object.values(ns)) {
        await run(['delete', 'namespace', name, '--wait=false', '--ignore-not-found']);
      }
    }
  }

  const { verdict, reasons } = probeVerdict(checks);
  return {
    verdict,
    reasons,
    checks,
    clusterUid,
    kubernetesVersion,
    policyDigest: networkPolicyContractDigest(network),
    externalEgressPermitted: network.allowExternalEgress,
    nodeLocalEgress,
    namespaces: Object.values(ns),
    startedAt,
    finishedAt: now().toISOString(),
  };
}
