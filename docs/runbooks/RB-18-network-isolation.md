# RB-18 — Network isolation not proven

**Alerts:** `NetworkIsolationNotAttested` (critical),
`NetworkIsolationAttestationAging` (warning)
**Source:** the API reads BETA-P0-015's enforcement attestation
(`kube-system/jumptotech-network-policy-enforcement`) every 60 seconds with the
same cluster credential and network contract the Kubernetes provider gates
admission on.
**Blast radius:** the Kubernetes track admits no student — by design, it fails
closed. Running Kubernetes labs keep working. Container tracks are unaffected.

Commands use `prod` and `q` from [private-beta-operations.md §1](private-beta-operations.md).
The model: [kubernetes-network-security.md §5](../kubernetes-network-security.md).

## 1. Confirm it is real

```bash
q 'jtt_network_isolation_attestation_valid'
q '(time() - jtt_network_isolation_attestation_verified_timestamp_seconds) / jtt_network_isolation_attestation_max_age_seconds'
prod logs --since 1h api | grep '"event":"ops.network_attestation.checked"' | tail -5
kubectl -n kube-system get configmap jumptotech-network-policy-enforcement -o yaml
```

The log line's message carries the reason the attestation was refused; the
metric deliberately does not.

## 2. Scope it — the reason

| Reason in the log | Meaning |
|---|---|
| no attestation found | Never probed on this cluster, or the ConfigMap was deleted |
| older than `NETWORK_POLICY_ATTESTATION_MAX_AGE_SECONDS` | It aged out: re-probe |
| different network policy contract | The deployment's network settings changed since the probe |
| recorded on a different cluster | A rebuilt cluster; re-probe |
| verdict FAIL / INCONCLUSIVE | The last probe did not prove enforcement — **stop here, §8** |
| could not be read | The API cannot reach the cluster or read `kube-system` |

## 3. Immediate mitigation

None is needed for safety: the platform already refuses Kubernetes labs. Tell
the cohort the Kubernetes track is paused. Do not set
`NETWORK_POLICY_ATTESTATION_REQUIRED=false` — production refuses it, and it
would admit students to a cluster whose isolation is unproven.

## 4. Diagnose

1. `could not be read`: `q 'jtt_provider_available{provider="kubernetes"}'`,
   [RB-09](RB-09-provider-unavailable.md).
2. Aged out or contract changed: re-probe (§5).
3. FAIL or INCONCLUSIVE: read the probe report; it pairs every denial with a
   negative control. A FAIL means NetworkPolicy is not enforced on this cluster.

## 5. Fix

Run the probe with the deployment's own network settings, so the attestation is
bound to the contract the API checks:

```bash
cd /srv/jumptotech-labs
set -a; . ./.env; set +a
KUBECONFIG=/path/to/admin-kubeconfig npm run verify:network-policy -- --write-attestation --private-target <infra host:port>
```

It needs rights to create namespaces, Pods and NetworkPolicies and to write the
ConfigMap in `kube-system`. Exit 0 is PASS. Details and the choice of
`--private-target`: kubernetes-network-security.md §5.2 and §9.

## 6. Verify recovery

- Within 60 seconds, `q 'jtt_network_isolation_attestation_valid'` is 1.
- `q 'jtt_provider_available{provider="kubernetes"}'` is 1.
- A Kubernetes lab starts.

## 7. What this does NOT mean

- **Not the cluster being down** when `valid` is 1 and the provider is
  unavailable: RB-09.
- **`AttestationAging` is not a failure.** It is the reminder to re-probe before
  admission stops.

## 8. Escalate when

The probe returns FAIL or INCONCLUSIVE. That is a CNI or cluster problem
(P0-015 D2, "production CNI" — DECISION REQUIRED). Keep the Kubernetes track
paused; do not look for a way around the gate.

## 9. Follow-up

Who runs the probe and how often (P0-015 D5) is still DECISION REQUIRED; until
then, schedule it well inside the maximum age.
