/**
 * PLATFORM-003 — the generic lab brief (story test requirement 35).
 *
 * One component renders every lab, on the lab page and in the workspace. These
 * tests feed it two very different definitions and assert that the difference
 * in output comes entirely from the metadata — there is no branch on a lab id
 * anywhere in the component.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { LabBrief } from '../src/components/LabBrief';
import type { LabDetail } from '../src/lib/types';

function detail(overrides: Partial<LabDetail> = {}): LabDetail {
  return {
    id: 'K8S-002',
    slug: 'k8s-002-deployments',
    title: 'Run an Application with a Deployment',
    track: 'kubernetes',
    topic: 'workloads',
    topicTitle: 'Workloads',
    difficulty: 'beginner',
    level: 'practice',
    durationMinutes: 30,
    environment: { provider: 'kubernetes', isolation: 'namespace' },
    story: 'The customer frontend runs as a single Pod.\n\nIt must survive a node drain.',
    objectives: ['Describe what a Deployment adds on top of a bare Pod'],
    task: {
      summary: 'Create a Deployment named frontend running 3 replicas.',
      description: 'A Deployment describes a desired state.\n\nCreate one named `frontend`.',
    },
    requirements: ['Deployment frontend exists', 'Deployment requests 3 replicas'],
    hints: [
      { level: 1, text: 'A Deployment is a controller.' },
      { level: 2, text: 'Check the replica count.' },
    ],
    references: [
      { title: 'Deployments', url: 'https://kubernetes.io/docs/concepts/workloads/controllers/deployment/' },
    ],
    skills: ['kubernetes.deployments.create', 'kubernetes.deployments.scale'],
    certifications: [{ certification: 'CKA', domains: ['workloads-and-scheduling'] }],
    prerequisites: [{ id: 'K8S-001', title: 'Create Your First Pod', available: true }],
    prerequisitesEnforced: false,
    hasSetup: false,
    ...overrides,
  };
}

/** A deliberately different lab: no story, no objectives, no prerequisites. */
const MINIMAL = detail({
  id: 'K8S-006',
  slug: 'k8s-006-jobs',
  title: 'Run a One-Time Task with a Job',
  topic: 'batch',
  topicTitle: 'Batch',
  durationMinutes: 45,
  difficulty: 'intermediate',
  task: { summary: 'Create a Job named ledger-migration.', description: 'A Job runs to completion.' },
  requirements: ['Job ledger-migration exists', 'Job completed successfully'],
  references: [{ title: 'Jobs', url: 'https://kubernetes.io/docs/concepts/workloads/controllers/job/' }],
  skills: ['kubernetes.jobs.create'],
  certifications: [],
  hints: [],
  objectives: [],
  prerequisites: [],
  ...{ story: undefined },
});

describe('LabBrief — one component, many labs', () => {
  it('renders a full lab definition', () => {
    render(<LabBrief lab={detail()} />);

    expect(screen.getByText('K8S-002')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Run an Application with a Deployment' })).toBeTruthy();
    expect(screen.getByText('Beginner')).toBeTruthy();
    expect(screen.getByText('30 min')).toBeTruthy();
    expect(screen.getByText('Workloads')).toBeTruthy();
    expect(screen.getByText('CKA')).toBeTruthy();
  });

  it('renders a different lab from the same component', () => {
    render(<LabBrief lab={MINIMAL} />);

    expect(screen.getByText('K8S-006')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Run a One-Time Task with a Job' })).toBeTruthy();
    expect(screen.getByText('Job completed successfully')).toBeTruthy();
    expect(screen.getByText('45 min')).toBeTruthy();
  });

  it('renders the scenario as paragraphs', () => {
    render(<LabBrief lab={detail()} />);

    expect(screen.getByRole('heading', { name: 'Scenario' })).toBeTruthy();
    expect(screen.getByText('The customer frontend runs as a single Pod.')).toBeTruthy();
    expect(screen.getByText('It must survive a node drain.')).toBeTruthy();
  });

  it('renders objectives, task, what Verify checks, and documentation', () => {
    render(<LabBrief lab={detail()} />);

    expect(screen.getByText('Describe what a Deployment adds on top of a bare Pod')).toBeTruthy();
    expect(screen.getByText('Create a Deployment named frontend running 3 replicas.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'What Verify checks' })).toBeTruthy();
    expect(screen.getByText('Deployment requests 3 replicas')).toBeTruthy();
    // Backticked names in lab prose are code, not literal backticks.
    expect(screen.getByText('frontend', { selector: 'code' })).toBeTruthy();

    const link = screen.getByRole('link', { name: /Deployments/ });
    expect(link.getAttribute('href')).toBe('https://kubernetes.io/docs/concepts/workloads/controllers/deployment/');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('omits sections a lab does not define', () => {
    render(<LabBrief lab={MINIMAL} />);

    // No story, objectives, prerequisites or hints in this definition — and so
    // no empty headings for them either.
    expect(screen.queryByRole('heading', { name: 'Scenario' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'What you will learn' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Recommended first' })).toBeNull();
    expect(screen.queryByRole('heading', { name: /Hints/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: /certification/ })).toBeNull();
  });

  it('shows prerequisites as a recommendation, linked, and says they are not enforced', () => {
    render(<LabBrief lab={detail()} />);

    const link = screen.getByRole('link', { name: /Create Your First Pod/ });
    expect(link.getAttribute('href')).toBe('#/labs/K8S-001');
    // The API serves prerequisitesEnforced: false, so the UI must not imply a gate.
    expect(screen.getByText(/nothing stops you starting this lab now/i)).toBeTruthy();
  });

  it('says certification topics are related practice, not an award', () => {
    render(<LabBrief lab={detail()} />);
    expect(screen.getByText(/does not award a certification/)).toBeTruthy();
  });

  it('embeds the progressive hint ladder, and can leave it out', () => {
    const { unmount } = render(<LabBrief lab={detail()} />);

    expect(screen.getByText('0 of 2')).toBeTruthy();
    expect(screen.queryByText('A Deployment is a controller.')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /show a hint/i }));
    expect(screen.getByText('A Deployment is a controller.')).toBeTruthy();
    expect(screen.queryByText('Check the replica count.')).toBeNull();
    unmount();

    render(<LabBrief lab={detail()} showHints={false} />);
    expect(screen.queryByRole('button', { name: /show a hint/i })).toBeNull();
  });

  it('marks the checklist with the last verification, only when the checks match the requirements', () => {
    const { unmount } = render(
      <LabBrief
        lab={detail()}
        checks={[
          { id: 'a', label: 'Deployment frontend exists', status: 'pass' },
          { id: 'b', label: 'Deployment requests 3 replicas', status: 'fail', detail: 'found 1' },
        ]}
      />,
    );
    const checklist = screen.getByRole('heading', { name: /What Verify checks/ }).parentElement!;
    expect(within(checklist).getByText('1 of 2 passing')).toBeTruthy();
    expect(within(checklist).getByText(/— passed/)).toBeTruthy();
    expect(within(checklist).getByText(/— not yet passing/)).toBeTruthy();
    unmount();

    // A stale result for a different set of requirements marks nothing.
    render(<LabBrief lab={detail()} checks={[{ id: 'x', label: 'Something else', status: 'pass' }]} />);
    expect(screen.queryByText(/passing$/)).toBeNull();
  });

  it('lists the skills a lab practises', () => {
    render(<LabBrief lab={detail()} />);

    expect(screen.getByText('deployments · create')).toBeTruthy();
    expect(screen.getByText('deployments · scale')).toBeTruthy();
  });

  it('renders no lab content that is not in the definition', () => {
    const { container } = render(<LabBrief lab={MINIMAL} />);

    // Nothing about Deployments leaks into a Jobs lab: the component holds no
    // lab-specific text of its own.
    expect(container.textContent).not.toContain('Deployment');
    expect(container.textContent).not.toContain('K8S-002');
  });
});
