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
 *   curl -s localhost:4000/api/labs/ANSIBLE-001 | jq '.data' > test/fixtures/lab-ansible-001.json
 *   curl -s localhost:4000/api/labs/ANSIBLE-010 | jq '.data' > test/fixtures/lab-ansible-010.json
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CatalogPage } from '../src/pages/CatalogPage';
import { LabBrief } from '../src/components/LabBrief';
import type { LabDetail, LabSummary, TrackSummary } from '../src/lib/types';
import catalog from './fixtures/labs.json';
import k8s010 from './fixtures/lab-k8s-010.json';
import k8s006 from './fixtures/lab-k8s-006.json';
import ansible001 from './fixtures/lab-ansible-001.json';
import ansible010 from './fixtures/lab-ansible-010.json';

const CATALOG = catalog as unknown as { labs: LabSummary[]; tracks: TrackSummary[]; count: number };
const TROUBLESHOOTING = k8s010 as unknown as LabDetail;
const JOBS = k8s006 as unknown as LabDetail;
const INVENTORY = ansible001 as unknown as LabDetail;
const ANSIBLE_TROUBLESHOOTING = ansible010 as unknown as LabDetail;

/** Labs in one track, from the captured catalog. */
const labsIn = (track: string) => CATALOG.labs.filter((lab) => lab.track === track);

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
  it('renders every shipped lab, grouped by track', async () => {
    render(<CatalogPage onOpenLab={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Create Your First Pod')).toBeTruthy());

    for (const lab of CATALOG.labs) {
      expect(screen.getByText(lab.title), lab.id).toBeTruthy();
    }

    // Track sections come from the API payload, not from anything in React.
    for (const track of CATALOG.tracks) {
      expect(screen.getByRole('heading', { name: track.title }), track.track).toBeTruthy();
    }
    expect(screen.getAllByText('10 labs')).toHaveLength(CATALOG.tracks.length);
  });

  it('shows the Ansible track alongside Kubernetes without any code change', async () => {
    render(<CatalogPage onOpenLab={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Create Your First Pod')).toBeTruthy());

    expect(screen.getByRole('heading', { name: 'Ansible' })).toBeTruthy();
    expect(screen.getByText('Build Your First Inventory')).toBeTruthy();
    expect(screen.getByText('Repair a Broken Ansible Project')).toBeTruthy();
    expect(labsIn('ansible')).toHaveLength(10);
  });

  it('shows every card with a duration, a difficulty and its skills', async () => {
    render(<CatalogPage onOpenLab={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Create Your First Pod')).toBeTruthy());

    // One badge per card, plus the one filter chip that offers that level.
    const countOf = (difficulty: string) =>
      CATALOG.labs.filter((lab) => lab.difficulty === difficulty).length + 1;

    expect(screen.getAllByText('beginner')).toHaveLength(countOf('beginner'));
    expect(screen.getAllByText('intermediate')).toHaveLength(countOf('intermediate'));
    expect(screen.getAllByText('advanced')).toHaveLength(countOf('advanced'));
    expect(screen.getAllByRole('button', { name: 'Open lab' })).toHaveLength(CATALOG.labs.length);
    // Labs that seed an environment say so.
    expect(screen.getAllByText('prepared environment')).toHaveLength(
      CATALOG.labs.filter((l) => l.hasSetup).length,
    );
  });

  it('filters the real catalog by track', async () => {
    render(<CatalogPage onOpenLab={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Create Your First Pod')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /^Ansible/ }));

    expect(screen.getByText('Build Your First Inventory')).toBeTruthy();
    expect(screen.queryByText('Create Your First Pod')).toBeNull();
  });

  it('filters the real catalog down to the intermediate labs', async () => {
    render(<CatalogPage onOpenLab={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Create Your First Pod')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /^intermediate$/i }));

    expect(screen.getByText('Signal Readiness with a Probe')).toBeTruthy();
    expect(screen.getByText('Repair a Broken Deployment')).toBeTruthy();
    expect(screen.queryByText('Create Your First Pod')).toBeNull();
  });

  it('opens the lab the student clicked', async () => {
    const onOpenLab = vi.fn();
    render(<CatalogPage onOpenLab={onOpenLab} />);
    await waitFor(() => expect(screen.getByText('Create Your First Pod')).toBeTruthy());

    const buttons = screen.getAllByRole('button', { name: 'Open lab' });
    fireEvent.click(buttons[CATALOG.labs.indexOf(labsIn('kubernetes').at(-1)!)]!);
    expect(onOpenLab).toHaveBeenCalledWith('K8S-010');
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

  it('renders an Ansible lab from the same component, with no track-specific code', () => {
    render(<LabBrief lab={INVENTORY} />);

    expect(screen.getByText('ANSIBLE-001')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Build Your First Inventory' })).toBeTruthy();
    expect(screen.getByText(/automation team at JumpToTech Bank/)).toBeTruthy();

    for (const requirement of INVENTORY.requirements) {
      expect(screen.getByText(requirement)).toBeTruthy();
    }
    for (const reference of INVENTORY.references) {
      expect(screen.getByRole('link', { name: new RegExp(reference.title) })).toBeTruthy();
    }
  });

  it('never renders the injected faults of the Ansible troubleshooting lab', () => {
    const { container } = render(<LabBrief lab={ANSIBLE_TROUBLESHOOTING} />);

    fireEvent.click(screen.getByRole('button', { name: /show a hint/i }));
    fireEvent.click(screen.getByRole('button', { name: /show hint 2/i }));
    fireEvent.click(screen.getByRole('button', { name: /show hint 3/i }));

    // The seeded project's actual mistakes are never named on the page.
    expect(container.textContent).not.toContain('app_prt');
    expect(container.textContent).not.toContain('webservers');
    expect(container.textContent).not.toContain('app.conf.jinja');
    expect(container.textContent).not.toContain('directoy');
    expect(container.textContent).not.toContain('ansible_user=deploy');
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
