/**
 * `applyObjects` sends every field of a manifest, including the ones the
 * client's models rename.
 *
 * `@kubernetes/client-node` serialises through generated models that rename
 * fields whose wire names are reserved words: `LimitRangeItem.default` is
 * `_default`, `NetworkPolicyIngressRule.from` is `_from`. A plain manifest was
 * serialised as if it were a model, so those fields were silently dropped.
 * Measured on kind: every session's `allow-same-namespace` policy was stored as
 * `ingress: [{}]` — allow from every Pod in every namespace — and the
 * LimitRange's `default` came back equal to its `max`.
 *
 * A loopback stand-in answers discovery and records each body the client
 * sends. No cluster is contacted.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_SESSION_POLICY, KubernetesClient } from '../src/index.js';
import { limitRangeManifest } from '../src/session/isolation.js';
import { networkPolicyManifests } from '../src/session/network-policy.js';

const DISCOVERY: Record<string, unknown> = {
  '/api/v1': {
    kind: 'APIResourceList',
    groupVersion: 'v1',
    resources: [{ name: 'limitranges', namespaced: true, kind: 'LimitRange', verbs: ['create', 'get'] }],
  },
  '/apis/networking.k8s.io/v1': {
    kind: 'APIResourceList',
    groupVersion: 'networking.k8s.io/v1',
    resources: [{ name: 'networkpolicies', namespaced: true, kind: 'NetworkPolicy', verbs: ['create', 'get'] }],
  },
};

let server: Server;
let dir: string;
let kubeconfigPath: string;
let created: Array<Record<string, any>>;

beforeEach(async () => {
  created = [];
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      const url = (req.url ?? '').split('?')[0]!;
      res.setHeader('content-type', 'application/json');
      if (DISCOVERY[url]) return res.end(JSON.stringify(DISCOVERY[url]));
      if (req.method === 'GET') {
        res.statusCode = 404;
        return res.end(JSON.stringify({ kind: 'Status', status: 'Failure', reason: 'NotFound', code: 404 }));
      }
      if (req.method === 'POST') {
        const object = JSON.parse(body) as Record<string, any>;
        created.push(object);
        res.statusCode = 201;
        return res.end(JSON.stringify(object));
      }
      res.statusCode = 405;
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  dir = mkdtempSync(path.join(tmpdir(), 'jtt-k8s-apply-'));
  kubeconfigPath = path.join(dir, 'config');
  writeFileSync(
    kubeconfigPath,
    [
      'apiVersion: v1',
      'kind: Config',
      'current-context: stand-in',
      // Loopback stand-in only; the client refuses plain HTTP without this.
      `clusters: [{name: stand-in, cluster: {server: "http://127.0.0.1:${port}", insecure-skip-tls-verify: true}}]`,
      'users: [{name: tester, user: {token: not-a-real-token}}]',
      'contexts: [{name: stand-in, context: {cluster: stand-in, user: tester}}]',
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

describe('applyObjects keeps fields the client models rename', () => {
  it("sends the session NetworkPolicy's ingress `from`, not an allow-all rule", async () => {
    const client = new KubernetesClient({ kubeconfigPath });
    await client.applyObjects('lab-0000000000aa', networkPolicyManifests(DEFAULT_SESSION_POLICY));

    const sameNamespace = created.find((o) => o.metadata.name.endsWith('allow-same-namespace'));
    expect(sameNamespace, JSON.stringify(created.map((o) => o.metadata.name))).toBeDefined();
    expect(sameNamespace!.spec.ingress).toEqual([{ from: [{ podSelector: {} }] }]);
    // No ingress rule anywhere may be empty: `{}` admits every source.
    for (const policy of created) {
      for (const rule of policy.spec.ingress ?? []) expect(Object.keys(rule).length, policy.metadata.name).toBeGreaterThan(0);
    }
  });

  it("sends the LimitRange's defaults, not only its maximums", async () => {
    const client = new KubernetesClient({ kubeconfigPath });
    await client.applyObjects('lab-0000000000aa', [limitRangeManifest(DEFAULT_SESSION_POLICY)]);

    const [limits] = created[0]!.spec.limits;
    expect(limits.default).toEqual(DEFAULT_SESSION_POLICY.limitRange.default);
    expect(limits.defaultRequest).toEqual(DEFAULT_SESSION_POLICY.limitRange.defaultRequest);
    expect(limits.max).toEqual(DEFAULT_SESSION_POLICY.limitRange.max);
  });

  it('imposes the session namespace on the object it sends', async () => {
    const client = new KubernetesClient({ kubeconfigPath });
    const manifest = limitRangeManifest(DEFAULT_SESSION_POLICY);
    await client.applyObjects('lab-0000000000aa', [
      { ...manifest, metadata: { ...manifest.metadata, namespace: 'kube-system' } },
    ]);
    expect(created[0]!.metadata.namespace).toBe('lab-0000000000aa');
  });
});
