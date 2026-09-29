/**
 * Every terminal log line names what happened — reliability audit 2026-09-28.
 *
 * The free-text `log()` helper wrote every message as an info line under
 * `terminal.connection.opened`, including "failed to start shell", "reattach
 * failed" and "shell lost". RB-12 and the incident runbook find terminal
 * trouble by event (`terminal.connection.rejected`); those failures were
 * invisible to that search and looked like successful connections. Each call
 * now names its event and level; this keeps it that way.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/server.ts'),
  'utf8',
);

/** Every `log(\`…\`, 'event', 'level')` call: message template, event, level. */
function calls(): Array<{ message: string; event: string; level: string }> {
  const found: Array<{ message: string; event: string; level: string }> = [];
  const pattern = /\blog\(\s*(`[\s\S]*?`(?:\s*\+\s*\([\s\S]*?\))?)\s*,\s*'([a-z_.]+)'(?:\s*,\s*'(info|warn)')?\s*,?\s*\)/g;
  for (const match of source.matchAll(pattern)) {
    found.push({ message: match[1]!, event: match[2]!, level: match[3] ?? 'info' });
  }
  return found;
}

describe('terminal log lines', () => {
  it('every log() call names an event', () => {
    const bare = source.match(/\blog\(\s*`[^`]*`\s*\);/g) ?? [];
    expect(bare).toEqual([]);
    expect(calls().length).toBeGreaterThanOrEqual(13);
  });

  it('no failure, loss or abandonment is logged as a connection opening', () => {
    for (const call of calls()) {
      if (/fail|lost|abandon/i.test(call.message)) {
        expect(call.event, call.message).not.toBe('terminal.connection.opened');
      }
    }
  });

  it('failures are warnings, and a shell that could not start is a rejected connection', () => {
    for (const call of calls().filter((c) => /failed|lost/i.test(c.message))) {
      expect(call.level, call.message).toBe('warn');
    }
    const shell = calls().find((c) => c.message.includes('failed to start shell'));
    expect(shell).toMatchObject({ event: 'terminal.connection.rejected', level: 'warn' });
  });
});
