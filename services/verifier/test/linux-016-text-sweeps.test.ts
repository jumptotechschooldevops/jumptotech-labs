/**
 * LINUX-016 — a sweep is graded by what it spared, not only by what it hit.
 *
 * Each of the three tasks has an obvious wide version that produces the right
 * visible result and damages something beside it, so the regression this file
 * guards against is someone later trimming the requirement list down to the
 * casualties. Drop the README check and a `sed -i` over the whole of
 * /srv/jumptotech passes. Drop the two surviving spool files and `rm *.tmp`
 * passes. Drop one of the two ordering checks and an unsorted answer passes.
 *
 * Every world is stated explicitly rather than produced by running the seed.
 * That the *tools* behave as described — that a shell glob skips a dotfile
 * while find's -name does not — was confirmed inside the sandbox image and is
 * recorded in the lab file; what is asserted here is that the lab fails the
 * hosts it ought to.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLabDefinition } from '@jumptotech/lab-orchestrator';
import { verifyLab } from '../src/index.js';
import { FakeSandbox, type FakeWorld } from './sandbox-fake.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LAB_YAML = path.resolve(here, '../../../labs/linux/linux-016-text-sweeps/lab.yaml');
const SANDBOX = 'jtt-lab-000000000016';

const CONF = '/srv/jumptotech/conf';
const SPOOL = '/srv/jumptotech/spool';
const README = `${CONF}/README.txt`;
const RECORD = '/srv/jumptotech/archive/2026-06-change-record.log';
const TOTALS = '/home/student/analysis/merchant-totals.txt';

const OLD_HOST = 'ledger-old.jumptotech.internal';
const NEW_HOST = 'ledger-01.jumptotech.internal';

/** The four graded config files, and the two files that must keep the old name. */
const GRADED_CONFS = [
  `${CONF}/services/ledger.conf`,
  `${CONF}/edge/edge-tls.conf`,
  `${CONF}/defaults.conf`,
  `${CONF}/services/reconciliation.conf`,
  `${CONF}/edge/edge-waf.conf`,
];

/** The exact settled totals the seeded log produces, largest first. */
const CORRECT_TOTALS = [
  'ember-books 105960',
  'forge-tools 104424',
  'gale-energy 102645',
  'harbor-freight 102033',
  'bolt-foods 100638',
  'delta-travel 98908',
  'acme-retail 91561',
  'cinder-media 84587',
].join('\n');

function conf(host: string): { type: 'file'; content: string } {
  return { type: 'file', content: `upstream_host = ${host}\nupstream_port = 9105\n` };
}

interface WorldOptions {
  confHost?: string;
  readmeHost?: string;
  recordHost?: string;
  totals?: string | null;
  staleRemoved?: boolean;
  hiddenRemoved?: boolean;
  freshKept?: boolean;
  historyKept?: boolean;
}

/** A host, described by which of the six outcomes it got right. */
function world(o: WorldOptions = {}): FakeWorld {
  const {
    confHost = NEW_HOST,
    readmeHost = OLD_HOST,
    recordHost = OLD_HOST,
    totals = CORRECT_TOTALS,
    staleRemoved = true,
    hiddenRemoved = true,
    freshKept = true,
    historyKept = true,
  } = o;

  const files: NonNullable<FakeWorld['files']> = {
    [README]: { type: 'file', content: `history: the estate used to be ${readmeHost}\n` },
    [RECORD]: { type: 'file', content: `CHG-1188 retire ${recordHost}\n` },
  };
  for (const p of GRADED_CONFS) files[p] = conf(confHost);
  if (totals !== null) files[TOTALS] = { type: 'file', content: `${totals}\n` };

  // Stale exports are absent when the sweep worked; present when it did not.
  if (!staleRemoved) {
    files[`${SPOOL}/export-2026-07-04.tmp`] = { type: 'file', content: '' };
    files[`${SPOOL}/reconcile-2026-07-18.tmp`] = { type: 'file', content: '' };
  }
  if (!hiddenRemoved) files[`${SPOOL}/.export-2026-07-25.tmp`] = { type: 'file', content: '' };
  if (freshKept) {
    files[`${SPOOL}/export-2026-08-24.tmp`] = { type: 'file', content: '' };
    files[`${SPOOL}/export-2026-08-25.tmp`] = { type: 'file', content: '' };
  }
  if (historyKept) files[`${SPOOL}/spool-history.log`] = { type: 'file', content: '' };

  return { files };
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

// --------------------------------------------------------- the graded shape

describe('LINUX-016 grades the survivors as well as the casualties', () => {
  it('passes a host where all three sweeps were correctly scoped', async () => {
    const result = await verify(world());

    expect(failed(result.checks)).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.summary).toBe('LAB PASSED');
  });

  it('fails the seeded starting state', async () => {
    const result = await verify(
      world({ confHost: OLD_HOST, totals: null, staleRemoved: false, hiddenRemoved: false }),
    );

    expect(result.passed).toBe(false);
    // Nothing has been damaged yet, so every survivor check is already green —
    // which is why they cannot be the only thing the lab grades.
    expect(failed(result.checks)).not.toContain(
      "The tree's README still records what the estate used to be",
    );
  });

  it('fails a substitution that ran one directory too high', async () => {
    // `grep -rl old /srv/jumptotech | xargs sed -i` retargets every .conf
    // correctly and rewrites the audit trail on the way past.
    const result = await verify(world({ readmeHost: NEW_HOST, recordHost: NEW_HOST }));

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      "The tree's README still records what the estate used to be",
      'The archived change record was left alone',
    ]);
  });

  it('fails a substitution that matched by directory rather than by filename', async () => {
    // Scoped to the config tree, but not to *.conf — README.txt is in there.
    const result = await verify(world({ readmeHost: NEW_HOST }));

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      "The tree's README still records what the estate used to be",
    ]);
  });

  it('fails a spool sweep that went through the shell and missed the dotfile', async () => {
    // `rm *.tmp`: the glob skips a leading dot, and takes this morning's
    // exports because it never looked at age at all.
    const result = await verify(world({ hiddenRemoved: false, freshKept: false }));

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'The stale export whose name begins with a dot was cleared too',
      "This morning's exports survived the sweep",
      "Yesterday's exports survived the sweep",
    ]);
  });

  it('fails a spool sweep that selected on age but not on name', async () => {
    const result = await verify(world({ historyKept: false }));

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      "The spool's own history, old but not a temporary export, survived",
    ]);
  });

  it('fails totals that counted reversed payments as revenue', async () => {
    // Every one of the eight numbers moves when the status filter is dropped.
    const unfiltered = [
      'ember-books 134024',
      'harbor-freight 129271',
      'forge-tools 128470',
      'gale-energy 126800',
      'bolt-foods 125212',
      'delta-travel 123554',
      'acme-retail 116319',
      'cinder-media 107446',
    ].join('\n');

    const result = await verify(world({ totals: unfiltered }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'The four largest merchants are correct, in order',
      'The four smallest merchants are correct, in order',
    ]);
  });

  it('fails totals that are right but unsorted', async () => {
    const alphabetical = [
      'acme-retail 91561',
      'bolt-foods 100638',
      'cinder-media 84587',
      'delta-travel 98908',
      'ember-books 105960',
      'forge-tools 104424',
      'gale-energy 102645',
      'harbor-freight 102033',
    ].join('\n');

    const result = await verify(world({ totals: alphabetical }));
    expect(result.passed).toBe(false);
    /*
     * Only the second ordering check catches this, and that is worth pinning:
     * in alphabetical order the four largest merchants happen to fall in the
     * same relative order as they do by total, so the first check passes by
     * coincidence. Two checks over disjoint halves is what makes the pair
     * sound — removing either one would let an unsorted answer through.
     */
    expect(failed(result.checks)).toEqual(['The four smallest merchants are correct, in order']);
  });

  it('fails a totals file that is raw log lines rather than totals', async () => {
    const raw =
      '2026-08-06 02:01:07 TXN-10001 merchant=forge-tools amount=182 status=reversed\n' +
      '2026-08-05 03:02:14 TXN-10002 merchant=ember-books amount=429 status=settled';

    const result = await verify(world({ totals: raw }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain(
      'The totals file holds totals rather than raw log lines',
    );
  });

  it('fails an untouched sandbox with every check reported', async () => {
    const result = await verify({});

    expect(result.passed).toBe(false);
    expect(result.checks).toHaveLength((await lab()).requirements.length);
    expect(result.checks.every((c) => c.status !== 'skipped')).toBe(true);
  });
});

// --------------------------------------------------------------- lab hygiene

describe('LINUX-016 grades state, and never the route taken to it', () => {
  it('runs nothing, and names no inspection command at all', async () => {
    const definition = await lab();
    for (const requirement of [...definition.requirements, ...definition.setup.verify]) {
      expect(requirement.type).not.toBe('script_runs');
      expect(requirement.type).not.toBe('command_exit_code');
      expect(requirement.type).not.toBe('command_output');
    }
  });

  it('needs no elevated privilege anywhere', async () => {
    // Every path this lab reads is under the student's own ownership, so a
    // correct solution never calls for sudo and the lab never grants more.
    const definition = await lab();
    const paths = [...definition.requirements, ...definition.setup.verify]
      .map((r) => ('path' in r ? r.path : ''))
      .filter(Boolean);

    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      expect(p.startsWith('/srv/jumptotech/') || p.startsWith('/home/student/') || p.startsWith('/var/log/jumptotech/')).toBe(true);
    }
  });

  it('grades both halves of every sweep', async () => {
    const labels = (await lab()).requirements.map((r) => r.label ?? '');
    // A casualty and a survivor for each of the three tasks.
    expect(labels).toContain('The archived change record was left alone');
    expect(labels).toContain("The spool's own history, old but not a temporary export, survived");
    expect(labels).toContain("This morning's exports survived the sweep");
    expect(labels).toContain('The stale export whose name begins with a dot was cleared too');
  });

  it('never names the fix in a failure detail', async () => {
    const result = await verify(world({ confHost: OLD_HOST, totals: null, staleRemoved: false, hiddenRemoved: false }));
    for (const check of result.checks.filter((c) => c.status !== 'pass')) {
      expect(check.detail ?? '', check.label).not.toMatch(/\b(sed|awk|find|xargs|-mtime|-delete)\b/);
    }
  });

  it('claims no certification coverage, because text processing is not an LFCS objective', async () => {
    // The published competency list was enumerated in full on 2026-08-25: no
    // bullet in any of the five domains mentions text processing, sed, awk,
    // grep, find, xargs or regular expressions.
    const certification = (await lab()).certification;
    expect(certification).toHaveLength(1);
    expect(certification[0]?.certification).toBe('LFCS');
    expect(certification[0]?.relevant).toBe(false);
    expect(certification[0]?.domains).toEqual([]);
  });
});
