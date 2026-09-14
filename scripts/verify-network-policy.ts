/**
 * BETA-P0-015 — prove NetworkPolicy enforcement on a cluster, and record it.
 *
 *   npm run verify:network-policy -- [--write-attestation]
 *       [--public-target 1.1.1.1:443] [--private-target 172.19.0.3:4000]
 *       [--image busybox:1.36] [--run-id abc123] [--keep-namespaces] [--json report.json]
 *
 * Runs `runNetworkEnforcementProbe` against the cluster in KUBECONFIG. It needs
 * rights to create and delete namespaces, Pods and NetworkPolicies, to exec into
 * Pods, and — with --write-attestation — to write a ConfigMap in kube-system.
 *
 * The network contract is read from the same environment variables the API
 * reads (`loadNetworkPolicyConfig`), so run it with the deployment's values: the
 * attestation is bound to their digest, and the API refuses a proof of any other
 * configuration.
 *
 * --write-attestation records whatever the verdict was. A FAIL or INCONCLUSIVE
 * replaces an earlier PASS, which is the point: re-probing a cluster that has
 * stopped enforcing revokes admission.
 *
 * Exit: 0 PASS, 1 FAIL, 2 INCONCLUSIVE or the probe could not run.
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  DEFAULT_SESSION_POLICY,
  NETWORK_ATTESTATION_NAME,
  NETWORK_ATTESTATION_NAMESPACE,
  attestationConfigMap,
  networkPolicyContractDigest,
  probeReportToAttestation,
  runNetworkEnforcementProbe,
  spawnKubectl,
  type ProbeTarget,
} from '@jumptotech/lab-orchestrator';
import { loadNetworkPolicyConfig } from '../apps/api/src/config.js';

function target(flag: string, value: string | undefined): ProbeTarget | undefined {
  if (value === undefined) return undefined;
  const match = /^([A-Za-z0-9.-]+):(\d{1,5})$/.exec(value);
  if (!match) throw new Error(`--${flag} must be host:port, got '${value}'`);
  return { host: match[1]!, port: Number(match[2]) };
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      'write-attestation': { type: 'boolean', default: false },
      'public-target': { type: 'string' },
      'private-target': { type: 'string' },
      image: { type: 'string' },
      'run-id': { type: 'string' },
      'keep-namespaces': { type: 'boolean', default: false },
      json: { type: 'string' },
    },
  });

  const network = loadNetworkPolicyConfig(process.env);
  const kubectl = spawnKubectl();
  const runId = values['run-id'] ?? randomBytes(4).toString('hex');
  const publicTarget = target('public-target', values['public-target']);
  const privateTarget = target('private-target', values['private-target']);

  console.log(`NetworkPolicy enforcement probe ${runId}`);
  console.log(`  contract digest   ${networkPolicyContractDigest(network)}`);
  console.log(`  external egress   ${network.allowExternalEgress ? 'permitted (public IPv4 only)' : 'not permitted'}`);

  const report = await runNetworkEnforcementProbe({
    kubectl,
    policy: { ...DEFAULT_SESSION_POLICY, network },
    runId,
    ...(values.image ? { image: values.image } : {}),
    ...(publicTarget ? { publicTarget } : {}),
    ...(privateTarget ? { privateTarget } : {}),
    keepNamespaces: values['keep-namespaces'],
    log: (line) => console.log(`  ${line}`),
  });

  console.log('');
  console.log(`VERDICT: ${report.verdict}  (cluster ${report.clusterUid}, ${report.kubernetesVersion})`);
  for (const reason of report.reasons) console.log(`  - ${reason}`);
  console.log(
    `  pod-to-node (kubelet :10250) was ${report.nodeLocalEgress}. NetworkPolicy does not govern that path; ` +
      'it needs a host firewall or CNI host policy (docs/kubernetes-network-security.md).',
  );

  if (values.json) writeFileSync(values.json, `${JSON.stringify(report, null, 2)}\n`);

  if (values['write-attestation']) {
    const manifest = attestationConfigMap(probeReportToAttestation(report));
    manifest.metadata.namespace = NETWORK_ATTESTATION_NAMESPACE;
    const applied = await kubectl(['apply', '-f', '-'], { input: JSON.stringify(manifest) });
    if (applied.code !== 0) {
      console.error(`could not write ${NETWORK_ATTESTATION_NAMESPACE}/${NETWORK_ATTESTATION_NAME}: ${applied.stderr.trim()}`);
      return 2;
    }
    console.log(`Recorded ${report.verdict} at ${NETWORK_ATTESTATION_NAMESPACE}/${NETWORK_ATTESTATION_NAME}.`);
  }

  return report.verdict === 'PASS' ? 0 : report.verdict === 'FAIL' ? 1 : 2;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`VERDICT: INCONCLUSIVE — the probe could not run: ${(error as Error).message}`);
    process.exit(2);
  },
);
