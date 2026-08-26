/**
 * PLATFORM-DOCKER — the catalog with more than one track.
 *
 * The catalog page never knew what a "track" was beyond a grouping key, and
 * that has to stay true: a second track appears because the API returned one,
 * ordered where the API put it, titled and subtitled with what the API said.
 * There is no list of known tracks in the frontend, and these tests use a
 * made-up third track to prove it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { renderWithAuth } from './auth-harness';
import { CatalogPage } from '../src/pages/CatalogPage';
import { StartOverlay } from '../src/components/StartOverlay';
import type { LabSummary, ProvisionStep, TrackSummary } from '../src/lib/types';

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
    provider: 'kubernetes',
    ...overrides,
  };
}

const LABS: LabSummary[] = [
  lab(),
  lab({
    id: 'DOCKER-001',
    slug: 'docker-001-first-container',
    title: 'Run Your First Container',
    track: 'docker',
    provider: 'docker',
    topic: 'containers',
    topicTitle: 'Containers',
    summary: 'Run a container named web from the nginx:1.27-alpine image.',
    skills: ['docker.containers.run'],
    certifications: ['DCA'],
  }),
  lab({
    id: 'DOCKER-010',
    slug: 'docker-010-troubleshooting',
    title: 'Repair a Broken Container',
    track: 'docker',
    provider: 'docker',
    topic: 'troubleshooting',
    topicTitle: 'Troubleshooting',
    difficulty: 'intermediate',
    order: 10,
    durationMinutes: 45,
    summary: 'Investigate a container that will not stay running.',
    hasSetup: true,
    skills: ['docker.containers.troubleshoot'],
    certifications: ['DCA'],
  }),
];

/** Deliberately returned Kubernetes-first, Docker-second, as the API orders them. */
const TRACKS: TrackSummary[] = [
  {
    track: 'kubernetes',
    providers: ['kubernetes'],
    title: 'Kubernetes',
    labCount: 1,
    topics: [{ topic: 'pods', title: 'Pods', labCount: 1 }],
    difficulties: ['beginner'],
    tagline: 'Pods, workloads, and the cluster APIs that schedule them.',
    order: 10,
  },
  {
    track: 'docker',
    providers: ['docker'],
    title: 'Docker',
    labCount: 2,
    topics: [
      { topic: 'containers', title: 'Containers', labCount: 1 },
      { topic: 'troubleshooting', title: 'Troubleshooting', labCount: 1 },
    ],
    difficulties: ['beginner', 'intermediate'],
    tagline: 'Containers, images, volumes, and the daemon underneath them.',
    order: 20,
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
  renderWithAuth(<CatalogPage onOpenLab={onOpenLab} />);
  await waitFor(() => expect(screen.getByText('Create Your First Pod')).toBeTruthy());
  return { onOpenLab };
}

describe('CatalogPage — more than one track', () => {
  it('renders a section per track, with the labs grouped under it', async () => {
    await renderCatalog();

    expect(screen.getByRole('heading', { name: 'Kubernetes' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Docker' })).toBeTruthy();
    expect(screen.getByText('Run Your First Container')).toBeTruthy();
    expect(screen.getByText('Repair a Broken Container')).toBeTruthy();
  });

  it('follows the API\'s track order rather than the order labs arrive in', async () => {
    // Docker is returned first in the lab list but second in the track list.
    listLabs.mockResolvedValue({
      labs: [LABS[1]!, LABS[2]!, LABS[0]!],
      tracks: TRACKS,
      count: 3,
    });
    renderWithAuth(<CatalogPage onOpenLab={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Create Your First Pod')).toBeTruthy());

    const headings = screen
      .getAllByRole('heading')
      .map((h) => h.textContent)
      .filter((text) => text === 'Kubernetes' || text === 'Docker');
    expect(headings).toEqual(['Kubernetes', 'Docker']);
  });

  it('shows a track\'s tagline when it declares one', async () => {
    await renderCatalog();

    expect(
      screen.getByText('Containers, images, volumes, and the daemon underneath them.'),
    ).toBeTruthy();
  });

  it('renders no subtitle for a track that declares none', async () => {
    listLabs.mockResolvedValue({
      labs: [LABS[1]!],
      tracks: [{ ...TRACKS[1]!, tagline: undefined }],
      count: 1,
    });
    renderWithAuth(<CatalogPage onOpenLab={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Run Your First Container')).toBeTruthy());

    expect(screen.queryByText(/daemon underneath them/)).toBeNull();
  });

  it('renders a brand-new track it has never heard of', async () => {
    // No table of tracks exists in the frontend: a track the API invents today
    // renders correctly today.
    listLabs.mockResolvedValue({
      labs: [lab({ id: 'TF-001', title: 'Write a Terraform Module', track: 'terraform' })],
      tracks: [
        {
          track: 'terraform',
          title: 'Terraform',
          labCount: 1,
          topics: [],
          difficulties: ['beginner'],
          tagline: 'Infrastructure as code.',
        },
      ],
      count: 1,
    });
    renderWithAuth(<CatalogPage onOpenLab={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('Write a Terraform Module')).toBeTruthy());
    expect(screen.getByRole('heading', { name: 'Terraform' })).toBeTruthy();
    expect(screen.getByText('Infrastructure as code.')).toBeTruthy();
  });

  it('filters across tracks without refetching', async () => {
    await renderCatalog();

    fireEvent.click(screen.getByRole('button', { name: /^intermediate$/i }));

    expect(screen.getByText('Repair a Broken Container')).toBeTruthy();
    expect(screen.queryByText('Create Your First Pod')).toBeNull();
    expect(screen.queryByText('Run Your First Container')).toBeNull();
    // The Kubernetes section disappears entirely rather than rendering empty.
    expect(screen.queryByRole('heading', { name: 'Kubernetes' })).toBeNull();
    expect(listLabs).toHaveBeenCalledTimes(1);
  });

  it('opens a Docker lab by its own id', async () => {
    const { onOpenLab } = await renderCatalog();
    const dockerCard = screen.getByText('Run Your First Container').closest('article');

    fireEvent.click(within(dockerCard as HTMLElement).getByRole('button', { name: 'Open lab' }));

    expect(onOpenLab).toHaveBeenCalledWith('DOCKER-001');
  });
});

// ---------------------------------------------------------------- overlay

const TERMINAL_PENDING: ProvisionStep = {
  id: 'terminal',
  label: 'Terminal connected',
  status: 'pending',
};

describe('StartOverlay — wording follows the lab\'s substrate', () => {
  it('names Docker for a Docker lab', () => {
    render(
      <StartOverlay
        phase="idle"
        steps={[]}
        terminalStep={TERMINAL_PENDING}
        error={null}
        onStart={vi.fn()}
        environmentName="Docker"
      />,
    );

    expect(screen.getByText(/A temporary Docker environment/)).toBeTruthy();
  });

  it('names Kubernetes for a Kubernetes lab', () => {
    render(
      <StartOverlay
        phase="idle"
        steps={[]}
        terminalStep={TERMINAL_PENDING}
        error={null}
        onStart={vi.fn()}
        environmentName="Kubernetes"
      />,
    );

    expect(screen.getByText(/A temporary Kubernetes environment/)).toBeTruthy();
  });

  it('stays neutral rather than naming the wrong technology', () => {
    // An unknown provider must not be described as Kubernetes, which is what
    // the hardcoded wording used to do. LabPage falls back to the track name,
    // and with nothing at all the overlay says only "lab".
    render(
      <StartOverlay
        phase="idle"
        steps={[]}
        terminalStep={TERMINAL_PENDING}
        error={null}
        onStart={vi.fn()}
      />,
    );

    expect(screen.getByText(/A temporary lab environment will be prepared/)).toBeTruthy();
    expect(screen.queryByText(/Kubernetes/)).toBeNull();
  });

  it('renders the Docker provisioning steps the backend reports', () => {
    const steps: ProvisionStep[] = [
      { id: 'sandbox-network', label: 'Sandbox network ready', status: 'ok' },
      { id: 'environment-created', label: 'Environment created', status: 'ok' },
      {
        id: 'docker-daemon',
        label: 'Docker daemon available',
        status: 'ok',
        detail: 'Docker Engine 27.3.1 — private daemon, 10 container budget',
      },
      { id: 'docker-cli', label: 'docker CLI ready', status: 'pending' },
    ];

    render(
      <StartOverlay
        phase="starting"
        steps={steps}
        terminalStep={TERMINAL_PENDING}
        error={null}
        onStart={vi.fn()}
        environmentName="Docker"
      />,
    );

    // Step labels are backend data, so a new substrate needs no component change.
    expect(screen.getByText('Sandbox network ready')).toBeTruthy();
    expect(screen.getByText('Docker daemon available')).toBeTruthy();
    expect(screen.getByText('docker CLI ready')).toBeTruthy();
    expect(screen.getByText(/private daemon, 10 container budget/)).toBeTruthy();
    expect(screen.getByText(/Preparing Docker environment/)).toBeTruthy();
  });
});
