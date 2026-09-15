/**
 * Informational copy about each kind of lab environment.
 *
 * This is the one place the UI describes a provider in prose, and it is
 * deliberately *descriptive only*: nothing here changes what a button does, and
 * nothing decides whether a lab can start — that is the API's `availability`.
 * A provider that is not listed gets a neutral sentence rather than a wrong one.
 *
 * Each sentence is checked against how the provider actually works today:
 *
 *   - kubernetes — a per-session namespace on a shared cluster; the student's
 *     credentials are namespace-scoped (`kubectl get nodes` is Forbidden).
 *   - linux / docker / terraform / cicd — a per-session container. Docker labs
 *     add a daemon private to the session; Terraform uses a local provider
 *     mirror and reaches no cloud.
 *   - ansible — a per-session group of containers: a control node and managed
 *     nodes reached over SSH.
 *
 * Reset semantics are the providers' own: a Kubernetes reset purges the
 * student's objects and keeps the namespace (and the shell); a container reset
 * replaces the container, which ends the shell (`reconnectTerminal`).
 */
import type { SandboxKind } from './types';

export interface EnvironmentDescription {
  /** What the student gets, in one sentence. */
  summary: string;
  /** Short name for headings, e.g. "Kubernetes namespace". */
  name: string;
}

const DESCRIPTIONS: Record<string, EnvironmentDescription> = {
  kubernetes: {
    name: 'Kubernetes namespace',
    summary:
      'A private namespace on a shared Kubernetes cluster. The kubectl in your terminal can only work inside that namespace.',
  },
  linux: {
    name: 'Linux container',
    summary: 'Your own Linux container with a shell in the browser.',
  },
  docker: {
    name: 'Docker environment',
    summary: 'Your own container with a Docker daemon that belongs to this session only.',
  },
  terraform: {
    name: 'Terraform container',
    summary:
      'Your own container with Terraform installed. Providers come from a local mirror, and nothing is created in a real cloud account.',
  },
  ansible: {
    name: 'Ansible nodes',
    summary:
      'A small group of containers: a control node you work from, and managed nodes it reaches over SSH.',
  },
  cicd: {
    name: 'CI/CD container',
    summary: 'Your own container prepared with this lab’s project and pipeline tooling.',
  },
};

export function describeProvider(provider: string): EnvironmentDescription {
  return (
    DESCRIPTIONS[provider] ?? {
      name: 'Lab environment',
      summary: 'A private environment created for you when you launch the lab.',
    }
  );
}

/**
 * Track-level honesty notes.
 *
 * AWS is the one track whose name implies something the platform does not do:
 * its labs are simulated in the ordinary Linux sandbox (see `labs/aws/track.yaml`
 * and `docs/aws-track-architecture.md`). Saying so up front is the difference
 * between a student expecting a console login and a student who is not misled.
 */
const TRACK_NOTES: Record<string, string> = {
  aws: 'AWS labs are simulated. They run in a Linux sandbox and use no AWS account, no AWS credentials, and create no AWS resources.',
};

export function trackNote(track: string): string | undefined {
  return TRACK_NOTES[track];
}

/** What Reset does, by what the sandbox is. */
export function describeReset(sandboxKind: SandboxKind | undefined): string {
  if (sandboxKind === 'namespace') {
    return 'Reset removes the Kubernetes objects you created in your namespace and restores the lab’s starting resources. Your terminal stays connected.';
  }
  if (sandboxKind === 'container') {
    return 'Reset replaces your environment with a fresh one from the lab’s starting state. Files, running processes and shell history are lost. Your terminal reconnects automatically.';
  }
  return 'Reset returns your environment to the lab’s starting state. Anything you changed is lost.';
}

/** What is always true about Reset, whatever the sandbox. */
export const RESET_KEEPS =
  'Your saved progress and any completion are kept. The time limit is not extended.';
