/**
 * A stand-in JumpToTech Labs platform for the browser UX suite — TEST ONLY.
 *
 * The page under test is the real production bundle in a real Chromium, with
 * real xterm.js. What is fake is everything behind it: this class answers the
 * page's `/api/*` and `/auth/*` requests from memory, and plays the terminal
 * service on its `/terminal` WebSocket. That makes the things a real backend
 * cannot do on cue deterministic: a check that answers a minute late, a start
 * that fails once, a terminal that refuses three times, a sign-in that expires.
 *
 * Fail closed. A request this class does not know is answered 404 and recorded
 * in `unexpected`, and every spec's fixture asserts that stays empty; nothing is
 * ever passed through to a network (the preview server's own proxy points at a
 * closed port as well — see playwright.ux.config.ts).
 *
 * Payloads come from the same builders as the jsdom page tests
 * (apps/web/test/payloads.ts), which follow the API's captured shapes.
 */
import type { BrowserContext, Page, Request, Route, WebSocketRoute } from '@playwright/test';
import {
  LABS,
  TRACKS,
  attemptSummary,
  labDetail,
  learningPathDetail,
  learningPathProgress,
  progressSnapshot,
  sessionInfo,
  verification,
} from '../../../apps/web/test/payloads.js';
import type { AttemptSummary, SessionInfo } from '../../../apps/web/src/lib/types.js';

export interface Student {
  /** OIDC subject; also what the fake identity provider signs in as. */
  subject: string;
  displayName: string;
}

export interface ApiFailure {
  status: number;
  code: string;
  message: string;
  details?: unknown;
}

/** A request held open until the test releases it. */
export class Gate {
  private release!: () => void;
  readonly opened: Promise<void>;
  /** Resolves when a request has reached the gate. */
  readonly reached: Promise<void>;
  private markReached!: () => void;
  constructor() {
    this.opened = new Promise((resolve) => (this.release = resolve));
    this.reached = new Promise((resolve) => (this.markReached = resolve));
  }
  arrive(): Promise<void> {
    this.markReached();
    return this.opened;
  }
  open(): void {
    this.release();
  }
}

interface LiveSession {
  session: SessionInfo;
  labTitle: string;
  attempt: AttemptSummary;
  owner: string;
}

type Action = 'start' | 'check' | 'reset' | 'end' | 'terminal' | 'lab' | 'sessions' | 'progress' | 'hint' | 'session';

let counter = 0;
const nextId = (prefix: string) => {
  counter += 1;
  return `${prefix}-${Date.now().toString(16)}${counter.toString(16).padStart(6, '0')}`;
};

/** The fake session cookie. HttpOnly, like the real one: the page cannot read it. */
export const COOKIE = 'ux_student';

export class FakePlatform {
  /** Every student this platform knows, by subject. */
  readonly students = new Map<string, Student>();
  /** Who the identity provider signs in as next. */
  nextSignIn: Student | null = null;
  /** Subjects whose sign-in has been ended server-side (expired, revoked). */
  readonly revoked = new Set<string>();
  /** The student the request being answered belongs to. */
  private signedIn: Student | null = null;
  /** Per-student solved state, by session id: Verify passes when set. */
  readonly solved = new Set<string>();
  readonly sessions = new Map<string, LiveSession>();
  readonly completed = new Map<string, Set<string>>();
  readonly hints = new Map<string, Set<number>>();
  /** Every API request, as `METHOD /path`. */
  readonly calls: string[] = [];
  /** Requests nobody expected. Must stay empty. */
  readonly unexpected: string[] = [];
  /** Terminal sockets opened, and the ones still open. */
  terminalOpened = 0;
  readonly openSockets = new Set<WebSocketRoute>();
  /** How many upcoming terminal connections to refuse (1011, like a broker that is down). */
  refuseTerminal = 0;
  /** The terminal service answers `ready` only once this is open, when set. */
  terminalGate: Gate | null = null;
  /** How many upcoming terminal tokens to refuse as expired (UNAUTHORIZED, 4401). */
  refuseTokens = 0;
  /** Lab titles to serve instead of the builders' short ones (long titles are the layout risk). */
  readonly titles = new Map<string, string>();

  private gates = new Map<Action, Gate>();
  private failures = new Map<Action, Array<ApiFailure | 'abort'>>();

  /** Hold the next request of this kind until the returned gate is opened. */
  hold(action: Action): Gate {
    const gate = new Gate();
    this.gates.set(action, gate);
    return gate;
  }

  /** Answer the next request of this kind with an error. */
  failNext(action: Action, failure: ApiFailure): void {
    const queue = this.failures.get(action) ?? [];
    queue.push(failure);
    this.failures.set(action, queue);
  }

  /** Drop the next request of this kind at the network level, as if the platform were unreachable. */
  abortNext(action: Action): void {
    const queue = this.failures.get(action) ?? [];
    queue.push('abort');
    this.failures.set(action, queue);
  }

  count(pattern: RegExp): number {
    return this.calls.filter((call) => pattern.test(call)).length;
  }

  /** A student's live sessions — the only student's, when there is one. */
  liveSessions(subject?: string): LiveSession[] {
    const owner = subject ?? this.signedIn?.subject ?? this.onlyStudent();
    return [...this.sessions.values()].filter(
      (entry) => entry.owner === owner && !['ENDED', 'EXPIRED', 'FAILED'].includes(entry.session.status),
    );
  }

  private onlyStudent(): string | undefined {
    const owners = new Set([...this.sessions.values()].map((entry) => entry.owner));
    return owners.size === 1 ? [...owners][0] : undefined;
  }

  /** The one live session (most specs run exactly one). */
  current(subject?: string): LiveSession {
    const live = this.liveSessions(subject);
    if (live.length !== 1) throw new Error(`expected one live session, found ${live.length}`);
    return live[0]!;
  }

  /** Answer this page's platform requests. Identity comes from each request's cookie. */
  async install(page: Page): Promise<void> {
    await page.route('**/*', (route, request) => this.handle(route, request));
    await page.routeWebSocket(/\/terminal$/, (ws) => this.terminal(ws));
  }

  /** Sign a browser context in as `student`, as the callback would: an HttpOnly cookie. */
  async signIn(context: BrowserContext, baseURL: string, student: Student): Promise<void> {
    this.students.set(student.subject, student);
    this.revoked.delete(student.subject);
    await context.addCookies([{ name: COOKIE, value: student.subject, url: baseURL, httpOnly: true, sameSite: 'Lax' }]);
  }

  // --------------------------------------------------------------- terminal

  private terminal(ws: WebSocketRoute): void {
    this.terminalOpened += 1;
    if (this.refuseTerminal > 0) {
      this.refuseTerminal -= 1;
      void ws.close({ code: 1011, reason: 'refused by the UX suite' });
      return;
    }
    this.openSockets.add(ws);
    ws.onClose(() => this.openSockets.delete(ws));
    let authed = false;
    ws.onMessage(async (raw) => {
      const frame = JSON.parse(String(raw)) as { type: string; token?: string; data?: string };
      if (frame.type === 'auth') {
        const owned = [...this.sessions.values()].some(
          (entry) => entry.session.status === 'ACTIVE' && frame.token === `token-${entry.session.sessionId}`,
        );
        if (!owned || this.refuseTokens > 0) {
          if (owned) this.refuseTokens -= 1;
          ws.send(JSON.stringify({ type: 'error', code: 'UNAUTHORIZED', message: 'Terminal token expired: jwt expired at 2026-09-21T01:00:00Z (kid terminal-2)' }));
          await ws.close({ code: 4401, reason: 'unauthorized' });
          return;
        }
        if (this.terminalGate) await this.terminalGate.arrive();
        authed = true;
        ws.send(JSON.stringify({ type: 'ready', sessionId: 'x' }));
        ws.send(JSON.stringify({ type: 'output', data: 'student@jumptotech-lab:~$ ' }));
        return;
      }
      if (!authed) {
        await ws.close({ code: 4401, reason: 'First message must be an auth frame.' });
        return;
      }
      if (frame.type === 'input' && frame.data) {
        // An echoing shell: enough for "what the student types reaches it".
        ws.send(JSON.stringify({ type: 'output', data: frame.data.replace(/\r/g, '\r\nstudent@jumptotech-lab:~$ ') }));
      }
    });
  }

  /** Drop every open terminal socket the way a network blip does. */
  async dropTerminals(code = 1006): Promise<void> {
    for (const ws of [...this.openSockets]) await ws.close({ code, reason: 'dropped by the UX suite' });
  }

  // ------------------------------------------------------------------ HTTP

  private async handle(route: Route, request: Request): Promise<void> {
    const url = new URL(request.url());
    const path = url.pathname;
    if (!path.startsWith('/api/') && !path.startsWith('/auth/')) {
      await route.continue();
      return;
    }
    const call = `${request.method()} ${path}`;
    this.calls.push(call);
    const cookie = (await request.allHeaders())['cookie'] ?? '';
    const subject = new RegExp(`(?:^|; )${COOKIE}=([^;]+)`).exec(cookie)?.[1];
    this.signedIn = subject && !this.revoked.has(decodeURIComponent(subject)) ? (this.students.get(decodeURIComponent(subject)) ?? null) : null;
    try {
      await this.answer(route, request, url, call);
    } catch (error) {
      if (String(error).includes('Target page, context or browser has been closed')) return;
      throw error;
    }
  }

  private async gateFor(action: Action): Promise<void> {
    const gate = this.gates.get(action);
    if (!gate) return;
    this.gates.delete(action);
    await gate.arrive();
  }

  private async failure(route: Route, action: Action): Promise<boolean> {
    const failure = this.failures.get(action)?.shift();
    if (!failure) return false;
    if (failure === 'abort') {
      await route.abort('connectionrefused');
      return true;
    }
    await route.fulfill({
      status: failure.status,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: { code: failure.code, message: failure.message, details: failure.details } }),
    });
    return true;
  }

  private ok(route: Route, data: unknown): Promise<void> {
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data }) });
  }

  private error(route: Route, status: number, code: string, message: string, details?: unknown): Promise<void> {
    return route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: { code, message, ...(details ? { details } : {}) } }),
    });
  }

  private studentIdentity() {
    return { studentId: 'hidden', authenticated: true, identitySource: 'oidc', durable: true };
  }

  private async answer(route: Route, request: Request, url: URL, call: string): Promise<void> {
    const path = url.pathname;
    const method = request.method();

    // --- auth ---------------------------------------------------------------
    if (call === 'GET /auth/session') {
      return this.ok(route, {
        authenticated: this.signedIn !== null,
        signInAvailable: true,
        mode: 'oidc',
        ...(this.signedIn
          ? {
              identity: {
                subject: this.signedIn.subject,
                issuer: 'https://idp.ux.test/',
                displayName: this.signedIn.displayName,
                role: 'STUDENT',
                source: 'oidc',
              },
            }
          : {}),
      });
    }
    if (call === 'GET /auth/login') {
      // The identity provider round trip, collapsed: sign in, set the cookie, go back.
      const student = this.nextSignIn;
      if (!student) return this.error(route, 400, 'AUTH_REFUSED', 'Nobody to sign in as');
      this.students.set(student.subject, student);
      this.revoked.delete(student.subject);
      const returnTo = url.searchParams.get('returnTo') ?? '/';
      return route.fulfill({
        status: 200,
        contentType: 'text/html',
        headers: { 'set-cookie': `${COOKIE}=${encodeURIComponent(student.subject)}; Path=/; HttpOnly; SameSite=Lax` },
        body: `<!doctype html><script>location.replace(${JSON.stringify(returnTo)})</script>`,
      });
    }
    if (call === 'POST /auth/logout') {
      if (this.signedIn) this.revoked.add(this.signedIn.subject);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` },
        body: JSON.stringify({ ok: true, data: { signedOut: true } }),
      });
    }

    if (!this.signedIn) {
      return this.error(route, 401, 'AUTH_REQUIRED', 'Sign in first.');
    }
    const owner = this.signedIn.subject;
    const completed = this.completed.get(owner) ?? new Set<string>();
    this.completed.set(owner, completed);

    // --- catalog and progress ---------------------------------------------------
    if (call === 'GET /api/labs') {
      const labs = LABS.map((lab) => ({ ...lab, title: this.titles.get(lab.id) ?? lab.title }));
      return this.ok(route, { labs, tracks: TRACKS, providers: [], count: labs.length });
    }
    const labMatch = /^\/api\/labs\/([A-Z0-9-]+)$/.exec(path);
    if (labMatch && method === 'GET') {
      await this.gateFor('lab');
      if (await this.failure(route, 'lab')) return;
      const summary = LABS.find((lab) => lab.id === labMatch[1]);
      if (!summary) return this.error(route, 404, 'LAB_NOT_FOUND', 'No such lab');
      return this.ok(route, labDetail({ id: summary.id, title: this.titles.get(summary.id) ?? summary.title, track: summary.track }));
    }
    if (call === 'GET /api/me/access') {
      // An open deployment: every signed-in student may use labs (docs/commercial-access.md).
      return this.ok(route, { access: { policy: 'open', state: 'NONE', active: true, startsAt: null, expiresAt: null } });
    }
    if (call === 'GET /api/me/progress') {
      await this.gateFor('progress');
      if (await this.failure(route, 'progress')) return;
      const statuses: Record<string, 'COMPLETED' | 'IN_PROGRESS'> = {};
      for (const labId of completed) statuses[labId] = 'COMPLETED';
      return this.ok(route, progressSnapshot(statuses));
    }
    if (call === 'GET /api/me/attempts') {
      const attempts = [...this.sessions.values()].filter((entry) => entry.owner === owner).map((entry) => entry.attempt);
      return this.ok(route, { student: this.studentIdentity(), attempts, count: attempts.length });
    }
    const attemptMatch = /^\/api\/me\/attempts\/([^/]+)$/.exec(path);
    if (attemptMatch && method === 'GET') {
      const entry = [...this.sessions.values()].find((e) => e.owner === owner && e.attempt.attemptId === attemptMatch[1]);
      if (!entry) return this.error(route, 404, 'ATTEMPT_NOT_FOUND', 'No such attempt');
      const levels = [...(this.hints.get(entry.attempt.attemptId) ?? [])];
      return this.ok(route, {
        student: this.studentIdentity(),
        attempt: { ...entry.attempt, hints: levels.map((level) => ({ level, revealedAt: new Date().toISOString() })), hintsUsed: levels.length },
      });
    }
    if (call === 'GET /api/learning-paths') return this.ok(route, { learningPaths: [learningPathDetail()], count: 1 });
    if (call === 'GET /api/learning-paths/devops-engineer') return this.ok(route, { learningPath: learningPathDetail() });
    if (call === 'GET /api/me/learning-paths/devops-engineer') {
      const statuses: Record<string, 'COMPLETED'> = {};
      for (const labId of completed) statuses[labId] = 'COMPLETED';
      const next = ['LINUX-001', 'LINUX-002', 'K8S-001'].find((id) => !completed.has(id)) ?? 'K8S-001';
      const title = LABS.find((lab) => lab.id === next)?.title ?? next;
      return this.ok(
        route,
        learningPathProgress(statuses, { kind: 'NEXT_IN_STAGE', labId: next, labTitle: title, reason: `Next: ${title}.` }),
      );
    }

    // --- sessions --------------------------------------------------------------
    if (call === 'GET /api/sessions') {
      await this.gateFor('sessions');
      if (await this.failure(route, 'sessions')) return;
      const entries = this.liveSessions().map(({ session, labTitle, attempt }) => ({ session, labTitle, attempt }));
      return this.ok(route, { sessions: entries, count: entries.length, limits: { maxActiveSessionsPerStudent: 1 } });
    }
    const startMatch = /^\/api\/labs\/([A-Z0-9-]+)\/start$/.exec(path);
    if (startMatch && method === 'POST') {
      await this.gateFor('start');
      if (await this.failure(route, 'start')) return;
      const running = this.liveSessions()[0];
      if (running) {
        return this.error(route, 409, 'STUDENT_SESSION_LIMIT_REACHED', 'You already have a lab running.', {
          maxActiveSessionsPerStudent: 1,
          activeSessions: [{ sessionId: running.session.sessionId, labId: running.session.labId }],
        });
      }
      const labId = startMatch[1]!;
      const summary = LABS.find((lab) => lab.id === labId);
      const sessionId = nextId('sess');
      const attempt = attemptSummary({ attemptId: nextId('attempt'), labId, labTitle: summary?.title ?? labId, status: completed.has(labId) ? 'PASSED' : 'IN_PROGRESS' });
      const session = sessionInfo({ sessionId, labId, sandboxRef: `lab-sbx-${sessionId}` });
      this.sessions.set(sessionId, { session, labTitle: summary?.title ?? labId, attempt, owner });
      return this.ok(route, {
        session,
        attempt,
        environment: { environmentId: sessionId, provider: 'docker-linux', phase: 'ready', namespace: '' },
        steps: [{ id: 'container', label: 'Container created', status: 'ok' }],
        terminal: { url: 'ws://ignored.ux.test', token: `token-${sessionId}` },
      });
    }

    const sessionMatch = /^\/api\/sessions\/([^/]+)(?:\/([a-z]+))?$/.exec(path);
    if (sessionMatch) {
      const [, sessionId, verb] = sessionMatch;
      const entry = this.sessions.get(sessionId!);
      if (!entry || entry.owner !== owner) return this.error(route, 404, 'SESSION_NOT_FOUND', 'Session not found');
      const live = !['ENDED', 'EXPIRED', 'FAILED'].includes(entry.session.status);

      if (!verb && method === 'GET') {
        await this.gateFor('session');
        if (await this.failure(route, 'session')) return;
        return this.ok(route, { session: entry.session, environment: null });
      }
      if (verb === 'terminal' && method === 'POST') {
        await this.gateFor('terminal');
        if (await this.failure(route, 'terminal')) return;
        if (entry.session.status !== 'ACTIVE') return this.error(route, 409, 'SESSION_NOT_ACTIVE', 'Not active');
        return this.ok(route, { session: entry.session, terminal: { url: 'ws://ignored.ux.test', token: `token-${sessionId}` } });
      }
      if (verb === 'activity' && method === 'POST') return this.ok(route, { session: entry.session });
      if (verb === 'hints' && method === 'POST') {
        await this.gateFor('hint');
        const { level } = JSON.parse(request.postData() ?? '{}') as { level: number };
        const set = this.hints.get(entry.attempt.attemptId) ?? new Set<number>();
        const recorded = !set.has(level);
        set.add(level);
        this.hints.set(entry.attempt.attemptId, set);
        return this.ok(route, { recorded, persisted: true, revealedCount: set.size });
      }
      if (verb === 'check' && method === 'POST') {
        const before = entry.session;
        await this.gateFor('check');
        if (await this.failure(route, 'check')) return;
        if (!live) return this.error(route, 409, 'SESSION_NOT_ACTIVE', 'Not active');
        const passed = this.solved.has(sessionId!);
        const newlyCompleted = passed && entry.attempt.status !== 'PASSED';
        if (passed) {
          entry.attempt = { ...entry.attempt, status: 'PASSED', completedAt: new Date().toISOString() };
          completed.add(entry.session.labId);
        }
        entry.attempt = { ...entry.attempt, checkCount: entry.attempt.checkCount + 1 };
        return this.ok(route, verification(passed, { labId: entry.session.labId, session: before, attempt: entry.attempt, newlyCompleted, checkedAt: new Date().toISOString() }));
      }
      if (verb === 'reset' && method === 'POST') {
        await this.gateFor('reset');
        if (await this.failure(route, 'reset')) return;
        this.solved.delete(sessionId!);
        entry.attempt = { ...entry.attempt, resetCount: entry.attempt.resetCount + 1 };
        await this.dropTerminals(1000);
        return this.ok(route, {
          message: 'Lab reset.',
          attempt: entry.attempt,
          removed: [],
          restored: [],
          steps: [],
          environment: { environmentId: sessionId, provider: 'docker-linux', phase: 'ready', namespace: '' },
          session: entry.session,
          clearTerminal: true,
          reconnectTerminal: true,
        });
      }
      if (!verb && method === 'DELETE') {
        await this.gateFor('end');
        if (await this.failure(route, 'end')) return;
        entry.session = { ...entry.session, status: 'ENDED', secondsRemaining: 0, endedAt: new Date().toISOString() };
        if (entry.attempt.status !== 'PASSED') entry.attempt = { ...entry.attempt, status: 'ENDED', endedAt: new Date().toISOString() };
        await this.dropTerminals(4410);
        return this.ok(route, { message: 'Lab environment released.', session: entry.session, attempt: entry.attempt, steps: [] });
      }
    }

    this.unexpected.push(call);
    return this.error(route, 404, 'NOT_FOUND', 'No such endpoint');
  }
}
