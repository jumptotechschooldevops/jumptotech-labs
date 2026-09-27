/**
 * Every Kubernetes lab, started on real kind the way a student starts it.
 *
 * `labs-integration.test.ts` walks a handful of Kubernetes labs to a PASS. This
 * asks the questions a student's first minutes ask, of every lab whose provider
 * is `kubernetes` — the K8S track and the networking labs that run on it:
 *
 *   1. **Start** succeeds: the namespace, guardrails and the lab's fixtures are
 *      applied, and its setup verification held (the provider waits for it).
 *   2. **Check** before any work does not pass: the lab does not begin solved.
 *   3. **Reset** succeeds, and the Check that follows grades exactly as the
 *      first one did: Reset returns the lab to where Start left it.
 *   4. **End Lab** removes the namespace.
 *
 * Labs in `SOLUTIONS` are also solved between 2 and 3, with the session's own
 * namespace-scoped credentials, to every check green.
 *
 * A Check reads live objects, and a lab's setup verification may accept a
 * fixture before its rollout is finished (K8S-015 waits for three of
 * checkout-api's four replicas; K8S-019 for a Deployment that exists), so both
 * Checks are read once the grades have held for 30 seconds rather than once.
 *
 * Tier: E2E. Gated on RUN_INTEGRATION_TESTS=1 and a kind kubeconfig, like the
 * rest of the kind job.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SESSION_POLICY,
  InMemorySessionStore,
  KindLabProvider,
  KubernetesClient,
  LabRegistry,
  SessionManager,
} from '../src/index.js';
import { verifyLab, waitForRequirements } from '@jumptotech/verifier';
import { realCatalog } from './real-catalog.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const HOST_KUBECONFIG =
  process.env.KUBECONFIG ?? path.join(repoRoot, 'infrastructure/kind/generated/kubeconfig-host.yaml');
const ENABLED = process.env.RUN_INTEGRATION_TESTS === '1' && existsSync(HOST_KUBECONFIG);

if (!ENABLED) {
  // eslint-disable-next-line no-console
  console.log(
    `[k8s-catalog-sweep] skipped — set RUN_INTEGRATION_TESTS=1 and ensure ${HOST_KUBECONFIG} exists`,
  );
}

const NAMESPACE_SECRET = 'k8s-catalog-sweep-namespace-secret';
const execFileAsync = promisify(execFile);

/**
 * What a student types to solve a lab, for the labs this sweep walks to a PASS.
 *
 * Run with `bash` on the host, with the session's own namespace-scoped
 * kubeconfig as KUBECONFIG and NAMESPACE set — the credentials a student's
 * terminal holds, and nothing more. Test code only: nothing here is served.
 */
const SOLUTIONS: Record<string, string> = {
  // Create the Pod with kubectl run, then wait for its container to report Ready.
  'K8S-001': `
set -e
kubectl run nginx --image=nginx:stable --restart=Never
kubectl wait --for=condition=Ready pod/nginx --timeout=120s
`,
  // Create a 3-replica Deployment from a manifest and wait for the rollout to finish.
  'K8S-002': `
set -e
kubectl apply -f - <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: frontend
  labels:
    app: frontend
spec:
  replicas: 3
  selector:
    matchLabels:
      app: frontend
  template:
    metadata:
      labels:
        app: frontend
    spec:
      containers:
        - name: frontend
          image: nginx:stable
          ports:
            - containerPort: 80
YAML
kubectl rollout status deployment/frontend --timeout=120s
`,
  // ClusterIP Service selecting app=accounts, port 80 -> targetPort 80; wait until both endpoints exist.
  'K8S-003': `
set -e
kubectl get pods -l app=accounts --show-labels
kubectl apply -f - <<'YAML'
apiVersion: v1
kind: Service
metadata:
  name: accounts
spec:
  type: ClusterIP
  selector:
    app: accounts
  ports:
    - name: http
      protocol: TCP
      port: 80
      targetPort: 80
YAML
kubectl rollout status deployment/accounts --timeout=120s
kubectl get endpoints accounts
`,
  // Create the ConfigMap, then patch the existing Deployment in place: drop the literal env, add envFrom.
  'K8S-004': `
set -e
kubectl create configmap statements-config --from-literal=STATEMENT_FORMAT=pdf --from-literal=RETENTION_DAYS=90
kubectl patch deployment statements --type=json -p '[
  {"op":"remove","path":"/spec/template/spec/containers/0/env"},
  {"op":"add","path":"/spec/template/spec/containers/0/envFrom","value":[{"configMapRef":{"name":"statements-config"}}]}
]'
kubectl rollout status deployment/statements --timeout=120s
`,
  // Create the Secret, then replace the literal PAYMENTS_API_TOKEN with a secretKeyRef on the payments container.
  'K8S-005': `
set -e
kubectl create secret generic payments-api --from-literal=api-token=golden-path-token
kubectl patch deployment payments --type=json -p '[
  {"op":"replace","path":"/spec/template/spec/containers/0/env","value":[
    {"name":"PAYMENTS_API_TOKEN","valueFrom":{"secretKeyRef":{"name":"payments-api","key":"api-token"}}}
  ]}
]'
kubectl rollout status deployment/payments --timeout=120s
`,
  // A Job with restartPolicy Never running a command that exits 0; wait for Complete.
  'K8S-006': `
set -e
kubectl apply -f - <<'YAML'
apiVersion: batch/v1
kind: Job
metadata:
  name: ledger-migration
spec:
  backoffLimit: 4
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: nginx:stable
          command: ["sh", "-c", "echo applying ledger schema migration; echo done"]
YAML
kubectl wait --for=condition=complete job/ledger-migration --timeout=120s
kubectl logs job/ledger-migration
`,
  // An active (not suspended) CronJob on */5 * * * *.
  'K8S-007': `
set -e
kubectl apply -f - <<'YAML'
apiVersion: batch/v1
kind: CronJob
metadata:
  name: reconciliation
spec:
  schedule: "*/5 * * * *"
  suspend: false
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: reconcile
              image: nginx:stable
              command: ["sh", "-c", "echo reconciling ledger against provider records"]
YAML
kubectl get cronjob reconciliation
`,
  // Patch an HTTP GET / :80 readinessProbe onto the notifications container, let the rollout finish.
  'K8S-008': `
set -e
kubectl patch deployment notifications --type=json -p '[
  {"op":"add","path":"/spec/template/spec/containers/0/readinessProbe","value":{
    "httpGet":{"path":"/","port":80},
    "initialDelaySeconds":2,"periodSeconds":5
  }}
]'
kubectl rollout status deployment/notifications --timeout=120s
kubectl get endpoints notifications
`,
  // Declare requests/limits on the reporting container's Pod template with kubectl set resources.
  'K8S-009': `
set -e
kubectl set resources deployment/reporting -c reporting --requests=cpu=100m,memory=128Mi --limits=cpu=250m,memory=256Mi
kubectl rollout status deployment/reporting --timeout=120s
`,
  // Fix both faults: correct the misspelled image tag, and point the Service selector at app=ledger-api.
  'K8S-010': `
set -e
kubectl get deployment,service,pods --show-labels
kubectl set image deployment/ledger-api ledger-api=nginx:stable
kubectl patch service ledger-api --type=merge -p '{"spec":{"selector":{"app":"ledger-api"}}}'
kubectl rollout status deployment/ledger-api --timeout=120s
kubectl get endpoints ledger-api
`,
  // Create PVC ledger-data (RWO, 1Gi, default StorageClass), strategic-merge the volume + /data mount into Deployment ledger in place, wait for rollout and Bound.
  'K8S-011': `
set -e
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ledger-data
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
EOF
cat > patch.yaml <<'EOF'
spec:
  template:
    spec:
      volumes:
        - name: ledger-data
          persistentVolumeClaim:
            claimName: ledger-data
      containers:
        - name: ledger
          volumeMounts:
            - name: ledger-data
              mountPath: /data
EOF
kubectl patch deployment ledger --type=strategic --patch-file=patch.yaml
kubectl rollout status deployment/ledger --timeout=240s
kubectl wait --for=jsonpath='{.status.phase}'=Bound pvc/ledger-data --timeout=120s
`,
  // Create-only RBAC (student may create but not update Roles/RoleBindings): minimal Role get/list/watch on configmaps + RoleBinding to SA inventory-sync, via kubectl create.
  'K8S-012': `
set -e
kubectl create -f - <<EOF
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: inventory-reader
rules:
  - apiGroups: [""]
    resources: ["configmaps"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: inventory-reader-binding
subjects:
  - kind: ServiceAccount
    name: inventory-sync
    namespace: $NAMESPACE
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: inventory-reader
EOF
kubectl rollout status deployment/inventory-sync --timeout=180s
`,
  // In-place rolling update with kubectl set image (keeps the two-label selector, bumps revision to 2), then follow rollout status.
  'K8S-013': `
set -e
kubectl rollout status deployment/payments-api --timeout=180s
kubectl set image deployment/payments-api api=nginx:1.28-alpine
kubectl rollout status deployment/payments-api --timeout=240s
`,
  // Roll forward to the non-existent nginx:1.29-rc1-jumptotech (revision 2, stalls), wait until its ReplicaSet exists, then kubectl rollout undo (revision 3 carries revision-history of rev 1).
  'K8S-014': `
set -e
kubectl rollout status deployment/payments-api --timeout=180s
kubectl set image deployment/payments-api api=nginx:1.29-rc1-jumptotech
found=""
for i in $(seq 1 60); do
  if kubectl get replicasets -l app=payments-api,tier=api -o jsonpath='{range .items[*]}{.spec.template.spec.containers[0].image}{" "}{end}' | grep -q 'nginx:1.29-rc1-jumptotech'; then
    found=yes
    break
  fi
  sleep 2
done
[ -n "$found" ] || { echo "broken release ReplicaSet never appeared" >&2; exit 1; }
# The rollout cannot complete: the image does not exist. Watch it stall.
kubectl rollout status deployment/payments-api --timeout=20s || true
kubectl get pods -l app=payments-api,tier=api
kubectl rollout history deployment/payments-api
kubectl rollout undo deployment/payments-api
kubectl rollout status deployment/payments-api --timeout=240s
kubectl rollout history deployment/payments-api
`,
  // Patch strategies first (Recreate for ledger-writer; RollingUpdate maxSurge 1 / maxUnavailable 0 for checkout-api — no template change, no revision), then set image to release both in place.
  'K8S-015': `
set -e
kubectl patch deployment ledger-writer --type=merge -p '{"spec":{"strategy":{"type":"Recreate","rollingUpdate":null}}}'
kubectl patch deployment checkout-api --type=merge -p '{"spec":{"strategy":{"type":"RollingUpdate","rollingUpdate":{"maxSurge":1,"maxUnavailable":0}}}}'
kubectl set image deployment/ledger-writer writer=nginx:1.28-alpine
kubectl set image deployment/checkout-api api=nginx:1.28-alpine
kubectl rollout status deployment/ledger-writer --timeout=240s
kubectl rollout status deployment/checkout-api --timeout=240s
`,
  // Strategic-merge an initContainer prepare-content (busybox:1.36) that writes index.html into the existing emptyDir "site"; app container, mount and probe untouched.
  'K8S-016': `
set -e
cat > patch.yaml <<'EOF'
spec:
  template:
    spec:
      initContainers:
        - name: prepare-content
          image: busybox:1.36
          command:
            - sh
            - -c
            - echo "<html><body><h1>JumpToTech reports</h1></body></html>" > /work/index.html
          volumeMounts:
            - name: site
              mountPath: /work
          resources:
            requests:
              cpu: 25m
              memory: 32Mi
            limits:
              cpu: 100m
              memory: 64Mi
EOF
kubectl patch deployment reporting-api --type=strategic --patch-file=patch.yaml
kubectl rollout status deployment/reporting-api --timeout=240s
`,
  // Strategic-merge: emptyDir audit-logs, native sidecar log-shipper (initContainers + restartPolicy Always, tail -F), and the same mount on the api container (merged by name, image/command unchanged).
  'K8S-017': `
set -e
cat > patch.yaml <<'EOF'
spec:
  template:
    spec:
      volumes:
        - name: audit-logs
          emptyDir: {}
      initContainers:
        - name: log-shipper
          image: busybox:1.36
          restartPolicy: Always
          command:
            - sh
            - -c
            - tail -F /var/log/audit/audit.log
          volumeMounts:
            - name: audit-logs
              mountPath: /var/log/audit
          resources:
            requests:
              cpu: 25m
              memory: 32Mi
            limits:
              cpu: 100m
              memory: 64Mi
      containers:
        - name: api
          volumeMounts:
            - name: audit-logs
              mountPath: /var/log/audit
EOF
kubectl patch deployment audit-api --type=strategic --patch-file=patch.yaml
kubectl rollout status deployment/audit-api --timeout=240s
`,
  // Create DaemonSet node-agent with the Deployment's Pod template (same labels/image, no replicas), wait for it, then delete the old Deployment.
  'K8S-018': `
set -e
kubectl apply -f - <<'EOF'
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-agent
  labels:
    app: node-agent
    tier: infrastructure
spec:
  selector:
    matchLabels:
      app: node-agent
      tier: infrastructure
  template:
    metadata:
      labels:
        app: node-agent
        tier: infrastructure
    spec:
      containers:
        - name: agent
          image: busybox:1.36
          command:
            - sh
            - -c
            - >
              while true; do
                echo "$(date -Iseconds) node-agent: collecting on $NODE_NAME";
                sleep 10;
              done
          env:
            - name: NODE_NAME
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
          resources:
            requests:
              cpu: 25m
              memory: 32Mi
            limits:
              cpu: 100m
              memory: 64Mi
EOF
kubectl rollout status daemonset/node-agent --timeout=180s
kubectl delete deployment node-agent --wait=true
kubectl get daemonset node-agent
`,
  // Delete the Deployment, wait for its Pods, delete the shared PVC and the ClusterIP Service; create headless Service ledger-db and a StatefulSet (serviceName ledger-db, 2 replicas, claim template data 1Gi RWO mounted at /var/lib/ledger).
  'K8S-019': `
set -e
kubectl delete deployment ledger-db --wait=true
kubectl wait --for=delete pod -l app=ledger-db --timeout=120s || true
kubectl delete pvc ledger-shared-data --wait=true --timeout=180s
kubectl delete service ledger-db --wait=true
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Service
metadata:
  name: ledger-db
  labels:
    app: ledger-db
spec:
  clusterIP: None
  selector:
    app: ledger-db
  ports:
    - name: db
      port: 5432
      targetPort: db
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: ledger-db
  labels:
    app: ledger-db
spec:
  serviceName: ledger-db
  replicas: 2
  selector:
    matchLabels:
      app: ledger-db
  template:
    metadata:
      labels:
        app: ledger-db
    spec:
      containers:
        - name: db
          image: nginx:1.28-alpine
          ports:
            - name: db
              containerPort: 80
          volumeMounts:
            - name: data
              mountPath: /var/lib/ledger
          resources:
            requests:
              cpu: 25m
              memory: 32Mi
            limits:
              cpu: 100m
              memory: 64Mi
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes:
          - ReadWriteOnce
        resources:
          requests:
            storage: 1Gi
EOF
kubectl rollout status statefulset/ledger-db --timeout=300s
kubectl get pods -l app=ledger-db
kubectl get pvc
`,
  // Run the Pod-IP churn experiment for real (record, delete a Pod, record), create ClusterIP Service ledger-api 80->80, repeat with EndpointSlices, then store the observed evidence in ConfigMap pod-ip-observation/ip-churn.txt.
  'NET-024': `
set -e
wait_two_ready() {
  for i in $(seq 1 90); do
    n=$(kubectl get pods -l app=ledger-api -o jsonpath='{range .items[*]}{"@"}{.metadata.deletionTimestamp}{"|"}{.status.conditions[?(@.type=="Ready")].status}{" "}{end}' | grep -o '@|True' | grep -c . || true)
    if [ "$n" = "2" ]; then return 0; fi
    sleep 2
  done
  echo "ledger-api never got back to two Ready Pods" >&2
  return 1
}
wait_two_ready
{
  echo "== Before deleting a Pod (kubectl get pods -o wide)"
  kubectl get pods -l app=ledger-api -o wide
} > ip-churn.txt
VICTIM=$(kubectl get pods -l app=ledger-api -o jsonpath='{.items[0].metadata.name}')
VICTIM_IP=$(kubectl get pod "$VICTIM" -o jsonpath='{.status.podIP}')
kubectl delete pod "$VICTIM" --wait=true
wait_two_ready
{
  echo
  echo "== Deleted $VICTIM (IP $VICTIM_IP); after the Deployment replaced it"
  kubectl get pods -l app=ledger-api -o wide
} >> ip-churn.txt
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Service
metadata:
  name: ledger-api
spec:
  type: ClusterIP
  selector:
    app: ledger-api
  ports:
    - name: http
      port: 80
      targetPort: 80
      protocol: TCP
EOF
CLUSTER_IP=$(kubectl get service ledger-api -o jsonpath='{.spec.clusterIP}')
sleep 3
{
  echo
  echo "== Service ledger-api ClusterIP: $CLUSTER_IP"
  kubectl get endpointslices -l kubernetes.io/service-name=ledger-api -o wide
} >> ip-churn.txt
VICTIM2=$(kubectl get pods -l app=ledger-api -o jsonpath='{.items[0].metadata.name}')
kubectl delete pod "$VICTIM2" --wait=true
wait_two_ready
sleep 3
{
  echo
  echo "== Deleted $VICTIM2 again; Service and EndpointSlice afterwards"
  echo "Service ledger-api ClusterIP now: $(kubectl get service ledger-api -o jsonpath='{.spec.clusterIP}')"
  kubectl get pods -l app=ledger-api -o wide
  kubectl get endpointslices -l kubernetes.io/service-name=ledger-api -o wide
  echo
  echo "== Model"
  echo "Every Pod gets a real, routable, cluster-unique IP from the CNI under the flat Pod-network model,"
  echo "but a replacement Pod is a new Pod with a new IP. The Service ClusterIP stayed the same while the"
  echo "EndpointSlice backend addresses changed, so clients must use the Service, never a Pod IP."
} >> ip-churn.txt
kubectl create configmap pod-ip-observation --from-file=ip-churn.txt=ip-churn.txt
`,
  // Fix selector app=ledger -> app=ledger-api on ledger-selector-broken and targetPort 8080 -> 3000 on ledger-port-broken (Services only, port 80 kept), then record the diagnosis ConfigMap.
  'NET-025': `
set -e
kubectl get pods --show-labels
kubectl get endpointslices
kubectl patch service ledger-selector-broken --type=merge -p '{"spec":{"selector":{"app":"ledger-api"}}}'
kubectl patch service ledger-port-broken --type=json -p '[{"op":"replace","path":"/spec/ports/0/targetPort","value":3000}]'
kubectl create configmap diagnosis \\
  --from-literal=selector='ledger-selector-broken selected app=ledger, but the ledger-api Pods are labelled app=ledger-api. No Pod matched the selector, so its EndpointSlice had no addresses; an empty EndpointSlice means discovery failed, which points to a Service selector / Pod label mismatch. Fixed by selecting app=ledger-api.' \\
  --from-literal=targetPort='ledger-port-broken selected the right Pods, so its EndpointSlice was populated, but it forwarded to targetPort 8080 while nginx listens on containerPort 3000. Discovery worked and requests still failed, which points to the Service targetPort versus the application listening port. Fixed by setting targetPort 3000, keeping Service port 80.'
kubectl get endpointslices
`,
};
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Kubernetes lab ids, read from disk so a new lab joins the sweep by existing. */
const LAB_IDS = (await realCatalog())
  .all()
  .filter((lab) => lab.environment.provider === 'kubernetes')
  .map((lab) => lab.id)
  .sort();

describe.runIf(ENABLED)('every Kubernetes lab on real kind', () => {
  let k8s: KubernetesClient;
  let provider: KindLabProvider;
  let registry: LabRegistry;
  let manager: SessionManager;
  const created = new Set<string>();

  beforeAll(async () => {
    registry = await realCatalog();
    k8s = new KubernetesClient({ kubeconfigPath: HOST_KUBECONFIG });
    provider = new KindLabProvider({
      k8s,
      clusterName: process.env.LAB_CLUSTER_NAME ?? 'jumptotech-labs',
      kubeconfigPath: HOST_KUBECONFIG,
      resetDrainTimeoutMs: 120_000,
      destroyTimeoutMs: 150_000,
      waitForRequirements: (input) => waitForRequirements({ k8s, ...input }),
    });
    manager = new SessionManager({
      registry,
      provider,
      store: new InMemorySessionStore(),
      policy: DEFAULT_SESSION_POLICY,
      lifetimes: {
        maxSessionSeconds: 3_600,
        idleTimeoutSeconds: 1_800,
        warningSeconds: 300,
        maxActiveSessions: 20,
      },
      namespaceSecret: NAMESPACE_SECRET,
    });
  }, 240_000);

  afterAll(async () => {
    for (const namespace of created) {
      await provider.destroyNamespace(namespace).catch(() => undefined);
    }
  }, 300_000);

  /** Label → status for one Check of a session's namespace. */
  async function grades(labId: string, namespace: string): Promise<{ passed: boolean; byLabel: Record<string, string> }> {
    const result = await verifyLab({ k8s, lab: registry.get(labId), namespace });
    return {
      passed: result.passed,
      byLabel: Object.fromEntries(result.checks.map((c) => [c.label, c.status])),
    };
  }

  /**
   * Grades once they have held for 30 seconds, or after three minutes.
   *
   * Two agreeing reads were not enough: K8S-019's setup accepts its Deployment
   * before the Pods are Ready, and two reads during the image pull agreed on a
   * state that was about to change. A lab that starts deliberately broken stays
   * the same, so it settles in 30 seconds too.
   */
  async function settledGrades(labId: string, namespace: string) {
    const deadline = Date.now() + 180_000;
    let current = await grades(labId, namespace);
    let stableSince = Date.now();
    while (Date.now() - stableSince < 30_000 && Date.now() < deadline) {
      await sleep(5_000);
      const next = await grades(labId, namespace);
      if (JSON.stringify(next) !== JSON.stringify(current)) stableSince = Date.now();
      current = next;
    }
    return current;
  }

  it.each(LAB_IDS)(
    '%s starts, does not begin solved, resets to its start, and ends',
    async (labId) => {
      // 1. Start.
      const { session } = await manager.start(labId);
      created.add(session.namespace);

      try {
        // 2. Check before any work.
        const initial = await settledGrades(labId, session.namespace);
        expect(Object.keys(initial.byLabel).length).toBeGreaterThan(0);
        expect(initial.passed, `${labId} passes its Check before any work`).toBe(false);

        // 3. Where the sweep knows a solution: solve with the student's own
        //    credentials, and the Check passes once the rollout lands.
        const solution = SOLUTIONS[labId];
        if (solution) {
          const credentials = await manager.issueCredentials(session.sessionId);
          const scratch = await mkdtemp(path.join(tmpdir(), 'jtt-k8s-sweep-'));
          try {
            const kubeconfig = path.join(scratch, 'kubeconfig');
            await writeFile(kubeconfig, credentials.kubeconfig, { mode: 0o600 });
            await execFileAsync('bash', ['--noprofile', '--norc', '-c', solution], {
              cwd: scratch,
              env: { PATH: process.env.PATH ?? '', HOME: scratch, KUBECONFIG: kubeconfig, NAMESPACE: session.namespace },
              timeout: 300_000,
              maxBuffer: 8 * 1024 * 1024,
            }).catch((error: { code?: number; stdout?: string; stderr?: string }) => {
              throw new Error(`${labId} solution exited ${error.code}: ${error.stdout ?? ''}\n${error.stderr ?? ''}`);
            });
          } finally {
            await rm(scratch, { recursive: true, force: true });
          }
          const deadline = Date.now() + 180_000;
          let solvedGrades = await grades(labId, session.namespace);
          while (!solvedGrades.passed && Date.now() < deadline) {
            await sleep(5_000);
            solvedGrades = await grades(labId, session.namespace);
          }
          expect(
            Object.entries(solvedGrades.byLabel).filter(([, status]) => status !== 'pass'),
            `${labId} solved`,
          ).toEqual([]);
        }

        // 4. Reset, then the same grades as at Start — whether or not the lab
        //    was solved in between.
        const { result: reset } = await manager.reset(session.sessionId);
        expect(reset.ok, JSON.stringify(reset.steps)).toBe(true);
        const after = await settledGrades(labId, session.namespace);
        expect(after.byLabel).toEqual(initial.byLabel);
      } finally {
        // 5. End Lab.
        await manager.end(session.sessionId);
      }

      const gone = Date.now() + 150_000;
      while ((await k8s.namespaceExists(session.namespace)) && Date.now() < gone) await sleep(3_000);
      expect(await k8s.namespaceExists(session.namespace), `${labId} namespace left behind`).toBe(false);
      created.delete(session.namespace);
    },
    900_000,
  );
});
