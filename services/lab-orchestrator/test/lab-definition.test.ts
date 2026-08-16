/** Test requirement 1 — Lab YAML loading. */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  LabDefinitionError,
  LabRegistry,
  loadLabDefinition,
  parseLabDefinition,
} from '../src/index.js';
import { K8S_001_PATH, LABS_DIR, REPO_ROOT } from './helpers.js';

const VALID_YAML = `
id: K8S-999
slug: k8s-999-demo
title: Demo Lab
track: kubernetes
topic: pods
difficulty: beginner
duration_minutes: 15
environment:
  provider: kubernetes
task:
  summary: Do the thing.
  description: A longer description of the thing.
requirements:
  - type: pod_exists
    name: demo
    label: Pod name must be demo
hints:
  - level: 1
    text: A helpful nudge.
references:
  - title: Kubernetes Pods
    url: https://kubernetes.io/docs/concepts/workloads/pods/
skills:
  - kubernetes.pods.create
reset:
  purge_namespaced_resources: [pods]
`;

describe('loadLabDefinition — the real K8S-001 definition', () => {
  it('loads and validates labs/kubernetes/k8s-001-pods/lab.yaml', async () => {
    const def = await loadLabDefinition(K8S_001_PATH);

    expect(def.id).toBe('K8S-001');
    expect(def.title).toBe('Create Your First Pod');
    expect(def.track).toBe('kubernetes');
    expect(def.difficulty).toBe('beginner');
    expect(def.duration_minutes).toBe(30);
  });

  it('carries the requirements the verifier enforces', async () => {
    const def = await loadLabDefinition(K8S_001_PATH);

    expect(def.requirements).toEqual([
      { type: 'pod_exists', name: 'nginx', label: 'Pod nginx exists' },
      { type: 'pod_image', name: 'nginx', image: 'nginx:stable', label: 'Image nginx:stable is correct' },
      { type: 'pod_running', name: 'nginx', label: 'Pod is Running' },
      { type: 'pod_ready', name: 'nginx', label: 'Container is Ready' },
    ]);
  });

  it('names no namespace at all', async () => {
    // PLATFORM-002: the namespace belongs to the session, not to the lab. A
    // lab that could name its namespace could reach another student's sandbox.
    const raw = JSON.stringify(await loadLabDefinition(K8S_001_PATH));

    expect(raw).not.toMatch(/"namespace"\s*:/);
    expect(await loadLabDefinition(K8S_001_PATH)).toMatchObject({
      environment: { provider: 'kubernetes', isolation: 'namespace' },
    });
  });

  it('exposes only official Kubernetes documentation links', async () => {
    const def = await loadLabDefinition(K8S_001_PATH);

    expect(def.references.length).toBeGreaterThan(0);
    for (const doc of def.references) {
      expect(doc.url.startsWith('https://kubernetes.io/')).toBe(true);
    }
  });

  it('provides hints that do not contain the full solution', async () => {
    const def = await loadLabDefinition(K8S_001_PATH);
    const text = def.hints.map((h) => h.text).join(' ');

    expect(def.hints.length).toBeGreaterThan(0);
    expect(text).toMatch(/manifest|kubectl/i);
    // The hints must not hand over a runnable answer.
    expect(text).not.toMatch(/kubectl\s+run\s+nginx/i);
    expect(text).not.toMatch(/--image=/);
  });

  it('protects the cluster-managed objects a reset must not remove', async () => {
    const def = await loadLabDefinition(K8S_001_PATH);

    expect(def.reset.purge_namespaced_resources).toContain('pods');
    expect(def.reset.protected_resources).toContain('services/kubernetes');
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
    const bad = VALID_YAML.replace(/requirements:[\s\S]*?label: Pod name must be demo\n/, '');
    expect(() => parseLabDefinition(bad)).toThrow(LabDefinitionError);
  });

  it('rejects non-https documentation links', () => {
    const bad = VALID_YAML.replace(
      'url: https://kubernetes.io/docs/concepts/workloads/pods/',
      'url: javascript:alert(1)',
    );
    expect(() => parseLabDefinition(bad)).toThrow(LabDefinitionError);
  });

  it('rejects a lab that tries to name its own namespace', () => {
    const bad = VALID_YAML.replace(
      'environment:\n  provider: kubernetes',
      'environment:\n  provider: kubernetes\n  namespace: kube-system',
    );
    expect(() => parseLabDefinition(bad)).toThrow(LabDefinitionError);
  });

  it('rejects an unsupported requirement type with a precise message', () => {
    const bad = VALID_YAML.replace('type: pod_exists', 'type: run_shell_command');
    try {
      parseLabDefinition(bad);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as LabDefinitionError).issues.join(' ')).toMatch(
        /requirements\[0\].type is not supported/,
      );
    }
  });

  it('rejects a requirement carrying an unknown key', () => {
    // `.strict()` everywhere is what stops a lab smuggling in a `command:`.
    const bad = VALID_YAML.replace('    name: demo', '    name: demo\n    command: rm -rf /');
    expect(() => parseLabDefinition(bad)).toThrow(LabDefinitionError);
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
    const registry = new LabRegistry(LABS_DIR);
    await registry.load();

    expect(registry.loadErrors).toEqual([]);
    expect(registry.size).toBeGreaterThanOrEqual(1);
    expect(registry.list().map((l) => l.id)).toContain('K8S-001');
    expect(registry.get('K8S-001').title).toBe('Create Your First Pod');
  });

  it('accepts a lowercase id and canonicalises it', async () => {
    const registry = new LabRegistry(LABS_DIR);
    await registry.load();

    expect(registry.get('k8s-001').id).toBe('K8S-001');
  });

  it('throws LabNotFoundError for a valid but unknown id', async () => {
    const registry = new LabRegistry(LABS_DIR);
    await registry.load();

    expect(() => registry.get('K8S-404')).toThrow(/not found/i);
  });

  it('records an error instead of throwing when the directory is missing', async () => {
    const registry = new LabRegistry(path.join(REPO_ROOT, 'labs-that-do-not-exist'));
    await registry.load();

    expect(registry.size).toBe(0);
    expect(registry.loadErrors.join(' ')).toMatch(/cannot read labs directory/i);
  });
});
