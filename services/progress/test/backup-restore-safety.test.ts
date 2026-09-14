/**
 * BETA-P0-013 — the backup and restore workflow cannot quietly lose its safety.
 *
 * `scripts/test-db-backup-restore.sh` drives the scripts' failure paths with a
 * fake daemon, and `scripts/db-restore-drill.sh` restores a real backup into a
 * real server. Both need a shell. This suite needs nothing: it reads the
 * scripts, compose files, ignore rules, CI workflow and runbook as text, on
 * every `npm test`, and fails the moment one of them stops saying what the
 * workflow's guarantees depend on.
 *
 * Comment lines are ignored wherever code is checked: the scripts explain at
 * length what they refuse to do, and prose about a `DROP` is not a `DROP`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const read = (file: string): string => readFileSync(path.join(REPO_ROOT, file), 'utf8');

/** Non-comment, non-blank lines of a shell script. */
const code = (file: string): string[] =>
  read(file)
    .split('\n')
    .filter((line) => line.trim() !== '' && !/^\s*#/.test(line));

const BACKUP = 'scripts/db-backup.sh';
const RESTORE = 'scripts/db-restore.sh';
const LIB = 'scripts/db-lib.sh';
const DRILL = 'scripts/db-restore-drill.sh';
const STUB_TESTS = 'scripts/test-db-backup-restore.sh';
const RUNBOOK = 'docs/runbooks/postgres-backup-restore.md';
const EXECUTABLES = [BACKUP, RESTORE, DRILL, STUB_TESTS];
/** The scripts that touch an operator's real database. */
const OPERATOR_SCRIPTS = [LIB, BACKUP, RESTORE];

describe('backup and restore scripts fail safely', () => {
  for (const file of EXECUTABLES) {
    it(`${file} starts strict, with tracing off and a private umask`, () => {
      expect(read(file).split('\n')[0], 'shebang').toBe('#!/usr/bin/env bash');
      expect(code(file).slice(0, 3)).toEqual(['set -Eeuo pipefail', 'set +x', 'umask 077']);
      expect(statSync(path.join(REPO_ROOT, file)).mode & 0o111, `${file} is executable`).not.toBe(0);
    });
  }

  for (const file of [...EXECUTABLES, LIB]) {
    it(`${file} never turns shell tracing on`, () => {
      const traced = code(file).filter((line) => /\bset\s+(-[a-zA-Z]*x|-o\s+xtrace)\b|\bbash\s+-[a-zA-Z]*x\b/.test(line));
      expect(traced).toEqual([]);
    });
  }

  it('the library is sourced by both operator scripts and executed by neither', () => {
    for (const file of [BACKUP, RESTORE]) {
      expect(code(file)).toContain('. "$(dirname "${BASH_SOURCE[0]}")/db-lib.sh"');
    }
    expect(read(LIB).startsWith('#!')).toBe(false);
  });
});

describe('no credential in the backup workflow', () => {
  for (const file of OPERATOR_SCRIPTS) {
    it(`${file} reads, passes and writes no password, and opens no network connection`, () => {
      const lines = code(file).join('\n');
      for (const [name, pattern] of [
        ['POSTGRES_PASSWORD', /POSTGRES_PASSWORD/],
        ['PGPASSWORD / PGPASSFILE', /PGPASS(WORD|FILE)/],
        ['a connection string', /postgres(ql)?:\/\//i],
        ['a password option', /--password\b|\bpassword\s*=/i],
        ['DATABASE_URL', /DATABASE_URL/],
        ['PGHOST / PGPORT', /PGHOST|PGPORT/],
        ['an sslmode', /sslmode/i],
      ] as const) {
        expect(pattern.test(lines), `${file} contains ${name}`).toBe(false);
      }
      // Every client command runs inside the database container over its Unix
      // socket. A host or port flag would mean a network hop, and a TLS decision.
      const clientCalls = code(file).filter((line) => /\b(pg_dump|pg_restore|psql)\b/.test(line));
      expect(clientCalls.length, `${file} runs a PostgreSQL client`).toBeGreaterThan(0);
      expect(clientCalls.filter((line) => /\s(-h|--host|-p|--port)(\s|=|$)/.test(line))).toEqual([]);
    });
  }

  it('reads only POSTGRES_USER and POSTGRES_DB from the container', () => {
    const lib = read(LIB);
    expect(lib).toMatch(/POSTGRES_USER \| POSTGRES_DB\) ;;\n\s+\*\) jtt_die "refusing to read \$1 from the container" ;;/);
    const printenv = code(LIB).filter((line) => line.includes('printenv'));
    expect(printenv).toEqual(['  jtt_pg printenv "$1" 2>/dev/null || true']);
  });

  it('the drill generates its disposable password and hands it to Docker in a file', () => {
    const drill = code(DRILL).join('\n');
    expect(drill).toContain("password=$(od -An -tx1 -N24 /dev/urandom | tr -d ' \\n')");
    expect(drill).toContain('--env-file "$work/postgres.env"');
    expect(drill).not.toMatch(/-e\s+POSTGRES_PASSWORD|POSTGRES_PASSWORD=[A-Za-z0-9]/);
    // The drill proves the password is absent from the archive's name, the
    // backup log and the archive content.
    expect(drill).toContain('the password is inside the archive');
  });
});

describe('a backup is real before it looks real', () => {
  const backup = code(BACKUP).join('\n');

  it('dumps in PostgreSQL custom format', () => {
    expect(backup).toContain('pg_dump --format=custom');
  });

  it('reads the archive back and compares checksums across the copy, then renames into place', () => {
    const order = [
      'jtt_pg pg_dump --format=custom',
      'toc=$(jtt_archive_toc',
      'container_sum=$(jtt_sha256_in_container',
      'partial="$backup_dir/.$name.partial"',
      'if [ "$host_sum" != "$container_sum" ]; then',
      'mv -f "$partial" "$final"',
    ].map((needle) => backup.indexOf(needle));
    expect(order.every((index) => index >= 0), 'every step is present').toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(read(LIB)).toContain("grep -q ' TABLE DATA public schema_migrations '");
  });

  it('refuses a destination inside the database storage', () => {
    expect(backup).toContain('/var/lib/docker/* | */var/lib/postgresql/*)');
    expect(backup).toContain("docker inspect --format '{{range .Mounts}}{{println .Source}}{{end}}'");
  });

  it('retention deletes only this database\'s archives, never a symlink, and keeps a minimum', () => {
    expect(backup).toContain('BACKUP_RETENTION_MIN_KEEP:-7');
    expect(backup).toContain('BACKUP_RETENTION_DAYS:-14');
    expect(backup).toContain('if [ -f "$entry" ] && [ ! -L "$entry" ]; then basename "$entry"; fi');
    const deletions = code(BACKUP).filter((line) => /\brm\b/.test(line));
    expect(deletions.map((line) => line.trim()).sort()).toEqual(
      [
        'if [ -n "$lock_dir" ]; then rm -rf "$lock_dir"; fi',
        'if [ -n "$partial" ]; then rm -f "$partial"; fi',
        'if [ -n "$sidecar" ]; then rm -f "$sidecar"; fi',
        'rm -f "$backup_dir/$entry" "$backup_dir/$entry.sha256"',
        'rm -rf "$dir"',
      ].sort(),
    );
  });
});

describe('a restore cannot destroy the database it replaces', () => {
  const restore = code(RESTORE).join('\n');

  it('drops, truncates and deletes nothing', () => {
    for (const file of [RESTORE, LIB]) {
      const lines = code(file).join('\n');
      expect(lines, file).not.toMatch(/\bDROP\b|\bdropdb\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|--clean\b|--create\b/i);
    }
  });

  it('has no default mode, and --replace needs a typed or explicit confirmation', () => {
    expect(restore).toContain('[ -n "$mode" ] || jtt_die "no mode given');
    expect(restore).toContain('[ "$confirm" = "$target" ] || jtt_die');
    expect(restore).toContain('elif [ -t 0 ]; then');
    expect(restore).toContain('jtt_die "--replace needs confirmation');
  });

  it('checks the archive before it contacts the server, and refuses while sessions are connected', () => {
    const checksum = restore.indexOf('does not match its .sha256 sidecar');
    const firstServerCall = restore.indexOf('jtt_resolve_container');
    expect(checksum).toBeGreaterThan(0);
    expect(firstServerCall).toBeGreaterThan(checksum);
    expect(restore.indexOf('toc=$(jtt_archive_toc')).toBeLessThan(restore.indexOf('CREATE DATABASE'));
    expect(restore).toContain('FROM pg_stat_activity WHERE datname');
  });

  it('restores into staging in one transaction, then swaps names atomically and keeps the old database', () => {
    expect(restore).toContain('pg_restore --exit-on-error --single-transaction --no-owner --no-privileges');
    expect(restore).toMatch(
      /-c 'BEGIN' \\\n\s+-c "ALTER DATABASE \$target RENAME TO \$retained" \\\n\s+-c "ALTER DATABASE \$staging RENAME TO \$target" \\\n\s+-c 'COMMIT'/,
    );
    expect(restore).toContain('retained="${target}_prerestore_$stamp"');
  });
});

describe('backups stay out of git and out of the database container', () => {
  it('ignores the default backup directory and every archive name', () => {
    const ignore = read('.gitignore').split('\n');
    for (const rule of ['/backups/', '*.dump', '*.dump.sha256', '*.dump.partial']) {
      expect(ignore, rule).toContain(rule);
    }
    expect(read(BACKUP)).toContain('backup_dir=${BACKUP_DIR:-$JTT_REPO_ROOT/backups/postgres}');
  });

  it('commits no archive', () => {
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(path.join(REPO_ROOT, dir))) {
        if (['node_modules', '.git', 'backups', 'dist', 'coverage'].includes(name)) continue;
        const rel = path.join(dir, name);
        if (statSync(path.join(REPO_ROOT, rel)).isDirectory()) walk(rel);
        else if (/\.(dump|backup|bak)$/.test(name)) found.push(rel);
      }
    };
    for (const dir of ['scripts', 'services', 'apps', 'infrastructure', 'docs', 'test-support']) walk(dir);
    expect(found).toEqual([]);
  });

  it('adds no backup service, mount or published port to any compose file', () => {
    const composeFiles = readdirSync(REPO_ROOT).filter((name) => /^docker-compose.*\.ya?ml$/.test(name));
    expect(composeFiles.length).toBeGreaterThanOrEqual(4);
    for (const file of composeFiles) {
      const text = code(file).join('\n');
      expect(text, file).not.toMatch(/backup|pg_dump|pg_restore/i);
    }
    // PostgreSQL's only volume is its data directory: the backup destination is
    // never mounted into the container whose storage it must outlive.
    const base = read('docker-compose.yml');
    const postgres = /^ {2}postgres:\n((?: {4}.*\n|\s*\n)*)/m.exec(base)?.[1] ?? '';
    const volumes = /^ {4}volumes:\n((?: {6}.*\n)*)/m.exec(postgres)?.[1] ?? '';
    expect(volumes.split('\n').filter((line) => /^\s+- /.test(line))).toEqual([
      '      - postgres-data:/var/lib/postgresql/data',
    ]);
  });
});

describe('globals are not needed to recover this schema', () => {
  it('the migrations create no role, grant, ownership change or extension', () => {
    const dir = path.join(REPO_ROOT, 'services/progress/migrations');
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.sql'))) {
      const sql = readFileSync(path.join(dir, file), 'utf8')
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n');
      expect(sql, file).not.toMatch(/\bCREATE\s+(ROLE|USER|EXTENSION)\b|\bGRANT\b|\bREVOKE\b|\bOWNER\s+TO\b/i);
    }
  });
});

describe('the workflow is exercised and documented', () => {
  it('CI runs the stub suite and the archive check in gates, and the drill with PostgreSQL', () => {
    const workflow = read('.github/workflows/quality-gates.yml');
    const gates = workflow.slice(workflow.indexOf('  gates:'), workflow.indexOf('  postgres-integration:'));
    const postgres = workflow.slice(workflow.indexOf('  postgres-integration:'), workflow.indexOf('  kind-integration:'));
    expect(gates).toContain('run: bash scripts/test-db-backup-restore.sh');
    expect(gates).toMatch(/git ls-files \| grep -E/);
    expect(postgres).toContain('run: make db-restore-drill');
  });

  it('the Makefile offers backup, verification, the stub suite and the drill, and no restore shortcut', () => {
    const makefile = read('Makefile');
    for (const target of ['db-backup:', 'db-backup-verify:', 'test-db-backup:', 'db-restore-drill:']) {
      expect(makefile, target).toContain(`\n${target}`);
    }
    // Restoring is deliberate: the script, its mode and its confirmation, typed.
    expect(makefile).not.toMatch(/^db-restore:/m);
  });

  it('the runbook states the targets and the open decisions', () => {
    const runbook = read(RUNBOOK);
    for (const phrase of [
      'PRIVATE-BETA TARGETS',
      'RPO',
      'RTO',
      'OFF-HOST BACKUP DESTINATION — DECISION REQUIRED',
      'BACKUP ENCRYPTION / EXTERNAL STORAGE — DECISION REQUIRED',
      'scripts/db-backup.sh',
      'scripts/db-restore.sh --into',
      'scripts/db-restore.sh --replace',
      'make db-restore-drill',
    ]) {
      expect(runbook, phrase).toContain(phrase);
    }
    expect(read('docs/runbooks/RB-02-database.md')).toContain('postgres-backup-restore.md');
    expect(read('docs/runbooks/RB-02-database.md')).not.toContain('There is no backup procedure yet');
  });
});
