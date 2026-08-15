/** Test requirement 1 — Lab YAML loading. */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LabDefinitionError,
  LabRegistry,
  labContextFor,
  loadLabDefinition,
  parseLabDefinition,
} from '../src/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const labsDir = path.join(repoRoot, 'labs');
const k8s001Path = path.join(labsDir, 'kubernetes/k8s-001-pods/lab.yaml');

const VALID_YAML = `
id: K8S-999
slug: k8s-999-demo
title: Demo Lab
track: kubernetes
difficulty: beginner
duration_minutes: 15
environment:
  provider: kubernetes
  namespace: default
task:
  summary: Do the thing.
  description: A longer description of the thing.
requirements:
  pod_name: demo
  namespace: default
  image: nginx:stable
  status: Running
requirement_labels:
  - Pod name must be demo
hint: A helpful nudge.
documentation:
  - title: Kubernetes Pods
    url: https://kubernetes.io/docs/concepts/workloads/pods/
verification:
  checks:
    - id: pod-exists
      type: pod_exists
      label: Pod exists
reset:
  purge_namespaced_resources: [pods]
`;

describe('loadLabDefinition — the real K8S-001 definition', () => {
  it('loads and validates labs/kubernetes/k8s-001-pods/lab.yaml', async () => {
    const def = await loadLabDefinition(k8s001Path);

    expect(def.id).toBe('K8S-001');
    expect(def.title).toBe('Create Your First Pod');
    expect(def.track).toBe('kubernetes');
    expect(def.difficulty).toBe('beginner');
    expect(def.duration_minutes).toBe(30);
  });

  it('carries the requirements the verifier enforces', async () => {
    const def = await loadLabDefinition(k8s001Path);

    expect(def.requirements).toEqual({
      pod_name: 'nginx',
      namespace: 'default',
      image: 'nginx:stable',
      status: 'Running',
    });
  });

  it('exposes only official Kubernetes documentation links', async () => {
    const def = await loadLabDefinition(k8s001Path);

    expect(def.documentation.length).toBeGreaterThan(0);
    for (const doc of def.documentation) {
      expect(doc.url.startsWith('https://kubernetes.io/')).toBe(true);
    }
  });

  it('provides a hint that does not contain the full solution', async () => {
    const def = await loadLabDefinition(k8s001Path);

    expect(def.hint).toMatch(/manifest|kubectl/i);
    // The hint must not hand over a runnable answer.
    expect(def.hint).not.toMatch(/kubectl\s+run\s+nginx/i);
    expect(def.hint).not.toMatch(/--image=/);
  });

  it('builds a provider context from the definition', async () => {
    const def = await loadLabDefinition(k8s001Path);
    const context = labContextFor(def);

    expect(context.labId).toBe('K8S-001');
    expect(context.namespace).toBe('default');
    expect(context.purgeResources).toContain('pods');
    expect(context.protectedResources).toContain('services/kubernetes');
  });
});

describe('parseLabDefinition — validation', () => {
  it('accepts a well-formed definition', () => {
    expect(parseLabDefinition(VALID_YAML).id).toBe('K8S-999');
  });

  it('rejects invalid YAML', () => {
    expect(() => parseLabDefinition('id: [unclosed')).toThrow(LabDefinitionError);
  });

  it('rejects a malformed lab id', () => {
    const bad = VALID_YAML.replace('id: K8S-999', 'id: not-a-lab-id');
    try {
      parseLabDefinition(bad);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(LabDefinitionError);
      expect((error as LabDefinitionError).issues.join(' ')).toMatch(/lab id must look like/i);
    }
  });

  it('rejects a missing required section', () => {
    const bad = VALID_YAML.replace(/requirements:[\s\S]*?status: Running\n/, '');
    expect(() => parseLabDefinition(bad)).toThrow(LabDefinitionError);
  });

  it('rejects non-http documentation links', () => {
    const bad = VALID_YAML.replace(
      'url: https://kubernetes.io/docs/concepts/workloads/pods/',
      'url: javascript:alert(1)',
    );
    expect(() => parseLabDefinition(bad)).toThrow(LabDefinitionError);
  });

  it('rejects a namespace mismatch between environment and requirements', () => {
    const bad = VALID_YAML.replace('  namespace: default\ntask:', '  namespace: other\ntask:');
    expect(() => parseLabDefinition(bad)).toThrow(/must match environment.namespace/);
  });

  it('rejects duplicate verification check ids', () => {
    const bad = VALID_YAML.replace(
      'reset:',
      `    - id: pod-exists
      type: pod_phase
      label: Duplicate
reset:`,
    );
    expect(() => parseLabDefinition(bad)).toThrow(/duplicate verification check ids/);
  });

  it('reports every schema issue, not just the first', () => {
    const bad = VALID_YAML.replace('duration_minutes: 15', 'duration_minutes: -5').replace(
      'difficulty: beginner',
      'difficulty: impossible',
    );
    try {
      parseLabDefinition(bad, 'bad.yaml');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(LabDefinitionError);
      expect((error as LabDefinitionError).issues.length).toBeGreaterThanOrEqual(2);
      expect((error as LabDefinitionError).path).toBe('bad.yaml');
    }
  });
});

describe('LabRegistry', () => {
  it('discovers K8S-001 from the labs directory', async () => {
    const registry = new LabRegistry(labsDir);
    await registry.load();

    expect(registry.loadErrors).toEqual([]);
    expect(registry.size).toBeGreaterThanOrEqual(1);
    expect(registry.list().map((l) => l.id)).toContain('K8S-001');
    expect(registry.get('K8S-001').title).toBe('Create Your First Pod');
  });

  it('accepts a lowercase id and canonicalises it', async () => {
    const registry = new LabRegistry(labsDir);
    await registry.load();

    expect(registry.get('k8s-001').id).toBe('K8S-001');
  });

  it('throws LabNotFoundError for a valid but unknown id', async () => {
    const registry = new LabRegistry(labsDir);
    await registry.load();

    expect(() => registry.get('K8S-404')).toThrow(/not found/i);
  });

  it('records an error instead of throwing when the directory is missing', async () => {
    const registry = new LabRegistry(path.join(repoRoot, 'labs-that-do-not-exist'));
    await registry.load();

    expect(registry.size).toBe(0);
    expect(registry.loadErrors.join(' ')).toMatch(/cannot read labs directory/i);
  });
});
