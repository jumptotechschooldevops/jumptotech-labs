/**
 * Every Docker-track lab, started on a real docker:27-dind sandbox.
 *
 * The docker0NN suites walk DOCKER-009 … 014 to a PASS and the core suite a few
 * more; this asks every lab whose provider is `docker` the questions a student's
 * first minutes ask:
 *
 *   1. **Start** succeeds: the sandbox daemon comes up, the lab's images,
 *      containers and workspace files are seeded, and its setup verification
 *      holds.
 *   2. **Check** before any work does not pass: the lab does not begin solved.
 *   3. **Reset** succeeds, and the Check that follows grades exactly as the
 *      first one did.
 *   4. **End Lab** removes the sandbox and its data volume.
 *
 * Labs in `SOLUTIONS` are also solved between 2 and 3, to every check green.
 *
 * Both Checks are read once the grades stop changing — a seeded container can
 * still be starting when setup verification accepts it.
 *
 * Sequential, one sandbox at a time: each is a privileged dind daemon, and
 * several at once on a two-core runner measures the runner.
 *
 * SAFETY: every object carries this run's random token and every removal goes
 * through `owned()`, exactly as in the other Docker suites.
 *
 *   RUN_DOCKER_INTEGRATION_TESTS=1 \
 *     npx vitest run test/docker-catalog-sweep-integration.test.ts --root services/lab-orchestrator
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_SESSION_POLICY,
  DockerCliFactory,
  DockerLabProvider,
  type LabRegistry,
  type LabSessionContext,
  type SessionPolicy,
  type WorkspaceFile,
  type WorkspacePort,
} from '../src/index.js';
import { verifyLab, waitForRequirements } from '@jumptotech/verifier';
import { realCatalog } from './real-catalog.js';

const execFileAsync = promisify(execFile);
const ENABLED = process.env.RUN_DOCKER_INTEGRATION_TESTS === '1';

if (!ENABLED) {
  // eslint-disable-next-line no-console
  console.log('[docker-catalog-sweep] skipped — set RUN_DOCKER_INTEGRATION_TESTS=1');
}

const RUN = randomBytes(4).toString('hex');
const TEST_NETWORK = `jtt-itcat-${RUN}-net`;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function owned(name: string): string {
  if (!name.includes(RUN)) {
    throw new Error(`refusing to remove '${name}': not created by this run (${RUN})`);
  }
  return name;
}

const POLICY: SessionPolicy = {
  ...DEFAULT_SESSION_POLICY,
  docker: {
    ...DEFAULT_SESSION_POLICY.docker,
    network: TEST_NETWORK,
    memory: '1g',
    cpus: '1',
    pidsLimit: 256,
    readyTimeoutSeconds: 240,
  },
};

async function docker(...args: string[]) {
  try {
    const { stdout, stderr } = await execFileAsync('docker', args, {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/tmp' },
      timeout: 600_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

/** The student's workspace, as the terminal service keeps it, on local disk. */
class TempDirWorkspace implements WorkspacePort {
  constructor(private readonly root: string) {}
  #dir(sessionId: string): string {
    return path.join(this.root, sessionId.replace(/[^a-zA-Z0-9_-]/g, ''));
  }
  async seed(sessionId: string, files: readonly WorkspaceFile[]): Promise<void> {
    const dir = this.#dir(sessionId);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true, mode: 0o700 });
    for (const file of files) {
      const target = path.join(dir, file.path);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, file.content, { mode: 0o600 });
    }
  }
  async read(sessionId: string, filePath: string): Promise<string | null> {
    try {
      return await readFile(path.join(this.#dir(sessionId), filePath), 'utf8');
    } catch {
      return null;
    }
  }
  async destroy(sessionId: string): Promise<void> {
    await rm(this.#dir(sessionId), { recursive: true, force: true });
  }
}

/** Docker-provider lab ids, read from disk so a new lab joins the sweep by existing. */
const CATALOG: LabRegistry = await realCatalog();
const LAB_IDS = CATALOG.all()
  .filter((lab) => lab.environment.provider === 'docker')
  .map((lab) => lab.id)
  .sort();

const DOCKER_008_COMPOSE = `services:
  api:
    image: nginx:1.27-alpine
    container_name: ledger-api
    networks:
      - ledger-net
  worker:
    image: alpine:3.20
    container_name: ledger-worker
    command: ["sleep", "infinity"]
    environment:
      LEDGER_API_URL: http://ledger-api
    networks:
      - ledger-net
networks:
  ledger-net:
    name: ledger-net
    driver: bridge
`;

/**
 * What a student does to solve a lab, for the labs this sweep walks to a PASS
 * (DOCKER-009 … 014 are solved in their own suites).
 *
 * `daemon` runs inside the session's sandbox with its own Docker CLI — the
 * same daemon the student's terminal drives over mTLS. `workspace` is what the
 * student writes into their workspace files. Test code only.
 */
const SOLUTIONS: Record<string, { daemon?: string; workspace?: Record<string, string> }> = {
  'DOCKER-002': {
    daemon: `
set -e
docker start ledger-api
docker rm -f stale-worker
docker run --name audit-log alpine:3.20 echo audit complete
`,
  },
  // Two names for one image. Reset must then remove both, or the retry
  // starts half solved (#73).
  'DOCKER-003': {
    daemon: `
set -e
docker pull busybox:1.36
docker tag busybox:1.36 jumptotech/toolbox:1.0
docker image inspect busybox:1.36 >/dev/null
`,
  },
  'DOCKER-005': {
    daemon: `
set -e
docker volume create ledger-data
docker run -d --name ledger-db -v ledger-data:/var/lib/ledger alpine:3.20 sleep 3600
`,
  },
  // The env file lives with the student's CLI; here that is the sandbox.
  'DOCKER-007': {
    daemon: `
set -e
printf 'LEDGER_BATCH_SIZE=500\n' > /tmp/statements.env
docker run -d --name statements -e LEDGER_REGION=eu-west-1 -e LEDGER_MODE=batch --env-file /tmp/statements.env alpine:3.20 sleep 3600
`,
  },
  // The Dockerfile is the student's workspace file and the build context the
  // CLI sends; here the context is written inside the sandbox as well.
  'DOCKER-004': {
    daemon: `
set -e
mkdir -p /tmp/greeter
cat > /tmp/greeter/message.txt <<'TXT'
JumpToTech Bank — internal platform services
Environment: lab
Support: platform-team@jumptotech.invalid
TXT
cat > /tmp/greeter/Dockerfile <<'DOCKERFILE'
FROM alpine:3.20
WORKDIR /app
COPY message.txt .
RUN cp message.txt banner.txt
CMD ["cat", "/app/banner.txt"]
DOCKERFILE
docker build -t jumptotech/greeter:1.0 /tmp/greeter
docker run --name greeter jumptotech/greeter:1.0
`,
    workspace: {
      Dockerfile:
        'FROM alpine:3.20\nWORKDIR /app\nCOPY message.txt .\nRUN cp message.txt banner.txt\nCMD ["cat", "/app/banner.txt"]\n',
    },
  },
  'DOCKER-006': {
    daemon: `
set -e
docker network create --driver bridge ledger-net
docker run -d --name ledger-api --network ledger-net nginx:1.27-alpine
docker run -d --name ledger-worker --network ledger-net alpine:3.20 sleep 3600
for i in 1 2 3 4 5 6 7 8 9 10; do docker exec ledger-worker wget -qO- http://ledger-api >/dev/null && break; sleep 1; done
`,
  },
  // The worker added to the student's compose.yaml, and the stack brought up
  // by Compose — the check reads Compose's own service labels.
  'DOCKER-008': {
    daemon: `
set -e
mkdir -p /tmp/stack
cat > /tmp/stack/compose.yaml <<'YAML'
${DOCKER_008_COMPOSE}YAML
docker compose -f /tmp/stack/compose.yaml up -d
docker compose -f /tmp/stack/compose.yaml ps
`,
    workspace: { 'compose.yaml': DOCKER_008_COMPOSE },
  },
  // Same name, image and command; only the container side of 3000 changes.
  'NET-022': {
    daemon: `
set -e
docker rm -f payments-status
docker run -d --name payments-status -p 3000:8080 nginx:1.27-alpine sh -c "sed -i 's/listen       80;/listen       8080;/' /etc/nginx/conf.d/default.conf && exec nginx -g 'daemon off;'"
`,
    workspace: {
      'diagnosis.txt':
        'mapping_sends_traffic_to_container_port: 80\n' +
        'application_is_listening_on_port: 8080\n' +
        'why_the_request_fails: host port 3000 is published to container port 80, where nothing listens\n',
      'model.txt':
        'The daemon installs a DNAT rule on the Docker host: a packet to host port 3000 is rewritten to the ' +
        "container's address and port 8080, the port nginx listens on after the repair.\n",
    },
  },
};

describe.runIf(ENABLED)('every Docker-track lab on a real dind sandbox', () => {
  const engines = new DockerCliFactory({});
  const sandboxes: string[] = [];
  let workspaceRoot: string;
  let workspace: TempDirWorkspace;

  beforeAll(async () => {
    workspaceRoot = await mkdtemp(path.join(tmpdir(), `jtt-itcat-${RUN}-`));
    workspace = new TempDirWorkspace(workspaceRoot);
    const pull = await docker('image', 'pull', POLICY.docker.image);
    expect(pull.code, pull.stderr).toBe(0);
  }, 900_000);

  afterAll(async () => {
    for (const sandbox of sandboxes) {
      await docker('rm', '--force', '--volumes', owned(sandbox));
      await docker('volume', 'rm', '--force', owned(DockerLabProvider.dataVolume(sandbox)));
    }
    await docker('network', 'rm', owned(TEST_NETWORK));
    if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
  }, 600_000);

  it.each(LAB_IDS)(
    '%s starts, does not begin solved, resets to its start, and ends',
    async (labId) => {
      const lab = CATALOG.get(labId);
      const tag = randomBytes(2).toString('hex');
      const sandbox = `jtt-lab-${RUN}${tag}`;
      const sessionId = `sess-${randomBytes(8).toString('hex')}`;
      sandboxes.push(sandbox);

      const provider = new DockerLabProvider({
        engines,
        workspace,
        hostName: 'integration-catalog',
        waitForRequirements: (input) =>
          waitForRequirements({
            docker: engines.session(input.namespace),
            workspace: { port: workspace, sessionId },
            ...input,
          }),
      });
      const context: LabSessionContext = {
        sessionId,
        labId,
        namespace: sandbox,
        serviceAccountName: POLICY.serviceAccountName,
        lab,
        expiresAtMs: Date.now() + 60 * 60_000,
        policy: POLICY,
      };
      const grades = async () => {
        const result = await verifyLab({
          lab,
          namespace: sandbox,
          docker: engines.session(sandbox),
          workspace: { port: workspace, sessionId },
        });
        return {
          passed: result.passed,
          byLabel: Object.fromEntries(result.checks.map((c) => [c.label, c.status])),
        };
      };
      /** Grades once two reads five seconds apart agree, or after a minute. */
      const settled = async () => {
        const deadline = Date.now() + 60_000;
        let previous = await grades();
        for (;;) {
          await sleep(5_000);
          const current = await grades();
          if (JSON.stringify(current) === JSON.stringify(previous) || Date.now() > deadline) return current;
          previous = current;
        }
      };

      // 1. Start — retrying only a registry hiccup, as the per-lab suites do:
      //    every sandbox has its own image store and pulls from Docker Hub.
      let created = await provider.create(context);
      for (let attempt = 1; attempt < 3 && !created.ok; attempt += 1) {
        if (!/could not obtain image|timeout|TLS handshake|i\/o timeout/i.test(created.error?.message ?? '')) break;
        await provider.destroy(context);
        await sleep(5_000 * attempt);
        created = await provider.create(context);
      }
      expect(created.error?.message ?? '', JSON.stringify(created.steps)).toBe('');
      expect(created.ok).toBe(true);

      try {
        // 2. Check before any work.
        const initial = await settled();
        expect(Object.keys(initial.byLabel).length).toBeGreaterThan(0);
        expect(initial.passed, `${labId} passes its Check before any work`).toBe(false);

        // 3. Where the sweep knows a solution: solve it, and every check passes.
        const solution = SOLUTIONS[labId];
        if (solution) {
          if (solution.daemon) {
            const solved = await docker('exec', sandbox, 'sh', '-c', solution.daemon);
            expect(solved.code, `${labId} solution: ${solved.stdout}\n${solved.stderr}`).toBe(0);
          }
          for (const [file, content] of Object.entries(solution.workspace ?? {})) {
            await writeFile(path.join(workspaceRoot, sessionId.replace(/[^a-zA-Z0-9_-]/g, ''), file), content);
          }
          const solvedGrades = await settled();
          expect(
            Object.entries(solvedGrades.byLabel).filter(([, status]) => status !== 'pass'),
            `${labId} solved`,
          ).toEqual([]);
        }

        // 4. Reset, then the same grades as at Start — solved or not.
        const reset = await provider.reset(context);
        expect(reset.ok, JSON.stringify(reset.steps)).toBe(true);
        const after = await settled();
        expect(after.byLabel).toEqual(initial.byLabel);
      } finally {
        // 5. End Lab.
        await provider.destroy(context);
      }
      const left = await docker('ps', '-a', '--filter', `name=^${sandbox}$`, '--format', '{{.Names}}');
      expect(left.stdout.trim(), `${labId} sandbox left behind`).toBe('');
      const volume = await docker('volume', 'ls', '--filter', `name=^${DockerLabProvider.dataVolume(sandbox)}$`, '--format', '{{.Name}}');
      expect(volume.stdout.trim(), `${labId} data volume left behind`).toBe('');
    },
    1_200_000,
  );
});
