/**
 * No Docker lab passes on the daemon it hands the student.
 *
 * A Docker lab's starting state is its `setup.docker` block: images, networks,
 * volumes, workspace files and containers left running, exited or merely
 * created. This applies that block with the real provider — the same
 * `DockerLabProvider.create` a student's Start Lab runs — against the fake
 * engines, and then runs Verify on the result.
 *
 * What the fake cannot decide, and how the test stays honest about it: a fake
 * container has no filesystem and runs no program, so it cannot say what a
 * file inside it holds, what a process exited with, or whether the kernel
 * killed it. A check of that kind failing here proves nothing. So every lab
 * must fail at least one check whose verdict depends only on what the setup
 * *declares* — which containers exist, their image, ports, environment,
 * networks, mounts and limits, the images and objects in the daemon, and the
 * files in the workspace. That failure would happen on a real daemon too.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SESSION_POLICY,
  DockerLabProvider,
  InMemoryWorkspace,
  type LabSessionContext,
  type LoadedLabDefinition,
  type Requirement,
} from '@jumptotech/lab-orchestrator';
import { FakeDockerEngines } from '@jumptotech/lab-orchestrator/testing';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';
import { verifyLab } from '../src/index.js';

const SANDBOX = 'jtt-lab-0000000000aa';
const SESSION = 'sess-000000000000000a';

/** Checks whose verdict depends on a program actually running. */
const DECIDED_BY_THE_RUNTIME = new Set([
  'docker_container_file_content',
  'docker_container_exit_code',
  'docker_container_oom_killed',
]);

function contextFor(lab: LoadedLabDefinition): LabSessionContext {
  return {
    sessionId: SESSION,
    labId: lab.id,
    sandboxRef: SANDBOX,
    namespace: SANDBOX,
    serviceAccountName: DEFAULT_SESSION_POLICY.serviceAccountName,
    lab,
    expiresAtMs: Date.now() + 60 * 60_000,
    policy: DEFAULT_SESSION_POLICY,
  };
}

/** Start the lab exactly as a student would. */
async function startLab(lab: LoadedLabDefinition) {
  const engines = new FakeDockerEngines({ images: ['docker:27-dind'] });
  const workspace = new InMemoryWorkspace();
  const provider = new DockerLabProvider({ engines, workspace, sleep: async () => undefined });

  const created = await provider.create(contextFor(lab));
  expect(created.ok, `${lab.id} could not be started: ${JSON.stringify(created.steps)}`).toBe(true);
  return { engines, workspace };
}

/** Press Verify against a started lab. */
function verify(lab: LoadedLabDefinition, { engines, workspace }: Awaited<ReturnType<typeof startLab>>) {
  return verifyLab({
    lab,
    namespace: SANDBOX,
    docker: engines.session(SANDBOX),
    workspace: { port: workspace, sessionId: SESSION },
  });
}

describe('the starting state of every Docker lab', () => {
  it('covers every Docker-provider lab', async () => {
    const registry = await realCatalog();
    const labs = registry.all().filter((lab) => lab.environment.provider === 'docker');
    // The fourteen Docker labs and NET-022; a lab can only be added, never skipped.
    expect(labs.length).toBeGreaterThanOrEqual(15);
  });

  it('fails a check the setup alone decides, before the student has done anything', async () => {
    const registry = await realCatalog();
    const passesAtStart: string[] = [];

    for (const lab of registry.all().filter((l) => l.environment.provider === 'docker')) {
      const result = await verify(lab, await startLab(lab));
      expect(result.error, `${lab.id} could not be verified`).toBeUndefined();

      const requirements = lab.requirements as readonly Requirement[];
      const decisiveFailures = result.checks.filter(
        (check, index) =>
          check.status !== 'pass' && !DECIDED_BY_THE_RUNTIME.has(requirements[index]!.type),
      );
      if (process.env.STARTER_STATE_DEBUG) {
        console.log(lab.id, decisiveFailures.map((c) => `${c.label}: ${c.detail}`));
      }
      if (decisiveFailures.length === 0) passesAtStart.push(lab.id);
    }

    expect(passesAtStart, 'these labs fail at start only on checks the fake cannot decide, if at all').toEqual([]);
  });

  it('can say pass: the model is not failing labs for reasons of its own', async () => {
    const registry = await realCatalog();
    const lab = registry.get('DOCKER-001');
    const started = await startLab(lab);
    await started.engines.session(SANDBOX).runContainer({ name: 'web', image: 'nginx:1.27-alpine', detach: true });

    const result = await verify(lab, started);
    expect(result.checks.filter((c) => c.status !== 'pass')).toEqual([]);
    expect(result.passed).toBe(true);
  });
});
