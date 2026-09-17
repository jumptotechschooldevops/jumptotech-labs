/**
 * Browser-level helpers shared by the specs.
 *
 * Everything here acts through the page the way a student does — clicking,
 * typing into the identity provider's form and into xterm — except the few
 * helpers named `api*`, which make HTTP calls with the *browser context's own
 * cookie jar*. Those exist for assertions a page cannot make (another
 * student's session id answering 404) and for cleanup; they never mint or
 * forge a credential.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { expect, type APIResponse, type BrowserContext, type Page } from '@playwright/test';
import { requiredEnv } from './env.js';

/** A fresh username per test, so a reused stack never carries progress between runs. */
export function uniqueStudent(label: string): string {
  return `${label}-${randomBytes(4).toString('hex')}`;
}

export const LAB_ID = 'LINUX-001';
export const LAB_TITLE = 'Files and Directories';

/** The LINUX-001 solution, typed into the terminal exactly as a student would. */
export const LINUX_001_SOLUTION =
  'mkdir -p ~/project/archive && touch ~/project/config.txt ~/project/app.log && mv ~/project/app.log ~/project/archive/';

/**
 * Sign in through the real flow: app → /auth/login → provider login page →
 * /auth/callback → HttpOnly cookie → app. No cookie is injected.
 */
export async function signIn(page: Page, username: string): Promise<void> {
  const base = requiredEnv('E2E_BASE_URL');
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'JumpToTech Labs', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Sign in' }).click();

  // The provider's own page, on its own origin.
  await expect(page.getByRole('heading', { name: 'E2E test identity provider' })).toBeVisible();
  expect(new URL(page.url()).origin).not.toBe(new URL(base).origin);
  await page.getByLabel('Username').fill(username);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await page.waitForURL((url) => url.origin === new URL(base).origin);
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await expect(page.getByText(`E2E ${username}`).first()).toBeVisible();
}

/** The `Terminal: …` status line. Anchored: "Not connected" must not match "Connected". */
export function terminalState(page: Page) {
  return page.locator('.terminal-bar__state');
}

export async function expectTerminalConnected(page: Page, timeout = 120_000): Promise<void> {
  await expect(terminalState(page)).toHaveText(/Terminal: Connected$/, { timeout });
}

/** Type a command into xterm and press Enter. */
export async function typeInTerminal(page: Page, command: string): Promise<void> {
  await page.locator('.terminal-surface').click();
  await page.keyboard.type(command, { delay: 5 });
  await page.keyboard.press('Enter');
}

/** Wait for text to appear in xterm's rendered rows. */
export async function expectTerminalOutput(page: Page, text: string | RegExp, timeout = 30_000): Promise<void> {
  await expect(page.locator('.xterm-rows')).toContainText(text, { timeout });
}

/**
 * Run a command whose output is wrapped in a unique marker, and return what it
 * printed. The marker is computed by the shell (`$((…))`), so the echo of the
 * typed command line never matches — only real output does.
 */
export async function runInTerminal(page: Page, command: string, timeout = 30_000): Promise<string> {
  const n = Math.floor(Math.random() * 90_000) + 10_000;
  const tag = `E2E${n * 3}`;
  await typeInTerminal(page, `echo "E2E$((${n}*3))<$(${command} 2>&1 | tr '\\n' ' ')>E2E$((${n}*3))"`);
  const rows = page.locator('.xterm-rows');
  const pattern = new RegExp(`${tag}<([^>]*)>${tag}`);
  await expect(rows).toContainText(pattern, { timeout });
  const text = (await rows.innerText()).replace(/\s*\n\s*/g, '');
  return pattern.exec(text)?.[1]?.trim() ?? '';
}

function browserHeaders(): Record<string, string> {
  // What a same-origin fetch from the app sends; the API's origin guard checks it.
  return { origin: requiredEnv('E2E_BASE_URL'), accept: 'application/json' };
}

/** GET with the context's cookies. */
export function apiGet(context: BrowserContext, path: string): Promise<APIResponse> {
  return context.request.get(`${requiredEnv('E2E_BASE_URL')}${path}`, { headers: browserHeaders() });
}

export function apiSend(context: BrowserContext, method: 'POST' | 'DELETE', path: string): Promise<APIResponse> {
  return context.request.fetch(`${requiredEnv('E2E_BASE_URL')}${path}`, { method, headers: browserHeaders() });
}

interface MySession {
  sessionId: string;
  labId: string;
  status: string;
}

export async function mySessions(context: BrowserContext): Promise<MySession[]> {
  const response = await apiGet(context, '/api/sessions');
  expect(response.status(), 'GET /api/sessions').toBe(200);
  const body = (await response.json()) as { data: { sessions: { session: MySession }[] } };
  return body.data.sessions.map((entry) => entry.session);
}

/**
 * End every live session this context's student holds. Best effort, used in
 * `finally` blocks so a failed assertion never leaves a container running.
 */
export async function endAllSessions(context: BrowserContext): Promise<void> {
  try {
    for (const session of await mySessions(context)) {
      await apiSend(context, 'DELETE', `/api/sessions/${encodeURIComponent(session.sessionId)}`);
    }
  } catch {
    // Cleanup must not mask the original failure; e2e/stack.sh down also
    // removes every container this runtime owner created.
  }
}

/** Live sandbox containers for this stack's runtime owner, straight from Docker. */
export function ownerContainers(): string[] {
  const owner = requiredEnv('E2E_RUNTIME_OWNER_ID');
  const out = execFileSync(
    'docker',
    ['ps', '-q', '--filter', 'label=jumptotech.io/managed=true', '--filter', `label=jumptotech.io/runtime-owner=${owner}`],
    { encoding: 'utf8', timeout: 15_000 },
  );
  return out.split('\n').filter(Boolean);
}

export interface SocketProbe {
  /** The terminal service answered the auth frame with `ready`. */
  ready: boolean;
  /** WebSocket close code, or null if still open when the probe ended. */
  closeCode: number | null;
  /** Server `error` frame codes, in order. */
  errors: string[];
  /** Concatenated `output` frames. */
  output: string;
}

/**
 * Open the terminal WebSocket from inside the page — the browser's own
 * `WebSocket`, same origin, through nginx — authenticate with `token`, and if
 * the service accepts it, run `command` and collect output until `expect`
 * appears. Bounded by `timeoutMs`; always closes the socket it opened.
 */
export async function probeTerminalSocket(
  page: Page,
  token: string,
  command: string,
  expectText: string,
  timeoutMs = 20_000,
): Promise<SocketProbe> {
  return page.evaluate(
    ({ token, command, expectText, timeoutMs }) =>
      new Promise<SocketProbe>((resolve) => {
        const result: SocketProbe = { ready: false, closeCode: null, errors: [], output: '' };
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const socket = new WebSocket(`${proto}//${window.location.host}/terminal`);
        const finish = () => {
          clearTimeout(timer);
          if (socket.readyState === WebSocket.OPEN) socket.close(1000);
          resolve(result);
        };
        const timer = setTimeout(finish, timeoutMs);
        socket.onopen = () => socket.send(JSON.stringify({ type: 'auth', token, cols: 120, rows: 30 }));
        socket.onmessage = (event) => {
          const msg = JSON.parse(String(event.data)) as { type: string; data?: string; code?: string };
          if (msg.type === 'ready') {
            result.ready = true;
            socket.send(JSON.stringify({ type: 'input', data: `${command}\r` }));
          } else if (msg.type === 'output') {
            result.output += msg.data ?? '';
            if (result.output.includes(expectText)) finish();
          } else if (msg.type === 'error' && msg.code) {
            result.errors.push(msg.code);
          }
        };
        socket.onclose = (event) => {
          result.closeCode = event.code;
          finish();
        };
      }),
    { token, command, expectText, timeoutMs },
  );
}

/** A fresh terminal grant for a session, requested with the context's own cookie. */
export async function terminalToken(context: BrowserContext, sessionId: string): Promise<{ status: number; token?: string }> {
  const response = await apiSend(context, 'POST', `/api/sessions/${encodeURIComponent(sessionId)}/terminal`);
  if (response.status() !== 200) return { status: response.status() };
  const body = (await response.json()) as { data: { terminal: { token: string } } };
  return { status: 200, token: body.data.terminal.token };
}
