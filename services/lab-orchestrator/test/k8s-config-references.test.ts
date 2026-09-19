/**
 * Which ConfigMaps and Secrets a Pod spec actually hands its containers.
 *
 * The second lab-quality audit found that a volume declared from a ConfigMap
 * counted as "using" it even when nothing mounted it — K8S-004 and K8S-005
 * passed with the literals deleted and an unmounted volume added, while the
 * application received nothing — and that a `projected` volume, which the
 * task accepts as "a mounted volume", counted as nothing at all.
 */
import { describe, expect, it } from 'vitest';
import { configReferencesOf } from '../src/k8s/client.js';

const container = (extra: Record<string, unknown> = {}) => ({ name: 'app', image: 'nginx', ...extra });

describe('configReferencesOf', () => {
  it('ignores a configMap or secret volume that no container mounts', () => {
    const refs = configReferencesOf({
      containers: [container()],
      volumes: [
        { name: 'cfg', configMap: { name: 'statements-config' } },
        { name: 'tok', secret: { secretName: 'payments-api' } },
      ],
    } as never);
    expect(refs).toEqual([]);
  });

  it('counts a mounted volume, from any container including an init container', () => {
    const refs = configReferencesOf({
      initContainers: [container({ name: 'init', volumeMounts: [{ name: 'tok', mountPath: '/t' }] })],
      containers: [container({ volumeMounts: [{ name: 'cfg', mountPath: '/c' }] })],
      volumes: [
        { name: 'cfg', configMap: { name: 'statements-config' } },
        { name: 'tok', secret: { secretName: 'payments-api', items: [{ key: 'api-token', path: 't' }] } },
      ],
    } as never);
    expect(refs).toEqual([
      { source: 'configmap', name: 'statements-config', via: 'volume' },
      { source: 'secret', name: 'payments-api', key: 'api-token', via: 'volume' },
    ]);
  });

  it('counts the sources of a mounted projected volume', () => {
    const refs = configReferencesOf({
      containers: [container({ volumeMounts: [{ name: 'all', mountPath: '/etc/app' }] })],
      volumes: [
        {
          name: 'all',
          projected: {
            sources: [{ configMap: { name: 'statements-config' } }, { secret: { name: 'payments-api', items: [{ key: 'api-token', path: 't' }] } }],
          },
        },
      ],
    } as never);
    expect(refs).toEqual([
      { source: 'configmap', name: 'statements-config', via: 'volume' },
      { source: 'secret', name: 'payments-api', key: 'api-token', via: 'volume' },
    ]);
  });

  it('records the variable a single-key reference sets', () => {
    const refs = configReferencesOf({
      containers: [
        container({
          env: [{ name: 'PAYMENTS_API_TOKEN', valueFrom: { secretKeyRef: { name: 'payments-api', key: 'api-token' } } }],
        }),
      ],
    } as never);
    expect(refs).toEqual([
      { source: 'secret', name: 'payments-api', key: 'api-token', via: 'env', env: 'PAYMENTS_API_TOKEN', container: 'app' },
    ]);
  });
});
