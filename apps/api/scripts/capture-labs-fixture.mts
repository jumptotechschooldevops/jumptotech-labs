/**
 * Regenerate apps/web/test/fixtures/labs.json from GET /api/labs.
 *
 * Uses the same composition root as production (buildProviderRegistry) with
 * faked substrates so no cluster or daemon is required. Docker is enabled
 * (DOCKER_TRACK_ENABLED=true, the loadConfig default) and the host engine
 * fake answers `version()`, matching a deployment where the track is on and the
 * daemon is reachable.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import {
  InMemorySessionStore,
  KindLabProvider,
  LabRegistry,
  SessionManager,
} from '@jumptotech/lab-orchestrator';
import { FakeKubernetes } from '@jumptotech/lab-orchestrator/testing';
import { FakeContainerRuntime } from '@jumptotech/lab-orchestrator/testing/containers';
import { FakeDockerEngines } from '../../../services/lab-orchestrator/test/docker-fakes.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { buildProviderRegistry } from '../src/providers.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SECRET = 'fixture-capture-secret';

async function main(): Promise<void> {
  const registry = new LabRegistry(path.join(repoRoot, 'labs'));
  await registry.load();
  if (registry.loadErrors.length > 0) {
    throw new Error(`lab load errors:\n${registry.loadErrors.join('\n')}`);
  }

  const config = loadConfig({
    TERMINAL_SESSION_SECRET: SECRET,
    INTERNAL_SERVICE_SECRET: SECRET,
    LABS_DIR: path.join(repoRoot, 'labs'),
    ALLOWED_ORIGINS: 'http://localhost:3000',
  } as NodeJS.ProcessEnv);

  const k8s = new FakeKubernetes();
  const kubernetes = new KindLabProvider({
    k8s,
    clusterName: 'jumptotech-labs',
    resetDrainTimeoutMs: 2_000,
    destroyTimeoutMs: 2_000,
    sleep: async () => undefined,
    waitForRequirements: async () => ({ ok: true, checks: [] }),
  });
  kubernetes.execute = async () => ({
    exitCode: 0,
    stdout: JSON.stringify({ clientVersion: { gitVersion: 'v1.34.2' } }),
    stderr: '',
    timedOut: false,
  });

  const engines = new FakeDockerEngines({ images: [config.policy.docker.image] });
  const providers = buildProviderRegistry({
    config,
    kubernetes,
    containerRuntime: new FakeContainerRuntime(),
    engines,
  });

  const sessions = new SessionManager({
    registry,
    providers,
    store: new InMemorySessionStore(),
    policy: config.policy,
    lifetimes: config.lifetimes,
    namespaceSecret: SECRET,
  });

  const app = createApp({ registry, sessions, k8s, engines, config });
  const res = await request(app).get('/api/labs');
  if (res.status !== 200 || !res.body.ok) {
    throw new Error(`GET /api/labs failed: ${JSON.stringify(res.body)}`);
  }

  const out = path.join(repoRoot, 'apps/web/test/fixtures/labs.json');
  fs.writeFileSync(out, `${JSON.stringify(res.body.data, null, 2)}\n`);
  console.log(`wrote ${out} (${res.body.data.count} labs, ${res.body.data.tracks.length} tracks)`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
