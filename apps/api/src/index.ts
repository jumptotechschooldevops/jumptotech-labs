import {
  KubernetesClient,
  LabRegistry,
  createLabProvider,
} from '@jumptotech/lab-orchestrator';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { InMemoryLabSessionStore } from './session-store.js';

async function main(): Promise<void> {
  const config = loadConfig();

  if (process.getuid?.() === 0) {
    console.warn(
      '[api] WARNING: running as root. The provided container images run as the non-root `node` user; see README → Security.',
    );
  }

  const registry = new LabRegistry(config.labsDir);
  await registry.load();
  if (registry.loadErrors.length > 0) {
    console.warn('[api] lab definition problems:');
    for (const err of registry.loadErrors) console.warn(`  - ${err}`);
  }
  if (registry.size === 0) {
    console.error(`[api] No labs loaded from ${config.labsDir}. Check LABS_DIR.`);
  }

  const k8s = new KubernetesClient(
    config.kubeconfigPath ? { kubeconfigPath: config.kubeconfigPath } : {},
  );
  const provider = createLabProvider({
    provider: config.provider,
    clusterName: config.clusterName,
    ...(config.kubeconfigPath ? { kubeconfigPath: config.kubeconfigPath } : {}),
    k8s,
  });

  const app = createApp({
    registry,
    provider,
    k8s,
    sessions: new InMemoryLabSessionStore(),
    config,
  });

  app.listen(config.port, '0.0.0.0', () => {
    console.log(`[api] listening on :${config.port}`);
    console.log(`[api] provider=${provider.name} cluster=${config.clusterName}`);
    console.log(`[api] labs=${registry.size} from ${config.labsDir}`);
    console.log(`[api] kubernetes=${k8s.serverUrl}`);
  });
}

main().catch((error: unknown) => {
  console.error('[api] failed to start:', error instanceof Error ? error.message : error);
  process.exit(1);
});
