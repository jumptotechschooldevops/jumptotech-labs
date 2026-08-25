/**
 * The systemd unit parser and the two checks built on it.
 *
 * The reason this exists rather than a `file_content` substring match: a unit
 * file is structured configuration, and every one of the cases below is a file
 * that substring matching grades wrongly — usually in the direction that passes
 * something systemd would refuse.
 *
 * Syntax behaviour asserted here is what `systemd.syntax(7)` documents, read
 * from the Debian-published manual on 2026-08-25. List-versus-scalar behaviour
 * is what `systemd.unit(5)` documents for each specific directive.
 */
import { describe, expect, it } from 'vitest';
import { verifyRequirement } from '../src/index.js';
import { SandboxReader } from '../src/sandbox-reader.js';
import {
  LIST_DIRECTIVES,
  parseSystemdUnit,
  SystemdUnitParseError,
} from '../src/systemd-unit.js';
import { FakeSandbox } from './sandbox-fake.js';

const UNIT = '/etc/systemd/system/ledger-api.service';

const WELL_FORMED = `
# The bank's ledger API.
; both comment markers are ignored

[Unit]
Description=JumpToTech ledger API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/ledger-api --port 9105
User=ledger
Group=ledger
WorkingDirectory=/srv/jumptotech
Restart=on-failure
RestartSec=5
Environment=JTT_ENV=production
EnvironmentFile=-/etc/jumptotech/ledger-api.env

[Install]
WantedBy=multi-user.target
`;

function sandboxWith(content: string): SandboxReader {
  return new SandboxReader(new FakeSandbox({ files: { [UNIT]: { type: 'file', content } } }));
}

function checkDirective(
  content: string,
  extra: Record<string, unknown>,
): Promise<{ status: string; detail?: string }> {
  return verifyRequirement(
    { type: 'systemd_unit_directive', path: UNIT, ...extra } as never,
    { sandbox: sandboxWith(content) },
  );
}

function checkSection(content: string, section: string) {
  return verifyRequirement(
    { type: 'systemd_unit_section', path: UNIT, section } as never,
    { sandbox: sandboxWith(content) },
  );
}

// ------------------------------------------------------------- the parser

describe('parsing follows the syntax systemd documents', () => {
  it('reads a well-formed unit', () => {
    const unit = parseSystemdUnit(WELL_FORMED);

    expect(unit.sectionNames()).toEqual(['Unit', 'Service', 'Install']);
    expect(unit.scalar('Service', 'ExecStart')).toBe('/usr/local/bin/ledger-api --port 9105');
    expect(unit.scalar('Service', 'Restart')).toBe('on-failure');
    expect(unit.tokens('Install', 'WantedBy')).toEqual(['multi-user.target']);
  });

  it('ignores both comment markers, and only at the start of a line', () => {
    const unit = parseSystemdUnit(
      ['[Service]', '# ExecStart=/bin/false', '; ExecStart=/bin/true', 'ExecStart=/bin/real #1'].join('\n'),
    );

    // A `#` inside a value is part of the value, not a comment.
    expect(unit.scalar('Service', 'ExecStart')).toBe('/bin/real #1');
  });

  it('ignores whitespace around the equals sign and around the value', () => {
    const spaced = parseSystemdUnit(['[Service]', '   ExecStart   =   /bin/app   '].join('\n'));
    const tight = parseSystemdUnit(['[Service]', 'ExecStart=/bin/app'].join('\n'));

    expect(spaced.scalar('Service', 'ExecStart')).toBe('/bin/app');
    expect(spaced.scalar('Service', 'ExecStart')).toBe(tight.scalar('Service', 'ExecStart'));
  });

  it('joins a line ending in a backslash with the next, as a space', () => {
    const unit = parseSystemdUnit(
      ['[Service]', 'ExecStart=/bin/app \\', '  --port 9105 \\', '  --verbose'].join('\n'),
    );

    // The backslash becomes a space and the next line's indentation is kept,
    // so the joined value carries runs of spaces. That is systemd's behaviour;
    // the requirement handler compares scalars with runs collapsed so a student
    // is not failed over whitespace they cannot see.
    expect(unit.scalar('Service', 'ExecStart')).toBe('/bin/app    --port 9105    --verbose');
  });

  it('treats an empty assignment as a reset of everything before it', () => {
    const unit = parseSystemdUnit(
      ['[Unit]', 'After=a.target', 'After=b.target', 'After=', 'After=c.target'].join('\n'),
    );

    expect(unit.tokens('Unit', 'After')).toEqual(['c.target']);
  });

  it('accumulates a repeated list directive, and flattens a space-separated one', () => {
    const repeated = parseSystemdUnit(['[Unit]', 'After=a.target', 'After=b.target'].join('\n'));
    const inline = parseSystemdUnit(['[Unit]', 'After=a.target b.target'].join('\n'));

    // systemd.unit(5): "They may be specified more than once, in which case
    // dependencies for all listed names are created."
    expect(repeated.tokens('Unit', 'After')).toEqual(['a.target', 'b.target']);
    expect(repeated.tokens('Unit', 'After')).toEqual(inline.tokens('Unit', 'After'));
  });

  it('lets the last assignment win for an ordinary setting', () => {
    const unit = parseSystemdUnit(['[Service]', 'Restart=always', 'Restart=on-failure'].join('\n'));
    expect(unit.scalar('Service', 'Restart')).toBe('on-failure');
  });

  it('does not flatten a scalar directive into the list model by accident', () => {
    // The distinction the requirement handler depends on.
    expect(LIST_DIRECTIVES.has('After')).toBe(true);
    expect(LIST_DIRECTIVES.has('WantedBy')).toBe(true);
    expect(LIST_DIRECTIVES.has('Environment')).toBe(true);
    expect(LIST_DIRECTIVES.has('Restart')).toBe(false);
    expect(LIST_DIRECTIVES.has('ExecStart')).toBe(false);
    expect(LIST_DIRECTIVES.has('Type')).toBe(false);
  });

  it('merges two blocks that name the same section', () => {
    const unit = parseSystemdUnit(
      ['[Service]', 'Type=simple', '[Unit]', 'Description=x', '[Service]', 'User=ledger'].join('\n'),
    );

    expect(unit.scalar('Service', 'Type')).toBe('simple');
    expect(unit.scalar('Service', 'User')).toBe('ledger');
  });

  it('rejects a directive that appears before any section', () => {
    expect(() => parseSystemdUnit('ExecStart=/bin/app\n[Service]\n')).toThrow(SystemdUnitParseError);
  });

  it('rejects an unterminated section header', () => {
    expect(() => parseSystemdUnit('[Service\nExecStart=/bin/app\n')).toThrow(SystemdUnitParseError);
  });

  it('rejects a line that is neither comment, section nor assignment', () => {
    expect(() => parseSystemdUnit('[Service]\nthis is not a directive\n')).toThrow(
      SystemdUnitParseError,
    );
  });

  it('reports the line number of the problem', () => {
    try {
      parseSystemdUnit('[Service]\nExecStart=/bin/app\nnonsense\n');
      throw new Error('expected a parse error');
    } catch (error) {
      expect(error).toBeInstanceOf(SystemdUnitParseError);
      expect((error as SystemdUnitParseError).line).toBe(3);
    }
  });
});

// ------------------------------------------------------------ the checks

describe('the systemd requirement types', () => {
  it('passes a section that is present and fails one that is not', async () => {
    expect((await checkSection(WELL_FORMED, 'Install')).status).toBe('pass');
    const withoutInstall = WELL_FORMED.replace(/\[Install\][\s\S]*$/, '');
    expect((await checkSection(withoutInstall, 'Install')).status).toBe('fail');
  });

  it('matches a scalar directive by exact effective value', async () => {
    expect(
      (await checkDirective(WELL_FORMED, { section: 'Service', directive: 'Restart', equals: 'on-failure' })).status,
    ).toBe('pass');
    expect(
      (await checkDirective(WELL_FORMED, { section: 'Service', directive: 'Restart', equals: 'always' })).status,
    ).toBe('fail');
  });

  it('is indifferent to formatting, comments and directive ordering', async () => {
    const reordered = [
      '[Install]',
      'WantedBy=multi-user.target',
      '',
      '[Service]',
      '# a comment that mentions ExecStart=/bin/decoy',
      'RestartSec   =    5',
      'ExecStart=/usr/local/bin/ledger-api --port 9105',
      'Restart=on-failure',
      'Type=simple',
      'User=ledger',
      '',
      '[Unit]',
      'Description=JumpToTech ledger API',
    ].join('\n');

    for (const extra of [
      { section: 'Service', directive: 'ExecStart', equals: '/usr/local/bin/ledger-api --port 9105' },
      { section: 'Service', directive: 'Restart', equals: 'on-failure' },
      { section: 'Service', directive: 'RestartSec', equals: '5' },
      { section: 'Install', directive: 'WantedBy', contains: 'multi-user.target' },
    ]) {
      expect((await checkDirective(reordered, extra)).status, JSON.stringify(extra)).toBe('pass');
    }
  });

  it('matches a list directive by membership, however it was written', async () => {
    const split = ['[Unit]', 'After=network-online.target', 'After=postgresql.service'].join('\n');
    const inline = ['[Unit]', 'After=network-online.target postgresql.service'].join('\n');

    for (const content of [split, inline]) {
      expect(
        (await checkDirective(content, { section: 'Unit', directive: 'After', contains: 'postgresql.service' })).status,
      ).toBe('pass');
      expect(
        (await checkDirective(content, { section: 'Unit', directive: 'After', contains: 'redis.service' })).status,
      ).toBe('fail');
    }
  });

  it('reads an Environment assignment as a member, quotes stripped', async () => {
    const quoted = ['[Service]', 'Environment="JTT_ENV=production" JTT_TIER=edge'].join('\n');

    expect(
      (await checkDirective(quoted, { section: 'Service', directive: 'Environment', contains: 'JTT_ENV=production' })).status,
    ).toBe('pass');
    expect(
      (await checkDirective(quoted, { section: 'Service', directive: 'Environment', contains: 'JTT_TIER=edge' })).status,
    ).toBe('pass');
  });

  it('honours a reset when deciding whether a directive is set', async () => {
    const reset = ['[Unit]', 'After=a.target', 'After='].join('\n');

    expect((await checkDirective(reset, { section: 'Unit', directive: 'After', absent: true })).status).toBe('pass');
    expect((await checkDirective(reset, { section: 'Unit', directive: 'After', contains: 'a.target' })).status).toBe('fail');
  });

  it('fails a commented-out directive rather than matching its text', async () => {
    const commented = ['[Service]', '#ExecStart=/usr/local/bin/ledger-api', 'Type=simple'].join('\n');

    // The exact case substring matching gets wrong.
    expect(
      (await checkDirective(commented, { section: 'Service', directive: 'ExecStart', equals: '/usr/local/bin/ledger-api' })).status,
    ).toBe('fail');
    expect((await checkDirective(commented, { section: 'Service', directive: 'ExecStart', absent: true })).status).toBe('pass');
  });

  it('reports an unparseable unit as such, not as a pile of missing directives', async () => {
    const broken = ['[Service', 'ExecStart=/bin/app'].join('\n');
    const result = await checkDirective(broken, {
      section: 'Service',
      directive: 'ExecStart',
      equals: '/bin/app',
    });

    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/not a valid unit file/);
  });

  it('accepts a command line written across continued lines', async () => {
    const continued = [
      '[Service]',
      'ExecStart=/usr/local/bin/ledger-api \\',
      '  --port 9105 \\',
      '  --verbose',
    ].join('\n');

    expect(
      (await checkDirective(continued, {
        section: 'Service',
        directive: 'ExecStart',
        equals: '/usr/local/bin/ledger-api --port 9105 --verbose',
      })).status,
    ).toBe('pass');
  });

  it('reports a missing file distinctly from a wrong value', async () => {
    const empty = new SandboxReader(new FakeSandbox({}));
    const result = await verifyRequirement(
      { type: 'systemd_unit_directive', path: UNIT, section: 'Service', directive: 'ExecStart', equals: '/bin/app' } as never,
      { sandbox: empty },
    );

    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/No .*found/i);
  });
});

// ------------------------------------------------- expected-value disclosure

describe('a failing check never discloses what was expected', () => {
  it('says the directive is wrong without saying what it should be', async () => {
    const secret = '/usr/local/bin/ledger-api --port 9105 --token s3cr3t';
    const wrong = ['[Service]', 'ExecStart=/bin/wrong'].join('\n');

    const result = await checkDirective(wrong, {
      section: 'Service',
      directive: 'ExecStart',
      equals: secret,
    });

    expect(result.status).toBe('fail');
    expect(result.detail ?? '').not.toContain(secret);
    expect(result.detail ?? '').not.toContain('s3cr3t');
    expect(result.detail ?? '').not.toContain('9105');
    // It may name where the problem is — that is the point of a check result.
    expect(result.detail ?? '').toContain('ExecStart');
  });

  it('does not echo the expected member of a list directive', async () => {
    const result = await checkDirective(WELL_FORMED, {
      section: 'Unit',
      directive: 'After',
      contains: 'postgresql.service',
    });

    expect(result.status).toBe('fail');
    expect(result.detail ?? '').not.toContain('postgresql.service');
  });

  it('does not echo the observed value either, so a checklist is not an oracle', async () => {
    // Reading back what the student wrote would be harmless on its own, but a
    // student could then bisect toward the answer by editing and re-checking.
    const result = await checkDirective(
      ['[Service]', 'Restart=always'].join('\n'),
      { section: 'Service', directive: 'Restart', equals: 'on-failure' },
    );

    expect(result.detail ?? '').not.toContain('always');
    expect(result.detail ?? '').not.toContain('on-failure');
  });
});
