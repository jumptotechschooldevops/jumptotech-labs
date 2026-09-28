/**
 * Lab instructions as a student reads them, in the real bundle.
 *
 * The text below has the shapes the catalog uses (CS-012's answer format,
 * DOCKER-010's required state, CS-005's interface table, TF-026's bold steps).
 * Before RichText rendered them, the answer format read as one line — which a
 * student then copied, and the line-by-line check failed.
 */
import { ALICE, expect, launch, openSignedIn, test } from './support/fixture.js';

const DESCRIPTION = [
  'Your home directory is where everything happens.',
  '**The write-up.** Record in `/home/student/ops/syscalls.txt`:',
  '',
  '```',
  'BLOCKED_SYSCALL=<the name>',
  'PRINTER_IS=<buffered or unbuffered>',
  'SYSCALLS_SAVED_BY_BUFFERING=<a number>',
  '```',
  '',
  'When you are done:',
  '',
  '  - `ledger-api` must run the `nginx:1.27-alpine` image, with its container',
  '    port `80` published on host port `8080`.',
  '  - `ledger-web` must be *running*.',
  '',
  '| situation | exit status |',
  '| --- | --- |',
  '| within the limit | `0` |',
  '| over the limit | `3` |',
].join('\n');

test('a lab page shows its steps, answer format, list and table as written', async ({ page, platform }) => {
  platform.details.set('LINUX-001', {
    task: { summary: 'Write a probe and record what it found.', description: DESCRIPTION },
    hints: [{ level: 1, text: 'Read `/proc/<pid>/syscall` while the child is blocked.' }],
  });
  await openSignedIn(page, platform, ALICE, '#/labs/LINUX-001');

  const task = page.getByRole('region', { name: 'Your task' });
  await expect(task.locator('pre code')).toHaveText(
    'BLOCKED_SYSCALL=<the name>\nPRINTER_IS=<buffered or unbuffered>\nSYSCALLS_SAVED_BY_BUFFERING=<a number>',
  );
  // Folded YAML: each line is its own paragraph, not one run-on block.
  await expect(task.locator('p.brief__body').first()).toHaveText('Your home directory is where everything happens.');
  await expect(task.locator('strong')).toHaveText('The write-up.');
  await expect(task.getByRole('listitem')).toHaveText([
    'ledger-api must run the nginx:1.27-alpine image, with its container port 80 published on host port 8080.',
    'ledger-web must be running.',
  ]);
  await expect(task.getByRole('columnheader')).toHaveText(['situation', 'exit status']);
  // No Markdown left showing.
  await expect(task).not.toContainText('```');
  await expect(task).not.toContainText('**');
  await expect(task).not.toContainText('| ---');

  // A revealed hint shows its path as code, not with backticks.
  await launch(page);
  await page.getByRole('button', { name: 'Show a hint' }).click();
  const hints = page.getByRole('region', { name: 'Hints' });
  await expect(hints.locator('code')).toHaveText('/proc/<pid>/syscall');
  await expect(hints).not.toContainText('`');
});
