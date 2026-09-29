/**
 * SEC-ARCH-2 on a real kernel: one session's shell cannot reach another's.
 *
 * Runs only where this process was launched exactly as the terminal image
 * launches the service — non-root, holding SETUID, SETGID and CHOWN as ambient
 * capabilities, with no_new_privs, and the credential and workspace roots as
 * service-owned 0711 tmpfs — which `make test-terminal-isolation` arranges in a
 * container. The isolation is decided with `production: true`, so that launch
 * is held to production's rules too.
 *
 * Everything real: the terminal server, the WebSocket and token check, the
 * credential exchange over HTTP (a stub api that answers like the real one),
 * PTYs, bash, setpriv, the kernel's permission checks. Nothing mocked.
 *
 * ```text
 *   A, B        two Kubernetes-track students       uid 1900000101, 1900000102
 *   D           a Docker-track student (workspace)  uid 1900000104
 *   E           a session the api hands a bad uid   1001
 *   P1…P5       five students at once
 * ```
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile, readdir, stat } from 'node:fs/promises';
import WebSocket from 'ws';
import { SHELL_UID_MIN, issueSessionToken } from '@jumptotech/lab-orchestrator';

const OPTED_IN = process.env.RUN_INTEGRATION_TESTS === '1' && process.env.JTT_SHELL_ISOLATION_TEST === '1';
const suite = OPTED_IN ? describe : describe.skip;

const TERMINAL_SECRET = 'shell-isolation-terminal-secret';
const INTERNAL_SECRET = 'shell-isolation-internal-secret';
const CREDENTIALS_DIR = '/run/jumptotech';
const WORKSPACE_ROOT = '/home/student/workspaces';

interface Seat {
  sessionId: string;
  owner: string;
  kind: 'kubernetes' | 'docker-daemon';
  shellUid: number;
}

const seat = (n: number, kind: Seat['kind'] = 'kubernetes', shellUid = SHELL_UID_MIN + 100 + n): Seat => ({
  sessionId: `sess-${n.toString(16).padStart(16, '0')}`,
  owner: `usr-${String(n).padStart(8, '0')}`,
  kind,
  shellUid,
});

const A = seat(1);
const B = seat(2);
const D = seat(4, 'docker-daemon');
const E = seat(5, 'kubernetes', 1001);
const PEERS = [11, 12, 13, 14, 15].map((n) => seat(n));
const SEATS = new Map([A, B, D, E, ...PEERS].map((s) => [s.sessionId, s]));

const BASELINE = 'FROM alpine:3.20\nCMD ["echo", "baseline"]\n';

let api: Server;
let terminal: Server;
let url: string;
let base: string;
const sockets: WebSocket[] = [];

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

/** Answers the credential exchange like the real api: owner-checked, server-derived. */
function stubApi(): Server {
  return createServer((req, res) => {
    const match = /^\/internal\/sessions\/(sess-[0-9a-f]+)\/(credentials|activity)$/.exec(req.url ?? '');
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const s = match ? SEATS.get(match[1]!) : undefined;
      const claimed = (JSON.parse(body || '{}') as { ownerUserId?: string }).ownerUserId;
      if (!s || req.headers['x-internal-secret'] !== INTERNAL_SECRET || claimed !== s.owner) {
        res.writeHead(403, { 'content-type': 'application/json' }).end(
          JSON.stringify({ ok: false, error: { code: 'SESSION_NOT_OWNED', message: 'not yours' } }),
        );
        return;
      }
      if (match![2] === 'activity') {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true,"data":{"recorded":true}}');
        return;
      }
      const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
      const data =
        s.kind === 'kubernetes'
          ? {
              kind: 'kubernetes',
              kubeconfig: `apiVersion: v1\nkind: Config\n# secret-of-${s.sessionId}\n`,
              namespace: `lab-${s.sessionId.slice(-12)}`,
              serviceAccountName: 'student',
              expiresAt,
              shellUid: s.shellUid,
            }
          : {
              kind: 'docker-daemon',
              dockerHost: `tcp://jtt-lab-${s.sessionId.slice(-12)}:2376`,
              ca: `ca-of-${s.sessionId}`,
              clientCert: `cert-of-${s.sessionId}`,
              clientKey: `KEY-OF-${s.sessionId}`,
              sandboxRef: `jtt-lab-${s.sessionId.slice(-12)}`,
              workspaceFiles: [{ path: 'Dockerfile', content: BASELINE }],
              expiresAt,
              shellUid: s.shellUid,
            };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, data }));
    });
  });
}

const tokenFor = (s: Seat) =>
  issueSessionToken({
    sessionId: s.sessionId,
    ownerUserId: s.owner,
    labId: s.kind === 'kubernetes' ? 'K8S-001' : 'DOCKER-001',
    namespace: `lab-${s.sessionId.slice(-12)}`,
    secret: TERMINAL_SECRET,
    ttlSeconds: 600,
  }).token;

interface Shell {
  ws: WebSocket;
  ready: Record<string, unknown>;
  /** Run one command line; resolves with what it printed (stdout and stderr). */
  run: (command: string, timeoutMs?: number) => Promise<string>;
  closed: Promise<number>;
}

let marker = 0;

async function attach(s: Seat, extraAuth: Record<string, unknown> = {}): Promise<Shell> {
  const ws = new WebSocket(url, { headers: { origin: 'http://localhost:3000' } });
  sockets.push(ws);
  let buffer = '';
  let firstFrame: ((frame: Record<string, unknown>) => void) | undefined;
  const first = new Promise<Record<string, unknown>>((resolve) => (firstFrame = resolve));
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
  ws.on('message', (raw) => {
    const frame = JSON.parse(String(raw)) as Record<string, unknown>;
    if (frame.type === 'output') buffer += String(frame.data);
    if (frame.type === 'ready' || frame.type === 'error') firstFrame?.(frame);
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.send(JSON.stringify({ type: 'auth', token: tokenFor(s), cols: 200, rows: 50, ...extraAuth }));
  const ready = await first;

  const run = async (command: string, timeoutMs = 15_000): Promise<string> => {
    const n = (marker += 1);
    // Typed with an empty quote inside, so the echo of the typed line never
    // contains the markers the output does.
    const open = `__JTT_S${n}__`;
    const close = `__JTT_E${n}__`;
    const start = buffer.length;
    ws.send(
      JSON.stringify({
        type: 'input',
        data: `echo __JTT_S""${n}__; { ${command}; } 2>&1; echo __JTT_E""${n}__\r`,
      }),
    );
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const seen = buffer.slice(start);
      const from = seen.indexOf(`${open}\r\n`);
      const to = from === -1 ? -1 : seen.indexOf(close, from);
      if (to !== -1) {
        return seen
          .slice(from + open.length, to)
          .replace(/\r/g, '')
          .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
          .trim();
      }
      if (Date.now() > deadline) throw new Error(`timed out running: ${command}\n--- saw ---\n${seen}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  // No job-control chatter ("[1] 1234") in anything a command prints.
  if (ready.type === 'ready') await run('set +m');
  return { ws, ready, run, closed };
}

async function internal(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-secret': INTERNAL_SECRET },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** An interactive bash announces a background job (`[1] 305`) before `$!` prints. */
const lastLine = (text: string): string => text.trim().split('\n').pop()!.trim();

/** Every live process whose real uid is `uid`, from /proc. */
async function pidsOf(uid: number): Promise<number[]> {
  const pids: number[] = [];
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const status = await readFile(`/proc/${entry}/status`, 'utf8');
      if (new RegExp(`^Uid:\\s+${uid}\\s`, 'm').test(status)) pids.push(Number(entry));
    } catch {
      /* gone */
    }
  }
  return pids;
}

/** Whether `pid` is a live process (a zombie is not). */
async function isRunning(pid: number): Promise<boolean> {
  try {
    return !/^State:\s+Z/m.test(await readFile(`/proc/${pid}/status`, 'utf8'));
  } catch {
    return false;
  }
}

suite('SEC-ARCH-2 — a Unix identity per session, on a real kernel', () => {
  let a: Shell;
  let b: Shell;

  beforeAll(async () => {
    const { detectShellIsolation } = await import('../src/shell-identity.js');
    const { loadTerminalConfig } = await import('../src/config.js');
    const { createTerminalServer } = await import('../src/server.js');

    // Production's rules: this refuses unless the launch is exactly right.
    const isolation = detectShellIsolation({ production: true, maxProcesses: 64 });
    expect(isolation.mode).toBe('per-session');

    api = stubApi();
    const apiPort = await listen(api);
    const config = loadTerminalConfig({
      TERMINAL_SESSION_SECRET: TERMINAL_SECRET,
      INTERNAL_SERVICE_SECRET: INTERNAL_SECRET,
      API_INTERNAL_URL: `http://127.0.0.1:${apiPort}`,
      TERMINAL_CREDENTIALS_DIR: CREDENTIALS_DIR,
      TERMINAL_WORKSPACE_ROOT: WORKSPACE_ROOT,
      TERMINAL_WORKDIR: '/home/student',
      TERMINAL_SHELL: '/bin/bash',
      TERMINAL_MAX_SESSIONS: '32',
      TERMINAL_SHELL_MAX_PROCESSES: '64',
      ALLOWED_ORIGINS: 'http://localhost:3000',
    } as NodeJS.ProcessEnv);
    terminal = createTerminalServer(config, undefined, isolation);
    const port = await listen(terminal);
    url = `ws://127.0.0.1:${port}/terminal`;
    base = `http://127.0.0.1:${port}`;

    a = await attach(A);
    b = await attach(B);
    expect(a.ready).toMatchObject({ type: 'ready', sessionId: A.sessionId });
    expect(b.ready).toMatchObject({ type: 'ready', sessionId: B.sessionId });
  }, 120_000);

  afterAll(async () => {
    for (const ws of sockets) ws.terminate();
    terminal?.close();
    api?.close();
  });

  it('runs each session’s shell as its own uid, holding no capability and no other group', async () => {
    expect(await a.run('id -u; id -G')).toBe(`${A.shellUid}\n${A.shellUid}`);
    expect(await b.run('id -u; id -G')).toBe(`${B.shellUid}\n${B.shellUid}`);
    for (const shell of [a, b]) {
      const caps = await shell.run("grep -E '^(CapInh|CapPrm|CapEff|CapAmb|NoNewPrivs)' /proc/self/status");
      expect(caps).toMatch(/CapInh:\s+0{16}/);
      expect(caps).toMatch(/CapPrm:\s+0{16}/);
      expect(caps).toMatch(/CapEff:\s+0{16}/);
      expect(caps).toMatch(/CapAmb:\s+0{16}/);
      expect(caps).toMatch(/NoNewPrivs:\s+1/);
    }
    // And is not the service: this very process.
    expect(await a.run('id -u')).not.toBe(String(process.getuid!()));
  });

  it('keeps each session’s credentials and home its own: B cannot read, write or list A’s', async () => {
    const kubeconfig = await a.run('echo $KUBECONFIG');
    const home = await a.run('echo $HOME');
    expect(kubeconfig).toMatch(new RegExp(`^${CREDENTIALS_DIR}/`));
    expect(await a.run(`cat ${kubeconfig}`)).toContain(`secret-of-${A.sessionId}`);
    expect(await a.run('echo mine > ~/notes && cat ~/notes')).toBe('mine');
    expect((await stat(kubeconfig)).uid).toBe(A.shellUid);
    expect((await stat(kubeconfig)).mode & 0o777).toBe(0o600);
    expect((await stat(home)).mode & 0o777).toBe(0o700);

    expect(await b.run(`cat ${kubeconfig}`)).toMatch(/Permission denied/);
    expect(await b.run(`echo pwned > ${kubeconfig}`)).toMatch(/Permission denied/);
    expect(await b.run(`ls ${CREDENTIALS_DIR}`)).toMatch(/Permission denied/);
    expect(await b.run(`ls ${WORKSPACE_ROOT}`)).toMatch(/Permission denied/);
    expect(await b.run(`cat ${home}/notes`)).toMatch(/Permission denied/);
    expect(await b.run(`touch ${home}/planted`)).toMatch(/Permission denied/);
    expect(await a.run(`cat ${kubeconfig}`)).toContain(`secret-of-${A.sessionId}`);
    expect(await a.run('ls ~')).not.toContain('planted');
  });

  it('keeps each session’s processes its own: B cannot signal A’s or read their environment', async () => {
    const pid = lastLine(await a.run('sleep 1000 & echo $!'));
    expect(pid).toMatch(/^\d+$/);
    expect(await b.run(`kill -9 ${pid}`)).toMatch(/Operation not permitted/);
    expect(await b.run(`tr '\\0' '\\n' < /proc/${pid}/environ`)).toMatch(/Permission denied/);
    expect(await a.run(`kill -0 ${pid} && echo alive`)).toBe('alive');
  });

  it('keeps the service’s own memory closed to every shell', async () => {
    const service = process.pid;
    for (const shell of [a, b]) {
      expect(await shell.run(`tr '\\0' '\\n' < /proc/${service}/environ | head -c 40`)).toMatch(/Permission denied/);
      expect(await shell.run(`head -c 1 /proc/${service}/mem`)).toMatch(/Permission denied|Input\/output error/);
      expect(await shell.run(`kill -0 ${service}`)).toMatch(/Operation not permitted/);
    }
  });

  it('leaves the tools a Kubernetes or Docker lab uses working as the session’s own uid', async () => {
    // kubectl reads the session's kubeconfig and writes its cache under a home
    // that is the session's own.
    expect(await a.run('kubectl config view -o jsonpath={.kind}')).toBe('Config');
    expect(await a.run('kubectl version --client -o json >/dev/null && echo client-ok')).toBe('client-ok');
    expect(await a.run('mkdir -p ~/.kube/cache && touch ~/.kube/cache/x && echo cache-ok')).toBe('cache-ok');
    // Files a student makes are readable by what they build: `COPY` into an
    // image keeps the mode, and a 0600 file is unreadable to a non-root app.
    expect(await a.run('umask')).toBe('0022');
    expect(await a.run('echo hi > ~/app.py && stat -c %a ~/app.py')).toBe('644');
    expect(await a.run('docker --version >/dev/null && echo docker-cli-ok')).toBe('docker-cli-ok');
  });

  it('gives a shell no way back up: no uid 0, no other session’s uid', async () => {
    expect(await a.run('setpriv --reuid=0 true')).toMatch(/Operation not permitted/);
    expect(await a.run(`setpriv --reuid=${B.shellUid} true`)).toMatch(/Operation not permitted/);
    expect(await a.run('id -u')).toBe(String(A.shellUid));
  });

  it('keeps the identity across a reconnect, and the home with it', async () => {
    const again = await attach(A);
    expect(again.ready).toMatchObject({ type: 'ready', sessionId: A.sessionId });
    expect(await again.run('id -u')).toBe(String(A.shellUid));
    expect(await again.run('cat ~/notes')).toBe('mine');
    a = again;
  });

  /*
   * The service is not the shell's uid and holds no CAP_KILL, so a signal it
   * sends to the shell is refused by the kernel. Only closing the PTY ends
   * the shell, through the terminal hangup. A socket that goes away without
   * doing so leaves its bash, and whatever runs in the foreground, until End.
   */
  it('ends the shell a reconnect replaces, and the shell of a socket that drops', async () => {
    const replaced = await a.run('echo $$');
    expect(replaced).toMatch(/^\d+$/);
    const again = await attach(A);
    expect(again.ready).toMatchObject({ type: 'ready', sessionId: A.sessionId });
    await a.closed;
    a = again;
    await expect.poll(() => isRunning(Number(replaced)), { timeout: 10_000 }).toBe(false);

    const dropped = await attach(A);
    const droppedPid = await dropped.run('echo $$');
    dropped.ws.terminate();
    await dropped.closed;
    await expect.poll(() => isRunning(Number(droppedPid)), { timeout: 10_000 }).toBe(false);

    a = await attach(A);
    expect(await a.run('cat ~/notes')).toBe('mine');
  }, 60_000);

  it('ignores a uid, gid or user named in the auth frame', async () => {
    const planted = await attach(B, { uid: 0, gid: 0, shellUid: A.shellUid, user: 'root' });
    expect(planted.ready).toMatchObject({ type: 'ready', sessionId: B.sessionId });
    expect(await planted.run('id -u')).toBe(String(B.shellUid));
    b = planted;
  });

  it('opens no shell for a session the api hands an invalid uid', async () => {
    const before = (await pidsOf(1001)).length;
    const refused = await attach(E);
    expect(refused.ready).toMatchObject({ type: 'error', code: 'SHELL_IDENTITY_UNSAFE' });
    expect(await refused.closed).toBe(4403);
    expect((await pidsOf(1001)).length).toBe(before);
  });

  it('bounds one student’s processes without touching anyone else’s', async () => {
    expect(await b.run('ulimit -u')).toBe('64');
    // dash, not bash: bash retries a refused fork for half a minute each time.
    const out = await b.run("/bin/sh -c 'for i in $(seq 1 120); do sleep 300 & done' ; echo spawned", 60_000);
    expect(out).toMatch(/Cannot fork|Resource temporarily unavailable/);
    expect((await pidsOf(B.shellUid)).length).toBeLessThanOrEqual(64);
    // A still works, and a new student can still get a shell.
    expect(await a.run('echo still-here')).toBe('still-here');
    const extra = await attach(PEERS[0]!);
    expect(await extra.run('id -u')).toBe(String(PEERS[0]!.shellUid));
    await internal('/internal/terminate', { sessionId: PEERS[0]!.sessionId });
    // B clears its own: `kill -1` as B spares the calling shell.
    await b.run('kill -9 -1');
    expect((await pidsOf(B.shellUid)).length).toBeLessThan(5);
  }, 90_000);

  it('ends everything a session left behind at End — a setsid escapee included — and nobody else’s', async () => {
    await a.run('setsid nohup sleep 1000 >/dev/null 2>&1 < /dev/null & disown; echo started');
    const home = await a.run('echo $HOME');
    await a.run('mkdir -p ~/locked/deeper && chmod 000 ~/locked/deeper ~/locked');
    const bPid = lastLine(await b.run('sleep 1000 & echo $!'));
    expect((await pidsOf(A.shellUid)).length).toBeGreaterThan(0);

    const ended = await internal('/internal/terminate', { sessionId: A.sessionId });
    expect(ended).toMatchObject({ status: 200, body: { ok: true, data: { terminated: true } } });
    await a.closed;

    expect(await pidsOf(A.shellUid)).toEqual([]);
    await expect(stat(home)).rejects.toMatchObject({ code: 'ENOENT' });
    // B — its shell and its background job — untouched.
    expect(await b.run(`kill -0 ${bPid} && echo alive`)).toBe('alive');
    expect((await pidsOf(B.shellUid)).length).toBeGreaterThan(1);
  }, 60_000);

  it('hands a Docker student their workspace, reads it for the verifier, restores it, and removes it', async () => {
    const d = await attach(D);
    expect(d.ready).toMatchObject({ type: 'ready', sessionId: D.sessionId });
    const workspace = await d.run('echo $JTT_WORKSPACE');
    expect(await d.run('cat Dockerfile')).toContain('baseline');
    expect((await stat(workspace)).uid).toBe(D.shellUid);
    expect(await d.run('cat $DOCKER_CERT_PATH/key.pem')).toBe(`KEY-OF-${D.sessionId}`);

    // Another student can neither read the work nor the key.
    expect(await b.run(`cat ${workspace}/Dockerfile`)).toMatch(/Permission denied/);
    const certDir = await d.run('echo $DOCKER_CERT_PATH');
    expect(await b.run(`cat ${certDir}/key.pem`)).toMatch(/Permission denied/);
    expect(await b.run(`ls ${certDir}`)).toMatch(/Permission denied/);

    // The verifier reads what the student wrote; a link out of the workspace reads nothing.
    await d.run("printf 'FROM alpine:3.20\\nCMD [\"echo\", \"mine\"]\\n' > Dockerfile && ln -sf /proc/self/environ leak");
    expect(await internal('/internal/workspace/read', { sessionId: D.sessionId, path: 'Dockerfile' })).toMatchObject({
      status: 200,
      body: { data: { exists: true, content: expect.stringContaining('mine') } },
    });
    const leak = await internal('/internal/workspace/read', { sessionId: D.sessionId, path: 'leak' });
    expect(JSON.stringify(leak.body)).not.toMatch(/TERMINAL_SESSION_SECRET|INTERNAL_SERVICE_SECRET/);
    // …and the workspace is the student's again afterwards.
    expect((await stat(workspace)).uid).toBe(D.shellUid);
    expect(await d.run('echo more >> Dockerfile && echo ok')).toBe('ok');

    // Reset restores the baseline, still the student's.
    const seeded = await internal('/internal/workspace/seed', {
      sessionId: D.sessionId,
      files: [{ path: 'Dockerfile', content: BASELINE }],
    });
    expect(seeded.status).toBe(200);
    expect(await d.run('cat Dockerfile')).toContain('baseline');
    expect(await d.run('stat -c %u Dockerfile')).toBe(String(D.shellUid));

    await d.run('mkdir -p trap/inner && chmod 000 trap/inner trap');
    await internal('/internal/terminate', { sessionId: D.sessionId });
    await d.closed;
    await expect(stat(workspace)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await pidsOf(D.shellUid)).toEqual([]);
  }, 60_000);

  it('gives five students at once five working shells and five distinct identities, none able to read another’s', async () => {
    const shells = await Promise.all(PEERS.map((s) => attach(s)));
    const uids = await Promise.all(shells.map((s) => s.run('id -u')));
    expect(uids).toEqual(PEERS.map((s) => String(s.shellUid)));
    expect(new Set(uids).size).toBe(5);
    const configs = await Promise.all(shells.map((s) => s.run('echo $KUBECONFIG')));
    for (const [i, shell] of shells.entries()) {
      expect(await shell.run(`cat ${configs[i]}`)).toContain(`secret-of-${PEERS[i]!.sessionId}`);
      const neighbour = configs[(i + 1) % configs.length]!;
      expect(await shell.run(`cat ${neighbour}`)).toMatch(/Permission denied/);
    }
    for (const s of PEERS) await internal('/internal/terminate', { sessionId: s.sessionId });
    for (const s of PEERS) expect(await pidsOf(s.shellUid)).toEqual([]);
  }, 90_000);
});
