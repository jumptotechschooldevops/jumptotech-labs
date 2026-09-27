/**
 * Every container-backed lab, started on a real runtime the way a student
 * starts it.
 *
 * The unit suites grade the catalog against fakes, and the per-lab integration
 * suites walk a handful of labs end to end. Neither notices a lab whose seed
 * script fails on the image it actually runs on, whose setup verification never
 * holds, or whose starting state already passes the Check. A student finds those
 * on the first click. This suite clicks first, for every lab of the four
 * container providers:
 *
 *   1. **Start** succeeds: the container comes up, every seed script and
 *      workspace file lands, and the lab's own setup verification passes.
 *   2. **Check** before any work does not pass: the lab does not begin solved.
 *   3. **Reset** succeeds, and the Check that follows grades exactly as the
 *      first one did: Reset returns the lab to where Start left it.
 *   4. **End Lab** removes the sandbox, and every peer, managed node and
 *      network that carried the session's label.
 *
 * Five labs run at once, each as its own student, under the private beta's
 * capacity policy (five live sessions, one per student) — Vitest's default
 * `maxConcurrency` is five. So the sweep is also five independent students
 * starting, checking, resetting and ending side by side, and a slot that End
 * failed to release would refuse the next Start.
 *
 * Solving each lab is not attempted here — the repository deliberately ships no
 * solutions. The golden paths live in the per-lab suites (sandbox-integration,
 * net00N, docker0NN, ansible-runtime, cicd-runtime).
 *
 * Requirements: Docker and the four sandbox images (`npm run sandbox:build`).
 * The images default to the canonical tags; set all four of
 * LINUX_SANDBOX_IMAGE / TERRAFORM_SANDBOX_IMAGE / ANSIBLE_SANDBOX_IMAGE /
 * CICD_SANDBOX_IMAGE to run against private tags. Skips itself, with the
 * reason, when either is missing.
 *
 * ```bash
 * RUN_INTEGRATION_TESTS=1 npx vitest run test/catalog-runtime-integration.test.ts --root apps/api
 * ```
 *
 * Docker (dind) and Kubernetes labs are out of scope: they have their own
 * runtime suites and need a daemon or cluster per session.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import type { Express } from 'express';
import {
  ANSIBLE_WORKSPACE_DIR,
  CONTAINER_SESSION_LABEL,
  DEFAULT_ANSIBLE_SANDBOX_IMAGE,
  DEFAULT_CICD_SANDBOX_IMAGE,
  DEFAULT_LINUX_SANDBOX_IMAGE,
  DEFAULT_TERRAFORM_SANDBOX_IMAGE,
  DockerCliRuntime,
  InMemorySessionStore,
  KubernetesClient,
  SessionManager,
  type LabRegistry,
} from '@jumptotech/lab-orchestrator';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';
import { createApp } from '../src/app.js';
import { buildSandboxComposition } from '../src/composition.js';
import { loadConfig } from '../src/config.js';

const exec = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SECRET = 'catalog-runtime-integration-secret';
const ENABLED = process.env.RUN_INTEGRATION_TESTS === '1';

const IMAGES = {
  linux: process.env.LINUX_SANDBOX_IMAGE ?? DEFAULT_LINUX_SANDBOX_IMAGE,
  terraform: process.env.TERRAFORM_SANDBOX_IMAGE ?? DEFAULT_TERRAFORM_SANDBOX_IMAGE,
  ansible: process.env.ANSIBLE_SANDBOX_IMAGE ?? DEFAULT_ANSIBLE_SANDBOX_IMAGE,
  cicd: process.env.CICD_SANDBOX_IMAGE ?? DEFAULT_CICD_SANDBOX_IMAGE,
} as const;
type ContainerProvider = keyof typeof IMAGES;
const PROVIDERS = Object.keys(IMAGES) as ContainerProvider[];

const runtime = new DockerCliRuntime();
const HOME = '/home/student';

/**
 * What a student types to solve a lab, for the labs this suite walks to a PASS.
 *
 * Run as the student, in the student's working directory, through
 * `bash --norc --noprofile` — the shell the browser terminal gives them. Test
 * code only: nothing here is served, and the catalog ships no solutions.
 */
const SOLUTIONS: Record<string, string> = {
  // The leftover job is the student's own (the seed starts it as `student`),
  // so a plain kill works without sudo.
  'LINUX-004': `
set -e
kill "$(pgrep -x stale-batch-job)"
setsid /usr/local/bin/ledger-sync </dev/null >/dev/null 2>&1 &
sleep 2
pgrep -af ledger-sync > ops/running.txt
`,
  'ANSIBLE-001': `
set -e
printf '[web]\nnode1\nnode2\n' > inventory.ini
ansible web -m ping
`,
  'CICD-001': `
set -e
mkdir -p ci
printf '#!/bin/sh\nset -e\nnode build.mjs\nnode --test\nnode src/cli.mjs --selftest\n' > ci/pipeline.sh
sh ci/pipeline.sh
`,
  // Everything is read from the capture; this machine's meminfo is copied
  // straight out of /proc. No sudo: the lab is unprivileged_shell.
  'CS-001': `
set -e
mkdir -p ops/live
cat /proc/meminfo > ops/live/meminfo
cap=/srv/kestrel/scan-01
cpus=$(grep -c '^processor' "$cap/proc-cpuinfo.txt")
kb=$(awk '/^MemTotal:/ {print $2}' "$cap/proc-meminfo.txt")
mib=$(expr "$kb" / 1024)
mb=$(expr "$kb" \\* 1024 / 1000000)
load=$(cut -d' ' -f1 "$cap/proc-loadavg.txt" | cut -d. -f1)
per=$(expr "$load" / "$cpus")
full=$(awk '$5 == "100%" {print $6}' "$cap/df-h.txt")
if [ "$load" -gt "$cpus" ]; then verdict=saturated; else verdict=healthy; fi
cat /sys/fs/cgroup/memory.max || true
cat > ops/machine.txt <<REPORT
HOSTNAME=$(uname -n)
MEMINFO_SCOPE=host
SCAN01_CPUS=$cpus
SCAN01_MEM_MIB=$mib
SCAN01_MEM_MB=$mb
SCAN01_LOAD_PER_CPU=$per
SCAN01_FULL_MOUNT=$full
VERDICT=$verdict
REPORT
`,
  // A check that honours 0 / 2 / 3, and a launcher that exports the limit
  // from pipeline.yml (5) rather than merely assigning it.
  'CS-005': `
set -e
mkdir -p py bin ops
cat > py/deploy-check.py <<'PY'
#!/usr/bin/env python3
import os
import sys


def main() -> int:
    raw = os.environ.get("KESTREL_MAX_FAILURES", "")
    try:
        limit = int(raw)
    except ValueError:
        print("DEPLOY_CHECK=misconfigured", file=sys.stderr)
        return 2
    failures = int(sys.argv[1])
    if failures > limit:
        print(f"DEPLOY_CHECK=failed failures={failures} limit={limit}", file=sys.stderr)
        return 3
    print(f"DEPLOY_CHECK=ok failures={failures} limit={limit}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
PY
cat > bin/run-check.sh <<'SH'
#!/bin/bash
export KESTREL_MAX_FAILURES=5
exec /home/student/py/deploy-check.py "$1"
SH
chmod +x py/deploy-check.py bin/run-check.sh
status=0
env -u KESTREL_MAX_FAILURES py/deploy-check.py 1 > ops/out.txt 2> ops/err.txt || status=$?
test "$status" -eq 2
`,
  // Enable by symlink, stop and unlink the tracer, then wait for runsv.
  // pgrep -x matches the process name, so the loop never matches this script.
  'LINUX-005': `
set -e
sudo ln -s /etc/sv/ledger-api /etc/service/ledger-api
sudo sv stop debug-tracer || true
sudo rm /etc/service/debug-tracer
for _ in $(seq 1 30); do
  if sudo sv status ledger-api 2>/dev/null | grep -q '^run:' && ! pgrep -x debug-tracer >/dev/null; then
    break
  fi
  sleep 1
done
sudo sv status ledger-api | grep '^run:'
! pgrep -x debug-tracer
`,
  // Three faults: the squatter on 9105, the wrong PORT, the non-executable run.
  'LINUX-010': `
set -e
squatter=$(pgrep -f '^/usr/local/bin/legacy-exporter')
sudo kill $squatter
sudo sed -i 's/^PORT=9999$/PORT=9105/' /etc/jumptotech/ledger-api.conf
sudo chmod 0755 /etc/sv/ledger-api/run
sudo sv restart ledger-api || true
for _ in $(seq 1 30); do
  if curl -s --max-time 3 http://127.0.0.1:9105 | grep -q JTT-LEDGER-OK; then break; fi
  sleep 1
done
sudo sv status ledger-api
curl -s --max-time 5 http://127.0.0.1:9105 | grep JTT-LEDGER-OK
`,
  'LINUX-017': `
set -e
sudo tee /etc/systemd/system/ledger-api.service >/dev/null <<'UNIT'
[Unit]
Description=ledger-api - JumpToTech Bank ledger API
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/ledger-api
User=ledger
Group=ledger
WorkingDirectory=/srv/jumptotech
EnvironmentFile=/etc/jumptotech/ledger-api.env
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
sudo chown root:root /etc/systemd/system/ledger-api.service
sudo chmod 0644 /etc/systemd/system/ledger-api.service
`,
  // The environment goes in the run script, before the exec; then restart
  // and wait for a fresh STATUS=OK. \`source ~/.bashrc\` is not used: the
  // image's .bashrc returns early in a non-interactive shell (this exec is
  // one; the browser terminal is not), so the formatter's directory — which
  // the student reads off \`command -v jtt-format\` there — is named directly.
  'LINUX-014': `
set -e
dir=/usr/local/libexec/jumptotech
test -x "$dir/jtt-format"
sudo sed -i 's|^exec /usr/local/lib/jumptotech/report-runner$|JTT_ENV=production\\nexport JTT_ENV\\nPATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/libexec/jumptotech\\nexport PATH\\n\\n&|' /etc/sv/report-runner/run
cat /etc/sv/report-runner/run
sudo sv restart report-runner
for _ in $(seq 1 30); do
  if grep -q STATUS=OK /var/lib/jumptotech/report-runner.status && grep -q formatted=OK /var/log/jumptotech/report-runner.log; then break; fi
  sleep 1
done
cat /var/lib/jumptotech/report-runner.status
grep -q formatted=OK /var/log/jumptotech/report-runner.log
echo "$dir" > ops/service-env.txt
`,
  // The seeded Deny covered the whole bucket, so no Allow could reach the
  // build artifacts. Narrow it to customer-exports/, allow what the incident
  // needs (list, read, upload builds), and leave DeleteObject unallowed.
  'AWS-003': `
set -e
cd ~/access-review
cat > policy.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DeveloperList",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::jumptotech-build-artifacts"
    },
    {
      "Sid": "DeveloperBuilds",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": "arn:aws:s3:::jumptotech-build-artifacts/builds/*"
    },
    {
      "Sid": "ProtectCustomerExports",
      "Effect": "Deny",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::jumptotech-build-artifacts/customer-exports/*"
    }
  ]
}
EOF
python3 -m json.tool policy.json >/dev/null
`,
  // Every answer is worked out with Python's ipaddress module from the blocks
  // and addresses the templates name; the loopback count from the prefix the
  // kernel's local table shows.
  'NET-002': `
set -e
cd ~/subnets
python3 - <<'PY'
import ipaddress, re

def fill(path, answers):
    out = []
    for line in open(path).read().split('\\n'):
        m = re.match(r'^(\\s*)(\\S+) =\\s*$', line)
        if m and m.group(2) in answers:
            line = f"{m.group(1)}{m.group(2)} = {answers[m.group(2)]}"
        out.append(line)
    open(path, 'w').write('\\n'.join(out))

plan = open('plan.txt').read()
answers = {}
for letter, cidr in re.findall(r'^BLOCK ([A-D])\\s+(\\S+)$', plan, re.M):
    net = ipaddress.ip_network(cidr)
    k = letter.lower()
    answers[f'{k}_network'] = str(net.network_address)
    answers[f'{k}_broadcast'] = str(net.broadcast_address)
    answers[f'{k}_first_usable'] = str(net.network_address + 1)
    answers[f'{k}_last_usable'] = str(net.broadcast_address - 1)
    answers[f'{k}_usable_count'] = str(net.num_addresses - 2)
subnets = list(ipaddress.ip_network('10.20.0.0/16').subnets(new_prefix=20))
for name, net in zip(['prod', 'staging', 'dev'], subnets):
    answers[name] = str(net)
assert len(answers) == 23, answers
fill('plan.txt', answers)

classes = {}
for addr in re.findall(r'^(\\d+\\.\\d+\\.\\d+\\.\\d+) =', open('classify.txt').read(), re.M):
    ip = ipaddress.ip_address(addr)
    if ip.is_loopback:
        classes[addr] = 'loopback'
    elif ip.is_link_local:
        classes[addr] = 'link-local'
    elif ip.is_private:
        classes[addr] = 'private'
    else:
        classes[addr] = 'public'
assert len(classes) == 6, classes
fill('classify.txt', classes)
PY
ip route show table local > kernel.txt
prefix=$(awk '$1 == "local" && $2 ~ /^127\\./ && $2 ~ /\\// {print $2}' kernel.txt)
test -n "$prefix"
echo "loopback_addresses = $(python3 -c 'import ipaddress,sys; print(ipaddress.ip_network(sys.argv[1]).num_addresses)' "$prefix")" >> kernel.txt
cat plan.txt classify.txt kernel.txt
`,
  // Reproduce the four failures with nc (errors are on stderr), speak HTTP to
  // the ledger API, then classify: ECONNREFUSED is TCP (L4), ENETUNREACH is
  // routing (L3), the resolver is DNS (L7), and a 503 is the application
  // answering (L7) — the one that is not a network problem.
  'NET-003': `
set -e
cd ~/triage
nc -w2 -v 127.0.0.1 9110 > refused.txt 2>&1 || true
nc -w2 -v 10.99.99.99 80 > unreachable.txt 2>&1 || true
nc -w2 -v ledger.bank.invalid 80 > resolution.txt 2>&1 || true
printf 'GET /health HTTP/1.1\\r\\nHost: ledger\\r\\nConnection: close\\r\\n\\r\\n' | nc -w3 127.0.0.1 9109 > app.txt
cat refused.txt unreachable.txt resolution.txt app.txt
sed -i \
  -e 's/^\\( *refused_layer =\\).*/\\1 L4/' \
  -e 's/^\\( *unreachable_layer =\\).*/\\1 L3/' \
  -e 's/^\\( *resolution_layer =\\).*/\\1 L7/' \
  -e 's/^\\( *app_503_layer =\\).*/\\1 L7/' \
  -e 's/^\\( *not_a_network_problem =\\).*/\\1 app_503/' \
  triage.txt
sed -i \
  -e 's/^\\( *L4_rfc1122_name =\\).*/\\1 transport/' \
  -e 's/^\\( *L3_rfc1122_name =\\).*/\\1 internet/' \
  -e 's/^\\( *1 =\\).*/\\1 request/' \
  -e 's/^\\( *2 =\\).*/\\1 segment/' \
  -e 's/^\\( *3 =\\).*/\\1 packet/' \
  -e 's/^\\( *4 =\\).*/\\1 frame/' \
  model.txt
`,
  'TF-003': `
set -e
cd ~/terraform
terraform init -input=false
terraform apply -input=false -auto-approve
cat > outputs.tf <<'EOF'
output "service_name" {
  value = local.service
}

output "release_channel" {
  value = var.channel
}

output "manifest_path" {
  value = local_file.release_manifest.filename
}

output "release_summary" {
  value = {
    service  = local.service
    channel  = var.channel
    manifest = local_file.release_manifest.filename
  }
}

output "deploy_token" {
  value     = var.deploy_token
  sensitive = true
}
EOF
terraform apply -input=false -auto-approve
terraform output > outputs.txt
terraform output -raw manifest_path > manifest-path.txt
cat outputs.txt manifest-path.txt
`,
  'TF-012': `
set -e
cd ~/terraform
terraform init -input=false
terraform apply -input=false -auto-approve
ls out/draft-report.txt out/summary-report.txt out/audit-log.txt
terraform destroy -input=false -auto-approve -target=local_file.draft_report
terraform state list
test ! -e out/draft-report.txt
terraform destroy -input=false -auto-approve
test -z "$(terraform state list)"
`,
  'ANSIBLE-002': `
set -e
ansible web -m ansible.builtin.file -a "path=/opt/jumptotech/releases state=directory"
ansible web -m ansible.builtin.copy -a "dest=/etc/jumptotech/maintenance.txt content='status=scheduled\n'"
ansible web -m command -a "cat /etc/jumptotech/maintenance.txt"
`,
  'ANSIBLE-004': `
set -e
mkdir -p group_vars host_vars
cat > group_vars/web.yml <<'YAML'
---
app_port: 8080
app_release: "2.4.1"
YAML
printf -- '---\nnode_role: primary\n' > host_vars/node1.yml
printf -- '---\nnode_role: replica\n' > host_vars/node2.yml
cat > site.yml <<'YAML'
---
- name: Configure the ledger service
  hosts: web
  tasks:
    - name: Ensure the application directory exists
      ansible.builtin.file:
        path: /opt/jumptotech/app
        state: directory
        mode: "0755"

    - name: Write the application configuration
      ansible.builtin.copy:
        dest: /etc/jumptotech/app.conf
        mode: "0644"
        content: |
          app_name=ledger
          app_port={{ app_port }}
          app_release={{ app_release }}
          node_role={{ node_role }}

    - name: Read the node's hostname
      ansible.builtin.command: hostname
      register: hostname_result
      changed_when: false

    - name: Record the detected hostname
      ansible.builtin.copy:
        dest: /etc/jumptotech/node.facts
        mode: "0644"
        content: |
          detected_hostname={{ hostname_result.stdout }}
YAML
ansible-playbook site.yml
ansible-playbook site.yml
`,
  'ANSIBLE-006': `
set -e
sed -i 's/^app_port: 8080$/app_port: 9090/' group_vars/web.yml
cat > site.yml <<'YAML'
---
- name: Configure the ledger service
  hosts: web
  tasks:
    - name: Ensure the configuration directory exists
      ansible.builtin.file:
        path: /etc/jumptotech
        state: directory
        mode: "0755"

    - name: Ensure the log directory exists
      ansible.builtin.file:
        path: /var/log/jumptotech
        state: directory
        mode: "0755"

    - name: Write the application configuration
      ansible.builtin.copy:
        dest: /etc/jumptotech/app.conf
        mode: "0644"
        content: |
          app_name={{ app_name }}
          app_port={{ app_port }}
      notify: reload ledger

  handlers:
    - name: reload ledger
      ansible.builtin.copy:
        dest: /var/log/jumptotech/reload.log
        mode: "0644"
        content: "reloaded ledger\\n"
YAML
ansible-playbook site.yml
ansible-playbook site.yml
`,
  'CICD-002': `
set -e
mkdir -p .github/workflows
cat > .github/workflows/ci.yml <<'YAML'
name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Say hello
        run: echo "Building the statements service"
YAML
`,
  'CICD-004': `
set -e
cat >> .github/workflows/ci.yml <<'YAML'

      - name: Upload the build output
        uses: actions/upload-artifact@v4
        with:
          name: statements-dist
          path: dist/
YAML
node build.mjs
ls -l dist
`,
  'CICD-008': `
set -e
cat > Jenkinsfile <<'GROOVY'
// JumpToTech Bank — statements service
pipeline {
    agent any

    environment {
        REGISTRY_URL      = 'registry.jumptotech.internal'
        REGISTRY_PASSWORD = credentials('registry-password')
    }

    stages {
        stage('Checkout') {
            steps {
                checkout scm
            }
        }

        stage('Build') {
            steps {
                sh 'node build.mjs'
            }
        }

        stage('Test') {
            steps {
                sh 'node --test'
            }
        }

        stage('Publish') {
            steps {
                sh 'echo "publishing to $REGISTRY_URL"'
            }
        }
    }
}
GROOVY
node --test
`,
};

interface CheckResult {
  passed: boolean;
  checks: Array<{ label: string; status: string; detail?: string }>;
}

let skipReason = '';
let app: Express | undefined;
let catalog: LabRegistry | undefined;
const created = new Set<string>();

async function availability(): Promise<string> {
  if (!ENABLED) return 'set RUN_INTEGRATION_TESTS=1 to run the real catalog sweep';
  try {
    await runtime.ping();
  } catch (error) {
    return `no container runtime is reachable (${(error as Error).message})`;
  }
  for (const image of Object.values(IMAGES)) {
    if (!(await runtime.imageExists(image))) {
      return `sandbox image '${image}' is not built — run: npm run sandbox:build`;
    }
  }
  return '';
}

/**
 * The api as `index.ts` assembles it: the production sandbox composition (the
 * same providers, and the Ansible reader the verifier grades a topology
 * through), under the private beta's capacity policy. Only the image tags come
 * from the environment, exactly as a deployment sets them.
 */
async function buildApp(registry: LabRegistry): Promise<Express> {
  const config = loadConfig({
    TERMINAL_SESSION_SECRET: SECRET,
    LABS_DIR: path.join(repoRoot, 'labs'),
    MAX_ACTIVE_SESSIONS: '5',
    MAX_ACTIVE_SESSIONS_PER_STUDENT: '1',
    LINUX_SANDBOX_IMAGE: IMAGES.linux,
    TERRAFORM_SANDBOX_IMAGE: IMAGES.terraform,
    ANSIBLE_SANDBOX_IMAGE: IMAGES.ansible,
    CICD_SANDBOX_IMAGE: IMAGES.cicd,
  } as NodeJS.ProcessEnv);

  // A cluster is never touched: no lab in this sweep is a Kubernetes lab.
  const { k8s, engines, workspace, providers, ansible } = buildSandboxComposition({
    config,
    k8s: new KubernetesClient({}),
    containerRuntime: runtime,
  });
  const sessions = new SessionManager({
    registry,
    providers,
    store: new InMemorySessionStore(),
    policy: config.policy,
    lifetimes: config.lifetimes,
    namespaceSecret: SECRET,
  });
  return createApp({ registry, sessions, k8s, config, engines, workspace, ansible });
}

/** One student per lab: the beta allows one live lab per student. */
const studentFor = (labId: string) => ({ Authorization: `Developer runtime-${labId.toLowerCase()}` });

/** Label → status, for comparing two Checks of the same lab. */
function grades(result: CheckResult): Record<string, string> {
  return Object.fromEntries(result.checks.map((c) => [c.label, c.status]));
}

/**
 * Every container and network still carrying a session's label.
 *
 * The session's main container is not the whole of it: a `network: link` lab
 * has a peer container and a private network, and an Ansible lab has two
 * managed nodes. End Lab has not ended a session while any of them remain.
 */
async function leftovers(sessionId: string): Promise<string[]> {
  const filter = `label=${CONTAINER_SESSION_LABEL}=${sessionId}`;
  const containers = await exec('docker', ['ps', '-a', '--filter', filter, '--format', 'container {{.Names}}']);
  const networks = await exec('docker', ['network', 'ls', '--filter', filter, '--format', 'network {{.Name}}']);
  return `${containers.stdout}${networks.stdout}`.split('\n').filter(Boolean);
}

beforeAll(async () => {
  skipReason = await availability();
  if (skipReason) {
    console.log(`[catalog-runtime] skipped — ${skipReason}`);
    return;
  }
  catalog = await realCatalog();
  app = await buildApp(catalog);
}, 120_000);

afterAll(async () => {
  for (const ref of created) await runtime.remove(ref).catch(() => undefined);
}, 300_000);

/** Lab ids per provider, read from disk so a new lab joins the sweep by existing. */
async function labsFor(provider: ContainerProvider): Promise<string[]> {
  const registry = await realCatalog();
  return registry
    .all()
    .filter((lab) => lab.environment.provider === provider)
    .map((lab) => lab.id)
    .sort();
}

const LAB_IDS = Object.fromEntries(
  await Promise.all(PROVIDERS.map(async (p) => [p, await labsFor(p)] as const)),
) as Record<ContainerProvider, string[]>;

describe.runIf(ENABLED)('every container-backed lab on a real runtime', () => {
  for (const provider of PROVIDERS) {
    describe(provider, () => {
      it.concurrent.each(LAB_IDS[provider])(
        '%s starts, does not begin solved, resets to its start, and ends',
        async (labId) => {
          if (skipReason || !app) return;
          const as = studentFor(labId);
          const t0 = Date.now();
          const took: Record<string, number> = {};
          const mark = (step: string) => (took[step] = Math.round((Date.now() - t0) / 1000));

          // 1. Start.
          const started = await request(app).post(`/api/labs/${labId}/start`).set(as);
          expect(started.status, `Start: ${JSON.stringify(started.body)}`).toBe(200);
          const session = started.body.data.session as { sessionId: string; sandboxRef: string };
          created.add(session.sandboxRef);
          mark('start');

          try {
            // 2. Check before any work.
            const first = await request(app).post(`/api/sessions/${session.sessionId}/check`).set(as);
            expect(first.status, `Check: ${JSON.stringify(first.body)}`).toBe(200);
            const initial = first.body.data as CheckResult;
            mark('check');
            expect(initial.checks.length).toBeGreaterThan(0);
            expect(initial.passed, `${labId} passes its Check before any work`).toBe(false);

            // 3. Where the suite knows a solution: solve as the student, and
            //    the Check passes.
            const solution = SOLUTIONS[labId];
            if (solution) {
              const solved = await runtime.exec(session.sandboxRef, {
                argv: ['/bin/bash', '--norc', '--noprofile', '-c', solution],
                user: 'student',
                workdir: provider === 'ansible' ? ANSIBLE_WORKSPACE_DIR : HOME,
                timeoutMs: 300_000,
              });
              expect(solved.exitCode, `${labId} solution: ${solved.stdout}\n${solved.stderr}`).toBe(0);
              const after = await request(app).post(`/api/sessions/${session.sessionId}/check`).set(as);
              expect(after.status, `Check after solving: ${JSON.stringify(after.body)}`).toBe(200);
              const graded = after.body.data as CheckResult;
              expect(
                graded.checks.filter((c) => c.status !== 'pass').map((c) => `${c.label}: ${c.detail ?? ''}`),
                `${labId} solved`,
              ).toEqual([]);
              expect(graded.passed).toBe(true);
              mark('solved');
            }

            // 4. Reset, then the same grades as at Start — whether or not the
            //    lab was solved in between.
            const reset = await request(app).post(`/api/sessions/${session.sessionId}/reset`).set(as);
            expect(reset.status, `Reset: ${JSON.stringify(reset.body)}`).toBe(200);
            mark('reset');
            const second = await request(app).post(`/api/sessions/${session.sessionId}/check`).set(as);
            expect(second.status, `Check after Reset: ${JSON.stringify(second.body)}`).toBe(200);
            expect(grades(second.body.data as CheckResult)).toEqual(grades(initial));
          } finally {
            // 5. End Lab.
            const ended = await request(app).delete(`/api/sessions/${session.sessionId}`).set(as);
            expect([200, 204], `End: ${JSON.stringify(ended.body)}`).toContain(ended.status);
            mark('end');
            console.log(`[catalog-runtime] ${labId} ${JSON.stringify(took)} (seconds since Start was clicked)`);
          }
          expect(await leftovers(session.sessionId), `${labId} left behind after End Lab`).toEqual([]);
          created.delete(session.sandboxRef);
        },
        600_000,
      );
    });
  }
});
