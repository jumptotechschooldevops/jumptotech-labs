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
  // Each answer replaced in place, the seeded header comment left as it is.
  'AWS-001': `
set -e
cd /home/student/aws-incident
sed -i \\
  -e 's/^CAPTURE_1_SOURCE=.*/CAPTURE_1_SOURCE=environment_variables/' \\
  -e 's/^CAPTURE_2_SOURCE=.*/CAPTURE_2_SOURCE=credentials_file/' \\
  -e 's/^CAPTURE_3_SOURCE=.*/CAPTURE_3_SOURCE=custom_process/' \\
  -e 's/^ARN_1=.*/ARN_1=valid/' -e 's/^ARN_2=.*/ARN_2=invalid/' -e 's/^ARN_3=.*/ARN_3=valid/' \\
  -e 's/^ARN_4=.*/ARN_4=invalid/' -e 's/^ARN_5=.*/ARN_5=invalid/' \\
  findings.env
grep -q '^# Replace every FILL_ME' findings.env
sed -i 's/^\\[profile reconciliation\\]$/[reconciliation]/' deploy/credentials
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
  // Converter computes both unit systems from argv; findings are derived from the seeded evidence (printf/od/numfmt), verdict by comparing 640M (SI) with the limit in bytes.
  'CS-002': `
set -e
mkdir -p py ops
cat > py/units.py <<'PY'
#!/usr/bin/env python3
import sys


def main():
    count = int(sys.argv[1])
    print(f"BYTES={count}")
    print(f"SI={count / 1000000:.2f} MB")
    print(f"IEC={count / (1024 * 1024):.2f} MiB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
PY
chmod +x py/units.py
EV=/srv/kestrel/scan-api
LIMIT=$(printf '%d' "$(tr -d '[:space:]' < "$EV/limit.hex")")
TAG=$(od -An -tx1 "$EV/tag.bin" | tr -d '[:space:]')
SI=$(numfmt --to=si "$LIMIT")
IEC=$(numfmt --to=iec "$LIMIT")
if [ "$(numfmt --from=si 640M)" -gt "$LIMIT" ]; then VERDICT=over; else VERDICT=within; fi
{
  echo "LIMIT_BYTES=$LIMIT"
  echo "TAG_HEX=$TAG"
  echo "SI=$SI"
  echo "IEC=$IEC"
  echo "VERDICT=$VERDICT"
} > ops/units.txt
`,
  // Program counts characters (decoded text) and bytes (UTF-8 encoded) per line; hex/code point come from printf|od and ord(); the rejected line is the one whose BYTES exceed 20 while its CHARS do not.
  'CS-003': `
set -e
mkdir -p py ops
cat > py/encoding.py <<'PY'
#!/usr/bin/env python3
import sys


def main():
    with open(sys.argv[1], encoding="utf-8", newline="") as handle:
        lines = handle.read().splitlines()
    total_chars = 0
    total_bytes = 0
    most_chars = (-1, 0)
    most_bytes = (-1, 0)
    for number, line in enumerate(lines, start=1):
        chars = len(line)
        size = len(line.encode("utf-8"))
        print(f"LINE={number} CHARS={chars} BYTES={size}")
        total_chars += chars
        total_bytes += size
        if chars > most_chars[0]:
            most_chars = (chars, number)
        if size > most_bytes[0]:
            most_bytes = (size, number)
    print(f"TOTAL_CHARS={total_chars}")
    print(f"TOTAL_BYTES={total_bytes}")
    print(f"MAX_CHARS_LINE={most_chars[1]}")
    print(f"MAX_BYTES_LINE={most_bytes[1]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
PY
chmod +x py/encoding.py
A_HEX=$(printf 'A' | od -An -tx1 | tr -d '[:space:]')
U_HEX=$(printf 'ü' | od -An -tx1 | tr -d '[:space:]')
C_HEX=$(printf '東' | od -An -tx1 | tr -d '[:space:]')
CODEPOINT=$(printf 'ü' | python3 -c 'import sys; print("U+%04X" % ord(sys.stdin.buffer.read().decode("utf-8")))')
py/encoding.py /srv/kestrel/import/batch-1.txt > /tmp/cs003-batch1.txt
OVER=$(awk -F'[ =]' '/^LINE=/ && $6 > 20 {print $2; exit}' /tmp/cs003-batch1.txt)
OVER_CHARS=$(awk -F'[ =]' -v n="$OVER" '/^LINE=/ && $2 == n {print $4}' /tmp/cs003-batch1.txt)
if [ "$OVER_CHARS" -le 20 ]; then COUNTS=bytes; else COUNTS=characters; fi
{
  echo "ASCII_HEX=$A_HEX"
  echo "UMLAUT_HEX=$U_HEX"
  echo "CJK_HEX=$C_HEX"
  echo "UMLAUT_CODEPOINT=$CODEPOINT"
  echo "OVER_LIMIT_LINE=$OVER"
  echo "LIMIT_COUNTS=$COUNTS"
} > ops/encoding.txt
`,
  // fdlimit.py lowers RLIMIT_NOFILE, opens /dev/null until EMFILE and reports what it got; findings are read from the running collector's /proc/<pid>/fd and /proc/<pid>/limits ([s]can pattern so pgrep never matches this script's own bash).
  'CS-004': `
set -e
mkdir -p py ops
cat > py/fdlimit.py <<'PY'
#!/usr/bin/env python3
import errno
import os
import resource
import sys


def main():
    limit = int(sys.argv[1])
    _soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    if hard != resource.RLIM_INFINITY and limit > hard:
        limit = hard
    resource.setrlimit(resource.RLIMIT_NOFILE, (limit, hard))
    opened = []
    failure = None
    while True:
        try:
            opened.append(os.open("/dev/null", os.O_RDONLY))
        except OSError as exc:
            failure = exc
            break
    count = len(opened)
    for fd in opened:
        os.close(fd)
    print(f"LIMIT={sys.argv[1]}")
    print(f"OPENED={count}")
    print(f"ERRNO={failure.errno}")
    print(f"ERRNAME={errno.errorcode.get(failure.errno, 'UNKNOWN')}")
    return 0 if failure.errno == errno.EMFILE else 1


if __name__ == "__main__":
    sys.exit(main())
PY
chmod +x py/fdlimit.py
PID=$(pgrep -o -u student -f '[s]can-collector')
test -n "$PID"
SOCKETS=0; FILES=0; PIPES=0
for FD in /proc/$PID/fd/*; do
  case "$(basename "$FD")" in 0|1|2) continue ;; esac
  TARGET=$(readlink "$FD" || true)
  case "$TARGET" in
    socket:*) SOCKETS=$((SOCKETS + 1)) ;;
    pipe:*) PIPES=$((PIPES + 1)) ;;
    /*) FILES=$((FILES + 1)) ;;
  esac
done
KIND=socket
if [ "$FILES" -gt "$SOCKETS" ] && [ "$FILES" -ge "$PIPES" ]; then KIND=file; fi
if [ "$PIPES" -gt "$SOCKETS" ] && [ "$PIPES" -gt "$FILES" ]; then KIND=pipe; fi
SOFT=$(awk '/^Max open files/ {print $4}' /proc/$PID/limits)
{
  echo "STDERR_FD=2"
  echo "LEAK_KIND=$KIND"
  echo "COLLECTOR_SOFT_LIMIT=$SOFT"
  echo "REAL_FIX=close"
} > ops/fds.txt
`,
  // decide() compares parsed numbers with strict boundaries (minimum 0 is real); anything that is not a finite number prints DECISION=invalid and exits 2; --file applies the same rule per line.
  'CS-006': `
set -e
mkdir -p py
cat > py/scale.py <<'PY'
#!/usr/bin/env python3
import math
import sys


def parse(text):
    try:
        return int(text)
    except ValueError:
        pass
    value = float(text)
    if not math.isfinite(value):
        raise ValueError(text)
    return value


def decide(current, target, minimum):
    if current < target:
        return "scale-up"
    if current > target and current > minimum:
        return "scale-down"
    return "hold"


def line_for(texts):
    if len(texts) != 3:
        raise ValueError(texts)
    current, target, minimum = (parse(text) for text in texts)
    decision = decide(current, target, minimum)
    return f"DECISION={decision} current={texts[0]} target={texts[1]} minimum={texts[2]}"


def main(argv):
    try:
        if argv and argv[0] == "--file":
            with open(argv[1], encoding="utf-8") as handle:
                rows = [line.split() for line in handle if line.strip()]
            output = [line_for(row) for row in rows]
        else:
            output = [line_for(argv)]
    except ValueError:
        print("DECISION=invalid")
        return 2
    for line in output:
        print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
PY
chmod +x py/scale.py
`,
  // Counts only lines carrying a non-empty depot= field, ranks by (-count, name) for a stable order, and writes the CSV; then runs itself on the overnight log to produce ops/depots.csv.
  'CS-007': `
set -e
mkdir -p py ops
cat > py/depots.py <<'PY'
#!/usr/bin/env python3
import sys


def depot_of(line):
    for field in line.split():
        if field.startswith("depot="):
            name = field[len("depot="):]
            return name or None
    return None


def main():
    counts = {}
    with open(sys.argv[1], encoding="utf-8") as handle:
        for line in handle:
            name = depot_of(line)
            if name is None:
                continue
            counts[name] = counts.get(name, 0) + 1
    ranked = sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    for name, count in ranked:
        print(f"DEPOT={name} COUNT={count}")
    print("ORDER=" + ",".join(name for name, _count in ranked))
    print(f"TOTAL={sum(counts.values())}")
    with open(sys.argv[2], "w", encoding="utf-8") as out:
        for name, count in ranked:
            print(f"{name},{count}", file=out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
PY
chmod +x py/depots.py
py/depots.py /srv/kestrel/scans/scan-events.log ops/depots.csv
`,
  // Parses on the line's real structure: split once at ' msg="', the five well-behaved fields before it by whitespace, the quoted message kept whole; ties broken by request id / file order.
  'CS-008': `
set -e
mkdir -p py
cat > py/parselog.py <<'PY'
#!/usr/bin/env python3
import sys

FIELDS = ("level", "req", "dur_ms", "path")


def parse(line):
    head, sep, rest = line.partition(' msg="')
    if not sep or not rest.endswith('"'):
        return None
    parts = head.split()
    if len(parts) != 5:
        return None
    record = {}
    for name, part in zip(FIELDS, parts[1:]):
        key, eq, value = part.partition("=")
        if key != name or not eq or not value:
            return None
        record[name] = value
    if not record["dur_ms"].isdigit():
        return None
    record["dur_ms"] = int(record["dur_ms"])
    record["msg"] = rest[:-1]
    return record


def main():
    with open(sys.argv[1], encoding="utf-8") as handle:
        lines = handle.read().splitlines()
    records = []
    dropped = 0
    for line in lines:
        if not line.strip():
            continue
        record = parse(line)
        if record is None:
            dropped += 1
        else:
            records.append(record)
    errors = [r for r in records if r["level"] == "error"]
    slowest = sorted(records, key=lambda r: (-r["dur_ms"], r["req"]))[:3]
    longest = max(records, key=lambda r: len(r["msg"])) if records else None
    print(f"TOTAL={len(records)}")
    print(f"ERRORS={len(errors)}")
    print(f"DROPPED={dropped}")
    print("SLOWEST=" + ",".join(r["req"] for r in slowest))
    print("LONGEST_MSG=" + (longest["req"] if longest else ""))
    print("ERROR_PATHS=" + ",".join(sorted({r["path"] for r in errors})))
    return 0


if __name__ == "__main__":
    sys.exit(main())
PY
chmod +x py/parselog.py
`,
  // Catches only FileNotFoundError (exit 2) and a bad record (exit 3); the directory's IsADirectoryError escapes. The write-up is read off the real traceback and exit status.
  'CS-009': `
set -e
mkdir -p py ops
cat > py/reconcile.py <<'PY'
#!/usr/bin/env python3
import sys


def main():
    try:
        handle = open(sys.argv[1], encoding="utf-8")
    except FileNotFoundError:
        print("RECONCILE_ERROR=missing-input", file=sys.stderr)
        return 2
    count = 0
    total = 0
    with handle:
        for number, line in enumerate(handle, start=1):
            fields = line.strip().split(",")
            try:
                if len(fields) != 3:
                    raise ValueError(line)
                pence = int(fields[2])
            except ValueError:
                print(f"RECONCILE_ERROR=malformed-record line={number}", file=sys.stderr)
                return 3
            count += 1
            total += pence
    print(f"RECONCILED={count} TOTAL={total}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
PY
chmod +x py/reconcile.py
RC=0
py/reconcile.py /srv/kestrel/ledger/ledger-archive 2> /tmp/cs009-trace.txt || RC=$?
TYPE=$(tail -n 1 /tmp/cs009-trace.txt | cut -d: -f1)
test -n "$TYPE"
{
  echo "UNCAUGHT_TYPE=$TYPE"
  echo "UNCAUGHT_EXIT=$RC"
} > ops/errors.txt
`,
  // Loader: parse failure (4) vs missing key (2) vs wrong type (3); canonical = sort_keys, indent 2, UTF-8, one trailing newline, lists untouched. YAML: copy, drop the second (silently winning) leeds block, quote no/3.10, replace the tab; write-up derived from the seeded file.
  'CS-010': `
set -e
mkdir -p py out ops
cat > py/config.py <<'PY'
#!/usr/bin/env python3
import json
import os
import sys

SCHEMA = (
    ("depot", str),
    ("region", str),
    ("version", str),
    ("enabled", bool),
    ("limits", dict),
    ("scanners", list),
)


def main():
    source, target = sys.argv[1], sys.argv[2]
    try:
        with open(source, encoding="utf-8") as handle:
            document = json.load(handle)
    except ValueError:
        print("CONFIG_ERROR=invalid-json", file=sys.stderr)
        return 4
    if not isinstance(document, dict):
        document = {}
    for key, _kind in SCHEMA:
        if key not in document:
            print(f"CONFIG_ERROR=missing-key key={key}", file=sys.stderr)
            return 2
    for key, kind in SCHEMA:
        if not isinstance(document[key], kind):
            print(f"CONFIG_ERROR=wrong-type key={key}", file=sys.stderr)
            return 3
    text = json.dumps(document, sort_keys=True, indent=2, ensure_ascii=False)
    os.makedirs(os.path.dirname(os.path.abspath(target)), exist_ok=True)
    with open(target, "w", encoding="utf-8") as out:
        print(text, file=out)
    print("CONFIG_OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
PY
chmod +x py/config.py
CFG=/srv/kestrel/config
py/config.py "$CFG/depot-a.json" out/depot-a.json
py/config.py "$CFG/depot-b.json" out/depot-b.json
cmp out/depot-a.json out/depot-b.json

cp "$CFG/depots.yaml" ops/depots.yaml
chmod u+w ops/depots.yaml
DUP=$(awk '/^  [^ ]/ {print $1}' ops/depots.yaml | sort | uniq -d | tr -d ':')
TAB_DEPOT=$(awk '/^  [^ ]/ {d = $1} /^[[:blank:]]/ && !/^ / {print d}' ops/depots.yaml | tr -d ':')
VERSION_AS_FLOAT=$(python3 -c 'print(float("3.10"))')
awk '
  /^  [^ ]/ { seen[$1]++; skip = (seen[$1] > 1) }
  skip { next }
  { sub(/^[[:blank:]]+enabled:/, "    enabled:"); print }
' ops/depots.yaml > ops/depots.yaml.new
cat ops/depots.yaml.new > ops/depots.yaml
rm ops/depots.yaml.new
sed -i -e 's/^    country: no$/    country: "no"/' -e 's/^    version: 3[.]10$/    version: "3.10"/' -e 's/^    enabled: yes$/    enabled: true/' ops/depots.yaml
{
  echo "DUPLICATE_KEY=$DUP"
  echo "COUNTRY_BECAME=false"
  echo "VERSION_BECAME=$VERSION_AS_FLOAT"
  echo "TAB_DEPOT=$TAB_DEPOT"
} > ops/yaml.txt
`,
  // spawn.py forks, polls /proc/<child>/stat until Z, reaps with waitpid and prints the raw status; the write-up comes from running it, from an orphaned grandchild's getppid(), and from SIGKILLing a real zombie and re-reading its state.
  'CS-011': `
set -e
mkdir -p py ops
cat > py/spawn.py <<'PY'
#!/usr/bin/env python3
import os
import sys
import time


def state_of(pid):
    with open(f"/proc/{pid}/stat") as handle:
        return handle.read().rsplit(")", 1)[1].split()[0]


def main():
    code = int(sys.argv[1])
    child = os.fork()
    if child == 0:
        os._exit(code)
    print(f"PARENT={os.getpid()} CHILD={child}")
    state = state_of(child)
    deadline = time.monotonic() + 10
    while state != "Z" and time.monotonic() < deadline:
        time.sleep(0.01)
        state = state_of(child)
    print(f"CHILD_STATE={state}")
    reaped, raw = os.waitpid(child, 0)
    print(f"REAPED={reaped} STATUS={os.WEXITSTATUS(raw)} RAW={raw}")
    gone = "no" if os.path.exists(f"/proc/{child}") else "yes"
    print(f"CHILD_GONE={gone}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
PY
chmod +x py/spawn.py
py/spawn.py 7 > /tmp/cs011-run.txt
ZSTATE=$(sed -n 's/^CHILD_STATE=//p' /tmp/cs011-run.txt)
RAW=$(sed -n 's/.* RAW=//p' /tmp/cs011-run.txt)
ORPHAN=$(python3 - <<'PY'
import os
import time

read_end, write_end = os.pipe()
middle = os.fork()
if middle == 0:
    os.close(read_end)
    grandchild = os.fork()
    if grandchild == 0:
        original = os.getppid()
        for _ in range(1000):
            if os.getppid() != original:
                break
            time.sleep(0.01)
        os.write(write_end, str(os.getppid()).encode())
        os._exit(0)
    os._exit(0)
os.close(write_end)
os.waitpid(middle, 0)
print(os.read(read_end, 64).decode())
PY
)
AFTER_KILL=$(python3 - <<'PY'
import os
import signal
import time


def state_of(pid):
    with open(f"/proc/{pid}/stat") as handle:
        return handle.read().rsplit(")", 1)[1].split()[0]


child = os.fork()
if child == 0:
    os._exit(0)
while state_of(child) != "Z":
    time.sleep(0.01)
os.kill(child, signal.SIGKILL)
time.sleep(0.5)
print(state_of(child))
os.waitpid(child, 0)
PY
)
{
  echo "ZOMBIE_STATE=$ZSTATE"
  echo "RAW_WAIT_STATUS=$RAW"
  echo "ORPHAN_PARENT=$ORPHAN"
  echo "STATE_AFTER_SIGKILL=$AFTER_KILL"
} > ops/zombies.txt
`,
  // probe.py blocked: forks a child into read() on a pipe, polls its state, decodes /proc/<child>/syscall via the seeded table. writes: counts syscw from /proc/self/io around n single-line writes vs one gathered write. Saved crossings = measured difference.
  'CS-012': `
set -e
mkdir -p py ops
cat > py/probe.py <<'PY'
#!/usr/bin/env python3
import os
import signal
import sys
import time

TABLE = "/srv/kestrel/printer/syscall-table.txt"
NEWLINE = chr(10).encode()


def load_table():
    names = {}
    with open(TABLE, encoding="utf-8") as handle:
        for line in handle:
            if line.startswith("#"):
                continue
            parts = line.split()
            if len(parts) == 2 and parts[0].isdigit():
                names[parts[0]] = parts[1]
    return names


def state_of(pid):
    with open(f"/proc/{pid}/stat") as handle:
        return handle.read().rsplit(")", 1)[1].split()[0]


def syscall_of(pid):
    with open(f"/proc/{pid}/syscall") as handle:
        fields = handle.read().split()
    return fields[0] if fields else ""


def blocked():
    names = load_table()
    read_end, _write_end = os.pipe()
    child = os.fork()
    if child == 0:
        os.read(read_end, 1)
        os._exit(0)
    found = None
    previous = None
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        time.sleep(0.01)
        if state_of(child) != "S":
            previous = None
            continue
        number = syscall_of(child)
        if number.isdigit() and number == previous:
            found = number
            break
        previous = number
    os.kill(child, signal.SIGKILL)
    os.waitpid(child, 0)
    if found is None or found not in names:
        print("BLOCKED_SYSCALL=unknown", file=sys.stderr)
        return 1
    print(f"BLOCKED_SYSCALL={names[found]} BLOCKED_NUMBER={found}")
    return 0


def syscw():
    with open("/proc/self/io") as handle:
        for line in handle:
            if line.startswith("syscw:"):
                return int(line.split()[1])
    raise RuntimeError("no syscw in /proc/self/io")


def writes(count):
    lines = [f"KL{8800 + n} leeds parcel-label".encode() + NEWLINE for n in range(count)]
    fd = os.open("/dev/null", os.O_WRONLY)
    before = syscw()
    for line in lines:
        os.write(fd, line)
    unbuffered = syscw() - before
    batch = b"".join(lines)
    before = syscw()
    os.write(fd, batch)
    buffered = syscw() - before
    os.close(fd)
    print(f"LINES={count} UNBUFFERED_WRITES={unbuffered} BUFFERED_WRITES={buffered}")
    return 0


def main(argv):
    if argv and argv[0] == "blocked":
        return blocked()
    if len(argv) == 2 and argv[0] == "writes":
        return writes(int(argv[1]))
    print("usage: probe.py blocked | probe.py writes <n>", file=sys.stderr)
    return 64


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
PY
chmod +x py/probe.py
NAME=$(py/probe.py blocked | sed -n 's/^BLOCKED_SYSCALL=\\([^ ]*\\) .*/\\1/p')
test -n "$NAME"
COUNTS=$(py/probe.py writes 200)
UNBUF=$(echo "$COUNTS" | sed -n 's/.* UNBUFFERED_WRITES=\\([0-9]*\\).*/\\1/p')
BUF=$(echo "$COUNTS" | sed -n 's/.* BUFFERED_WRITES=\\([0-9]*\\)$/\\1/p')
# print-labels.py calls os.write once per label inside its loop: unbuffered.
{
  echo "BLOCKED_SYSCALL=$NAME"
  echo "PRINTER_IS=unbuffered"
  echo "SYSCALLS_SAVED_BY_BUFFERING=$((UNBUF - BUF))"
} > ops/syscalls.txt
`,
  // workers.py measures voluntary_ctxt_switches around n sleeps and around pure computation, polls Threads: for n+1 then 1, and reads cpu.max against the scan-ingest pool rule; BLOCKING_SHOWS_UP_AS is taken from a measured run, the other answers are the lab's conceptual findings.
  'CS-013': `
set -e
mkdir -p py ops
cat > py/workers.py <<'PY'
#!/usr/bin/env python3
import os
import sys
import threading
import time


def status_field(name):
    with open("/proc/self/status") as handle:
        for line in handle:
            if line.startswith(name + ":"):
                return int(line.split()[1])
    raise RuntimeError(f"{name} missing from /proc/self/status")


def switches(units):
    before = status_field("voluntary_ctxt_switches")
    for _ in range(units):
        time.sleep(0.005)
    after = status_field("voluntary_ctxt_switches")
    io_count = after - before
    before = status_field("voluntary_ctxt_switches")
    total = 0
    for value in range(units * 20000):
        total += value * value
    after = status_field("voluntary_ctxt_switches")
    cpu_count = after - before
    print(f"UNITS={units} IO_VOLUNTARY={io_count} CPU_VOLUNTARY={cpu_count}")
    return 0


def wait_for_threads(expected, timeout=10.0):
    deadline = time.monotonic() + timeout
    seen = status_field("Threads")
    while seen != expected and time.monotonic() < deadline:
        time.sleep(0.01)
        seen = status_field("Threads")
    return seen


def threads(count):
    release = threading.Event()
    workers = [threading.Thread(target=release.wait) for _ in range(count)]
    for worker in workers:
        worker.start()
    during = wait_for_threads(count + 1)
    release.set()
    for worker in workers:
        worker.join()
    after = wait_for_threads(1)
    print(f"STARTED={count} THREADS_DURING={during} THREADS_AFTER={after}")
    return 0


def budget():
    visible = os.cpu_count() or 1
    with open("/sys/fs/cgroup/cpu.max") as handle:
        quota_text, period_text = handle.read().split()[:2]
    if quota_text == "max":
        allowance = float(visible)
        shown = "max"
    else:
        allowance = int(quota_text) / int(period_text)
        shown = f"{allowance:g}"
    pool = visible * 2
    oversubscribed = "yes" if pool > allowance else "no"
    print(f"CPUS_VISIBLE={visible} CPU_QUOTA={shown} OVERSUBSCRIBED={oversubscribed}")
    return 0


def main(argv):
    if len(argv) == 2 and argv[0] == "switches":
        return switches(int(argv[1]))
    if len(argv) == 2 and argv[0] == "threads":
        return threads(int(argv[1]))
    if argv == ["budget"]:
        return budget()
    print("usage: workers.py switches <n> | threads <n> | budget", file=sys.stderr)
    return 64


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
PY
chmod +x py/workers.py
IO=$(py/workers.py switches 5 | sed -n 's/.* IO_VOLUNTARY=\\([0-9]*\\) .*/\\1/p')
if [ "$IO" -gt 0 ]; then BLOCKING=voluntary; else BLOCKING=involuntary; fi
{
  echo "WHY_THREADS_DONT_HELP_CPU=gil"
  echo "WHY_MORE_WORKERS_DIDNT_HELP=quota"
  echo "BLOCKING_SHOWS_UP_AS=$BLOCKING"
  echo "POOL_SIZE_SHOULD_FOLLOW=quota"
} > ops/threads.txt
`,
  // ss for the listening sockets; curl every listening port on loopback and keep the body that answers HTTP; hostname.
  'LINUX-006': `
set -e
cd /home/student/net
ss -ltn > ports.txt
for port in $(ss -Hltn | awk '{n = split($4, a, ":"); print a[n]}' | sort -un); do
  if curl -sf --max-time 10 "http://127.0.0.1:$port/" > banner.tmp 2>/dev/null; then
    mv banner.tmp banner.txt
    break
  fi
done
rm -f banner.tmp
grep -q . banner.txt
hostname > hostname.txt
`,
  // grep -c on the current log only; recursive grep of the archive for TXN-<digits> gives the id and (-l) the file.
  'LINUX-007': `
set -e
cd /home/student/analysis
grep -c ERROR /var/log/jumptotech/payments.log > error-count.txt
grep -rhoE 'TXN-[0-9]+' /var/log/jumptotech/archive | sort -u > failed-transaction.txt
grep -rlE 'TXN-[0-9]+' /var/log/jumptotech/archive > source.txt
test "$(wc -l < failed-transaction.txt)" -eq 1
test "$(wc -l < source.txt)" -eq 1
`,
  // df -h / with headers; largest directory by du; delete exactly the files index.txt marks "safe to delete", by name.
  'LINUX-008': `
set -e
cd /home/student/capacity
df -h / > filesystem.txt
du -s /var/log/jumptotech/*/ | sort -n | tail -n 1 | cut -f2- | sed 's:/*$::' > largest.txt
cat /var/log/jumptotech/archive/index.txt
for f in $(awk '/safe to delete/ {print $1}' /var/log/jumptotech/archive/index.txt); do
  rm -- "/var/log/jumptotech/archive/$f"
done
test -f /var/log/jumptotech/archive/index.txt
`,
  // Existence test first (exit 2), then HOST= line, then grep -w healthy decides OK/0 vs FAIL/1; self-test all three cases.
  'LINUX-009': `
set -e
cat > /home/student/scripts/health-check.sh <<'SH'
#!/bin/bash
file="$1"
if [ ! -f "$file" ]; then
  echo "STATUS=UNKNOWN"
  exit 2
fi
echo "HOST=$(hostname)"
if grep -qw healthy "$file"; then
  echo "STATUS=OK"
  exit 0
fi
echo "STATUS=FAIL"
exit 1
SH
chmod 0755 /home/student/scripts/health-check.sh
cd /home/student/scripts
./health-check.sh /srv/jumptotech/app/healthy.status
rc=0; ./health-check.sh /srv/jumptotech/app/degraded.status || rc=$?; test "$rc" -eq 1
rc=0; ./health-check.sh /srv/jumptotech/app/missing.status || rc=$?; test "$rc" -eq 2
`,
  // sudo chmod the three paths (setgid drop, sticky scratch, strip setuid); umask 027 in ~/.profile (login shells read it,
  // .bashrc returns early); then poll until the writer's next cycle produces 0640 deployers / 2750.
  'LINUX-011': `
set -e
sudo chmod 2770 /srv/jumptotech/drop
sudo chmod 1777 /srv/jumptotech/scratch
sudo chmod 0755 /usr/local/bin/report-helper
echo 'umask 027' >> /home/student/.profile
ok() {
  [ "$(stat -c %a /srv/jumptotech/drop/handoff.csv 2>/dev/null)" = 640 ] &&
  [ "$(stat -c %G /srv/jumptotech/drop/handoff.csv 2>/dev/null)" = deployers ] &&
  [ "$(stat -c %a /srv/jumptotech/drop/handoff.d 2>/dev/null)" = 2750 ]
}
for i in $(seq 1 30); do
  if ok; then break; fi
  sleep 1
done
ok
`,
  // Two full invocations (binary + args) NOPASSWD for oncall, validated with visudo, installed root:root 0440;
  // then poll the probe until it reports both permitted and both forbidden lines denied.
  'LINUX-015': `
set -e
tmp=$(mktemp /home/student/oncall.XXXXXX)
cat > "$tmp" <<'EOF'
# On-call rotation: check and restart the ledger service, nothing else.
oncall ALL=(root) NOPASSWD: /usr/local/sbin/jtt-service-control status ledger-api, /usr/local/sbin/jtt-service-control restart ledger-api
EOF
sudo visudo -c -f "$tmp"
sudo install -o root -g root -m 0440 "$tmp" /etc/sudoers.d/020-oncall
rm -f "$tmp"
sudo visudo -c
status=/var/lib/jumptotech/probe/sudo-probe.status
ok() {
  grep -qx 'PERMITTED_STATUS=ok' "$status" &&
  grep -qx 'PERMITTED_RESTART=ok' "$status" &&
  grep -qx 'FORBIDDEN_CMD=denied' "$status" &&
  grep -qx 'FORBIDDEN_ARG=denied' "$status"
}
for i in $(seq 1 60); do
  if ok; then break; fi
  sleep 1
done
ok
`,
  // find scoped to *.conf under conf/ with sed -i; one awk over settled lines summed per merchant, sort -k2nr;
  // find -name '*.tmp' -mtime +7 -delete (catches the dotfile the shell glob skips).
  'LINUX-016': `
set -e
find /srv/jumptotech/conf -type f -name '*.conf' -exec sed -i 's/ledger-old.jumptotech.internal/ledger-01.jumptotech.internal/g' {} +
awk '/status=settled/ {
  m = ""; a = 0
  for (i = 1; i <= NF; i++) {
    split($i, kv, "=")
    if (kv[1] == "merchant") m = kv[2]
    else if (kv[1] == "amount") a = kv[2]
  }
  total[m] += a
}
END { for (k in total) printf "%s %d\\n", k, total[k] }' /var/log/jumptotech/payments-2026-08.log \\
  | sort -k2,2nr > /home/student/analysis/merchant-totals.txt
test "$(wc -l < /home/student/analysis/merchant-totals.txt)" -eq 8
find /srv/jumptotech/spool -type f -name '*.tmp' -mtime +7 -print -delete
`,
  // Make the tool executable (sudo), install an every-minute crontab entry with the absolute path and both streams
  // appended to the runbook's log, then poll up to ~150s for a cron-invoked run.
  'LINUX-018': `
set -e
sudo chmod 0755 /usr/local/lib/jumptotech/jtt-rollup
crontab - <<'EOF'
# Event rollup: every minute during the incident window.
* * * * * /usr/local/lib/jumptotech/jtt-rollup >> /var/log/jumptotech/rollup-cron.log 2>&1
EOF
crontab -l
ok() {
  grep -qx 'RUNBY=cron' /var/lib/jumptotech/rollup/status.txt 2>/dev/null &&
  grep -q 'rollup complete' /var/log/jumptotech/rollup-cron.log 2>/dev/null
}
for i in $(seq 1 150); do
  if ok; then break; fi
  sleep 1
done
ok
`,
  // dpkg --verify finds the edited file -> reinstall jumptotech-tools from the local .deb; dpkg -S says the
  // /usr/local/bin shim is unowned -> remove it; dpkg -i the audit .deb.
  'LINUX-019': `
set -e
dpkg --verify jumptotech-tools || true
sudo dpkg --force-confold -i /srv/jumptotech/pkg/jumptotech-tools_1.2.0_all.deb </dev/null
dpkg --verify jumptotech-tools
if ! dpkg -S /usr/local/bin/jtt-checkctl >/dev/null 2>&1; then
  sudo rm -f /usr/local/bin/jtt-checkctl
fi
sudo dpkg -i /srv/jumptotech/pkg/jumptotech-audit_0.9.1_all.deb </dev/null
dpkg -s jumptotech-audit >/dev/null
test -x /usr/local/lib/jumptotech/jtt-audit
`,
  // Three statements from the ticket: ListBucket on the bucket ARN, GetObject on objects, PutObject on objects only
  // with StringEquals s3:x-amz-server-side-encryption=aws:kms. Delete and other buckets are simply never granted.
  'AWS-002': `
set -e
cat > /home/student/aws-iam/policy.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListLedgerExports",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::jumptotech-ledger-exports"
    },
    {
      "Sid": "ReadLedgerExports",
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::jumptotech-ledger-exports/*"
    },
    {
      "Sid": "UploadReportKmsOnly",
      "Effect": "Allow",
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::jumptotech-ledger-exports/*",
      "Condition": {
        "StringEquals": {
          "s3:x-amz-server-side-encryption": "aws:kms"
        }
      }
    }
  ]
}
EOF
python3 -m json.tool /home/student/aws-iam/policy.json >/dev/null
`,
  // Trust policy becomes one statement: Service ec2.amazonaws.com may sts:AssumeRole. Permissions policy untouched.
  'AWS-004': `
set -e
cat > /home/student/role-setup/trust-policy.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "Ec2AssumesReconciliationRole",
      "Effect": "Allow",
      "Principal": {
        "Service": "ec2.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF
python3 -m json.tool /home/student/role-setup/trust-policy.json >/dev/null
`,
  // The EC2 statement stays byte-for-byte; PassRole narrows to the two app
  // roles and only to ec2.amazonaws.com (iam:PassedToService). GetRole, a
  // read, is kept but scoped to the same two roles. No new iam: write action.
  'AWS-005': `
set -e
cd ~/escalation-review
cat roles-in-account.txt finding-8102.txt >/dev/null
cat > deployer-policy.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "LaunchInstances",
      "Effect": "Allow",
      "Action": [
        "ec2:RunInstances",
        "ec2:DescribeInstances",
        "ec2:CreateTags"
      ],
      "Resource": "*"
    },
    {
      "Sid": "AttachAppRolesToEc2Only",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": [
        "arn:aws:iam::123456789012:role/AppServerRole",
        "arn:aws:iam::123456789012:role/AppWorkerRole"
      ],
      "Condition": {
        "StringEquals": { "iam:PassedToService": "ec2.amazonaws.com" }
      }
    },
    {
      "Sid": "ReadAppRoles",
      "Effect": "Allow",
      "Action": "iam:GetRole",
      "Resource": [
        "arn:aws:iam::123456789012:role/AppServerRole",
        "arn:aws:iam::123456789012:role/AppWorkerRole"
      ]
    }
  ]
}
EOF
python3 -m json.tool deployer-policy.json >/dev/null
`,
  // Every answer is read out of the export: the payments-api-sg id from the
  // inventory, then the one RevokeSecurityGroupIngress on it with no
  // errorCode (the outage) and the one with an errorCode (the refused try).
  'AWS-006': `
set -e
cd ~/incident-9214
python3 - <<'PY'
import glob, json

records = []
for path in sorted(glob.glob('cloudtrail/*.json')):
    records += json.load(open(path))['Records']

sg = [line.split()[0] for line in open('infrastructure.txt').read().splitlines()
      if line.startswith('sg-') and line.strip().endswith('payments-api-sg')]
assert len(sg) == 1, sg
sg = sg[0]

revokes = [r for r in records
           if r['eventName'] == 'RevokeSecurityGroupIngress'
           and (r.get('requestParameters') or {}).get('groupId') == sg]
done = [r for r in revokes if 'errorCode' not in r]
refused = [r for r in revokes if 'errorCode' in r]
assert len(done) == 1 and len(refused) == 1, (done, refused)
hit, miss = done[0], refused[0]

answers = {
    'EVENT_NAME': hit['eventName'],
    'EVENT_SOURCE': hit['eventSource'],
    'EVENT_TIME': hit['eventTime'],
    'AWS_REGION': hit['awsRegion'],
    'AFFECTED_SECURITY_GROUP': hit['requestParameters']['groupId'],
    'PRINCIPAL_ARN': hit['userIdentity']['arn'],
    'PRINCIPAL_ID': hit['userIdentity']['principalId'],
    'SOURCE_IP': hit['sourceIPAddress'],
    'OUTCOME': 'success',
    'DENIED_PRINCIPAL_ARN': miss['userIdentity']['arn'],
    'DENIED_ERROR_CODE': miss['errorCode'],
}
out = []
for line in open('findings.env').read().split('\\n'):
    key = line.split('=', 1)[0]
    if line.endswith('=FILL_ME') and key in answers:
        line = key + '=' + answers.pop(key)
    out.append(line)
assert not answers, answers
open('findings.env', 'w').write('\\n'.join(out))
PY
cat findings.env
! grep -q '=FILL_ME' findings.env
`,
  // A /16 of RFC 1918 space; two /24 public subnets (256-5 = 251 assignable)
  // and two /20 private subnets (4096-5 = 4091), one of each tier per AZ,
  // 8,704 of 65,536 addresses allocated. MapPublicIpOnLaunch on every subnet.
  'AWS-007': `
set -e
cd ~/network
cat network-requirements.txt review.txt >/dev/null
cat > vpc.yaml <<'EOF'
AWSTemplateFormatVersion: '2010-09-09'
Description: Payments platform VPC - address plan, reworked for growth.

Resources:
  Vpc:
    Type: AWS::EC2::VPC
    Properties:
      CidrBlock: 10.0.0.0/16
      EnableDnsSupport: true
      EnableDnsHostnames: true
      Tags:
        - Key: Name
          Value: payments

  PublicSubnetA:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref Vpc
      CidrBlock: 10.0.0.0/24
      AvailabilityZone: eu-west-1a
      MapPublicIpOnLaunch: true

  PublicSubnetB:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref Vpc
      CidrBlock: 10.0.1.0/24
      AvailabilityZone: eu-west-1b
      MapPublicIpOnLaunch: true

  PrivateSubnetA:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref Vpc
      CidrBlock: 10.0.16.0/20
      AvailabilityZone: eu-west-1a
      MapPublicIpOnLaunch: false

  PrivateSubnetB:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref Vpc
      CidrBlock: 10.0.32.0/20
      AvailabilityZone: eu-west-1b
      MapPublicIpOnLaunch: false

Outputs:
  VpcId:
    Value: !Ref Vpc
EOF
`,
  // The deployed zone is left untouched: the zone-B subnets are inserted
  // before Outputs (10.42.1.0/24 and 10.42.32.0/20, both eu-west-1b, clear of
  // 10.42.0.0/24 and 10.42.16.0/20), and the two outputs are appended to the
  // Outputs section, which is the last in the file, following the ...Id pattern.
  'AWS-008': `
set -e
cd ~/network
cat incident-4471.txt platform-notes.txt >/dev/null
add=$(mktemp)
cat > "$add" <<'EOF'
  PublicSubnetB:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref Vpc
      CidrBlock: 10.42.1.0/24
      AvailabilityZone: eu-west-1b
      MapPublicIpOnLaunch: true

  PrivateSubnetB:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref Vpc
      CidrBlock: 10.42.32.0/20
      AvailabilityZone: eu-west-1b
      MapPublicIpOnLaunch: false

EOF
new=$(mktemp)
awk -v f="$add" '/^Outputs:/ { while ((getline l < f) > 0) print l } { print }' vpc.yaml > "$new"
cat >> "$new" <<'EOF'
  PublicSubnetBId:
    Value: !Ref PublicSubnetB
  PrivateSubnetBId:
    Value: !Ref PrivateSubnetB
EOF
cat "$new" > vpc.yaml
rm -f "$add" "$new"
cat vpc.yaml
`,
  // Insert the six named resources before Outputs, changing nothing already
  // there: the gateway, its attachment to Vpc, a public route table, a
  // 0.0.0.0/0 route whose GatewayId is the gateway, and both public subnet
  // associations. PrivateRouteTable keeps no route out.
  'AWS-009': `
set -e
cd ~/network
cat ticket-8830.txt routing-notes.txt >/dev/null
add=$(mktemp)
cat > "$add" <<'EOF'
  InternetGateway:
    Type: AWS::EC2::InternetGateway
    Properties:
      Tags:
        - Key: Name
          Value: payments

  InternetGatewayAttachment:
    Type: AWS::EC2::VPCGatewayAttachment
    Properties:
      VpcId: !Ref Vpc
      InternetGatewayId: !Ref InternetGateway

  PublicRouteTable:
    Type: AWS::EC2::RouteTable
    Properties:
      VpcId: !Ref Vpc
      Tags:
        - Key: Name
          Value: payments-public

  PublicDefaultRoute:
    Type: AWS::EC2::Route
    DependsOn: InternetGatewayAttachment
    Properties:
      RouteTableId: !Ref PublicRouteTable
      DestinationCidrBlock: 0.0.0.0/0
      GatewayId: !Ref InternetGateway

  PublicSubnetARouteTableAssociation:
    Type: AWS::EC2::SubnetRouteTableAssociation
    Properties:
      SubnetId: !Ref PublicSubnetA
      RouteTableId: !Ref PublicRouteTable

  PublicSubnetBRouteTableAssociation:
    Type: AWS::EC2::SubnetRouteTableAssociation
    Properties:
      SubnetId: !Ref PublicSubnetB
      RouteTableId: !Ref PublicRouteTable

EOF
new=$(mktemp)
awk -v f="$add" '/^Outputs:/ { while ((getline l < f) > 0) print l } { print }' vpc.yaml > "$new"
cat "$new" > vpc.yaml
rm -f "$add" "$new"
cat vpc.yaml
`,
  // Gateway endpoints for S3 and DynamoDB (the only two services that type
  // supports), on PrivateRouteTable; NAT and its default route untouched. The
  // removed share is summed from the report's two S3 rows and the DynamoDB row.
  'AWS-012': `
set -e
cd ~/network
cat traffic-report.txt review-notes.txt >/dev/null
add=$(mktemp)
cat > "$add" <<'EOF'
  S3Endpoint:
    Type: AWS::EC2::VPCEndpoint
    Properties:
      VpcEndpointType: Gateway
      VpcId: !Ref Vpc
      ServiceName: !Sub 'com.amazonaws.\${AWS::Region}.s3'
      RouteTableIds:
        - !Ref PrivateRouteTable

  DynamoDbEndpoint:
    Type: AWS::EC2::VPCEndpoint
    Properties:
      VpcEndpointType: Gateway
      VpcId: !Ref Vpc
      ServiceName: !Sub 'com.amazonaws.\${AWS::Region}.dynamodb'
      RouteTableIds:
        - !Ref PrivateRouteTable

EOF
new=$(mktemp)
awk -v f="$add" '/^Outputs:/ { while ((getline l < f) > 0) print l } { print }' vpc.yaml > "$new"
cat "$new" > vpc.yaml
rm -f "$add" "$new"
share=$(awk '/^ *Amazon (S3|DynamoDB) / { for (i = 1; i <= NF; i++) if ($i ~ /^[0-9]+%$/) { sub("%", "", $i); s += $i } } END { print s }' traffic-report.txt)
test "$share" -gt 0
sed -i \
  -e 's/^ENDPOINT_TYPE=FILL_ME$/ENDPOINT_TYPE=Gateway/' \
  -e 's/^ENDPOINT_CHARGE=FILL_ME$/ENDPOINT_CHARGE=none/' \
  -e 's/^BACKUP_TRAFFIC_VIA=FILL_ME$/BACKUP_TRAFFIC_VIA=gateway_endpoint/' \
  -e 's/^PATCHING_TRAFFIC_VIA=FILL_ME$/PATCHING_TRAFFIC_VIA=nat_gateway/' \
  -e "s/^NAT_SHARE_REMOVED=FILL_ME$/NAT_SHARE_REMOVED=$share/" \
  findings.env
cat findings.env
! grep -q '=FILL_ME' findings.env
`,
  // The three event failures (empty trust document, GetAtt on ExportsBucket,
  // Ref to an undeclared Env) plus the change request: Roles by !Ref, object
  // ARN from the bucket's Arn + "/*", and an ExportRoleArn output via GetAtt.
  'AWS-018': `
set -e
cd ~/stack
cat stack-events.txt change-request.txt >/dev/null
cat > payments-export.yaml <<'EOF'
AWSTemplateFormatVersion: '2010-09-09'
Description: Payments export pipeline - bucket, queue, and the role that reads them.

Parameters:
  Environment:
    Type: String
    Description: Deployment environment prefix, for example staging or prod.
    Default: staging

Resources:
  ExportBucket:
    Type: AWS::S3::Bucket
    Properties:
      BucketName: !Sub '\${Environment}-payments-exports'

  ExportQueue:
    Type: AWS::SQS::Queue
    Properties:
      QueueName: !Sub '\${Environment}-payments-export-events'
      MessageRetentionPeriod: 345600

  ExportRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: !Sub '\${Environment}-payments-export'
      Description: Runs the nightly payments export on EC2.
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              Service: ec2.amazonaws.com
            Action: sts:AssumeRole

  ExportRolePolicy:
    Type: AWS::IAM::Policy
    Properties:
      PolicyName: payments-export-read
      Roles:
        - !Ref ExportRole
      PolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Action:
              - s3:GetObject
            Resource: !Sub '\${ExportBucket.Arn}/*'

Outputs:
  ExportBucketName:
    Description: Name of the export bucket.
    Value: !Ref ExportBucket
  ExportRoleArn:
    Description: ARN of the export role.
    Value: !GetAtt ExportRole.Arn
EOF
`,
  // Three typed variables (environment with no default), the resource built
  // from them, and production supplied through terraform.tfvars. Nothing was
  // ever applied as staging, so build/staging.json never exists.
  'TF-002': `
set -e
cd ~/terraform
cat > variables.tf <<'EOF'
variable "environment" {
  type        = string
  description = "Which environment this configuration builds."
}

variable "replicas" {
  type    = number
  default = 2
}

variable "debug" {
  type    = bool
  default = true
}
EOF
cat > main.tf <<'EOF'
resource "local_file" "service_config" {
  filename = "build/\${var.environment}.json"

  content = jsonencode({
    service     = "ledger-api"
    environment = var.environment
    replicas    = var.replicas
    debug       = var.debug
  })
}
EOF
cat > terraform.tfvars <<'EOF'
environment = "production"
replicas    = 4
debug       = false
EOF
terraform init -input=false
terraform apply -input=false -auto-approve
cat build/production.json
test ! -e build/staging.json
`,
  // Apply, read state, then rename in config + state mv, and state rm plus
  // deleting the block for scratch_notes; the saved plan of the result is a
  // no-op, exported with terraform show -json.
  'TF-004': `
set -e
cd ~/terraform
terraform init -input=false
terraform apply -input=false -auto-approve
terraform state list
terraform state show local_file.metrics
sed -i 's/^resource "local_file" "legacy_report" {$/resource "local_file" "quarterly_report" {/' main.tf
sed -i '/^resource "local_file" "scratch_notes" {$/,/^}$/d' main.tf
terraform state mv local_file.legacy_report local_file.quarterly_report
terraform state rm local_file.scratch_notes
cat main.tf
terraform state list
terraform plan -input=false -detailed-exitcode -out=tfplan
terraform show -json tfplan > plan.json
test -f out/scratch-notes.txt
grep -q 'owner: platform-team' out/report.txt
`,
  // Two resources that interpolate local_file.service_config.content_sha256
  // (and the integrity record's filename), two outputs from the same
  // references, no depends_on. Plan first, then apply.
  'TF-005': `
set -e
cd ~/terraform
cat > chain.tf <<'EOF'
resource "local_file" "integrity_record" {
  filename = "build/integrity.txt"
  content  = "sha256 \${local_file.service_config.content_sha256} \${local_file.service_config.filename}"
}

resource "local_file" "deploy_manifest" {
  filename = "build/deploy-manifest.txt"
  content  = "fingerprint \${local_file.service_config.content_sha256} integrity \${local_file.integrity_record.filename}"
}

output "config_fingerprint" {
  value = local_file.service_config.content_sha256
}

output "deployment" {
  value = {
    config      = local_file.service_config.filename
    integrity   = local_file.integrity_record.filename
    fingerprint = local_file.service_config.content_sha256
  }
}
EOF
terraform init -input=false
terraform plan -input=false
terraform apply -input=false -auto-approve
terraform output
cat build/integrity.txt build/deploy-manifest.txt
`,
  // A local_file data source for platform.json decoded with jsondecode in the
  // resource itself, and the slug composed from two locals; the applied file
  // is byte-for-byte the seeded one.
  'TF-006': `
set -e
cd ~/terraform
cat > main.tf <<'EOF'
locals {
  service_prefix = "jumptotech"
  environment    = "prod"
  service_slug   = "\${local.service_prefix}-ledger-\${local.environment}"
}

data "local_file" "platform" {
  filename = "\${path.module}/platform.json"
}

resource "local_file" "service_manifest" {
  filename = "build/\${local.service_slug}.json"

  content = jsonencode({
    slug   = local.service_slug
    region = jsondecode(data.local_file.platform.content).region
    tier   = jsondecode(data.local_file.platform.content).tier
  })
}
EOF
terraform init -input=false
terraform apply -input=false -auto-approve
cat build/jumptotech-ledger-prod.json
grep -q platform-team platform.json
`,
  // Round one: init, plan -out=tfplan, show -json, apply the saved plan. Round
  // two adds rollback_plan (content refers to release_manifest.filename) and
  // the rollback_path output, then the same with tfplan2/plan2.json; the
  // already-applied manifest shows up in plan2.json as "no-op".
  'TF-011': `
set -e
cd ~/terraform
terraform init -input=false
terraform plan -input=false -out=tfplan
terraform show -json tfplan > plan.json
terraform apply -input=false tfplan
cat >> main.tf <<'EOF'

resource "local_file" "rollback_plan" {
  filename = "build/rollback-plan.txt"
  content  = "rollback to: \${local_file.release_manifest.filename}\\n"
}

output "rollback_path" {
  value = local_file.rollback_plan.filename
}
EOF
terraform plan -input=false -out=tfplan2
terraform show -json tfplan2 > plan2.json
grep -q '"no-op"' plan2.json
terraform apply -input=false tfplan2
cat build/rollback-plan.txt
`,
  // depends_on on the manifest (its content untouched), and a release record
  // whose content reads the manifest's content_sha256 with no depends_on.
  'TF-016': `
set -e
cd ~/terraform
cat > main.tf <<'EOF'
locals {
  release = "2026.08"
}

resource "local_file" "migration_marker" {
  filename = "build/migrations/applied.txt"

  content = <<-EOT
    release: \${local.release}
    status: complete
  EOT
}

resource "local_file" "app_manifest" {
  filename = "build/app/manifest.json"

  content = jsonencode({
    service = "ledger-api"
    release = local.release
  })

  depends_on = [local_file.migration_marker]
}

resource "local_file" "release_record" {
  filename = "build/app/release-record.txt"
  content  = "manifest_sha256: \${local_file.app_manifest.content_sha256}\\n"
}
EOF
terraform init -input=false
terraform apply -input=false -auto-approve
terraform graph > /dev/null
cat build/app/manifest.json build/app/release-record.txt
`,
  // map(object) with debug = optional(bool, false); the manifest reads every
  // key from var.environments[var.target]. terraform.tfvars is not touched.
  'TF-017': `
set -e
cd ~/terraform
cat > main.tf <<'EOF'
variable "target" {
  type    = string
  default = "production"
}

variable "environments" {
  type = map(object({
    region   = string
    replicas = number
    debug    = optional(bool, false)
  }))
}

resource "local_file" "environment_manifest" {
  filename = "build/\${var.target}.json"

  content = jsonencode({
    environment = var.target
    region      = var.environments[var.target].region
    replicas    = var.environments[var.target].replicas
    debug       = var.environments[var.target].debug
  })
}
EOF
terraform init -input=false
terraform apply -input=false -auto-approve
cat build/production.json
`,
  // The four locals from the hint (for with format, filtered for, a
  // conditional, sum times the factor), rendered through templatefile.
  'TF-018': `
set -e
cd ~/terraform
cat > main.tf <<'EOF'
variable "environment" {
  type    = string
  default = "production"
}

variable "services" {
  type = map(object({
    tier     = string
    replicas = number
  }))

  default = {
    ledger    = { tier = "gold", replicas = 3 }
    auth      = { tier = "gold", replicas = 2 }
    reporting = { tier = "silver", replicas = 1 }
  }
}

locals {
  service_summary = [for name, s in var.services : format("%s(%d)", name, s.replicas)]
  gold_services   = sort([for name, s in var.services : name if s.tier == "gold"])
  replica_factor  = var.environment == "production" ? 2 : 1
  scaled_replicas = sum([for s in var.services : s.replicas]) * local.replica_factor
}

resource "local_file" "release_manifest" {
  filename = "build/manifest.txt"

  content = templatefile("\${path.module}/manifest.tftpl", {
    environment = upper(var.environment)
    services    = join(", ", local.service_summary)
    gold        = join(", ", local.gold_services)
    replicas    = local.scaled_replicas
  })
}
EOF
terraform init -input=false
terraform apply -input=false -auto-approve
cat build/manifest.txt
`,
  // Validation (contains staging/production), precondition on replicas,
  // postcondition reading self.content's region, and a top-level check block.
  // The misspelt environment is shown to be refused at plan time.
  'TF-025': `
set -e
cd ~/terraform
cat > main.tf <<'EOF'
variable "environment" {
  type    = string
  default = "production"

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}

data "local_file" "platform" {
  filename = "platform.json"

  lifecycle {
    postcondition {
      condition     = can(jsondecode(self.content).region)
      error_message = "platform.json must contain a region."
    }
  }
}

locals {
  settings = jsondecode(data.local_file.platform.content)
}

resource "local_file" "release_manifest" {
  filename = "build/\${var.environment}.json"

  content = jsonencode({
    environment = var.environment
    region      = local.settings.region
    replicas    = local.settings.replicas
  })

  lifecycle {
    precondition {
      condition     = local.settings.replicas > 0
      error_message = "replicas in platform.json must be greater than zero."
    }
  }
}

check "manifest_is_populated" {
  assert {
    condition     = length(local_file.release_manifest.content) > 0
    error_message = "The release manifest is empty."
  }
}
EOF
terraform init -input=false
if terraform plan -input=false -var=environment=prodution >/dev/null 2>&1; then
  echo "the validation rule accepted prodution" >&2
  exit 1
fi
terraform apply -input=false -auto-approve
cat build/production.json
`,
  // Backend "local" at state/platform.tfstate, init answering yes to the copy
  // (-migrate-state -force-copy), then state_report reads the pet's id.
  // terraform.tfstate(.backup) are left where the migration put them.
  'TF-026': `
set -e
cd ~/terraform
grep -q romantic-eagle terraform.tfstate
cat > versions.tf <<'EOF'
terraform {
  required_version = ">= 1.5.0"

  backend "local" {
    path = "state/platform.tfstate"
  }

  required_providers {
    local  = { source = "hashicorp/local", version = "2.5.2" }
    random = { source = "hashicorp/random", version = "3.6.3" }
  }
}
EOF
terraform init -input=false -migrate-state -force-copy
grep -q romantic-eagle state/platform.tfstate
! grep -q romantic-eagle terraform.tfstate
cat >> main.tf <<'EOF'

resource "local_file" "state_report" {
  filename = "out/state-report.txt"
  content  = "deployment: \${random_pet.deployment_id.id}\\n"
}
EOF
terraform apply -input=false -auto-approve
cat out/state-report.txt
`,
  // checkout -> setup-node (node-version) -> build -> test, then run both.
  'CICD-003': `
set -e
cat > .github/workflows/ci.yml <<'YAML'
name: CI

on:
  push:
  pull_request:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Check out the repository
        uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'

      - name: Build
        run: node build.mjs

      - name: Test
        run: node --test
YAML
node build.mjs
node --test
`,
  // A Dockerfile, a workflow-level IMAGE_NAME, and an image job that needs
  // build, checks out, and runs docker build -t "$IMAGE_NAME:<sha>".
  'CICD-005': `
set -e
cat > Dockerfile <<'DOCKER'
FROM node:22-alpine
WORKDIR /app
COPY package.json build.mjs ./
COPY src ./src
CMD ["node", "src/cli.mjs"]
DOCKER
cat > .github/workflows/ci.yml <<'YAML'
name: CI

on:
  push:
  pull_request:

env:
  IMAGE_NAME: jumptotech/statements

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Check out the repository
        uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'

      - name: Build
        run: node build.mjs

      - name: Test
        run: node --test

      - name: Upload build output
        uses: actions/upload-artifact@v4
        with:
          name: statements-dist
          path: dist/

  image:
    runs-on: ubuntu-latest
    needs: build
    steps:
      - name: Check out the repository
        uses: actions/checkout@v4

      - name: Build the container image
        run: docker build -t "$IMAGE_NAME:\${{ github.sha }}" .
YAML
node build.mjs
node --test
`,
  // One declarative pipeline, agent any, a Build stage running the build.
  'CICD-006': `
set -e
node build.mjs
cat > Jenkinsfile <<'GROOVY'
pipeline {
    agent any

    stages {
        stage('Build') {
            steps {
                sh 'node build.mjs'
            }
        }
    }
}
GROOVY
`,
  // Checkout, Build, Test, Package in that order; run build and tests.
  'CICD-007': `
set -e
cat > Jenkinsfile <<'GROOVY'
// JumpToTech Bank — statements service
pipeline {
    agent any

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

        stage('Package') {
            steps {
                sh 'ls -l dist'
            }
        }
    }
}
GROOVY
node build.mjs
node --test
ls -l dist
`,
  // push limited to main; build (5 steps) -> image (docker build tagged from
  // workflow-level IMAGE_TAG = github.sha) -> deploy (sed the tag into
  // deploy/app.yml). The manifest itself is left for the pipeline to edit.
  'CICD-009': `
set -e
cat > .github/workflows/ci.yml <<'YAML'
name: CI

on:
  push:
    branches:
      - main
  pull_request:

env:
  IMAGE_TAG: \${{ github.sha }}

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Check out the repository
        uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'

      - name: Build
        run: node build.mjs

      - name: Test
        run: node --test

      - name: Upload build output
        uses: actions/upload-artifact@v4
        with:
          name: statements-dist
          path: dist/

  image:
    runs-on: ubuntu-latest
    needs: build
    steps:
      - name: Check out the repository
        uses: actions/checkout@v4

      - name: Build the container image
        run: docker build -t "jumptotech/statements:$IMAGE_TAG" .

  deploy:
    runs-on: ubuntu-latest
    needs: image
    steps:
      - name: Check out the repository
        uses: actions/checkout@v4

      - name: Point the staging manifest at this image
        run: |
          sed -i "s|^image: .*|image: jumptotech/statements:$IMAGE_TAG|" deploy/app.yml
          grep '^image:' deploy/app.yml
YAML
node build.mjs
node --test
`,
  // The faults: workflow under .github/workflow (moved to workflows), steps
  // over-indented under runs-on, no setup-node step, build.js for build.mjs,
  // artifact path build/ for dist/, APP_VERSION never defined; the Jenkinsfile
  // Build stage is missing its closing brace and there is no Test stage; the
  // "whole amount" test expects '$500' where every other test and the
  // self-check say two minor digits, so the test is corrected, not the code.
  'CICD-010': `
set -e
node --test || true
mkdir -p .github/workflows
mv .github/workflow/ci.yml .github/workflows/ci.yml
rmdir .github/workflow
cat > .github/workflows/ci.yml <<'YAML'
name: CI

on:
  push:

env:
  APP_VERSION: '1.4.1'

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Check out the repository
        uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'

      - name: Build
        run: node build.mjs

      - name: Test
        run: node --test

      - name: Publish the build output
        uses: actions/upload-artifact@v4
        with:
          name: statements-\${{ env.APP_VERSION }}
          path: dist/
YAML
cat > Jenkinsfile <<'GROOVY'
// JumpToTech Bank — statements service
pipeline {
    agent any

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

        stage('Package') {
            steps {
                sh 'ls -l dist'
            }
        }
    }
}
GROOVY
sed -i '/renders a whole amount/,/});/s/\\$500/$500.00/' test/statements.test.mjs
grep -n "500_00" test/statements.test.mjs
node build.mjs
node --test
ls -l dist/statements.bundle.js
`,
  // One play on web, two tasks (file directory + copy content); run twice so
  // the second recap shows changed=0.
  'ANSIBLE-003': `
set -e
cat > site.yml <<'YAML'
---
- name: Prepare the ledger application
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
          environment=staging
YAML
ansible-playbook --syntax-check site.yml
ansible-playbook site.yml
ansible-playbook site.yml
`,
  // One file task looping over app_directories; the lock gated on
  // node_role == "primary" (owner from inventory_hostname, never a node1
  // comparison) and removed where the role is not primary; release.txt from
  // app_release on every host.
  'ANSIBLE-005': `
set -e
cat > site.yml <<'YAML'
---
- name: Lay out the ledger service
  hosts: web
  tasks:
    - name: Create the application directories
      ansible.builtin.file:
        path: "/opt/jumptotech/{{ item }}"
        state: directory
        mode: "0755"
      loop: "{{ app_directories }}"

    - name: Place the scheduler lock on the primary
      ansible.builtin.copy:
        dest: /etc/jumptotech/scheduler.lock
        mode: "0644"
        content: |
          owner={{ inventory_hostname }}
      when: node_role == "primary"

    - name: Make sure no other node holds the scheduler lock
      ansible.builtin.file:
        path: /etc/jumptotech/scheduler.lock
        state: absent
      when: node_role != "primary"

    - name: Record the deployed release
      ansible.builtin.copy:
        dest: /etc/jumptotech/release.txt
        mode: "0644"
        content: |
          release={{ app_release }}
YAML
ansible-playbook --syntax-check site.yml
ansible-playbook site.yml
ansible-playbook site.yml
`,
  // templates/app.conf.j2 renders every value from group_vars/host_vars and
  // inventory_hostname (not the container's fact hostname); site.yml deploys
  // it with ansible.builtin.template.
  'ANSIBLE-007': `
set -e
mkdir -p templates
cat > templates/app.conf.j2 <<'J2'
# Managed by Ansible. Local edits will be overwritten on the next run.
app_name={{ app_name }}
app_port={{ app_port }}
app_release={{ app_release }}
app_workers={{ app_workers }}
node_role={{ node_role }}
served_by={{ inventory_hostname }}
J2
cat > site.yml <<'YAML'
---
- name: Configure the ledger service
  hosts: web
  tasks:
    - name: Deploy the application configuration
      ansible.builtin.template:
        src: app.conf.j2
        dest: /etc/jumptotech/app.conf
        mode: "0644"
YAML
ansible-playbook --syntax-check site.yml
ansible-playbook site.yml
ansible-playbook site.yml
`,
  // Move the three tasks, the reload handler and the template into roles/web,
  // add defaults, drop the dead top-level templates/, and reduce site.yml to
  // roles: [web] (no tasks:/handlers: text anywhere in it, comments included).
  'ANSIBLE-008': `
set -e
mkdir -p roles/web/tasks roles/web/handlers roles/web/templates roles/web/defaults
mv templates/app.conf.j2 roles/web/templates/app.conf.j2
rmdir templates
cat > roles/web/tasks/main.yml <<'YAML'
---
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

- name: Deploy the application configuration
  ansible.builtin.template:
    src: app.conf.j2
    dest: /etc/jumptotech/app.conf
    mode: "0644"
  notify: reload ledger
YAML
cat > roles/web/handlers/main.yml <<'YAML'
---
- name: reload ledger
  ansible.builtin.copy:
    dest: /var/log/jumptotech/reload.log
    mode: "0644"
    content: |
      reloaded ledger
YAML
cat > roles/web/defaults/main.yml <<'YAML'
---
app_name: ledger
app_port: 8080
app_release: "0.0.0"
YAML
cat > site.yml <<'YAML'
---
- name: Configure the ledger service
  hosts: web
  roles:
    - web
YAML
ansible-playbook --syntax-check site.yml
ansible-playbook site.yml
ansible-playbook site.yml
`,
  // Status page from a template (shared values + inventory_hostname); nginx
  // probed with pgrep (changed_when/failed_when false, registered) and started
  // only when the probe found nothing, so the second run changes nothing.
  'ANSIBLE-009': `
set -e
mkdir -p templates
cat > templates/index.html.j2 <<'J2'
service={{ app_name }}
release={{ app_release }}
node={{ inventory_hostname }}
J2
cat > site.yml <<'YAML'
---
- name: Deploy the ledger status page
  hosts: web
  tasks:
    - name: Ensure the status document root exists
      ansible.builtin.file:
        path: "{{ status_root }}"
        state: directory
        mode: "0755"

    - name: Render the status page
      ansible.builtin.template:
        src: index.html.j2
        dest: "{{ status_root }}/index.html"
        mode: "0644"

    - name: Is nginx already running?
      ansible.builtin.command: pgrep -x nginx
      register: nginx_ps
      changed_when: false
      failed_when: false

    - name: Start nginx
      ansible.builtin.command: nginx
      when: nginx_ps.rc != 0
YAML
ansible-playbook --syntax-check site.yml
ansible-playbook site.yml
ansible-playbook site.yml
ansible web -m command -a "pgrep -x nginx"
`,
  // Seven faults, found with the read-only tools in order: group_vars
  // indentation and the app_prt misspelling; ansible_user=deploy (the nodes
  // only admit root); hosts: web vs the webservers group (the group_vars file
  // is named for webservers, so the play moves, not the group); state:
  // directoy; the template src naming a file that does not exist; notify
  // naming a handler that does not exist.
  'ANSIBLE-010': `
set -e
cat > group_vars/webservers.yml <<'YAML'
---
app_name: ledger
app_port: 9090
app_release: "2.4.1"
YAML
ansible-inventory --list >/dev/null
cat > inventory.ini <<'INI'
# Inherited from a colleague who has since left the team.
[webservers]
node1
node2
INI
ansible all -m ping
sed -i \
  -e 's/^  hosts: web$/  hosts: webservers/' \
  -e 's/state: directoy$/state: directory/' \
  -e 's/src: app.conf.j2$/src: app.conf.jinja/' \
  -e 's/notify: reload app$/notify: reload ledger/' \
  site.yml
grep -q '^  hosts: webservers$' site.yml
grep -q 'src: app.conf.jinja$' site.yml
grep -q 'notify: reload ledger$' site.yml
if grep -q directoy site.yml; then exit 1; fi
ansible-playbook --syntax-check site.yml
ansible-playbook site.yml
ansible-playbook site.yml
`,
  // The same moves sandbox-integration makes, graded here with Reset after.
  'LINUX-001': `
set -e
mkdir -p project/archive
touch project/app.log project/config.txt
mv project/app.log project/archive/app.log
`,
  // Exact modes on the two files the audit flagged, and a private token.
  'LINUX-002': `
set -e
chmod 640 /srv/jumptotech/reports/daily-balance.csv
chmod 750 /srv/jumptotech/reports/collect-balances.sh
mkdir -p /home/student/secure
printf 'token-chosen-by-the-student\\n' > /home/student/secure/api-token.txt
chmod 600 /home/student/secure/api-token.txt
`,
  // Account management through sudo, which the lab grants.
  'LINUX-003': `
set -e
sudo groupadd deployers
sudo useradd --create-home ci-runner
sudo usermod -aG deployers ci-runner
sudo usermod -aG deployers student
sudo install -d -g deployers -m 0770 /srv/jumptotech/deploy
id student | grep -q deployers
`,
  // The configuration and workflow sandbox-integration uses for TF-001.
  'TF-001': `
set -e
cd terraform
cat > main.tf <<'HCL'
resource "local_file" "manifest" {
  filename = "build/manifest.txt"
  content  = "service=ledger-api\\nenvironment=lab\\n"
}

output "manifest_path" {
  value = "build/manifest.txt"
}
HCL
terraform init -no-color -input=false
terraform plan -no-color -input=false
terraform apply -auto-approve -no-color -input=false
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
    k8s: new KubernetesClient({ context: config.kubeContext }),
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
