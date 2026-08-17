/**
 * PLATFORM-003 — the UI against real API payloads.
 *
 * The fixtures in `test/fixtures/` are verbatim responses captured from a
 * running API serving the shipped labs. Rendering against them, rather than
 * against hand-written objects, is what catches a drift between what the API
 * actually sends and what the components expect — a shape mismatch that
 * hand-written fixtures would happily hide.
 *
 * Refresh them with:
 *   curl -s localhost:4000/api/labs             | jq '.data' > test/fixtures/labs.json
 *   curl -s localhost:4000/api/labs/K8S-010     | jq '.data' > test/fixtures/lab-k8s-010.json
 *   curl -s localhost:4000/api/labs/K8S-006     | jq '.data' > test/fixtures/lab-k8s-006.json
 *   curl -s localhost:4000/api/labs/LINUX-001   | jq '.data' > test/fixtures/lab-linux-001.json
 *   curl -s localhost:4000/api/labs/TF-001      | jq '.data' > test/fixtures/lab-tf-001.json
 *   curl -s localhost:4000/api/labs/DOCKER-004  | jq '.data' > test/fixtures/lab-docker-004.json
 *
 * They cover every shipped track. Each non-Kubernetes fixture is here for the
 * same reason as the Kubernetes ones: to catch the day a component quietly
 * starts depending on something only one substrate's payload happens to carry.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CatalogPage } from '../src/pages/CatalogPage';
import { LabBrief } from '../src/components/LabBrief';
import type { LabDetail, LabSummary, TrackSummary } from '../src/lib/types';
import catalog from './fixtures/labs.json';
import k8s010 from './fixtures/lab-k8s-010.json';
import k8s006 from './fixtures/lab-k8s-006.json';
import linux001 from './fixtures/lab-linux-001.json';
import tf001 from './fixtures/lab-tf-001.json';
import docker004 from './fixtures/lab-docker-004.json';

const CATALOG = catalog as unknown as { labs: LabSummary[]; tracks: TrackSummary[]; count: number };
const TROUBLESHOOTING = k8s010 as unknown as LabDetail;
const JOBS = k8s006 as unknown as LabDetail;
const LINUX = linux001 as unknown as LabDetail;
const TERRAFORM = tf001 as unknown as LabDetail;
const DOCKERFILE = docker004 as unknown as LabDetail;

const KUBERNETES_LABS = CATALOG.labs.filter((l) => l.track === 'kubernetes');
const DOCKER_LABS = CATALOG.labs.filter((l) => l.track === 'docker');

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
    render(<CatalogPage onOpenLab={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Create Your First Pod')).toBeTruthy());

    for (const lab of CATALOG.labs) {
      expect(screen.getByText(lab.title), lab.id).toBeTruthy();
    }
    // One page, four tracks, no per-technology component anywhere.
    expect(KUBERNETES_LABS).toHaveLength(10);
    expect(DOCKER_LABS).toHaveLength(10);
    expect(screen.getAllByText('10 labs')).toHaveLength(2);
    expect(screen.getAllByText('1 lab')).toHaveLength(2);
    for (const track of ['Kubernetes', 'Docker', 'Linux', 'Terraform']) {
      expect(screen.getByRole('heading', { name: track }), track).toBeTruthy();
    }
  });

  it('shows every card with a duration, a difficulty and its skills', async () => {
    render(<CatalogPage onOpenLab={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Create Your First Pod')).toBeTruthy());

    expect(screen.getAllByText('beginner').length).toBeGreaterThanOrEqual(7);
    expect(screen.getAllByText('intermediate').length).toBeGreaterThanOrEqual(3);
    expect(screen.getAllByText('CKA')).toHaveLength(KUBERNETES_LABS.length);
    expect(screen.getAllByText('DCA')).toHaveLength(DOCKER_LABS.length);
    expect(screen.getAllByRole('button', { name: 'Open lab' })).toHaveLength(CATALOG.labs.length);
    // Labs that seed an environment say so.
    expect(screen.getAllByText('prepared environment')).toHaveLength(
      CATALOG.labs.filter((l) => l.hasSetup).length,
    );
  });

  it('filters the real catalog down to the intermediate labs', async () => {
    render(<CatalogPage onOpenLab={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Create Your First Pod')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /^intermediate$/i }));

    expect(screen.getByText('Signal Readiness with a Probe')).toBeTruthy();
    expect(screen.getByText('Repair a Broken Deployment')).toBeTruthy();
    expect(screen.queryByText('Create Your First Pod')).toBeNull();
    // The facet spans the catalog, so both tracks narrow at once.
    expect(screen.getByText('3 labs')).toBeTruthy();
    expect(screen.getByText('6 labs')).toBeTruthy();
  });

  it('opens the lab the student clicked', async () => {
    const onOpenLab = vi.fn();
    render(<CatalogPage onOpenLab={onOpenLab} />);
    await waitFor(() => expect(screen.getByText('Create Your First Pod')).toBeTruthy());

    const openButtons = screen.getAllByRole('button', { name: 'Open lab' });
    fireEvent.click(openButtons[KUBERNETES_LABS.length - 1]!);
    expect(onOpenLab).toHaveBeenCalledWith('K8S-010');

    fireEvent.click(openButtons[KUBERNETES_LABS.length]!);
    expect(onOpenLab).toHaveBeenCalledWith('DOCKER-001');
  });

  it('never renders a lab\'s expected end state on a card', async () => {
    const { container } = render(<CatalogPage onOpenLab={vi.fn()} />);
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
    expect(screen.getByRole('heading', { name: 'Files, Directories & Permissions' })).toBeTruthy();
    expect(screen.getByText('deploy permissions are rwxr-x---')).toBeTruthy();
    expect(screen.getByRole('link', { name: /chmod\(1\)/ })).toBeTruthy();
    // No Kubernetes vocabulary leaks into a Linux lab.
    expect(screen.queryByText(/namespace/i)).toBeNull();
    unmount();

    render(<LabBrief lab={TERRAFORM} />);
    expect(screen.getByText('TF-001')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Terraform Init, Plan & Apply' })).toBeTruthy();
    expect(screen.getByText('Terraform is initialised in the terraform directory')).toBeTruthy();
    expect(screen.queryByText('Files, Directories & Permissions')).toBeNull();
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
