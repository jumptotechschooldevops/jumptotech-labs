/**
 * E2E-010 — two students, two browsers, one stack.
 *
 * Each student is a separate browser context (separate cookie jar, separate
 * storage), signed in through the identity provider under a different
 * username. Student B is handed Student A's real, live session id and must get
 * nothing for it — in the UI, over HTTP with B's own cookie, and inside B's own
 * terminal.
 */
import { expect, test } from '@playwright/test';
import {
  LAB_ID,
  apiGet,
  apiSend,
  endAllSessions,
  expectTerminalConnected,
  mySessions,
  runInTerminal,
  signIn,
  uniqueStudent,
} from './support/student.js';

test('a second student cannot see or reach the first student\'s session or workspace', async ({ browser }) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  const studentA = uniqueStudent('iso-a');
  const studentB = uniqueStudent('iso-b');
  const marker = `private-${studentA}`;

  try {
    let sessionA = '';

    await test.step('student A launches LINUX-001 and leaves a private file in the sandbox', async () => {
      await signIn(pageA, studentA);
      await pageA.goto(`/#/labs/${LAB_ID}`);
      await pageA.getByRole('button', { name: 'Launch lab' }).click();
      await expect(pageA.locator('.workspace__status')).toContainText('Ready', { timeout: 180_000 });
      await expectTerminalConnected(pageA);
      await runInTerminal(pageA, `echo ${marker} > ~/owner-marker.txt`);
      expect(await runInTerminal(pageA, 'cat ~/owner-marker.txt')).toBe(marker);
      const sessions = await mySessions(contextA);
      expect(sessions).toHaveLength(1);
      sessionA = sessions[0]!.sessionId;
    });

    await test.step('student B signs in separately and the UI shows no running lab', async () => {
      await signIn(pageB, studentB);
      await expect(pageB.getByRole('heading', { name: 'You have a lab running' })).toHaveCount(0);
      expect(await mySessions(contextB)).toEqual([]);

      await pageB.goto(`/#/labs/${LAB_ID}/workspace`);
      // The same URL A is working at: for B there is nothing running there.
      await expect(pageB.getByRole('heading', { level: 1, name: `${LAB_ID} is not running` })).toBeVisible();
      await expect(pageB.locator('.terminal-bar__state')).toHaveCount(0);
      expect(await pageB.content()).not.toContain(sessionA);
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

    await test.step('student B\'s own sandbox is a separate filesystem, in both directions', async () => {
      await pageB.goto(`/#/labs/${LAB_ID}`);
      await pageB.getByRole('button', { name: 'Launch lab' }).click();
      await expect(pageB.locator('.workspace__status')).toContainText('Ready', { timeout: 180_000 });
      await expectTerminalConnected(pageB);
      expect(await runInTerminal(pageB, 'cat ~/owner-marker.txt')).toMatch(/No such file/);
      // Every Linux sandbox has the same hostname by design, so separation is
      // proven by files: B writes its own, and A cannot see it.
      const markerB = `private-${studentB}`;
      await runInTerminal(pageB, `echo ${markerB} > ~/owner-marker-b.txt`);
      expect(await runInTerminal(pageA, 'cat ~/owner-marker-b.txt')).toMatch(/No such file/);
      expect(await runInTerminal(pageA, 'cat ~/owner-marker.txt')).toBe(marker);
      expect(await runInTerminal(pageB, 'cat ~/owner-marker-b.txt')).toBe(markerB);
      const [a, b] = [await mySessions(contextA), await mySessions(contextB)];
      expect(b).toHaveLength(1);
      expect(b[0]!.sessionId).not.toBe(a[0]!.sessionId);
    });
  } finally {
    await endAllSessions(contextA);
    await endAllSessions(contextB);
    await contextA.close();
    await contextB.close();
  }
});
