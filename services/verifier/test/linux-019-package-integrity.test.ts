/**
 * LINUX-019 — the package manager is the source of truth, not the filesystem.
 *
 * Two regressions to guard against, and they pull in opposite directions.
 *
 * The first is grading the drift by looking for the text that was added. A
 * student who deletes the lines they can see may leave a stray byte behind, and
 * a "the added text is gone" check would pass that. So the restored file is
 * graded by digest against what the package ships — verified in the sandbox: a
 * sloppy hand-edit that removed the visible block still hashed 1380d13f… rather
 * than the package's 62cbea8e…
 *
 * The second is grading the install by looking at the filesystem. Copying the
 * binary into place satisfies every file check and leaves a host nobody can
 * query, upgrade or remove — which the runbook names as half the reason the
 * host drifted. So installation is graded from dpkg's own database, and a
 * copied binary reaches 5/8 and stops there.
 *
 * There is no student-written evidence anywhere in this lab, so there is
 * nothing here about forged findings files: the only way to change a check's
 * answer is to change the machine.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLabDefinition } from '@jumptotech/lab-orchestrator';
import { verifyLab } from '../src/index.js';
import { FakeSandbox, type FakeWorld } from './sandbox-fake.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LAB_YAML = path.resolve(here, '../../../labs/linux/linux-019-package-integrity/lab.yaml');
const SANDBOX = 'jtt-lab-000000000019';

const CHECKCTL = '/usr/local/lib/jumptotech/jtt-checkctl';
const CONF = '/etc/jumptotech/checkctl.conf';
const AUDIT = '/usr/local/lib/jumptotech/jtt-audit';
const SHIM = '/usr/local/bin/jtt-checkctl';
const TOOLS_LIST = '/var/lib/dpkg/info/jumptotech-tools.list';
const AUDIT_LIST = '/var/lib/dpkg/info/jumptotech-audit.list';

/** The digests the packages ship, computed from the seed's fixed payload. */
const GOLDEN_CHECKCTL = '62cbea8ef4bfb108e7a0f62bdac3435b1c40c0ea73e2888df9b69fc760433ebf';
const GOLDEN_CONF = 'b58365da0df1dbee25acfd6d32d60ffad63d7b19f96d10b61a36bb855517e5b8';
const GOLDEN_AUDIT = '1ebbc40497567a8b06cea11aaab25ebc7edcff165b4b2c515bc68943d86ca6d9';
/** What a sloppy hand-edit actually produced in the sandbox. */
const HAND_EDITED = '1380d13f438f669a2b1c0e5d9a7c3f8e6d4b2a09fe8c7d6b5a4938271605f4e3d';

interface WorldOptions {
  checkctlDigest?: string;
  confDigest?: string;
  auditDigest?: string | null;
  shimPresent?: boolean;
  toolsInstalled?: boolean;
  auditInstalled?: boolean;
  auditExecutable?: boolean;
}

function world(o: WorldOptions = {}): FakeWorld {
  const {
    checkctlDigest = GOLDEN_CHECKCTL,
    confDigest = GOLDEN_CONF,
    auditDigest = GOLDEN_AUDIT,
    shimPresent = false,
    toolsInstalled = true,
    auditInstalled = true,
    auditExecutable = true,
  } = o;

  const files: NonNullable<FakeWorld['files']> = {};
  if (toolsInstalled) files[TOOLS_LIST] = { type: 'file', content: `${CHECKCTL}\n${CONF}\n` };
  if (auditInstalled) files[AUDIT_LIST] = { type: 'file', content: `${AUDIT}\n` };
  if (shimPresent) files[SHIM] = { type: 'file', mode: '755', content: '#!/bin/sh\n' };
  if (auditDigest !== null) {
    files[AUDIT] = {
      type: 'file',
      mode: auditExecutable ? '755' : '644',
      owner: 'root',
      group: 'root',
      content: '#!/bin/sh\n',
    };
  }

  return {
    commands: {
      [`sha256sum ${CHECKCTL}`]: { exitCode: 0, stdout: `${checkctlDigest}  ${CHECKCTL}\n` },
      [`sha256sum ${CONF}`]: { exitCode: 0, stdout: `${confDigest}  ${CONF}\n` },
      ...(auditDigest !== null
        ? { [`sha256sum ${AUDIT}`]: { exitCode: 0, stdout: `${auditDigest}  ${AUDIT}\n` } }
        : { [`sha256sum ${AUDIT}`]: { exitCode: 1, stdout: '', stderr: 'No such file' } }),
      'grep -q jumptotech-audit /var/lib/dpkg/status': { exitCode: auditInstalled ? 0 : 1 },
    },
    files,
  };
}

function lab() {
  return loadLabDefinition(LAB_YAML);
}

async function verify(w: FakeWorld) {
  return verifyLab({ lab: await lab(), sandbox: new FakeSandbox(w), namespace: SANDBOX });
}

function failed(checks: Array<{ status: string; label: string }>): string[] {
  return checks.filter((c) => c.status !== 'pass').map((c) => c.label);
}

// ------------------------------------------------------------ the outcomes

describe('LINUX-019 grades the host, not an account of it', () => {
  it('passes a host restored to what its packages describe', async () => {
    const result = await verify(world());

    expect(failed(result.checks)).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('fails the seeded state: a file edited in place, a shim, and a package never installed', async () => {
    const result = await verify(
      world({
        checkctlDigest: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888',
        shimPresent: true,
        auditInstalled: false,
        auditDigest: null,
      }),
    );

    expect(result.passed).toBe(false);
    // The config file was never touched, so that check is already green — the
    // lab has to distinguish the drifted file from the one beside it.
    expect(failed(result.checks)).not.toContain(
      "The package's configuration file was left as it shipped",
    );
    expect(failed(result.checks)).toContain(
      'The edited packaged file is byte-for-byte what its package installed',
    );
  });

  it('fails a hand-edit that removed the visible lines but not every byte', async () => {
    /*
     * The case a "the added text is gone" check would pass. Confirmed in the
     * sandbox: deleting the block the student can see left a trailing blank
     * line, and the file hashed 1380d13f… against the package's 62cbea8e…
     */
    const result = await verify(world({ checkctlDigest: HAND_EDITED }));

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'The edited packaged file is byte-for-byte what its package installed',
    ]);
  });

  it('fails a copied binary that the package manager knows nothing about', async () => {
    /*
     * The other half. Every file is present, correct and executable; dpkg has
     * never heard of the package. Confirmed in the sandbox at 5/8.
     */
    const result = await verify(world({ auditInstalled: false }));

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'The package manager recorded the audit package as installed',
      'The audit package appears in the package database',
    ]);
  });

  it('fails a shim left shadowing the packaged tool', async () => {
    const result = await verify(world({ shimPresent: true }));

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'Nothing in the earlier PATH directory shadows the packaged tool',
    ]);
  });

  it('fails a host where the drifted package was removed instead of repaired', async () => {
    // Purging jumptotech-tools would make `dpkg --verify` silent. That is not
    // the same as restoring the file, and the lab says so.
    const result = await verify(world({ toolsInstalled: false }));

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'The tools package is still installed rather than removed',
    ]);
  });

  it('fails an audit tool that is present but not executable', async () => {
    const result = await verify(world({ auditExecutable: false }));

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual(['The audit tool can be run']);
  });

  it('fails an audit binary that is not the one the package ships', async () => {
    const result = await verify(
      world({ auditDigest: '9999888877776666555544443333222211110000ffffeeeeddddccccbbbbaaaa' }),
    );

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual(['The audit tool on disk is the one the package ships']);
  });

  it('fails an untouched sandbox with every check reported', async () => {
    const result = await verify({});

    expect(result.passed).toBe(false);
    expect(result.checks).toHaveLength((await lab()).requirements.length);
    expect(result.checks.every((c) => c.status !== 'skipped')).toBe(true);
  });
});

// ------------------------------------------------------------- lab hygiene

describe('LINUX-019 reads authoritative state only', () => {
  it('has no student-written evidence file among its checks', async () => {
    /*
     * Every path this lab reads is either owned by a package, written by the
     * package manager, or a digest of one of those. Nothing under the student's
     * home is graded, so there is no file whose contents are a claim.
     */
    const definition = await lab();
    for (const requirement of definition.requirements) {
      const p = 'path' in requirement ? requirement.path : '';
      expect(p.startsWith('/home/'), `${p} is under the student's home`).toBe(false);
    }
  });

  it('runs nothing the student authored', async () => {
    const definition = await lab();
    for (const requirement of [...definition.requirements, ...definition.setup.verify]) {
      expect(requirement.type).not.toBe('script_runs');
    }
  });

  it('names only allow-listed read-only commands with fixed arguments', async () => {
    const definition = await lab();
    const permitted = new Map<string, string[][]>([
      ['sha256sum', [[CHECKCTL], [CONF], [AUDIT]]],
      ['grep', [['-q', 'jumptotech-audit', '/var/lib/dpkg/status'], ['-q', 'settlement', CHECKCTL]]],
    ]);

    for (const requirement of [...definition.requirements, ...definition.setup.verify]) {
      if (requirement.type !== 'command_exit_code' && requirement.type !== 'command_output') continue;
      const allowed = permitted.get(requirement.command);
      expect(allowed, `unexpected command '${requirement.command}'`).toBeDefined();
      expect(allowed).toContainEqual([...requirement.args]);
    }
  });

  it('reads the package database rather than trusting the filesystem for "installed"', async () => {
    const definition = await lab();
    const labels = definition.requirements.map((r) => r.label ?? '');
    expect(labels).toContain('The package manager recorded the audit package as installed');
    expect(labels).toContain('The audit package appears in the package database');

    // Both must read something dpkg writes, not something a copy would create.
    const dbPaths = definition.requirements
      .filter((r) => 'path' in r && String(r.path).startsWith('/var/lib/dpkg/'))
      .map((r) => ('path' in r ? r.path : ''));
    expect(dbPaths).toContain(AUDIT_LIST);
  });

  it('never names the fix or leaks a digest in a failure detail', async () => {
    const result = await verify(
      world({ checkctlDigest: HAND_EDITED, shimPresent: true, auditInstalled: false, auditDigest: null }),
    );

    for (const check of result.checks.filter((c) => c.status !== 'pass')) {
      const detail = check.detail ?? '';
      expect(detail, check.label).not.toContain(GOLDEN_CHECKCTL);
      expect(detail, check.label).not.toContain(GOLDEN_AUDIT);
      expect(detail, check.label).not.toMatch(/dpkg\s+-i|--verify|dpkg-deb/);
    }
  });

  it('claims the competency the published list actually names', async () => {
    // "Search for, install, validate, and maintain software packages or
    // repositories" — Operations Deployment, re-read 2026-08-25.
    const certification = (await lab()).certification;
    expect(certification[0]?.certification).toBe('LFCS');
    expect(certification[0]?.relevant).toBe(true);
    expect(certification[0]?.domains).toEqual(['operations-deployment']);
  });
});
