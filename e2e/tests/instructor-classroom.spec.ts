/**
 * The classroom view, in real browsers, on the real stack.
 *
 * An instructor and an administrator — given their roles the supported way,
 * `ops role set` over the operator socket — run a class of five: five students
 * on five labs at once, capacity 5 / 5, and a sixth student refused and shown
 * to the instructor by name. The instructor finds one student's lab by the
 * Support ID the student sees; the administrator ends it after a confirmation
 * naming the student, the lab and the ID; the instructor, in another browser,
 * sees it ended and cleaned up. Then the class ends and the view returns to
 * where it started. A student, and a request with no sign-in, are refused by
 * the server whatever the page shows.
 *
 * Waits are on what the page says, never on time: the Refresh button asks for
 * a new answer, and assertions wait for it to arrive.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { apiGet, endAllSessions, mySessions, signIn, uniqueStudent } from './support/student.js';
import { requiredEnv } from './support/env.js';
import { setRole } from './support/operator.js';

/** A page's first answer. Generous: a loaded CI host can take seconds to authenticate one request. */
const LOAD = { timeout: 60_000 };

interface Person {
  name: string;
  context: BrowserContext;
  page: Page;
}

/** Five Linux labs the E2E stack can run (it enables the Linux provider only). */
const CLASS = [
  { label: 'amy', lab: 'LINUX-001' },
  { label: 'ben', lab: 'LINUX-002' },
  { label: 'cai', lab: 'LINUX-003' },
  { label: 'dee', lab: 'LINUX-004' },
  { label: 'eve', lab: 'LINUX-006' },
] as const;

async function person(browser: Browser, label: string): Promise<Person> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const name = uniqueStudent(label);
  await signIn(page, name);
  return { name, context, page };
}

async function activeCount(staff: Person): Promise<number> {
  const response = await apiGet(staff.context, '/api/admin/classroom');
  expect(response.status()).toBe(200);
  return ((await response.json()) as { data: { capacity: { active: number } } }).data.capacity.active;
}

async function launch(student: Person, lab: string): Promise<string> {
  await student.page.goto(`/#/labs/${lab}`);
  await student.page.getByRole('button', { name: 'Launch lab' }).click();
  await expect(student.page.locator('.workspace__status')).toContainText('Ready', { timeout: 300_000 });
  const supportId = (await student.page.getByTestId('workspace-support-id').textContent())?.trim() ?? '';
  expect(supportId).toMatch(/^sess-/);
  return supportId;
}

const row = (page: Page, table: string, student: Person) =>
  page.getByRole('table', { name: table }).getByRole('row').filter({ hasText: `E2E ${student.name}` });

test('an instructor and an administrator run a class of five from the classroom view', async ({ browser, playwright }) => {
  test.setTimeout(900_000);
  const everyone: Person[] = [];
  try {
    const teacher = await person(browser, 'teacher');
    const head = await person(browser, 'head');
    everyone.push(teacher, head);
    const students: Person[] = [];
    for (const { label } of CLASS) {
      const student = await person(browser, label);
      students.push(student);
      everyone.push(student);
    }
    const [amy, ben] = students as [Person, Person, ...Person[]];

    await test.step('before a role is given, the classroom is refused — by the server, not just the page', async () => {
      await teacher.page.goto('/#/classroom');
      await expect(teacher.page.getByRole('heading', { level: 1, name: 'Not available for your account' })).toBeVisible(LOAD);
      await expect(teacher.page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Classroom' })).toHaveCount(0);
      expect((await apiGet(teacher.context, '/api/admin/classroom')).status()).toBe(403);
    });

    await test.step('an operator gives the roles with `ops role set`', async () => {
      setRole(teacher.name, 'INSTRUCTOR');
      setRole(head.name, 'ADMIN');
      // A class of five needs every slot: nothing from an earlier spec may still hold one.
      expect(await activeCount(teacher), 'labs left running by an earlier spec').toBe(0);
    });

    const supportIds = new Map<string, string>();
    await test.step('five students start five labs at once; the instructor sees each, and 5 / 5', async () => {
      const ids = await Promise.all(students.map((student, i) => launch(student, CLASS[i]!.lab)));
      students.forEach((student, i) => supportIds.set(student.name, ids[i]!));
      expect(new Set(ids).size).toBe(5);

      await teacher.page.reload();
      await teacher.page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Classroom' }).click();
      await expect(teacher.page.getByRole('heading', { level: 1, name: 'Classroom' })).toBeVisible(LOAD);
      await expect(teacher.page.getByTestId('capacity')).toHaveText('5 / 5');
      await expect(teacher.page.getByText(/Classroom capacity reached/)).toBeVisible();
      for (const [i, student] of students.entries()) {
        const line = row(teacher.page, 'Labs in progress', student);
        await expect(line).toHaveCount(1);
        await expect(line).toContainText(CLASS[i]!.lab);
        await expect(line).toContainText('Running');
        await expect(line).toContainText(supportIds.get(student.name)!);
      }
    });

    await test.step('a sixth student is refused, and the instructor sees who and why', async () => {
      const fin = await person(browser, 'fin');
      everyone.push(fin);
      await fin.page.goto('/#/labs/LINUX-001');
      await fin.page.getByRole('button', { name: 'Launch lab' }).click();
      await expect(fin.page.getByText('All lab environments are in use').first()).toBeVisible({ timeout: 60_000 });
      expect(await mySessions(fin.context)).toEqual([]);

      await teacher.page.getByRole('button', { name: 'Refresh' }).click();
      const problems = teacher.page.getByRole('region', { name: /Problems in the last hour/ });
      const refusal = problems.getByRole('listitem').filter({ hasText: `E2E ${fin.name}` });
      await expect(refusal).toContainText('Start refused — classroom capacity was full');
      await expect(refusal).toContainText('LAB_CAPACITY_REACHED');
      await expect(teacher.page.getByTestId('new-labs')).toHaveText('Students cannot start new labs right now.');
    });

    const amyId = supportIds.get(amy.name)!;
    await test.step('the instructor finds Amy’s lab by the Support ID she reads out, and cannot end it', async () => {
      await teacher.page.getByRole('textbox', { name: /Support ID/ }).fill(amyId);
      await teacher.page.getByRole('button', { name: 'Find' }).click();
      await expect(teacher.page.getByTestId('support-id')).toHaveText(amyId, LOAD);
      await expect(teacher.page.getByRole('link', { name: `E2E ${amy.name}` })).toBeVisible();
      await expect(teacher.page.getByTestId('environment')).toContainText('Reachable');
      await expect(teacher.page.getByRole('button', { name: /End this student/ })).toHaveCount(0);
      // Not just hidden: the server refuses the instructor.
      const refused = await teacher.context.request.post(`${requiredEnv('E2E_BASE_URL')}/api/admin/sessions/${amyId}/end`, {
        headers: { origin: requiredEnv('E2E_BASE_URL') },
        data: { confirmSessionId: amyId },
      });
      expect(refused.status()).toBe(403);
    });

    await test.step('a student and an anonymous request are refused', async () => {
      await ben.page.goto('/#/classroom');
      await expect(ben.page.getByRole('heading', { level: 1, name: 'Not available for your account' })).toBeVisible(LOAD);
      expect((await apiGet(ben.context, '/api/admin/classroom')).status()).toBe(403);
      expect((await apiGet(ben.context, `/api/admin/sessions/${amyId}`)).status()).toBe(403);
      const anonymous = await playwright.request.newContext();
      try {
        expect((await anonymous.get(`${requiredEnv('E2E_BASE_URL')}/api/admin/classroom`)).status()).toBe(401);
      } finally {
        await anonymous.dispose();
      }
    });

    await test.step('the administrator ends Amy’s lab after a confirmation naming her, the lab and the Support ID', async () => {
      await head.page.goto(`/#/classroom/sessions/${amyId}`);
      await head.page.getByRole('button', { name: /End this student’s lab/ }).click(LOAD);
      const dialog = head.page.getByRole('alertdialog', { name: 'End this student’s lab?' });
      await expect(dialog).toContainText(`E2E ${amy.name}`);
      await expect(dialog).toContainText('LINUX-001 — Files and Directories');
      await expect(dialog).toContainText(amyId);
      await dialog.getByRole('button', { name: 'End lab' }).click();
      await expect(head.page.getByText(/confirmed removed. The slot is free/)).toBeVisible({ timeout: 120_000 });
      await expect(head.page.getByText('Ended by staff').first()).toBeVisible();
      await expect(head.page.getByText(/Cleanup confirmed/).first()).toBeVisible();
      expect(await mySessions(amy.context)).toEqual([]);
    });

    await test.step('the instructor, in another browser, sees it after a refresh: 4 / 5, cleanup confirmed', async () => {
      await teacher.page.goto('/#/classroom');
      await teacher.page.getByRole('button', { name: 'Refresh' }).click();
      await expect(teacher.page.getByTestId('capacity')).toHaveText('4 / 5', LOAD);
      await expect(row(teacher.page, 'Recently finished labs', amy)).toContainText('Ended by staff');
      await expect(row(teacher.page, 'Recently finished labs', amy)).toContainText('Confirmed');
      await expect(row(teacher.page, 'Labs in progress', amy)).toHaveCount(0);
    });

    await test.step('the class ends: 0 / 5, and every lab shows cleanup confirmed', async () => {
      await Promise.all(students.slice(1).map(({ context }) => endAllSessions(context)));
      for (const { context } of students) {
        await expect.poll(() => mySessions(context), { timeout: 120_000, intervals: [1_000] }).toEqual([]);
      }
      await teacher.page.getByRole('button', { name: 'Refresh' }).click();
      await expect(teacher.page.getByTestId('capacity')).toHaveText('0 / 5');
      await expect(teacher.page.getByText('No student has a lab running.')).toBeVisible();
      for (const student of students.slice(1)) {
        await expect(row(teacher.page, 'Recently finished labs', student)).toContainText('Ended by student');
        await expect(row(teacher.page, 'Recently finished labs', student)).toContainText('Confirmed');
      }
    });
  } finally {
    for (const { context } of everyone) await endAllSessions(context);
    for (const { context } of everyone) await context.close();
  }
});
