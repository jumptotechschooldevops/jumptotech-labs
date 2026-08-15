import { loadTerminalConfig } from './config.js';
import { createTerminalServer } from './server.js';

function main(): void {
  const config = loadTerminalConfig();

  if (process.getuid?.() === 0) {
    console.warn(
      '[terminal] WARNING: running as root. Student shells inherit this process’ user — the provided image runs as the non-root `student` user.',
    );
  }

  const server = createTerminalServer(config);
  server.listen(config.port, '0.0.0.0', () => {
    console.log(`[terminal] websocket listening on :${config.port}/terminal`);
    console.log(`[terminal] shell=${config.shell} cwd=${config.workDir}`);
    console.log(`[terminal] kubeconfig=${config.kubeconfigPath ?? '<default>'}`);
    console.log(`[terminal] allowed origins: ${config.allowedOrigins.join(', ')}`);
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      console.log(`[terminal] ${signal} received, shutting down`);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    });
  }
}

try {
  main();
} catch (error) {
  console.error('[terminal] failed to start:', error instanceof Error ? error.message : error);
  process.exit(1);
}
