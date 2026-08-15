/**
 * Test requirements 4, 5 and 6 — the verifier with no Pod, a wrong image,
 * and a correct Pod.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLabDefinition, type LabDefinition } from '@jumptotech/lab-orchestrator';
import { FakeKubernetes, podSnapshot } from '@jumptotech/lab-orchestrator/testing';
import { imageMatches, normalizeImageReference, verifyLab } from '../src/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const K8S001 = path.join(repoRoot, 'labs/kubernetes/k8s-001-pods/lab.yaml');

let lab: LabDefinition;
beforeAll(async () => {
  lab = await loadLabDefinition(K8S001);
});

/** Map results to `{ id: status }` for terse assertions. */
function statuses(checks: Array<{ id: string; status: string }>): Record<string, string> {
  return Object.fromEntries(checks.map((c) => [c.id, c.status]));
}

describe('verifier — Pod does not exist (test requirement 4)', () => {
  it('fails every check and reports LAB NOT COMPLETE', async () => {
    const k8s = new FakeKubernetes({ pods: { default: [] } });

    const result = await verifyLab({ k8s, lab });

    expect(result.passed).toBe(false);
    expect(result.summary).toBe('LAB NOT COMPLETE');
    expect(statuses(result.checks)).toEqual({
      'pod-exists': 'fail',
      'namespace-correct': 'fail',
      'image-correct': 'fail',
      'pod-running': 'fail',
      'container-ready': 'fail',
    });
  });

  it('names what is missing without giving the solution', async () => {
    const k8s = new FakeKubernetes({ pods: { default: [] } });

    const result = await verifyLab({ k8s, lab });
    const existsCheck = result.checks.find((c) => c.id === 'pod-exists');

    expect(existsCheck?.detail).toContain("No Pod named 'nginx'");
    const allDetail = result.checks.map((c) => c.detail ?? '').join(' ');
    expect(allDetail).not.toMatch(/kubectl run/i);
    expect(allDetail).not.toMatch(/--image=/);
  });

  it('ignores a Pod with the right name in the wrong namespace', async () => {
    const k8s = new FakeKubernetes({
      pods: { default: [], other: [podSnapshot({ namespace: 'other' })] },
    });

    const result = await verifyLab({ k8s, lab });

    expect(result.passed).toBe(false);
    expect(statuses(result.checks)['pod-exists']).toBe('fail');
  });
});

describe('verifier — wrong image (test requirement 5)', () => {
  it('fails only the image check when everything else is right', async () => {
    const k8s = new FakeKubernetes({
      pods: {
        default: [
          podSnapshot({
            containers: [
              {
                name: 'nginx',
                image: 'nginx:latest',
                ready: true,
                restartCount: 0,
                state: 'running',
              },
            ],
          }),
        ],
      },
    });

    const result = await verifyLab({ k8s, lab });

    expect(result.passed).toBe(false);
    expect(result.summary).toBe('LAB NOT COMPLETE');
    expect(statuses(result.checks)).toEqual({
      'pod-exists': 'pass',
      'namespace-correct': 'pass',
      'image-correct': 'fail',
      'pod-running': 'pass',
      'container-ready': 'pass',
    });
    expect(result.checks.find((c) => c.id === 'image-correct')?.detail).toContain('nginx:latest');
  });

  it('fails an image that is a different repository entirely', async () => {
    const k8s = new FakeKubernetes({
      pods: {
        default: [
          podSnapshot({
            containers: [
              { name: 'nginx', image: 'httpd:2.4', ready: true, restartCount: 0, state: 'running' },
            ],
          }),
        ],
      },
    });

    const result = await verifyLab({ k8s, lab });
    expect(statuses(result.checks)['image-correct']).toBe('fail');
  });

  it('reports both a bad image and a not-Ready container', async () => {
    const k8s = new FakeKubernetes({
      pods: {
        default: [
          podSnapshot({
            phase: 'Pending',
            containers: [
              {
                name: 'nginx',
                image: 'nginx:does-not-exist',
                ready: false,
                restartCount: 0,
                state: 'waiting',
                reason: 'ImagePullBackOff',
              },
            ],
          }),
        ],
      },
    });

    const result = await verifyLab({ k8s, lab });

    expect(statuses(result.checks)).toEqual({
      'pod-exists': 'pass',
      'namespace-correct': 'pass',
      'image-correct': 'fail',
      'pod-running': 'fail',
      'container-ready': 'fail',
    });
    expect(result.checks.find((c) => c.id === 'container-ready')?.detail).toContain(
      'ImagePullBackOff',
    );
  });
});

describe('verifier — correct Pod (test requirement 6)', () => {
  it('passes every check and reports LAB PASSED', async () => {
    const k8s = new FakeKubernetes({ pods: { default: [podSnapshot()] } });

    const result = await verifyLab({ k8s, lab });

    expect(result.passed).toBe(true);
    expect(result.summary).toBe('LAB PASSED');
    expect(result.checks.every((c) => c.status === 'pass')).toBe(true);
    expect(result.labId).toBe('K8S-001');
    expect(Date.parse(result.checkedAt)).not.toBeNaN();
  });

  it('passes regardless of how the Pod was created', async () => {
    // Same desired state, different provenance (extra labels/annotations are
    // invisible to the verifier — it only reads spec + status).
    const k8s = new FakeKubernetes({ pods: { default: [podSnapshot()] } });

    const result = await verifyLab({ k8s, lab });
    expect(result.passed).toBe(true);
  });

  it('fails a Pod that exists but is terminating', async () => {
    const k8s = new FakeKubernetes({ pods: { default: [podSnapshot({ deleting: true })] } });

    const result = await verifyLab({ k8s, lab });

    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.id === 'pod-exists')?.detail).toMatch(/terminating/i);
  });
});

describe('verifier — cluster unreachable', () => {
  it('skips checks and reports the real transport error', async () => {
    const k8s = new FakeKubernetes({ unreachable: 'connect ECONNREFUSED 172.18.0.2:6443' });

    const result = await verifyLab({ k8s, lab });

    expect(result.passed).toBe(false);
    expect(result.error?.code).toBe('ENVIRONMENT_UNREACHABLE');
    expect(result.error?.message).toContain('ECONNREFUSED');
    expect(result.checks.every((c) => c.status === 'skipped')).toBe(true);
  });
});

describe('image reference handling', () => {
  it('defaults a missing tag to :latest', () => {
    expect(normalizeImageReference('nginx')).toBe('nginx:latest');
    expect(normalizeImageReference('nginx:stable')).toBe('nginx:stable');
  });

  it('does not mistake a registry port for a tag', () => {
    expect(normalizeImageReference('registry.local:5000/nginx')).toBe(
      'registry.local:5000/nginx:latest',
    );
  });

  it('leaves digest references alone', () => {
    expect(normalizeImageReference('nginx@sha256:abc')).toBe('nginx@sha256:abc');
  });

  it('treats docker.io/library prefixes as equivalent', () => {
    expect(imageMatches('nginx:stable', 'docker.io/library/nginx:stable')).toBe(true);
    expect(imageMatches('nginx:stable', 'nginx:stable')).toBe(true);
  });

  it('still rejects a different tag or repository', () => {
    expect(imageMatches('nginx:stable', 'nginx:latest')).toBe(false);
    expect(imageMatches('nginx:stable', 'nginx-unprivileged:stable')).toBe(false);
    expect(imageMatches('nginx:stable', 'evil.example.com/nginx:stable')).toBe(false);
  });
});
