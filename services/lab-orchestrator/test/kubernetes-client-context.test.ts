/**
 * The Kubernetes client uses the context it was told to, or none at all.
 *
 * The defect (red-team O10): with no `KUBECONFIG`, the client called
 * `loadFromDefault()` and used whatever `kubectl config use-context` had last
 * chosen. A developer's ~/.kube/config routinely holds real clusters beside
 * kind — the machine this was found on had an EKS context named
 * `prod-eks-cluster` — so `npm run dev:api` with that context current created
 * lab namespaces, Roles and student ServiceAccount tokens on it, and handed the
 * token to a student shell.
 *
 * Two loopback HTTP servers stand in for the two clusters. Nothing here can
 * reach a real one: every server URL is 127.0.0.1 or `.invalid`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { KubernetesClient, KubernetesUnreachableError } from '../src/index.js';

interface StandIn {
  server: Server;
  url: string;
  requests: IncomingMessage[];
}

async function standIn(): Promise<StandIn> {
  const requests: IncomingMessage[] = [];
  const server = createServer((req, res) => {
    requests.push(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ major: '1', minor: '31', gitVersion: 'v1.31.0' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}`, requests };
}

let production: StandIn;
let kind: StandIn;
let dir: string;
let kubeconfigPath: string;
const savedKubeconfig = process.env.KUBECONFIG;

/** A developer kubeconfig: a real cluster is current, kind is merely present. */
function writeKubeconfig(contexts: Array<{ name: string; server: string }>, current: string): void {
  const lines = ['apiVersion: v1', 'kind: Config', `current-context: ${current}`, 'clusters:'];
  for (const c of contexts) {
    // Loopback stand-ins speak plain HTTP; the client refuses that without this.
    lines.push(`  - name: ${c.name}`, '    cluster:', `      server: ${c.server}`, '      insecure-skip-tls-verify: true');
  }
  lines.push('users:', '  - name: tester', '    user:', '      token: not-a-real-token', 'contexts:');
  for (const c of contexts) {
    lines.push(`  - name: ${c.name}`, '    context:', `      cluster: ${c.name}`, '      user: tester');
  }
  writeFileSync(kubeconfigPath, lines.join('\n') + '\n', { mode: 0o600 });
}

beforeEach(async () => {
  production = await standIn();
  kind = await standIn();
  dir = mkdtempSync(path.join(tmpdir(), 'jtt-k8s-context-'));
  kubeconfigPath = path.join(dir, 'config');
});

afterEach(() => {
  for (const s of [production, kind]) {
    s.server.closeAllConnections();
    s.server.close();
  }
  rmSync(dir, { recursive: true, force: true });
  if (savedKubeconfig === undefined) delete process.env.KUBECONFIG;
  else process.env.KUBECONFIG = savedKubeconfig;
});

describe('a kubeconfig whose current-context is a real cluster', () => {
  beforeEach(() => {
    writeKubeconfig(
      [
        { name: 'prod-eks-cluster', server: production.url },
        { name: 'kind-jumptotech-labs', server: kind.url },
      ],
      'prod-eks-cluster',
    );
  });

  it('uses the named kind context, not the current one', async () => {
    const client = new KubernetesClient({ kubeconfigPath, context: 'kind-jumptotech-labs' });

    expect(client.serverUrl).toBe(kind.url);
    await client.ping();
    expect(kind.requests.length).toBeGreaterThan(0);
    expect(production.requests).toHaveLength(0);
  });

  it('does the same when the kubeconfig is found by default rules, not a path', async () => {
    // What `npm run dev:api` does on a host: no path, so `loadFromDefault`.
    process.env.KUBECONFIG = kubeconfigPath;
    const client = new KubernetesClient({ context: 'kind-jumptotech-labs' });

    expect(client.serverUrl).toBe(kind.url);
    await client.ping();
    expect(production.requests).toHaveLength(0);
  });
});

describe('a kubeconfig without the named context', () => {
  beforeEach(() => {
    // kind was never created (or was named differently): only the real cluster.
    writeKubeconfig([{ name: 'prod-eks-cluster', server: production.url }], 'prod-eks-cluster');
    process.env.KUBECONFIG = kubeconfigPath;
  });

  it('refuses every call and never contacts the current-context cluster', async () => {
    const client = new KubernetesClient({ context: 'kind-jumptotech-labs' });

    expect(client.serverUrl).not.toBe(production.url);
    await expect(client.ping()).rejects.toBeInstanceOf(KubernetesUnreachableError);
    await expect(client.ping()).rejects.toThrow(/no context 'kind-jumptotech-labs'/);
    // The writes a Start makes: a namespace, then lab objects.
    await expect(client.getNamespace('lab-0000000000aa')).rejects.toThrow(/no context/);
    await expect(
      client.applyObjects('lab-0000000000aa', [
        { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'probe' }, data: {} },
      ]),
    ).rejects.toThrow(/no context/);

    expect(production.requests).toHaveLength(0);
  });

  it('refuses the same way when the path is explicit', async () => {
    const client = new KubernetesClient({ kubeconfigPath, context: 'kind-jumptotech-labs' });

    await expect(client.ping()).rejects.toThrow(/no context 'kind-jumptotech-labs'/);
    expect(production.requests).toHaveLength(0);
  });
});
