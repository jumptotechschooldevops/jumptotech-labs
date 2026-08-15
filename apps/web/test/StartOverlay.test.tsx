import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StartOverlay } from '../src/components/StartOverlay';
import type { ProvisionStep } from '../src/lib/types';

const BACKEND_STEPS: ProvisionStep[] = [
  { id: 'environment-created', label: 'Environment created', status: 'ok', detail: 'namespace default initialised' },
  { id: 'kubernetes-api', label: 'Kubernetes API available', status: 'ok', detail: 'v1.34.0 — 1 node Ready' },
  { id: 'kubectl', label: 'kubectl ready', status: 'ok', detail: 'client v1.34.2' },
];

const TERMINAL_PENDING: ProvisionStep = {
  id: 'terminal',
  label: 'Terminal connected',
  status: 'pending',
  detail: 'connecting…',
};
const TERMINAL_OK: ProvisionStep = { id: 'terminal', label: 'Terminal connected', status: 'ok' };

describe('StartOverlay', () => {
  it('shows the Start Lab button before the lab begins', () => {
    render(
      <StartOverlay phase="idle" steps={[]} terminalStep={TERMINAL_PENDING} error={null} onStart={vi.fn()} />,
    );

    expect(screen.getByRole('button', { name: 'Start Lab' })).toBeDefined();
  });

  it('renders each provisioning step exactly once', () => {
    render(
      <StartOverlay
        phase="starting"
        steps={BACKEND_STEPS}
        terminalStep={TERMINAL_PENDING}
        error={null}
        onStart={vi.fn()}
      />,
    );

    // Regression guard: "Terminal connected" was previously rendered twice.
    expect(screen.getAllByText('Terminal connected')).toHaveLength(1);
    expect(screen.getAllByText('Environment created')).toHaveLength(1);
    expect(screen.getAllByText('Kubernetes API available')).toHaveLength(1);
    expect(screen.getAllByText('kubectl ready')).toHaveLength(1);
  });

  it('does not offer a terminal step before the backend steps have all passed', () => {
    const partial: ProvisionStep[] = [
      BACKEND_STEPS[0]!,
      { id: 'kubernetes-api', label: 'Kubernetes API available', status: 'failed', detail: 'ECONNREFUSED' },
    ];

    render(
      <StartOverlay phase="failed" steps={partial} terminalStep={TERMINAL_PENDING} error={null} onStart={vi.fn()} />,
    );

    expect(screen.queryByText('Terminal connected')).toBeNull();
  });

  it('announces Lab Ready once the terminal is connected', () => {
    render(
      <StartOverlay
        phase="ready"
        steps={BACKEND_STEPS}
        terminalStep={TERMINAL_OK}
        error={null}
        onStart={vi.fn()}
      />,
    );

    expect(screen.getByText('Lab Ready')).toBeDefined();
    expect(screen.getAllByText('✓')).toHaveLength(4);
  });

  it('gets out of the way once the lab is active', () => {
    const { container } = render(
      <StartOverlay phase="active" steps={BACKEND_STEPS} terminalStep={TERMINAL_OK} error={null} onStart={vi.fn()} />,
    );

    expect(container.firstChild).toBeNull();
  });

  it('shows the real failure instead of claiming the lab is ready', () => {
    const failed: ProvisionStep[] = [
      {
        id: 'environment-created',
        label: 'Environment created',
        status: 'failed',
        detail: 'getaddrinfo ENOTFOUND jumptotech-labs-control-plane',
      },
    ];

    render(
      <StartOverlay
        phase="failed"
        steps={failed}
        terminalStep={TERMINAL_PENDING}
        error={{
          code: 'PROVISION_FAILED',
          message: 'Kubernetes API call failed while reading namespace default',
          remediation: 'Ensure the kind cluster is running: npm run cluster:up',
        }}
        onStart={vi.fn()}
      />,
    );

    expect(screen.getByText('Could not start the lab')).toBeDefined();
    expect(screen.getByText('PROVISION_FAILED')).toBeDefined();
    expect(screen.getByText(/reading namespace default/)).toBeDefined();
    expect(screen.getByText(/npm run cluster:up/)).toBeDefined();
    expect(screen.queryByText('Lab Ready')).toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeDefined();
  });
});
