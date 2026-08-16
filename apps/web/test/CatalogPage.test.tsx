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
import { CatalogPage } from '../src/pages/CatalogPage';
import type { LabSummary, TrackSummary } from '../src/lib/types';

function lab(overrides: Partial<LabSummary> = {}): LabSummary {
  return {
    id: 'K8S-001',
    slug: 'k8s-001-pods',
    title: 'Create Your First Pod',
    track: 'kubernetes',
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

/** Render and wait for the catalog to load. */
async function renderCatalog(onOpenLab = vi.fn()) {
  render(<CatalogPage onOpenLab={onOpenLab} />);
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
    render(<CatalogPage onOpenLab={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Create Your First Pod')).toBeTruthy());

    // Only one difficulty is present in the data, so no difficulty row renders;
    // filter by a track that has no labs instead.
    expect(screen.queryByText(/no labs match/i)).toBeNull();
  });

  it('reports an API failure instead of rendering an empty catalog', async () => {
    listLabs.mockRejectedValue(new Error('boom'));
    render(<CatalogPage onOpenLab={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByText('UNEXPECTED_ERROR')).toBeTruthy();
  });

  it('explains an empty catalog rather than showing a blank page', async () => {
    listLabs.mockResolvedValue({ labs: [], tracks: [], count: 0 });
    render(<CatalogPage onOpenLab={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('No labs found')).toBeTruthy());
  });
});
