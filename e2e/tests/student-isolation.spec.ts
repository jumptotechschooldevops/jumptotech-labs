/**
 * E2E-010 — two students, two browsers, one stack.
 *
 * Each student is a separate browser context (separate cookie jar, separate
 * storage), signed in through the identity provider under a different
 * username. Student B is handed Student A's real, live session id and must get
 * nothing for it: not in the UI, not over HTTP with B's own cookie, not through
 * the terminal WebSocket, not from the verifier, and not in progress.
 */
import { expect, test } from '@playwright/test';
import {
  LAB_ID,
  LINUX_001_SOLUTION,
  apiGet,
  apiSend,
  endAllSessions,
  expectTerminalConnected,
  mySessions,
  probeTerminalSocket,
  runInTerminal,
  signIn,
  terminalToken,
  uniqueStudent,
} from './support/student.js';

test('a second student cannot reach the first student\'s session, terminal, sandbox, verification or progress', async ({ browser }) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  const studentA = uniqueStudent('iso-a');
  const studentB = uniqueStudent('iso-b');
  const marker = `private-${studentA}`;

  try {
    let sessionA = '';

    await test.step('student A launches LINUX-001, leaves a private file, and passes Verify', async () => {
      await signIn(pageA, studentA);
      await pageA.goto(`/#/labs/${LAB_ID}`);
      await pageA.getByRole('button', { name: 'Launch lab' }).click();
      await expect(pageA.locator('.workspace__status')).toContainText('Ready', { timeout: 180_000 });
      await expectTerminalConnected(pageA);
      await runInTerminal(pageA, `echo ${marker} > ~/owner-marker.txt`);
      expect(await runInTerminal(pageA, 'cat ~/owner-marker.txt')).toBe(marker);
      await runInTerminal(pageA, LINUX_001_SOLUTION);
      await pageA.getByRole('button', { name: 'Verify', exact: true }).click();
      await expect(pageA.locator('section.verify')).toContainText('Lab passed — every check passes', { timeout: 60_000 });
      const sessions = await mySessions(contextA);
      expect(sessions).toHaveLength(1);
      sessionA = sessions[0]!.sessionId;
    });

    await test.step('student B signs in separately and the UI shows no running lab and no progress', async () => {
      await signIn(pageB, studentB);
      await expect(pageB.getByRole('heading', { name: 'You have a lab running' })).toHaveCount(0);
      expect(await mySessions(contextB)).toEqual([]);

      await pageB.goto(`/#/labs/${LAB_ID}/workspace`);
      // The same URL A is working at: for B there is nothing running there.
      await expect(pageB.getByRole('heading', { level: 1, name: `${LAB_ID} is not running` })).toBeVisible();
      await expect(pageB.locator('.terminal-bar__state')).toHaveCount(0);
      expect(await pageB.content()).not.toContain(sessionA);

      // A's completion is A's alone.
      await pageB.goto('/#/progress');
      await expect(pageB.getByRole('progressbar', { name: /^Overall: 0 of \d+ labs completed$/ })).toBeVisible();
      await pageA.goto('/#/progress');
      await expect(pageA.getByRole('progressbar', { name: /^Overall: 1 of \d+ labs completed$/ })).toBeVisible();
    });

    await test.step('student B\'s cookie buys nothing on student A\'s session id', async () => {
      const id = encodeURIComponent(sessionA);
      for (const [method, path] of [
        ['GET', `/api/sessions/${id}`],
        ['POST', `/api/sessions/${id}/terminal`],
        ['POST', `/api/sessions/${id}/check`],
        ['POST', `/api/sessions/${id}/activity`],
        ['POST', `/api/sessions/${id}/reset`],
        ['DELETE', `/api/sessions/${id}`],
      ] as const) {
        const response = method === 'GET' ? await apiGet(contextB, path) : await apiSend(contextB, method, path);
        expect(response.status(), `${method} ${path}`).toBe(404);
        expect(((await response.json()) as { error?: { code?: string } }).error?.code).toBe('SESSION_NOT_FOUND');
      }
      // A's session is untouched by all of that.
      expect(await mySessions(contextA)).toMatchObject([{ sessionId: sessionA, status: 'ACTIVE' }]);
    });

    let sessionB = '';

    await test.step('student B\'s own sandbox is a separate filesystem and B\'s Verify grades only B\'s work', async () => {
      await pageB.goto(`/#/labs/${LAB_ID}`);
      await pageB.getByRole('button', { name: 'Launch lab' }).click();
      await expect(pageB.locator('.workspace__status')).toContainText('Ready', { timeout: 180_000 });
      await expectTerminalConnected(pageB);
      expect(await runInTerminal(pageB, 'cat ~/owner-marker.txt')).toMatch(/No such file/);
      expect(await runInTerminal(pageB, 'ls ~/project')).toMatch(/No such file/);

      // Every Linux sandbox has the same hostname by design, so separation is
      // proven by files: B writes its own, and A cannot see it.
      const markerB = `private-${studentB}`;
      await runInTerminal(pageB, `echo ${markerB} > ~/owner-marker-b.txt`);
      await pageA.goto(`/#/labs/${LAB_ID}/workspace`);
      await expectTerminalConnected(pageA);
      expect(await runInTerminal(pageA, 'cat ~/owner-marker-b.txt')).toMatch(/No such file/);
      expect(await runInTerminal(pageA, 'cat ~/owner-marker.txt')).toBe(marker);

      // A passed in A's sandbox; B's verifier reads B's sandbox and sees none of it.
      await pageB.getByRole('button', { name: 'Verify', exact: true }).click();
      await expect(pageB.locator('section.verify')).toContainText('Not complete yet — 1 of 5 checks passing', { timeout: 60_000 });
      await expect(pageB.locator('.workspace__status')).not.toContainText('Completed');

      const sessions = await mySessions(contextB);
      expect(sessions).toHaveLength(1);
      sessionB = sessions[0]!.sessionId;
      expect(sessionB).not.toBe(sessionA);
    });

    await test.step('the terminal WebSocket, opened from B\'s browser, refuses B\'s token re-pointed at A\'s session', async () => {
      const grant = await terminalToken(contextB, sessionB);
      expect(grant.status).toBe(200);
      const [payload, signature] = grant.token!.split('.');
      const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as { sid: string };
      expect(claims.sid).toBe(sessionB);

      // Positive control through the same code path: B's own grant attaches
      // and runs a command, so a refusal below is the boundary, not the probe.
      const own = await probeTerminalSocket(pageB, grant.token!, 'echo "OWN$((20+22))"', 'OWN42');
      expect(own.ready, JSON.stringify(own)).toBe(true);
      expect(own.output).toContain('OWN42');

      const forgedPayload = Buffer.from(JSON.stringify({ ...claims, sid: sessionA })).toString('base64url');
      const forged = await probeTerminalSocket(pageB, `${forgedPayload}.${signature}`, 'cat ~/owner-marker.txt', marker);
      expect(forged.ready).toBe(false);
      expect(forged.closeCode).toBe(4401);
      expect(forged.errors).toContain('UNAUTHORIZED');
      expect(forged.output).not.toContain(marker);

      // A's own terminal is unaffected and still sees A's file.
      await pageA.reload();
      await expectTerminalConnected(pageA);
      expect(await runInTerminal(pageA, 'cat ~/owner-marker.txt')).toBe(marker);
    });
  } finally {
    await endAllSessions(contextA);
    await endAllSessions(contextB);
    await contextA.close();
    await contextB.close();
  }
});
