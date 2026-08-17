/**
 * PLATFORM-CICD-001 — the UI carries a new track without being told about it.
 *
 * The catalog renders whatever tracks the API serves. These tests feed it a
 * two-track payload and assert both appear, then check the environment caption
 * stays truthful for a sandbox that has no cluster, no version and no nodes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { CatalogPage } from '../src/pages/CatalogPage';
import { describeEnvironment } from '../src/lib/environment';
import type { EnvironmentInfo, LabSummary, TrackSummary } from '../src/lib/types';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function labSummary(overrides: Partial<LabSummary>): LabSummary {
  return {
    id: 'CICD-002',
    slug: 'cicd-002-github-actions-first-workflow',
    title: 'Your First GitHub Actions Workflow',
    track: 'cicd',
    topic: 'github-actions',
    topicTitle: 'Github Actions',
    difficulty: 'beginner',
    level: 'practice',
    durationMinutes: 30,
    order: 2,
    summary: 'Create .github/workflows/ci.yml with a named workflow.',
    skills: ['cicd.githubactions.workflow.create'],
    hasSetup: true,
    certifications: [],
    prerequisites: [],
    hintCount: 3,
    ...overrides,
  };
}

const TRACKS: TrackSummary[] = [
  { track: 'cicd', title: 'CI/CD', labCount: 2, topics: [], difficulties: ['beginner'] },
  { track: 'kubernetes', title: 'Kubernetes', labCount: 1, topics: [], difficulties: ['beginner'] },
];

const LABS: LabSummary[] = [
  labSummary({}),
  labSummary({ id: 'CICD-006', title: 'Your First Jenkins Pipeline', topic: 'jenkins', order: 6 }),
  labSummary({
    id: 'K8S-001',
    slug: 'k8s-001-pods',
    title: 'Run a Container in a Pod',
    track: 'kubernetes',
    topic: 'pods',
    topicTitle: 'Pods',
    order: 1,
    skills: ['kubernetes.pods.create'],
  }),
];

function stubCatalog(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, data: { labs: LABS, tracks: TRACKS, count: LABS.length } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
}

describe('the catalog with a CI/CD track (acceptance steps 1–3)', () => {
  it('renders both tracks, each with its own labs, from data alone', async () => {
    stubCatalog();
    render(<CatalogPage onOpenLab={() => undefined} />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'CI/CD' })).toBeTruthy();
    });
    expect(screen.getByRole('heading', { name: 'Kubernetes' })).toBeTruthy();
    expect(screen.getByText('Your First GitHub Actions Workflow')).toBeTruthy();
    expect(screen.getByText('Your First Jenkins Pipeline')).toBeTruthy();
    expect(screen.getByText('Run a Container in a Pod')).toBeTruthy();
  });

  it('offers a filter chip per track, named by the API', async () => {
    stubCatalog();
    render(<CatalogPage onOpenLab={() => undefined} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /CI\/CD/ })).toBeTruthy();
    });
    expect(screen.getByRole('button', { name: /Kubernetes/ })).toBeTruthy();
  });
});

describe('the environment caption', () => {
  const base: EnvironmentInfo = {
    environmentId: 'x',
    provider: 'workspace',
    phase: 'ready',
    namespace: 'lab-0000000000aa',
  };

  it('uses the summary the provider wrote', () => {
    expect(describeEnvironment({ ...base, summary: 'Node.js v22.11.0' })).toBe(
      'workspace · Node.js v22.11.0',
    );
  });

  it('never claims a Kubernetes version a file-backed sandbox does not have', () => {
    const caption = describeEnvironment(base);
    expect(caption).toBe('workspace');
    expect(caption).not.toMatch(/k8s|node/i);
  });

  it('still describes a Kubernetes sandbox the old way when no summary is served', () => {
    expect(
      describeEnvironment({
        ...base,
        provider: 'kind',
        kubernetesVersion: 'v1.34.2',
        nodes: [{ name: 'control-plane', ready: true, roles: [], version: 'v1.34.2' }],
      }),
    ).toBe('kind · v1.34.2 · 1 node');
  });
});
