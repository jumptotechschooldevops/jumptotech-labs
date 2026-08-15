import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CheckPanel } from '../src/components/CheckPanel';
import type { VerificationResult } from '../src/lib/types';

const PASSED: VerificationResult = {
  labId: 'K8S-001',
  passed: true,
  summary: 'LAB PASSED',
  checkedAt: new Date(0).toISOString(),
  checks: [
    { id: 'pod-exists', label: 'Pod nginx exists', status: 'pass' },
    { id: 'namespace-correct', label: 'Namespace is correct', status: 'pass' },
    { id: 'image-correct', label: 'Image nginx:stable is correct', status: 'pass' },
    { id: 'pod-running', label: 'Pod is Running', status: 'pass' },
    { id: 'container-ready', label: 'Container is Ready', status: 'pass' },
  ],
};

const FAILED: VerificationResult = {
  ...PASSED,
  passed: false,
  summary: 'LAB NOT COMPLETE',
  checks: [
    { id: 'pod-exists', label: 'Pod nginx exists', status: 'pass' },
    {
      id: 'image-correct',
      label: 'Image nginx:stable is correct',
      status: 'fail',
      detail: "Incorrect image — found 'nginx:1.25', expected 'nginx:stable'",
    },
  ],
};

describe('CheckPanel', () => {
  it('renders nothing when idle', () => {
    const { container } = render(
      <CheckPanel running={false} result={null} error={null} onDismiss={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows the checking headline while verification runs', () => {
    render(<CheckPanel running result={null} error={null} onDismiss={vi.fn()} />);
    expect(screen.getByText('Checking your environment…')).toBeDefined();
  });

  it('renders every check and the LAB PASSED verdict', () => {
    render(<CheckPanel running={false} result={PASSED} error={null} onDismiss={vi.fn()} />);

    expect(screen.getByText('LAB PASSED')).toBeDefined();
    expect(screen.getAllByText('✓')).toHaveLength(5);
    expect(screen.getByText('Pod nginx exists')).toBeDefined();
  });

  it('renders failure detail and the LAB NOT COMPLETE verdict', () => {
    render(<CheckPanel running={false} result={FAILED} error={null} onDismiss={vi.fn()} />);

    expect(screen.getByText('LAB NOT COMPLETE')).toBeDefined();
    expect(screen.getByText(/found 'nginx:1.25'/)).toBeDefined();
  });

  it('never displays a runnable solution', () => {
    const { container } = render(
      <CheckPanel running={false} result={FAILED} error={null} onDismiss={vi.fn()} />,
    );

    expect(container.textContent).not.toMatch(/kubectl run/i);
    expect(container.textContent).not.toMatch(/--image=/);
  });

  it('surfaces an environment error', () => {
    render(
      <CheckPanel
        running={false}
        result={null}
        error={{ code: 'ENVIRONMENT_UNREACHABLE', message: 'connect ECONNREFUSED 172.18.0.2:6443' }}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByText('ENVIRONMENT_UNREACHABLE')).toBeDefined();
    expect(screen.getByText(/ECONNREFUSED/)).toBeDefined();
  });
});
