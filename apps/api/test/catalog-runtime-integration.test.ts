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
