/**
 * Shipped Docker labs, graded against the state a student leaves behind.
 *
 * `docker-requirements.test.ts` proves what each requirement type does; this
 * proves what each *lab* accepts. Every case starts from the lab's own setup,
 * applied by the real provider, then makes the changes a student would.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SESSION_POLICY,
  DockerLabProvider,
  InMemoryWorkspace,
  type LoadedLabDefinition,
} from '@jumptotech/lab-orchestrator';
import { FakeDockerEngines } from '@jumptotech/lab-orchestrator/testing';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';
import { verifyLab } from '../src/index.js';

const SANDBOX = 'jtt-lab-0000000000aa';
const SESSION = 'sess-000000000000000a';

async function started(labId: string) {
  const registry = await realCatalog();
  const lab = registry.get(labId);
  const engines = new FakeDockerEngines({ images: ['docker:27-dind'] });
  const workspace = new InMemoryWorkspace();
  const provider = new DockerLabProvider({ engines, workspace, sleep: async () => undefined });
  const created = await provider.create({
    sessionId: SESSION,
    labId: lab.id,
    sandboxRef: SANDBOX,
    namespace: SANDBOX,
    serviceAccountName: DEFAULT_SESSION_POLICY.serviceAccountName,
    lab,
    expiresAtMs: Date.now() + 60 * 60_000,
    policy: DEFAULT_SESSION_POLICY,
  });
  expect(created.ok).toBe(true);
  return { lab, workspace, daemon: engines.daemon(SANDBOX) };
}

async function grade({ lab, workspace, daemon }: Awaited<ReturnType<typeof started>> & { lab: LoadedLabDefinition }) {
  const result = await verifyLab({
    lab,
    namespace: SANDBOX,
    docker: daemon,
    workspace: { port: workspace, sessionId: SESSION },
  });
  expect(result.error).toBeUndefined();
  return result.checks.filter((c) => c.status !== 'pass').map((c) => c.label);
}

// ---------------------------------------------------------------- DOCKER-004

describe('DOCKER-004 — build an image from a Dockerfile', () => {
  const DOCKERFILE =
    'FROM alpine:3.20\nWORKDIR /app\nCOPY message.txt .\nRUN cp message.txt banner.txt\nCMD ["cat", "/app/banner.txt"]\n';

  async function built(runImage: string) {
    const lab = await started('DOCKER-004');
    await lab.workspace.seed(SESSION, [{ path: 'Dockerfile', content: DOCKERFILE }]);
    lab.daemon.addImage('jumptotech/greeter:1.0', { workingDir: '/app', cmd: ['cat', '/app/banner.txt'] });
    lab.daemon.addContainer({ name: 'greeter', image: runImage, detach: false }, 'exited', 0);
    return lab;
  }

  it('passes the built image, run to completion, holding the banner the RUN step made', async () => {
    const lab = await built('jumptotech/greeter:1.0');
    lab.daemon.putFile('greeter', '/app/banner.txt', '*** JumpToTech Bank ***\n');
    expect(await grade(lab)).toEqual([]);
  });

  it('fails a greeter container run from some other image', async () => {
    // Before: `docker run --name greeter alpine:3.20 true` satisfied both
    // container checks, so the image the lab is about never had to run.
    const lab = await built('alpine:3.20');
    lab.daemon.putFile('greeter', '/app/banner.txt', 'x\n');
    expect(await grade(lab)).toEqual(['Container greeter runs the image you built']);
  });

  it('fails an image whose CMD does nothing, and accepts the shell form', async () => {
    const quiet = await started('DOCKER-004');
    await quiet.workspace.seed(SESSION, [{ path: 'Dockerfile', content: DOCKERFILE.replace('CMD ["cat", "/app/banner.txt"]', 'CMD ["true"]') }]);
    quiet.daemon.addImage('jumptotech/greeter:1.0', { workingDir: '/app', cmd: ['true'] });
    quiet.daemon.addContainer({ name: 'greeter', image: 'jumptotech/greeter:1.0', detach: false }, 'exited', 0);
    quiet.daemon.putFile('greeter', '/app/banner.txt', 'x\n');
    expect(await grade(quiet)).toEqual(['The image starts by printing the banner']);

    const shell = await started('DOCKER-004');
    await shell.workspace.seed(SESSION, [{ path: 'Dockerfile', content: DOCKERFILE }]);
    shell.daemon.addImage('jumptotech/greeter:1.0', { workingDir: '/app', cmd: ['/bin/sh', '-c', 'cat /app/banner.txt'] });
    shell.daemon.addContainer({ name: 'greeter', image: 'jumptotech/greeter:1.0', detach: false }, 'exited', 0);
    shell.daemon.putFile('greeter', '/app/banner.txt', 'x\n');
    expect(await grade(shell)).toEqual([]);
  });

  it('fails an image whose build never produced the banner', async () => {
    const lab = await built('jumptotech/greeter:1.0');
    expect(await grade(lab)).toEqual(['The image contains the banner the RUN step produced']);
  });
});

// ------------------------------------------------------------------ NET-022

describe('NET-022 — the recreated container keeps the deployment command', () => {
  const COMMAND = [
    'sh',
    '-c',
    "sed -i 's/listen       80;/listen       8080;/' /etc/nginx/conf.d/default.conf && exec nginx -g 'daemon off;'",
  ];
  const DIAGNOSIS = 'port: 8080\n';
  const MODEL = 'mapping: 3000 -> 8080\ncarried_by: DNAT\n';

  async function recreated(options: { command?: string[]; config: string }) {
    const lab = await started('NET-022');
    await lab.workspace.seed(SESSION, [
      { path: 'diagnosis.txt', content: DIAGNOSIS },
      { path: 'model.txt', content: MODEL },
    ]);
    await lab.daemon.removeContainer('payments-status');
    await lab.daemon.runContainer({
      name: 'payments-status',
      image: 'nginx:1.27-alpine',
      detach: true,
      ...(options.command ? { command: options.command } : {}),
      ports: [{ containerPort: 8080, hostPort: 3000 }],
    });
    lab.daemon.putFile('payments-status', '/etc/nginx/conf.d/default.conf', options.config);
    return lab;
  }

  it('passes the container recreated with the corrected mapping and the same command', async () => {
    const lab = await recreated({ command: COMMAND, config: 'server {\n    listen       8080;\n}\n' });
    expect(await grade(lab)).toEqual([]);
  });

  it('fails the container recreated without the command, whose nginx is back on port 80', async () => {
    // The mapping now points at 8080, and nothing listens there.
    const lab = await recreated({ config: 'server {\n    listen       80;\n}\n' });
    expect(await grade(lab)).toEqual([
      'The recreated container still configures the application the way the deployment did',
    ]);
  });
});

// ------------------------------------------------ first-Check disclosure

describe('the first Check does not hand over a diagnosis', () => {
  async function details(labId: string) {
    const lab = await started(labId);
    const result = await verifyLab({
      lab: lab.lab,
      namespace: SANDBOX,
      docker: lab.daemon,
      workspace: { port: lab.workspace, sessionId: SESSION },
    });
    return result.checks.map((c) => `${c.label} ${c.detail ?? ''}`).join('\n');
  }

  it('DOCKER-011 never names the region the API should run in', async () => {
    // The task has the student find it in /etc/statements/regions.conf.
    const text = await details('DOCKER-011');
    expect(text).toContain('us-east-1');
    expect(text).not.toContain('eu-west-1');
  });

  it('NET-022 never names the port the application listens on', async () => {
    const text = await details('NET-022');
    expect(text).not.toMatch(/\b8080\b/);
  });
});
