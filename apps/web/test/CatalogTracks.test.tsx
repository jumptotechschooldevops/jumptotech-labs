/**
 * The catalog with more than one track.
 *
 * The page must present tracks as a choice, let a student open one, and then
 * navigate that track by topic. None of it is keyed to a track name: the
 * fixtures below are the shape the API serves, and a third track would render
 * the same way without a line of frontend work.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CatalogPage } from '../src/pages/CatalogPage';
import type { LabSummary, TrackSummary } from '../src/lib/types';

function lab(overrides: Partial<LabSummary> = {}): LabSummary {
  return {
    id: 'K8S-001',
    slug: 'k8s-001-pods',
    title: 'Create Your First Pod',
    track: 'kubernetes',
    // The provider the API serves alongside each card, so the page can mark a
    // track unavailable without knowing what a track *is*.
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
  lab({ id: 'K8S-002', slug: 'k8s-002-deployments', title: 'Run a Deployment', topic: 'workloads', topicTitle: 'Workloads', order: 2 }),
  lab({
    id: 'LINUX-001',
    slug: 'linux-001-files',
    title: 'Files and Directories',
    track: 'linux',
    topic: 'linux-fundamentals',
    topicTitle: 'Linux Fundamentals',
    order: 1,
    summary: 'Build a project directory tree.',
    skills: ['linux.files.create'],
    certifications: ['LFCS'],
  }),
  lab({
    id: 'LINUX-003',
    slug: 'linux-003-users-groups',
    title: 'Users and Groups',
    track: 'linux',
    topic: 'linux-administration',
    topicTitle: 'Linux Administration',
    order: 3,
    summary: 'Create a group and a service account.',
    skills: ['linux.accounts.groups'],
    certifications: ['LFCS'],
  }),
  lab({
    id: 'LINUX-010',
    slug: 'linux-010-troubleshooting',
    title: 'Linux Troubleshooting',
    track: 'linux',
    topic: 'troubleshooting',
    topicTitle: 'Troubleshooting',
    difficulty: 'advanced',
    order: 10,
    summary: 'Restore a broken ledger service.',
    skills: ['linux.troubleshooting.diagnose'],
    hasSetup: true,
    certifications: ['LFCS'],
  }),
];

const TRACKS: TrackSummary[] = [
  {
    track: 'kubernetes',
    title: 'Kubernetes',
    tagline: 'CKA-oriented Kubernetes practice on a live cluster',
    labCount: 2,
    topics: [
      { topic: 'pods', title: 'Pods', labCount: 1 },
      { topic: 'workloads', title: 'Workloads', labCount: 1 },
    ],
    difficulties: ['beginner'],
  },
  {
    track: 'linux',
    title: 'Linux',
    tagline: 'Linux for DevOps engineers, on a real shell',
    labCount: 3,
    topics: [
      { topic: 'linux-fundamentals', title: 'Linux Fundamentals', labCount: 1 },
      { topic: 'linux-administration', title: 'Linux Administration', labCount: 1 },
      { topic: 'troubleshooting', title: 'Troubleshooting', labCount: 1 },
    ],
    difficulties: ['beginner', 'advanced'],
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

async function renderCatalog(onOpenLab = vi.fn()) {
  render(<CatalogPage onOpenLab={onOpenLab} />);
  await waitFor(() => expect(screen.getByText('Files and Directories')).toBeTruthy());
  return { onOpenLab };
}

describe('a catalog with two tracks', () => {
  it('offers both tracks as a choice, with counts and taglines', async () => {
    await renderCatalog();

    const tracks = screen.getByRole('region', { name: 'Tracks' });
    const cards = within(tracks).getAllByRole('button');

    expect(cards).toHaveLength(2);
    expect(within(cards[0]!).getByText('Kubernetes')).toBeTruthy();
    expect(within(cards[0]!).getByText('2 labs')).toBeTruthy();
    expect(within(cards[1]!).getByText('Linux')).toBeTruthy();
    expect(within(cards[1]!).getByText('3 labs')).toBeTruthy();
    expect(within(cards[1]!).getByText(/Linux for DevOps engineers/)).toBeTruthy();
  });

  it('shows every lab from both tracks, grouped under its own track', async () => {
    await renderCatalog();

    expect(screen.getByRole('heading', { name: 'Kubernetes' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Linux' })).toBeTruthy();
    expect(screen.getByText('Create Your First Pod')).toBeTruthy();
    expect(screen.getByText('Files and Directories')).toBeTruthy();
    expect(screen.getByText('Linux Troubleshooting')).toBeTruthy();
  });

  it('opening the Linux track shows only Linux labs, and its topics', async () => {
    await renderCatalog();

    const tracks = screen.getByRole('region', { name: 'Tracks' });
    fireEvent.click(within(tracks).getAllByRole('button')[1]!);

    // Kubernetes labs are gone …
    expect(screen.queryByText('Create Your First Pod')).toBeNull();
    expect(screen.getByText('Files and Directories')).toBeTruthy();
    expect(screen.getByText('Users and Groups')).toBeTruthy();

    // … and the track's topics are offered as the next level of navigation.
    const topics = screen.getByRole('group', { name: 'Topic' });
    expect(within(topics).getByRole('button', { name: /Linux Fundamentals/ })).toBeTruthy();
    expect(within(topics).getByRole('button', { name: /Linux Administration/ })).toBeTruthy();
    expect(within(topics).getByRole('button', { name: /Troubleshooting/ })).toBeTruthy();

    // The whole catalog is a few kilobytes and touches no environment, so
    // navigating it never refetches.
    expect(listLabs).toHaveBeenCalledTimes(1);
  });

  it('filters a track down to one topic, and back again', async () => {
    await renderCatalog();

    const tracks = screen.getByRole('region', { name: 'Tracks' });
    fireEvent.click(within(tracks).getAllByRole('button')[1]!);

    const topics = screen.getByRole('group', { name: 'Topic' });
    fireEvent.click(within(topics).getByRole('button', { name: /Linux Administration/ }));

    expect(screen.getByText('Users and Groups')).toBeTruthy();
    expect(screen.queryByText('Files and Directories')).toBeNull();

    fireEvent.click(within(screen.getByRole('group', { name: 'Topic' })).getByRole('button', { name: 'All topics' }));
    expect(screen.getByText('Files and Directories')).toBeTruthy();
  });

  it('returns to every track from inside one', async () => {
    await renderCatalog();

    fireEvent.click(within(screen.getByRole('region', { name: 'Tracks' })).getAllByRole('button')[1]!);
    expect(screen.queryByText('Create Your First Pod')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'All tracks' }));

    expect(screen.getByText('Create Your First Pod')).toBeTruthy();
    expect(screen.getByText('Files and Directories')).toBeTruthy();
  });

  it('clears the topic when the track changes, so no filter survives its own track', async () => {
    await renderCatalog();

    fireEvent.click(within(screen.getByRole('region', { name: 'Tracks' })).getAllByRole('button')[1]!);
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Topic' })).getByRole('button', { name: /Troubleshooting/ }),
    );
    expect(screen.queryByText('Files and Directories')).toBeNull();

    // Switch to Kubernetes via the track filter row.
    fireEvent.click(within(screen.getByRole('group', { name: 'Track' })).getByRole('button', { name: /Kubernetes/ }));

    expect(screen.getByText('Create Your First Pod')).toBeTruthy();
    expect(screen.getByText('Run a Deployment')).toBeTruthy();
  });

  it('renders a Linux lab card with everything it needs, and no Kubernetes wording', async () => {
    await renderCatalog();

    const card = screen.getByText('Linux Troubleshooting').closest('article');
    expect(card).toBeTruthy();
    expect(within(card!).getByText('LINUX-010')).toBeTruthy();
    expect(within(card!).getByText('advanced')).toBeTruthy();
    expect(within(card!).getByText('LFCS')).toBeTruthy();
    expect(within(card!).getByText('Troubleshooting')).toBeTruthy();
    expect(within(card!).getByText('prepared environment')).toBeTruthy();
    expect(within(card!).getByText('troubleshooting · diagnose')).toBeTruthy();
  });

  it('opens a Linux lab by id', async () => {
    const { onOpenLab } = await renderCatalog();

    const card = screen.getByText('Files and Directories').closest('article');
    fireEvent.click(within(card!).getByRole('button', { name: 'Open lab' }));

    expect(onOpenLab).toHaveBeenCalledWith('LINUX-001');
  });

  it('does not offer a track chooser when there is only one track', async () => {
    listLabs.mockResolvedValue({
      labs: LABS.filter((l) => l.track === 'kubernetes'),
      tracks: [TRACKS[0]!],
      count: 2,
    });
    render(<CatalogPage onOpenLab={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Create Your First Pod')).toBeTruthy());

    // A row of one is not a choice; the page goes straight to the labs.
    expect(screen.queryByRole('region', { name: 'Tracks' })).toBeNull();
  });
});
