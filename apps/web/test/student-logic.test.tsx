/**
 * Student beta experience — the pure pieces the pages are built on.
 *
 * Routes, error meaning, the "next up" rule, lab prose rendering, and how a
 * closed terminal socket is classified. Each is a plain function, so each is
 * tested as one.
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { hrefFor, parseRoute } from '../src/lib/router';
import { describeError } from '../src/lib/errors';
import { InlineText } from '../src/components/RichText';
import { codeForClose } from '../src/lib/terminal';
import { describeProvider, describeReset, trackNote } from '../src/lib/environmentInfo';

describe('routes', () => {
  it('names every student page', () => {
    expect(parseRoute('')).toEqual({ name: 'dashboard' });
    expect(parseRoute('#/')).toEqual({ name: 'dashboard' });
    expect(parseRoute('#/labs')).toEqual({ name: 'labs' });
    expect(parseRoute('#/tracks')).toEqual({ name: 'tracks' });
    expect(parseRoute('#/tracks/linux')).toEqual({ name: 'track', trackId: 'linux' });
    expect(parseRoute('#/labs/linux-001')).toEqual({ name: 'lab', labId: 'LINUX-001' });
    expect(parseRoute('#/labs/LINUX-001/workspace')).toEqual({ name: 'workspace', labId: 'LINUX-001' });
    expect(parseRoute('#/progress')).toEqual({ name: 'progress' });
    expect(parseRoute('#/help')).toEqual({ name: 'help' });
  });

  it('keeps catalog filters in the hash, and only the known ones', () => {
    expect(parseRoute('#/labs?track=linux&q=pods&level=beginner&status=COMPLETED&evil=1')).toEqual({
      name: 'labs',
      track: 'linux',
      q: 'pods',
      level: 'beginner',
      status: 'COMPLETED',
    });
    expect(hrefFor({ name: 'labs', track: 'linux', q: 'move files' })).toBe('#/labs?track=linux&q=move+files');
    expect(parseRoute(hrefFor({ name: 'labs', track: 'linux', q: 'move files' }))).toEqual({
      name: 'labs',
      track: 'linux',
      q: 'move files',
    });
  });

  it('says "not found" for an address that is not a page, rather than quietly showing another one', () => {
    expect(parseRoute('#/nope')).toEqual({ name: 'notFound' });
    expect(parseRoute('#/labs/this-id-is-far-too-long-to-be-a-lab')).toEqual({ name: 'notFound' });
    expect(parseRoute('#/tracks/UPPER')).toEqual({ name: 'notFound' });
  });

  it('never puts a session id in a URL', () => {
    for (const route of [
      hrefFor({ name: 'workspace', labId: 'LINUX-001' }),
      hrefFor({ name: 'lab', labId: 'LINUX-001' }),
    ]) {
      expect(route).not.toMatch(/sess-/);
    }
  });
});

describe('what an API error means to a student', () => {
  it('explains global capacity without numbers about other students', () => {
    const described = describeError(
      {
        code: 'LAB_CAPACITY_REACHED',
        message: 'All 5 practice environments are currently in use.',
        details: { activeSessions: 5, maxActiveSessions: 5 },
      },
      'launch',
    );
    expect(described.kind).toBe('capacity');
    expect(described.title).toBe('All lab environments are in use');
    expect(described.guidance).toMatch(/try again in a few minutes/i);
    expect(described.reference).toBe('LAB_CAPACITY_REACHED');
    expect(JSON.stringify(described)).not.toMatch(/\b5\b/);
    expect(described.retryable).toBe(true);
  });

  it('says new labs are paused, that running labs keep working, and keeps the code', () => {
    const described = describeError(
      {
        code: 'LAB_LAUNCHES_PAUSED',
        message: 'Starting new labs is paused for maintenance.',
        remediation: 'Labs that are already running keep working. Try again later.',
      },
      'launch',
    );
    expect(described.title).toBe('New labs are paused');
    expect(described.message).toMatch(/already running keep working/);
    expect(described.reference).toBe('LAB_LAUNCHES_PAUSED');
    expect(described.retryable).toBe(true);
  });

  it('does not tell a signed-in student to sign in again when the api could not check the sign-in', () => {
    const described = describeError(
      { code: 'AUTH_UNAVAILABLE', message: 'Your sign-in could not be checked right now.' },
      'verify',
    );
    expect(described.kind).not.toBe('auth');
    expect(described.retryable).toBe(true);
    expect(`${described.title} ${described.message} ${described.guidance ?? ''}`).not.toMatch(/expired|sign in again/i);
    // A real refusal still is one.
    expect(describeError({ code: 'AUTH_EXPIRED', message: 'Your session has expired.' }, 'verify').kind).toBe('auth');
  });

  it('words an unreachable environment for the action that failed', () => {
    const error = { code: 'ENVIRONMENT_UNREACHABLE', message: 'The sandbox could not be reached.' };
    expect(describeError(error, 'verify').title).toBe('Verification could not run');
    const reset = describeError(error, 'reset');
    expect(reset.title).toBe('The reset could not reach your environment');
    expect(`${reset.message} ${reset.guidance}`).not.toMatch(/verif/i);
    expect(reset.reference).toBe('ENVIRONMENT_UNREACHABLE');
  });

  it('points a student at their running lab instead of suggesting another start', () => {
    const described = describeError(
      { code: 'STUDENT_SESSION_LIMIT_REACHED', message: 'x', details: { maxActiveSessionsPerStudent: 1 } },
      'launch',
    );
    expect(described.kind).toBe('student-limit');
    expect(described.message).toMatch(/one lab at a time/);
    expect(described.guidance).toMatch(/Continue the lab you already have/);
    expect(described.retryable).toBe(false);
  });

  it('never presents an unreadable environment as a mistake in the student’s work', () => {
    const described = describeError({ code: 'ENVIRONMENT_UNREACHABLE', message: 'dial tcp: timeout' }, 'verify');
    expect(described.kind).toBe('environment');
    expect(described.message).toMatch(/nothing was checked/);
    expect(described.message).toMatch(/not a mistake in your work/);
  });

  it('replaces operator remediation with something a student can do', () => {
    const described = describeError(
      { code: 'API_UNREACHABLE', message: 'Cannot reach x', remediation: 'Is the api service running? Try: docker compose ps' },
      'load',
    );
    expect(JSON.stringify(described)).not.toMatch(/docker/);
    expect(described.guidance).toMatch(/internet connection/);
  });

  it('treats every AUTH_ code as an expired sign-in', () => {
    expect(describeError({ code: 'AUTH_REQUIRED', message: '' }).kind).toBe('auth');
    expect(describeError({ code: 'AUTH_INVALID_TOKEN', message: '' }).kind).toBe('auth');
  });

  it('falls back to the server’s own words and keeps the code, for an error it does not know while reading', () => {
    const described = describeError(
      { code: 'SOMETHING_NEW', message: 'The widget is sideways.', remediation: 'Straighten it.' },
      'load',
    );
    expect(described.title).toBe('This page could not be loaded');
    expect(described.message).toBe('The widget is sideways.');
    expect(described.guidance).toBe('Straighten it.');
    expect(described.reference).toBe('SOMETHING_NEW');
  });

  /*
   * An action on the environment that fails with a code this file does not
   * know is the provider's failure, in the provider's words: the kind
   * provider's reset answers SETUP_FAILED with kubectl's stderr, and the check
   * route puts "Start the lab environment before checking your solution" on
   * every verifier error — to a student whose lab is running.
   */
  it('never shows a provider’s raw words for an unknown code on an action, and keeps the code', () => {
    const raw = {
      message: 'kubectl apply -f /app/labs/kubernetes/K8S-006/setup/deployment.yaml exited 1: error: the server could not find the requested resource',
      remediation: 'Start the lab environment before checking your solution.',
    };
    for (const context of ['launch', 'verify', 'reset', 'end', 'terminal'] as const) {
      const described = describeError({ code: 'SETUP_FAILED', ...raw }, context);
      const text = `${described.title} ${described.message} ${described.guidance ?? ''}`;
      expect(text, context).not.toMatch(/kubectl|\/app\/labs|setup\/|Start the lab environment/);
      expect(described.reference, context).toBe('SETUP_FAILED');
      expect(described.retryable, context).toBe(true);
    }
    expect(describeError({ code: 'KUBECTL_UNAVAILABLE', ...raw }, 'verify').message).toMatch(
      /nothing was checked.*not a mistake in your work/,
    );
    expect(describeError({ code: 'SETUP_FAILED', ...raw }, 'reset').guidance).toMatch(/Press Reset to try again/);
  });

  it('words a failed Stay active as that, not as a terminal that could not connect', () => {
    const described = describeError({ code: 'INTERNAL_ERROR', message: 'x' }, 'activity');
    expect(described.title).toBe('Your lab could not be kept active');
    const unknown = describeError({ code: 'SOMETHING_NEW', message: 'raw' }, 'activity');
    expect(unknown.title).toBe('Your lab could not be kept active');
    expect(unknown.guidance).toMatch(/Typing in the terminal also counts/);
    expect(`${unknown.title} ${unknown.message}`).not.toMatch(/terminal could not connect|raw/);
  });

  it('explains a rate limit, a check already running, and a fault in the page itself', () => {
    expect(describeError({ code: 'RATE_LIMITED', message: 'Too many requests.' }, 'load').title).toBe('Too many requests');
    expect(describeError({ code: 'CHECK_IN_PROGRESS', message: 'x' }, 'verify').guidance).toMatch(/press Verify again/);
    const page = describeError({ code: 'UNEXPECTED_ERROR', message: "Cannot read properties of undefined (reading 'map')" });
    expect(page.message).not.toMatch(/undefined|properties/);
    expect(page.guidance).toMatch(/Reload the page/);
  });
});

describe('lab prose', () => {
  it('renders backticked commands as code, and never as markup', () => {
    const { container } = render(<InlineText text={'Run `ls -R ~/project` then `<img src=x onerror=alert(1)>`'} />);
    const codes = container.querySelectorAll('code');
    expect([...codes].map((code) => code.textContent)).toEqual(['ls -R ~/project', '<img src=x onerror=alert(1)>']);
    expect(container.querySelector('img')).toBeNull();
  });

  it('keeps an unbalanced backtick as a literal character', () => {
    const { container } = render(<InlineText text={'a `b c'} />);
    expect(container.textContent).toBe('a `b c');
    expect(container.querySelector('code')).toBeNull();
  });
});

describe('how a closed terminal socket is classified', () => {
  it('maps the terminal service close codes', () => {
    expect(codeForClose(4410, undefined)).toBe('SESSION_ENDED');
    expect(codeForClose(4401, undefined)).toBe('UNAUTHORIZED');
    expect(codeForClose(1013, undefined)).toBe('CAPACITY');
    expect(codeForClose(1000, undefined)).toBe('SHELL_EXITED');
    expect(codeForClose(1006, undefined)).toBe('CONNECTION_LOST');
  });

  it('prefers the code the service named in its error frame', () => {
    expect(codeForClose(4408, 'IDLE_TIMEOUT')).toBe('IDLE_TIMEOUT');
    expect(codeForClose(4408, 'SESSION_EXPIRED')).toBe('SESSION_EXPIRED');
  });
});

describe('environment descriptions', () => {
  it('tells the truth about AWS labs', () => {
    expect(trackNote('aws')).toMatch(/simulated/);
    expect(trackNote('aws')).toMatch(/no AWS account, no AWS credentials/);
    expect(trackNote('linux')).toBeUndefined();
  });

  it('describes reset by what the sandbox actually is', () => {
    expect(describeReset('namespace')).toMatch(/terminal stays connected/);
    expect(describeReset('container')).toMatch(/reconnects automatically/);
  });

  it('stays neutral for a provider it does not know', () => {
    expect(describeProvider('quantum').name).toBe('Lab environment');
    expect(describeProvider('kubernetes').summary).toMatch(/namespace/);
  });
});
