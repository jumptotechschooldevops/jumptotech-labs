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

  it('fails an image whose build never produced the banner', async () => {
    const lab = await built('jumptotech/greeter:1.0');
    expect(await grade(lab)).toEqual(['The image contains the banner the RUN step produced']);
  });
});
