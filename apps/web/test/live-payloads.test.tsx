/**
 * PLATFORM-003 / PLATFORM-LINUX-001 — the UI against real API payloads.
 *
 * The fixtures in `test/fixtures/` are verbatim responses captured from an API
 * serving the shipped labs. Rendering against them, rather than against
 * hand-written objects, is what catches a drift between what the API actually
 * sends and what the components expect — a shape mismatch that hand-written
 * fixtures would happily hide. Since PLATFORM-LINUX-001 that payload carries
 * two tracks, which is the shape the catalog now has to render.
 *
 * Refresh them with:
 *   curl -s localhost:4000/api/labs             | jq '.data' > test/fixtures/labs.json
 *   curl -s localhost:4000/api/labs/K8S-010     | jq '.data' > test/fixtures/lab-k8s-010.json
 *   curl -s localhost:4000/api/labs/K8S-006     | jq '.data' > test/fixtures/lab-k8s-006.json
 *   curl -s localhost:4000/api/labs/LINUX-001   | jq '.data' > test/fixtures/lab-linux-001.json
 *   curl -s localhost:4000/api/labs/LINUX-010   | jq '.data' > test/fixtures/lab-linux-010.json
 *   curl -s localhost:4000/api/labs/TF-001      | jq '.data' > test/fixtures/lab-tf-001.json
 *   curl -s localhost:4000/api/labs/DOCKER-004  | jq '.data' > test/fixtures/lab-docker-004.json
 *
 * They cover every shipped track. Each non-Kubernetes fixture is here for the
 * same reason as the Kubernetes ones: to catch the day a component quietly
 * starts depending on something only one substrate's payload happens to carry.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { renderWithAuth } from './auth-harness';
import { CatalogPage } from '../src/pages/CatalogPage';
import { LabBrief } from '../src/components/LabBrief';
import type { LabDetail, LabSummary, TrackSummary } from '../src/lib/types';
import catalog from './fixtures/labs.json';
import k8s010 from './fixtures/lab-k8s-010.json';
import k8s006 from './fixtures/lab-k8s-006.json';
import linux001 from './fixtures/lab-linux-001.json';
import linux010 from './fixtures/lab-linux-010.json';
import tf001 from './fixtures/lab-tf-001.json';
import docker004 from './fixtures/lab-docker-004.json';

const CATALOG = catalog as unknown as { labs: LabSummary[]; tracks: TrackSummary[]; count: number };
const TROUBLESHOOTING = k8s010 as unknown as LabDetail;
const JOBS = k8s006 as unknown as LabDetail;
const LINUX = linux001 as unknown as LabDetail;
const LINUX_TROUBLESHOOTING = linux010 as unknown as LabDetail;
const TERRAFORM = tf001 as unknown as LabDetail;
const DOCKERFILE = docker004 as unknown as LabDetail;

const KUBERNETES_LABS = CATALOG.labs.filter((l) => l.track === 'kubernetes');
const DOCKER_LABS = CATALOG.labs.filter((l) => l.track === 'docker');

const labsIn = (track: string) => CATALOG.labs.filter((lab) => lab.track === track);

/** A literal match for text that may contain regex metacharacters. */
const escaped = (value: string) => new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

const listLabs = vi.fn();
vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  return { ...actual, api: { listLabs: (...args: unknown[]) => listLabs(...args) } };
});

beforeEach(() => {
  listLabs.mockReset();
  listLabs.mockResolvedValue(CATALOG);
});

describe('catalog UI against the real API payload (test requirement 34)', () => {
  it('renders every shipped lab, grouped into its track', async () => {
    renderWithAuth(<CatalogPage onOpenLab={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Create Your First Pod')).toBeTruthy());

    for (const lab of CATALOG.labs) {
      expect(screen.getByText(lab.title), lab.id).toBeTruthy();
    }
    // One page, every shipped track, no per-technology component anywhere.
    expect(CATALOG.count).toBe(CATALOG.labs.length);
    expect(KUBERNETES_LABS).toHaveLength(10);
    expect(DOCKER_LABS).toHaveLength(10);
    expect(labsIn('linux')).toHaveLength(10);
    for (const track of CATALOG.tracks) {
      expect(screen.getByRole('heading', { name: track.title }), track.track).toBeTruthy();
    }
  });

  it('offers each shipped track as a card, from the API’s own track summary', async () => {
    renderWithAuth(<CatalogPage onOpenLab={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Create Your First Pod')).toBeTruthy());

    const cards = within(screen.getByLabelText('Tracks')).getAllByRole('button');
    expect(cards).toHaveLength(CATALOG.tracks.length);
    CATALOG.tracks.forEach((track, index) => {
      const card = cards[index]!;
      expect(within(card).getByText(track.title)).toBeTruthy();
      expect(
        within(card).getByText(`${track.labCount} lab${track.labCount === 1 ? '' : 's'}`),
      ).toBeTruthy();
      if (track.tagline) expect(within(card).getByText(track.tagline)).toBeTruthy();
    });
  });

  it('shows every card with a duration, a difficulty and its skills', async () => {
    renderWithAuth(<CatalogPage onOpenLab={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Create Your First Pod')).toBeTruthy());

    // One badge per card, plus the one filter chip that offers that level.
    const count = (value: string) => CATALOG.labs.filter((l) => l.difficulty === value).length + 1;
    expect(screen.getAllByText('beginner')).toHaveLength(count('beginner'));
    expect(screen.getAllByText('intermediate')).toHaveLength(count('intermediate'));
    expect(screen.getAllByText('CKA')).toHaveLength(KUBERNETES_LABS.length);
    expect(screen.getAllByText('DCA')).toHaveLength(DOCKER_LABS.length);
    expect(screen.getAllByRole('button', { name: 'Open lab' })).toHaveLength(CATALOG.labs.length);
    // Labs that seed an environment say so, on every track.
    expect(screen.getAllByText('prepared environment')).toHaveLength(
      CATALOG.labs.filter((l) => l.hasSetup).length,
    );
  });

  it('narrows the real catalog to one track, then to one of its topics', async () => {
    renderWithAuth(<CatalogPage onOpenLab={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Create Your First Pod')).toBeTruthy());

    fireEvent.click(within(screen.getByLabelText('Track')).getByRole('button', { name: /^Linux/ }));

    expect(screen.getByText('Files and Directories')).toBeTruthy();
    expect(screen.queryByText('Create Your First Pod')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Open lab' })).toHaveLength(
      labsIn('linux').length,
    );

    const linuxTrack = CATALOG.tracks.find((t) => t.track === 'linux')!;
    const topics = within(screen.getByLabelText('Topic'));
    for (const topic of linuxTrack.topics) {
      expect(topics.getByRole('button', { name: new RegExp(topic.title) }), topic.topic).toBeTruthy();
    }

    fireEvent.click(topics.getByRole('button', { name: /Shell Scripting/ }));
    expect(screen.getAllByRole('button', { name: 'Open lab' })).toHaveLength(
      labsIn('linux').filter((l) => l.topicTitle === 'Shell Scripting').length,
    );
  });

  it('filters the real catalog down to the intermediate labs', async () => {
    renderWithAuth(<CatalogPage onOpenLab={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Create Your First Pod')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /^intermediate$/i }));

    expect(screen.getByText('Signal Readiness with a Probe')).toBeTruthy();
    expect(screen.getByText('Repair a Broken Deployment')).toBeTruthy();
    expect(screen.queryByText('Create Your First Pod')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Open lab' })).toHaveLength(
      CATALOG.labs.filter((l) => l.difficulty === 'intermediate').length,
    );
  });

  it('opens the lab the student clicked', async () => {
    const onOpenLab = vi.fn();
    renderWithAuth(<CatalogPage onOpenLab={onOpenLab} />);
    await waitFor(() => expect(screen.getByText('Create Your First Pod')).toBeTruthy());

    const openButtons = screen.getAllByRole('button', { name: 'Open lab' });
    fireEvent.click(openButtons[KUBERNETES_LABS.length - 1]!);
    expect(onOpenLab).toHaveBeenCalledWith('K8S-010');

    fireEvent.click(openButtons[KUBERNETES_LABS.length]!);
    expect(onOpenLab).toHaveBeenCalledWith('DOCKER-001');
  });

  it('never renders a lab\'s expected end state on a card', async () => {
    const { container } = renderWithAuth(<CatalogPage onOpenLab={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Create Your First Pod')).toBeTruthy());

    expect(container.textContent).not.toContain('nginx:stabel');
    expect(container.textContent).not.toContain('setup/ledger-api.yaml');
  });
});

describe('lab page UI against the real API payload (test requirement 35)', () => {
  it('renders the troubleshooting lab from its real definition', () => {
    render(<LabBrief lab={TROUBLESHOOTING} />);

    expect(screen.getByText('K8S-010')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Repair a Broken Deployment' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Scenario' })).toBeTruthy();
    expect(screen.getByText(/You are on call/)).toBeTruthy();
    expect(screen.getByText('45 min')).toBeTruthy();
    expect(screen.getByText('Troubleshooting')).toBeTruthy();

    for (const requirement of TROUBLESHOOTING.requirements) {
      expect(screen.getByText(requirement)).toBeTruthy();
    }
    for (const reference of TROUBLESHOOTING.references) {
      expect(screen.getByRole('link', { name: new RegExp(reference.title) })).toBeTruthy();
    }
  });

  it('renders a completely different lab from the same component', () => {
    render(<LabBrief lab={JOBS} />);

    expect(screen.getByText('K8S-006')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Run a One-Time Task with a Job' })).toBeTruthy();
    expect(screen.getByText('Job completed successfully')).toBeTruthy();
    // Nothing from the troubleshooting lab bleeds through.
    expect(screen.queryByText('Repair a Broken Deployment')).toBeNull();
  });

  it('renders a Linux lab and a Terraform lab from the same component', () => {
    // The point of PLATFORM-004 in one assertion: no LinuxLabPage, no
    // TerraformLabPage. The same brief renders a Kubernetes lab, a Linux lab
    // and a Terraform lab, because the only thing that differs is the data.
    const { unmount } = render(<LabBrief lab={LINUX} />);
    expect(screen.getByText('LINUX-001')).toBeTruthy();
    expect(screen.getByRole('heading', { name: LINUX.title })).toBeTruthy();
    // No Kubernetes vocabulary leaks into a Linux lab.
    expect(screen.queryByText(/namespace/i)).toBeNull();
    unmount();

    render(<LabBrief lab={TERRAFORM} />);
    expect(screen.getByText('TF-001')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Terraform Init, Plan & Apply' })).toBeTruthy();
    expect(screen.getByText('Terraform is initialised in the terraform directory')).toBeTruthy();
    expect(screen.queryByText(LINUX.title)).toBeNull();
  });

  it('renders a Docker lab through the same component', () => {
    // No component knows what Docker is: the brief is rendered from the same
    // fields, populated from the same lab.yaml keys.
    render(<LabBrief lab={DOCKERFILE} />);

    expect(screen.getByText('DOCKER-004')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Build an Image from a Dockerfile' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Scenario' })).toBeTruthy();

    for (const requirement of DOCKERFILE.requirements) {
      expect(screen.getByText(requirement)).toBeTruthy();
    }
    for (const reference of DOCKERFILE.references) {
      expect(screen.getByRole('link', { name: new RegExp(reference.title) })).toBeTruthy();
      expect(new URL(reference.url).hostname).toMatch(/docker\.com$/);
    }
  });

  it('serves a container-backed lab with its provider and readiness', () => {
    expect(LINUX.environment).toEqual({ provider: 'linux', isolation: 'container' });
    expect(TERRAFORM.environment).toEqual({ provider: 'terraform', isolation: 'container' });
    expect(DOCKERFILE.environment).toEqual({ provider: 'docker', isolation: 'container' });
    expect(LINUX.availability?.available).toBe(true);
    // And still no answer key: requirements arrive as student-facing labels.
    expect(LINUX.requirements.every((r) => typeof r === 'string')).toBe(true);
  });

  it('shows prerequisites as guidance, not as a gate', () => {
    render(<LabBrief lab={TROUBLESHOOTING} />);

    expect(screen.getByText('Expose a Workload with a Service')).toBeTruthy();
    expect(screen.getByText('Signal Readiness with a Probe')).toBeTruthy();
    expect(screen.getByText(/nothing stops you starting this lab now/i)).toBeTruthy();
  });

  it('unlocks the real hint ladder one step at a time (test requirement 36)', () => {
    render(<LabBrief lab={TROUBLESHOOTING} />);
    // YAML folded scalars keep a trailing newline that the DOM renders trimmed.
    const [first, second, third] = TROUBLESHOOTING.hints.map((hint) => hint.text.trim());

    expect(screen.getByText('0 of 3')).toBeTruthy();
    expect(screen.queryByText(first!)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /show a hint/i }));
    expect(screen.getByText(first!)).toBeTruthy();
    expect(screen.queryByText(second!)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /show hint 2/i }));
    expect(screen.getByText(second!)).toBeTruthy();
    expect(screen.queryByText(third!)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /show hint 3/i }));
    expect(screen.getByText(third!)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /show/i })).toBeNull();
  });

  it('renders a Linux lab through the same component, with no Kubernetes wording', () => {
    const { container } = render(<LabBrief lab={LINUX} />);

    expect(screen.getByText('LINUX-001')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Files and Directories' })).toBeTruthy();
    expect(screen.getByText('20 min')).toBeTruthy();
    expect(screen.getByText('Linux Fundamentals')).toBeTruthy();

    for (const requirement of LINUX.requirements) {
      expect(screen.getByText(requirement)).toBeTruthy();
    }
    for (const reference of LINUX.references) {
      // Man-page titles contain regex metacharacters — `mkdir(1)`.
      expect(screen.getByRole('link', { name: escaped(reference.title) })).toBeTruthy();
    }

    // Nothing about the other track leaks into a Linux brief.
    expect(container.textContent).not.toContain('kubectl');
    expect(container.textContent).not.toContain('namespace');
    expect(container.textContent).not.toContain('Pod');
  });

  it('never names the container a Linux lab will run in', () => {
    const { container } = render(<LabBrief lab={LINUX} />);

    // The sandbox is derived from the session server-side; a lab that could
    // name one could name someone else's.
    expect(container.textContent).not.toContain('jtt-lnx-');
    expect(container.textContent).not.toContain('docker');
  });

  it('does not put the Linux troubleshooting lab\'s injected fault on the page', () => {
    const { container } = render(<LabBrief lab={LINUX_TROUBLESHOOTING} />);

    expect(screen.getByText('LINUX-010')).toBeTruthy();
    for (const hint of LINUX_TROUBLESHOOTING.hints) {
      fireEvent.click(screen.getByRole('button', { name: /show/i }));
      expect(screen.getByText(hint.text.trim())).toBeTruthy();
    }
    // Even fully hinted, the brief never states the seeded fault or its fix.
    expect(container.textContent).not.toContain('seed.sh');
    expect(container.textContent).not.toContain('/etc/');
  });

  it('does not put the troubleshooting lab\'s fault on the page', () => {
    const { container } = render(<LabBrief lab={TROUBLESHOOTING} />);

    // Even with every hint revealed, the page never states the broken values.
    fireEvent.click(screen.getByRole('button', { name: /show a hint/i }));
    fireEvent.click(screen.getByRole('button', { name: /show hint 2/i }));
    fireEvent.click(screen.getByRole('button', { name: /show hint 3/i }));

    expect(container.textContent).not.toContain('nginx:stabel');
    expect(container.textContent).not.toContain('app: ledger"');
  });
});
