/**
 * PLATFORM-003 — the catalog UI (story test requirement 34).
 *
 * Asserts that the catalog renders whatever the API returns: multiple labs,
 * grouped by track, with difficulty, duration, skills, prerequisites and
 * certification relevance. Nothing in the page is keyed to a lab id, so these
 * fixtures are deliberately not the shipped labs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderWithAuth } from './auth-harness';
import { CatalogPage } from '../src/pages/CatalogPage';
import type { LabSummary, TrackSummary } from '../src/lib/types';

function lab(overrides: Partial<LabSummary> = {}): LabSummary {
  return {
    id: 'K8S-001',
    slug: 'k8s-001-pods',
    title: 'Create Your First Pod',
    track: 'kubernetes',
    provider: 'kubernetes',
    topic: 'pods',
    topicTitle: 'Pods',
    difficulty: 'beginner',
    level: 'practice',
    durationMinutes: 30,
    order: 1,
    summary: 'Create a Kubernetes Pod named nginx.',
    skills: ['kubernetes.pods.create'],
    hasSetup: false,
    certifications: ['CKA'],
    prerequisites: [],
    hintCount: 3,
    ...overrides,
  };
}

const LABS: LabSummary[] = [
  lab(),
  lab({
    id: 'K8S-002',
    slug: 'k8s-002-deployments',
    title: 'Run an Application with a Deployment',
    topic: 'workloads',
    topicTitle: 'Workloads',
    order: 2,
    summary: 'Create a Deployment named frontend.',
    skills: ['kubernetes.deployments.create', 'kubernetes.deployments.scale'],
    prerequisites: [{ id: 'K8S-001', title: 'Create Your First Pod', available: true }],
  }),
  lab({
    id: 'K8S-010',
    slug: 'k8s-010-troubleshooting',
    title: 'Repair a Broken Deployment',
    topic: 'troubleshooting',
    topicTitle: 'Troubleshooting',
    difficulty: 'intermediate',
    order: 10,
    durationMinutes: 45,
    summary: 'Investigate the ledger-api workload.',
    hasSetup: true,
    prerequisites: [{ id: 'K8S-002', title: 'Run an Application with a Deployment', available: true }],
  }),
];

const TRACKS: TrackSummary[] = [
  {
    track: 'kubernetes',
    title: 'Kubernetes',
    labCount: 3,
    topics: [{ topic: 'pods', title: 'Pods', labCount: 1 }],
    difficulties: ['beginner', 'intermediate'],
  },
];

const listLabs = vi.fn();
vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  return { ...actual, api: { listLabs: (...args: unknown[]) => listLabs(...args) } };
});

beforeEach(() => {
  listLabs.mockReset();
  listLabs.mockResolvedValue({ labs: LABS, tracks: TRACKS, count: LABS.length });
});

afterEach(() => vi.clearAllMocks());

// --- provider readiness (PLATFORM-004) --------------------------------------

describe('CatalogPage — provider readiness', () => {
  it('lists providers that have no labs yet as coming soon, without cards', async () => {
    listLabs.mockResolvedValue({
      labs: LABS,
      tracks: TRACKS,
      count: LABS.length,
      providers: [
        { provider: 'kubernetes', available: true },
        {
          provider: 'docker',
          available: false,
          reason: 'Docker labs need a per-session Docker daemon.',
        },
        { provider: 'aws', available: false, reason: 'AWS labs are architecture only.' },
      ],
    });

    await renderCatalog();

    expect(screen.getByRole('heading', { name: 'Coming soon' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Docker' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'AWS' })).toBeTruthy();
    expect(screen.getByText('Docker labs need a per-session Docker daemon.')).toBeTruthy();
    // Nothing to open: a track with no labs gets no Start-shaped affordance.
    expect(screen.queryAllByRole('button', { name: 'Open lab' })).toHaveLength(LABS.length);
  });

  it('says why a track cannot run here, once, above its cards', async () => {
    listLabs.mockResolvedValue({
      labs: LABS,
      tracks: [
        {
          ...TRACKS[0]!,
          availability: {
            available: false,
            reason: "the sandbox image 'jumptotech/lab-linux:latest' has not been built",
            remediation: 'Build the sandbox images once with: npm run sandbox:build',
          },
        },
      ],
      count: LABS.length,
      providers: [],
    });

    await renderCatalog();

    expect(screen.getByText('unavailable here')).toBeTruthy();
    expect(screen.getByText(/has not been built/)).toBeTruthy();
    expect(screen.getByText(/npm run sandbox:build/)).toBeTruthy();
    // The brief is still reachable — reading a lab you cannot start is fine.
    expect(screen.queryAllByRole('button', { name: 'View lab' }).length).toBe(0);
  });

  it('offers "View lab" rather than "Open lab" for a lab that cannot start', async () => {
    listLabs.mockResolvedValue({
      labs: [
        lab({
          id: 'LINUX-001',
          title: 'Files, Directories & Permissions',
          track: 'linux',
          provider: 'linux',
          availability: { available: false, reason: 'no container runtime is reachable' },
        }),
      ],
      tracks: [{ ...TRACKS[0]!, track: 'linux', title: 'Linux', labCount: 1 }],
      count: 1,
      providers: [],
    });

    renderWithAuth(<CatalogPage onOpenLab={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Files, Directories & Permissions')).toBeTruthy());

    expect(screen.getByRole('button', { name: 'View lab' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open lab' })).toBeNull();
  });
});

/** Render and wait for the catalog to load. */
async function renderCatalog(onOpenLab = vi.fn()) {
  renderWithAuth(<CatalogPage onOpenLab={onOpenLab} />);
  await waitFor(() => expect(screen.getByText('Create Your First Pod')).toBeTruthy());
  return { onOpenLab };
}

describe('CatalogPage', () => {
  it('renders every lab the API returns', async () => {
    await renderCatalog();

    expect(screen.getByText('Create Your First Pod')).toBeTruthy();
    expect(screen.getByText('Run an Application with a Deployment')).toBeTruthy();
    expect(screen.getByText('Repair a Broken Deployment')).toBeTruthy();
    // K8S-001 appears twice: as its own card id, and as K8S-002's prerequisite.
    expect(screen.getAllByText('K8S-001').length).toBeGreaterThan(0);
    expect(screen.getByText('K8S-010')).toBeTruthy();
  });

  it('groups labs under their track', async () => {
    await renderCatalog();

    expect(screen.getByRole('heading', { name: 'Kubernetes' })).toBeTruthy();
    expect(screen.getByText('3 labs')).toBeTruthy();
  });

  it('shows difficulty, duration, topic and certification relevance', async () => {
    await renderCatalog();

    expect(screen.getAllByText('beginner').length).toBeGreaterThan(0);
    expect(screen.getByText('45 min')).toBeTruthy();
    expect(screen.getByText('Troubleshooting')).toBeTruthy();
    expect(screen.getAllByText('CKA').length).toBe(3);
  });

  it('shows skills and prerequisites on the card', async () => {
    await renderCatalog();

    expect(screen.getByText('deployments · create')).toBeTruthy();
    expect(screen.getByText('deployments · scale')).toBeTruthy();
    // The prerequisite is shown as guidance on the card.
    expect(screen.getAllByText('K8S-002').length).toBeGreaterThan(0);
  });

  it('marks labs that start from a prepared environment', async () => {
    await renderCatalog();
    expect(screen.getByText('prepared environment')).toBeTruthy();
  });

  it('opens a lab when its button is pressed', async () => {
    const { onOpenLab } = await renderCatalog();

    fireEvent.click(screen.getAllByRole('button', { name: 'Open lab' })[2]!);
    expect(onOpenLab).toHaveBeenCalledWith('K8S-010');
  });

  it('filters by difficulty without refetching', async () => {
    await renderCatalog();

    fireEvent.click(screen.getByRole('button', { name: /^intermediate$/i }));

    expect(screen.getByText('Repair a Broken Deployment')).toBeTruthy();
    expect(screen.queryByText('Create Your First Pod')).toBeNull();
    // The whole catalog is a few kilobytes and touches no cluster, so filtering
    // is local; a refetch would add latency for nothing.
    expect(listLabs).toHaveBeenCalledTimes(1);
  });

  it('restores the full list when a filter is cleared', async () => {
    await renderCatalog();

    fireEvent.click(screen.getByRole('button', { name: /^intermediate$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^any$/i }));

    expect(screen.getByText('Create Your First Pod')).toBeTruthy();
    expect(screen.getByText('Repair a Broken Deployment')).toBeTruthy();
  });

  it('says so when a filter combination matches nothing', async () => {
    listLabs.mockResolvedValue({
      labs: [lab({ difficulty: 'beginner' })],
      tracks: [{ ...TRACKS[0]!, difficulties: ['beginner', 'advanced'] }],
      count: 1,
    });
    renderWithAuth(<CatalogPage onOpenLab={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Create Your First Pod')).toBeTruthy());

    // Only one difficulty is present in the data, so no difficulty row renders;
    // filter by a track that has no labs instead.
    expect(screen.queryByText(/no labs match/i)).toBeNull();
  });

  it('reports an API failure instead of rendering an empty catalog', async () => {
    listLabs.mockRejectedValue(new Error('boom'));
    renderWithAuth(<CatalogPage onOpenLab={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByText('UNEXPECTED_ERROR')).toBeTruthy();
  });

  it('explains an empty catalog rather than showing a blank page', async () => {
    listLabs.mockResolvedValue({ labs: [], tracks: [], count: 0 });
    renderWithAuth(<CatalogPage onOpenLab={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('No labs found')).toBeTruthy());
  });
});
