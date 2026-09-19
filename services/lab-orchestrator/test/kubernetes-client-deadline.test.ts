/**
 * Every Kubernetes API request has a deadline.
 *
 * `@kubernetes/client-node` sets none, so a request to an API server that
 * accepted the connection and never answered waited forever — and so did the
 * Start, Reset or Check behind it, and the reaper, which runs one sweep at a
 * time and so stopped cleaning up every provider's sandboxes.
 *
 * The stand-in here is an HTTP server that reads each request and never
 * replies: exactly a paused control-plane container behind kind's
 * port-forward, as far as a client can tell.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { KubernetesClient, KubernetesUnreachableError } from '../src/index.js';

let server: Server;
let requests: IncomingMessage[];
let dir: string;
let kubeconfigPath: string;

beforeEach(async () => {
  requests = [];
  // Accepts, reads, and never answers.
  server = createServer((req) => void requests.push(req));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  dir = mkdtempSync(path.join(tmpdir(), 'jtt-k8s-deadline-'));
  kubeconfigPath = path.join(dir, 'kubeconfig');
  writeFileSync(
    kubeconfigPath,
    [
      'apiVersion: v1',
      'kind: Config',
      'clusters:',
      '  - name: silent',
      '    cluster:',
      `      server: http://127.0.0.1:${port}`,
      // The client refuses plain HTTP without this. Test fixture only: a
      // loopback stand-in that never answers, not a cluster.
      '      insecure-skip-tls-verify: true',
      'users:',
      '  - name: tester',
      '    user:',
      '      token: not-a-real-token',
      'contexts:',
      '  - name: silent',
      '    context:',
      '      cluster: silent',
      '      user: tester',
      'current-context: silent',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
});

afterEach(() => {
  server.closeAllConnections();
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('a Kubernetes API server that never answers', () => {
  it('fails a generated-API call as unreachable once the deadline passes', async () => {
    const client = new KubernetesClient({ kubeconfigPath, requestTimeoutMs: 200 });
    const started = Date.now();

    await expect(client.ping()).rejects.toBeInstanceOf(KubernetesUnreachableError);
    expect(requests.length).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('fails a namespace read the same way', async () => {
    const client = new KubernetesClient({ kubeconfigPath, requestTimeoutMs: 200 });
    await expect(client.getNamespace('lab-0000000000aa')).rejects.toBeInstanceOf(KubernetesUnreachableError);
  });

  it('bounds the object API as well, which applies lab manifests', async () => {
    const client = new KubernetesClient({ kubeconfigPath, requestTimeoutMs: 200 });
    const started = Date.now();

    await expect(
      client.applyObjects('lab-0000000000aa', [
        { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'probe' }, data: {} },
      ]),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
