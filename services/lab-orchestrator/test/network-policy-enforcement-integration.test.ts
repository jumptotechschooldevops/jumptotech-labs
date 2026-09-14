/**
 * BETA-P0-015 — NetworkPolicy enforcement, measured on a real cluster.
 *
 * A cluster accepts NetworkPolicy objects whether or not its network
 * implementation enforces them, so nothing here reads a policy back and calls
 * it isolation. Every denial is a connection attempt that fails, paired with a
 * negative control: the same connection, without the policy, succeeding.
 *
 *   1. The enforcement probe with the platform's contract — PASS, and every
 *      "blocked" has a "reachable" twin from before the policies existed.
 *   2. The probe with external egress permitted — the public target opens for a
 *      lab that declares it; other sessions and private infrastructure do not.
 *   3. Real sessions through SessionManager + KindLabProvider: session A cannot
 *      reach session B in either direction while each reaches itself and DNS;
 *      two sessions created with NetworkPolicy disabled reach each other over
 *      the very same connection.
 *   4. The production admission gate: with an attestation required and none on
 *      the cluster, no session starts; with the probe's PASS recorded, it does.
 *
 * Gated on RUN_INTEGRATION_TESTS=1.
 *
 *   RUN_INTEGRATION_TESTS=1 KUBECONFIG=… npm run test:integration:network-policy
 *
 * E2E — what it mutates, all run-scoped and removed afterwards:
 *   - namespaces jtt-netprobe-<run>…-{a,b,c} and lab-* session namespaces;
 *   - one Docker container on the `kind` network (a stand-in for private
 *     infrastructure), labelled jumptotech.io/managed=true;
 *   - kube-system/jumptotech-network-policy-enforcement, which is cluster-global:
 *     its previous content is saved first and restored (or it is deleted if it
 *     did not exist).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { scopedName, testRunId } from '@jumptotech/test-support/run-id';
import { waitForRequirements } from '@jumptotech/verifier';
import {
  DEFAULT_SESSION_POLICY,
  DEFAULT_NETWORK_PROBE_IMAGE,
  InMemorySessionStore,
  KindLabProvider,
  KubernetesClient,
  NETWORK_ATTESTATION_NAME,
  NETWORK_ATTESTATION_NAMESPACE,
  NETWORK_PROBE_MARKER,
  NETWORK_PROBE_SERVER_PORT,
  SessionManager,
  attestationConfigMap,
  networkPolicyNames,
  probeReportToAttestation,
  probeWorkload,
  runNetworkEnforcementProbe,
  spawnKubectl,
  type LabRegistry,
  type LabSession,
  type NetworkProbeReport,
  type ProbeTarget,
  type SessionPolicy,
} from '../src/index.js';
import { realCatalog } from './real-catalog.js';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const HOST_KUBECONFIG =
  process.env.KUBECONFIG ?? path.join(repoRoot, 'infrastructure/kind/generated/kubeconfig-host.yaml');

const enabled = process.env.RUN_INTEGRATION_TESTS === '1' && existsSync(HOST_KUBECONFIG);
const suite = enabled ? describe : describe.skip;

const kubectl = spawnKubectl({ kubeconfig: HOST_KUBECONFIG });
const RUN = testRunId().toLowerCase().replace(/[^a-z0-9]/g, '').slice(-10);
const log = (line: string) => console.log(`[netpol ${RUN}] ${line}`);

async function must(args: string[], input?: string, timeoutMs = 120_000): Promise<string> {
  const result = await kubectl(args, { ...(input !== undefined ? { input } : {}), timeoutMs });
  if (result.code !== 0) throw new Error(`kubectl ${args.join(' ')}: ${result.stderr.trim()}`);
  return result.stdout;
}

/** Private infrastructure stand-in: an HTTP listener on the kind Docker network. */
async function startInfraTarget(): Promise<{ name: string; target: ProbeTarget }> {
  const name = scopedName('netprobe', 'infra');
  await execFileAsync('docker', [
    'run', '-d', '--rm', '--name', name, '--network', 'kind',
    '--label', 'jumptotech.io/managed=true',
    DEFAULT_NETWORK_PROBE_IMAGE, 'sh', '-c',
    'mkdir -p /w && echo infra > /w/index.html && exec httpd -f -p 8080 -h /w',
  ]);
  const { stdout } = await execFileAsync('docker', [
    'inspect', '-f', '{{with index .NetworkSettings.Networks "kind"}}{{.IPAddress}}{{end}}', name,
  ]);
  return { name, target: { host: stdout.trim(), port: 8080 } };
}

const blockedAssertions = (report: NetworkProbeReport) =>
  report.checks.filter((c) => c.phase === 'with-policy' && c.role === 'assertion' && c.expected === 'blocked');

suite('NetworkPolicy enforcement on a real cluster (BETA-P0-015)', () => {
  let infra: { name: string; target: ProbeTarget };

  beforeAll(async () => {
    infra = await startInfraTarget();
  }, 180_000);

  afterAll(async () => {
    if (infra) await execFileAsync('docker', ['rm', '-f', infra.name]).catch(() => undefined);
  }, 60_000);

  // ------------------------------------------------ 1. the contract as shipped

  describe('the enforcement probe, platform defaults (no external egress)', () => {
    let report: NetworkProbeReport;

    beforeAll(async () => {
      report = await runNetworkEnforcementProbe({
        kubectl,
        policy: DEFAULT_SESSION_POLICY,
        runId: `${RUN}d`,
        privateTarget: infra.target,
        log,
      });
    }, 900_000);

    it('passes', () => {
      expect({ verdict: report.verdict, reasons: report.reasons }).toEqual({ verdict: 'PASS', reasons: [] });
    });

    it('proved every denial against a negative control that connected without the policy', () => {
      const denials = blockedAssertions(report);
      expect(denials.map((c) => c.name)).toEqual(
        expect.arrayContaining([
          'session A -> session B pod',
          'session A -> session B service',
          'session B -> session A pod',
          'unfenced C -> session A pod',
          'session A -> unfenced C pod',
          `session A -> private ${infra.target.host}:${infra.target.port}`,
        ]),
      );
      for (const denial of denials) {
        const control = report.checks.find((c) => c.phase === 'without-policy' && c.name === denial.name);
        expect(control?.observed, `negative control for ${denial.name}`).toBe('reachable');
        expect(denial.observed, denial.name).toBe('blocked');
      }
    });

    it('kept same-namespace traffic, cluster DNS and the API server working under deny-by-default', () => {
      const allowed = report.checks.filter((c) => c.phase === 'with-policy' && c.expected === 'reachable');
      const names = allowed.map((c) => c.name);

      expect(names).toEqual(
        expect.arrayContaining([
          'session A -> own pod',
          'session A -> own service by DNS name',
          'session A resolves cluster DNS',
          'session B -> own pod',
        ]),
      );
      expect(names.some((n) => n.startsWith('session A -> API server '))).toBe(true);
      for (const check of allowed) expect(check.observed, check.name).toBe('reachable');
    });

    it('records, without judging, whether a session Pod reaches its node', () => {
      expect(['reachable', 'blocked']).toContain(report.nodeLocalEgress);
      log(`pod-to-node :10250 was ${report.nodeLocalEgress} (not governed by NetworkPolicy)`);
    });
  });

  // ------------------------------------------- 2. external egress, permitted

  describe('the enforcement probe with external egress permitted', () => {
    let report: NetworkProbeReport;
    const permitted: SessionPolicy = {
      ...DEFAULT_SESSION_POLICY,
      network: { ...DEFAULT_SESSION_POLICY.network, allowExternalEgress: true },
    };

    beforeAll(async () => {
      report = await runNetworkEnforcementProbe({
        kubectl,
        policy: permitted,
        runId: `${RUN}e`,
        privateTarget: infra.target,
        log,
      });
    }, 900_000);

    it('passes', () => {
      expect({ verdict: report.verdict, reasons: report.reasons }).toEqual({ verdict: 'PASS', reasons: [] });
    });

    it('opens the public internet to the declaring lab only, and never private infrastructure or other Pods', () => {
      const observed = Object.fromEntries(
        report.checks.filter((c) => c.phase === 'with-policy').map((c) => [c.name, c.observed]),
      );
      const pub = '1.1.1.1:443';
      const priv = `${infra.target.host}:${infra.target.port}`;

      expect(observed[`external-egress session B -> public ${pub}`]).toBe('reachable');
      expect(observed[`session A -> public ${pub}`]).toBe('blocked');
      expect(observed[`external-egress session B -> private ${priv}`]).toBe('blocked');
      expect(observed['external-egress session B -> unfenced C pod']).toBe('blocked');
      expect(observed['session A -> session B pod']).toBe('blocked');
      expect(report.checks.find((c) => c.phase === 'without-policy' && c.name === `session A -> private ${priv}`)?.observed).toBe(
        'reachable',
      );
    });
  });

  // --------------------------------------------- 3. real sessions, real provider

  describe('real sessions through the provider', () => {
    let registry: LabRegistry;
    let provider: KindLabProvider;
    let guarded: SessionManager;
    let open: SessionManager;
    const sessions: Array<{ manager: SessionManager; session: LabSession }> = [];
    let a: LabSession;
    let b: LabSession;
    let x: LabSession;
    let y: LabSession;

    const managerWith = (policy: SessionPolicy) =>
      new SessionManager({
        registry,
        provider,
        store: new InMemorySessionStore(),
        policy,
        lifetimes: { maxSessionSeconds: 3_600, idleTimeoutSeconds: 1_200, warningSeconds: 300, maxActiveSessions: 20 },
        namespaceSecret: `network-it-${RUN}`,
      });

    const start = async (manager: SessionManager) => {
      const { session } = await manager.start('K8S-001');
      sessions.push({ manager, session });
      return session;
    };

    const deployProbePods = async (namespace: string) => {
      const workload = probeWorkload(namespace, DEFAULT_NETWORK_PROBE_IMAGE, RUN) as { items: Array<{ kind: string }> };
      const items = workload.items.filter((item) => item.kind !== 'Namespace');
      await must(['apply', '-n', namespace, '-f', '-'], JSON.stringify({ apiVersion: 'v1', kind: 'List', items }));
    };

    const podIp = async (namespace: string) => (await must(['get', 'pod', 'srv', '-n', namespace, '-o', 'jsonpath={.status.podIP}'])).trim();

    const reaches = async (from: string, host: string) => {
      const result = await kubectl(
        ['exec', '-n', from, 'cli', '--', 'wget', '-q', '-T', '3', '-O', '-', `http://${host}:${NETWORK_PROBE_SERVER_PORT}/`],
        { timeoutMs: 25_000 },
      );
      return result.code === 0 && result.stdout.includes(NETWORK_PROBE_MARKER);
    };

    /** Allowed: any of three attempts. Denied: after settling, none of three. */
    const eventually = async (from: string, host: string) => {
      for (let i = 0; i < 3; i += 1) if (await reaches(from, host)) return true;
      return false;
    };
    const everReaches = async (from: string, host: string) => {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline && (await reaches(from, host))) {
        /* enforcement is programmed asynchronously; wait for the first denial */
      }
      for (let i = 0; i < 3; i += 1) if (await reaches(from, host)) return true;
      return false;
    };

    beforeAll(async () => {
      registry = await realCatalog();
      const k8s = new KubernetesClient({ kubeconfigPath: HOST_KUBECONFIG });
      provider = new KindLabProvider({
        k8s,
        clusterName: process.env.LAB_CLUSTER_NAME ?? 'jumptotech-labs',
        kubeconfigPath: HOST_KUBECONFIG,
        resetDrainTimeoutMs: 90_000,
        destroyTimeoutMs: 120_000,
        waitForRequirements: (input) => waitForRequirements({ k8s, ...input }),
      });
      guarded = managerWith(DEFAULT_SESSION_POLICY);
      open = managerWith({ ...DEFAULT_SESSION_POLICY, network: { ...DEFAULT_SESSION_POLICY.network, enabled: false } });

      a = await start(guarded);
      b = await start(guarded);
      x = await start(open);
      y = await start(open);
      for (const session of [a, b, x, y]) await deployProbePods(session.namespace);
      for (const session of [a, b, x, y]) {
        await must(['wait', '--for=condition=Ready', 'pod', '--all', '-n', session.namespace, '--timeout=240s'], undefined, 260_000);
      }
    }, 900_000);

    afterAll(async () => {
      for (const { manager, session } of sessions) await manager.end(session.sessionId).catch(() => undefined);
    }, 600_000);

    it('gives a session deny-by-default, DNS and the API server allowance, and no external egress', async () => {
      const names = (await must(['get', 'networkpolicy', '-n', a.namespace, '-o', 'jsonpath={.items[*].metadata.name}'])).split(/\s+/);

      for (const name of networkPolicyNames(DEFAULT_SESSION_POLICY.network.name)) expect(names).toContain(name);
      expect(names).toContain(`${DEFAULT_SESSION_POLICY.network.name}-allow-kube-apiserver`);
      expect(names.some((n) => n.endsWith('allow-external-egress'))).toBe(false);
    }, 60_000);

    it('keeps same-session connectivity: own Pod, own Service by name, cluster DNS', async () => {
      expect(await eventually(a.namespace, await podIp(a.namespace))).toBe(true);
      expect(await eventually(a.namespace, `srv.${a.namespace}.svc.cluster.local`)).toBe(true);
      const lookup = await kubectl(['exec', '-n', a.namespace, 'cli', '--', 'nslookup', 'kubernetes.default.svc.cluster.local'], { timeoutMs: 30_000 });
      expect(lookup.code, lookup.stderr).toBe(0);
    }, 180_000);

    it('session A cannot connect to session B, in either direction, while B reaches itself', async () => {
      const ipA = await podIp(a.namespace);
      const ipB = await podIp(b.namespace);
      const serviceB = (await must(['get', 'service', 'srv', '-n', b.namespace, '-o', 'jsonpath={.spec.clusterIP}'])).trim();

      expect(await eventually(b.namespace, ipB), 'control: B reaches its own server').toBe(true);
      expect(await everReaches(a.namespace, ipB), 'A -> B pod').toBe(false);
      expect(await everReaches(a.namespace, serviceB), 'A -> B service').toBe(false);
      expect(await everReaches(b.namespace, ipA), 'B -> A pod').toBe(false);
    }, 400_000);

    it('negative control: the same connection between two sessions without NetworkPolicy succeeds', async () => {
      const ipY = await podIp(y.namespace);
      const serviceY = (await must(['get', 'service', 'srv', '-n', y.namespace, '-o', 'jsonpath={.spec.clusterIP}'])).trim();
      const policies = (await must(['get', 'networkpolicy', '-n', x.namespace, '-o', 'name'])).trim();

      expect(policies).toBe('');
      expect(await eventually(x.namespace, ipY), 'X -> Y pod').toBe(true);
      expect(await eventually(x.namespace, serviceY), 'X -> Y service').toBe(true);
      expect(await eventually(y.namespace, await podIp(x.namespace)), 'Y -> X pod').toBe(true);
    }, 180_000);
  });

  // ------------------------------------------------ 4. the admission gate

  describe('the production admission gate', () => {
    let registry: LabRegistry;
    let saved: string | null = null;
    const started: Array<{ manager: SessionManager; session: LabSession }> = [];

    const gatedManager = () => {
      const k8s = new KubernetesClient({ kubeconfigPath: HOST_KUBECONFIG });
      const provider = new KindLabProvider({
        k8s,
        clusterName: process.env.LAB_CLUSTER_NAME ?? 'jumptotech-labs',
        kubeconfigPath: HOST_KUBECONFIG,
        resetDrainTimeoutMs: 90_000,
        destroyTimeoutMs: 120_000,
        waitForRequirements: (input) => waitForRequirements({ k8s, ...input }),
        networkPolicyAttestation: { required: true, network: DEFAULT_SESSION_POLICY.network },
      });
      return new SessionManager({
        registry,
        provider,
        store: new InMemorySessionStore(),
        policy: DEFAULT_SESSION_POLICY,
        lifetimes: { maxSessionSeconds: 3_600, idleTimeoutSeconds: 1_200, warningSeconds: 300, maxActiveSessions: 20 },
        namespaceSecret: `network-gate-${RUN}`,
      });
    };

    beforeAll(async () => {
      registry = await realCatalog();
      const existing = await kubectl(['get', 'configmap', NETWORK_ATTESTATION_NAME, '-n', NETWORK_ATTESTATION_NAMESPACE, '-o', 'json']);
      saved = existing.code === 0 ? existing.stdout : null;
      await must(['delete', 'configmap', NETWORK_ATTESTATION_NAME, '-n', NETWORK_ATTESTATION_NAMESPACE, '--ignore-not-found']);
    }, 120_000);

    afterAll(async () => {
      for (const { manager, session } of started) await manager.end(session.sessionId).catch(() => undefined);
      if (saved) {
        const restored = JSON.parse(saved) as { metadata: Record<string, unknown> };
        restored.metadata = {
          name: restored.metadata.name,
          namespace: restored.metadata.namespace,
          labels: restored.metadata.labels,
        };
        await must(['apply', '-f', '-'], JSON.stringify(restored)).catch(() => undefined);
      } else {
        await kubectl(['delete', 'configmap', NETWORK_ATTESTATION_NAME, '-n', NETWORK_ATTESTATION_NAMESPACE, '--ignore-not-found']);
      }
    }, 300_000);

    it('admits no student on a cluster with no attestation', async () => {
      await expect(gatedManager().start('K8S-001')).rejects.toThrow(/network isolation is not proven/);
    }, 120_000);

    it('admits students once the probe has recorded a PASS for this contract', async () => {
      const report = await runNetworkEnforcementProbe({
        kubectl,
        policy: DEFAULT_SESSION_POLICY,
        runId: `${RUN}g`,
        log,
      });
      expect(report.verdict).toBe('PASS');
      const manifest = attestationConfigMap(probeReportToAttestation(report));
      manifest.metadata.namespace = NETWORK_ATTESTATION_NAMESPACE;
      await must(['apply', '-f', '-'], JSON.stringify(manifest));

      const manager = gatedManager();
      const { session } = await manager.start('K8S-001');
      started.push({ manager, session });

      expect(session.status).toBe('ACTIVE');
    }, 900_000);

    it('stops admitting when a later probe records a FAIL', async () => {
      const manifest = attestationConfigMap({
        ...probeReportToAttestation({
          verdict: 'FAIL',
          reasons: ['recorded by the integration suite'],
          checks: [],
          clusterUid: (await must(['get', 'namespace', 'kube-system', '-o', 'jsonpath={.metadata.uid}'])).trim(),
          kubernetesVersion: 'n/a',
          policyDigest: 'n/a',
          externalEgressPermitted: false,
          nodeLocalEgress: 'not-measured',
          namespaces: [],
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        }),
        checks: 'recorded by the integration suite',
      });
      manifest.metadata.namespace = NETWORK_ATTESTATION_NAMESPACE;
      await must(['apply', '-f', '-'], JSON.stringify(manifest));

      await expect(gatedManager().start('K8S-001')).rejects.toThrow(/network isolation is not proven/);
    }, 120_000);
  });
});
