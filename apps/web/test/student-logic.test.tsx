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
import { suggestNextLab } from '../src/lib/suggest';
import { InlineText } from '../src/components/RichText';
import { codeForClose } from '../src/lib/terminal';
import { describeProvider, describeReset, trackNote } from '../src/lib/environmentInfo';
import { LABS, TRACKS, labSummary } from './api-mock';
import type { LabProgressEntry } from '../src/lib/types';

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

  it('falls back to the server’s own words and keeps the code, for an error it does not know', () => {
    const described = describeError(
      { code: 'SOMETHING_NEW', message: 'The widget is sideways.', remediation: 'Straighten it.' },
      'reset',
    );
    expect(described.title).toBe('The lab could not be reset');
    expect(described.message).toBe('The widget is sideways.');
    expect(described.guidance).toBe('Straighten it.');
    expect(described.reference).toBe('SOMETHING_NEW');
  });
});

describe('the "next up" rule', () => {
  const progressOf =
    (map: Record<string, LabProgressEntry['status']>) =>
    (labId: string): LabProgressEntry | undefined =>
      map[labId]
        ? { labId, title: labId, status: map[labId]!, attemptCount: 1, completionCount: 0, completedAt: null, lastCompletedAt: null }
        : undefined;
  const ordered = [LABS[2]!, LABS[0]!, LABS[1]!]; // kubernetes, then linux — the API's track order

  it('suggests the first lab of the first track to someone who has done nothing', () => {
    const suggestion = suggestNextLab({ labs: ordered, tracks: TRACKS, progressFor: progressOf({}) });
    expect(suggestion?.lab.id).toBe('K8S-001');
    expect(suggestion?.reason).toMatch(/first lab in Kubernetes/);
  });

  it('prefers unfinished work, most recent first', () => {
    const suggestion = suggestNextLab({
      labs: ordered,
      tracks: TRACKS,
      progressFor: progressOf({ 'K8S-001': 'IN_PROGRESS', 'LINUX-002': 'IN_PROGRESS' }),
      recentLabIds: ['LINUX-002', 'K8S-001'],
    });
    expect(suggestion?.lab.id).toBe('LINUX-002');
    expect(suggestion?.reason).toMatch(/started this lab/);
  });

  it('continues in the track the student last worked in', () => {
    const suggestion = suggestNextLab({
      labs: ordered,
      tracks: TRACKS,
      progressFor: progressOf({ 'LINUX-001': 'COMPLETED' }),
      recentLabIds: ['LINUX-001'],
    });
    expect(suggestion?.lab.id).toBe('LINUX-002');
    expect(suggestion?.reason).toMatch(/next lab you have not completed in Linux/);
  });

  it('never suggests a lab this platform cannot run, and suggests nothing when all is done', () => {
    const unavailable = [labSummary({ id: 'X-1', availability: { available: false, reason: 'no image' } })];
    expect(suggestNextLab({ labs: unavailable, tracks: TRACKS, progressFor: progressOf({}) })).toBeNull();
    expect(
      suggestNextLab({
        labs: ordered,
        tracks: TRACKS,
        progressFor: progressOf({ 'K8S-001': 'COMPLETED', 'LINUX-001': 'COMPLETED', 'LINUX-002': 'COMPLETED' }),
      }),
    ).toBeNull();
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
