/**
 * CS-001 — what the verifier actually accepts.
 *
 * CS-001 is graded entirely by reading files back out of the sandbox, so the
 * interesting question is not "does a correct solution pass" but "what else
 * passes". These tests answer both, and each shortcut below is one a student
 * would plausibly try:
 *
 *   · write the report without doing the arithmetic;
 *   · copy the supplied capture into the answer instead of capturing this
 *     machine;
 *   · record the load average instead of the load *per processor*;
 *   · do half the lab.
 *
 * All of them must fail, and the failure detail must describe what was
 * observed rather than what was wanted — a check that prints the expected
 * value is an answer key.
 *
 * The reader is an in-memory sandbox. It models what a sandbox can be *asked*,
 * not how a container behaves; the real `docker exec` path is exercised by the
 * integration suites.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLabDefinition, type LoadedLabDefinition } from '@jumptotech/lab-orchestrator';
import { verifyLab } from '../src/index.js';
import { FakeSandbox, type FakeWorld } from './sandbox-fake.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LABS_DIR = path.resolve(here, '../../../labs');
const CS_001 = path.join(LABS_DIR, 'cs', 'cs-001-machine-anatomy', 'lab.yaml');
const SANDBOX = 'jtt-lab-000000000001';

const REPORT = '/home/student/ops/machine.txt';
const LIVE_MEMINFO = '/home/student/ops/live/meminfo';

/** The capture the seed script plants, byte for byte in the shape it writes. */
const CAPTURE_MEMINFO = [
  'MemTotal:       16266528 kB',
  'MemFree:          412884 kB',
  'Buffers:          128440 kB',
  'Cached:          3204112 kB',
  'SwapTotal:       4194300 kB',
  'SwapFree:              0 kB',
  'Dirty:             12488 kB',
  'Writeback:             0 kB',
  '',
].join('\n');

const CAPTURE_LOADAVG = '24.00 21.35 18.92 9/1183 28471\n';

const CAPTURE_DF = [
  'Filesystem      Size  Used Avail Use% Mounted on',
  '/dev/nvme0n1p2   40G   12G   26G  32% /',
  '/dev/nvme0n1p1  511M   62M  450M  13% /boot',
  '/dev/nvme0n1p3   50G   50G     0 100% /var',
  'tmpfs           7.8G     0  7.8G   0% /dev/shm',
  '',
].join('\n');

/**
 * This sandbox's own /proc/meminfo, as `cat /proc/meminfo > live/meminfo`
 * would leave it: different machine, and carrying MemAvailable, which every
 * kernel since 3.14 emits and the seeded capture deliberately does not.
 */
const THIS_MACHINE_MEMINFO = [
  'MemTotal:        8025424 kB',
  'MemFree:          312884 kB',
  'MemAvailable:    7100112 kB',
  'Buffers:           28440 kB',
  'Cached:           904112 kB',
  '',
].join('\n');

const CORRECT_REPORT = [
  'HOSTNAME=jumptotech-lab',
  'MEMINFO_SCOPE=host',
  'SCAN01_CPUS=8',
  'SCAN01_MEM_MIB=15885',
  'SCAN01_MEM_MB=16656',
  'SCAN01_LOAD_PER_CPU=3',
  'SCAN01_FULL_MOUNT=/var',
  'VERDICT=saturated',
  '',
].join('\n');

/** The world the student is dropped into: the capture, and nothing of theirs. */
function initialWorld(): FakeWorld {
  return {
    files: {
      '/srv/kestrel/scan-01': { type: 'directory', owner: 'root', group: 'root', mode: '755' },
      '/srv/kestrel/scan-01/README.txt': { content: 'kestrel-scan-01 — diagnostic capture\n', owner: 'root', mode: '444' },
      '/srv/kestrel/scan-01/proc-cpuinfo.txt': { content: 'processor\t: 0\n'.repeat(8), owner: 'root', mode: '444' },
      '/srv/kestrel/scan-01/proc-meminfo.txt': { content: CAPTURE_MEMINFO, owner: 'root', mode: '444' },
      '/srv/kestrel/scan-01/proc-loadavg.txt': { content: CAPTURE_LOADAVG, owner: 'root', mode: '444' },
      '/srv/kestrel/scan-01/proc-uptime.txt': { content: '1893421.55 14832910.22\n', owner: 'root', mode: '444' },
      '/srv/kestrel/scan-01/df-h.txt': { content: CAPTURE_DF, owner: 'root', mode: '444' },
    },
  };
}

function worldWith(report?: string, liveMeminfo?: string): FakeWorld {
  const world = initialWorld();
  if (report !== undefined) world.files![REPORT] = { content: report };
  if (liveMeminfo !== undefined) world.files![LIVE_MEMINFO] = { content: liveMeminfo };
  return world;
}

let cachedLab: LoadedLabDefinition | undefined;
async function lab(): Promise<LoadedLabDefinition> {
  cachedLab ??= await loadLabDefinition(CS_001);
  return cachedLab;
}

async function verify(world: FakeWorld) {
  return verifyLab({ lab: await lab(), sandbox: new FakeSandbox(world), namespace: SANDBOX });
}

function failedLabels(checks: readonly { status: string; label: string }[]): string[] {
  return checks.filter((c) => c.status === 'fail').map((c) => c.label);
}

// ------------------------------------------------------------ initial state

describe('CS-001 before the student does anything', () => {
  it('fails, and every check reports rather than being skipped', async () => {
    const result = await verify(initialWorld());
    const definition = await lab();

    expect(result.passed).toBe(false);
    expect(result.summary).toBe('LAB NOT COMPLETE');
    expect(result.checks).toHaveLength(definition.requirements.length);
    expect(result.checks.every((c) => c.status !== 'skipped')).toBe(true);
    // Nothing of the student's exists yet, so all eleven are outstanding.
    expect(failedLabels(result.checks)).toHaveLength(definition.requirements.length);
  });

  it('never prints an expected value in a failure detail', async () => {
    const result = await verify(worldWith('HOSTNAME=wrong\n', 'nothing useful\n'));

    for (const check of result.checks) {
      const detail = check.detail ?? '';
      // The report is graded on values the student has to derive. A detail that
      // named one would hand over the answer to anyone who clicks Check first.
      expect(detail, check.label).not.toMatch(/15885|16656|jumptotech-lab|saturated/);
      expect(detail, check.label).not.toMatch(/SCAN01_LOAD_PER_CPU=3\b/);
    }
  });

  it('reads the student’s files and not the capture', async () => {
    const sandbox = new FakeSandbox(initialWorld());
    await verifyLab({ lab: await lab(), sandbox, namespace: SANDBOX });

    // Grading looks only at what the student produced. The capture is evidence
    // for them, not an input to the verdict — so tampering with it cannot move
    // the grade in either direction.
    expect(new Set(sandbox.reads)).toEqual(new Set([REPORT, LIVE_MEMINFO]));
  });
});

// --------------------------------------------------------- correct solution

describe('CS-001 when the work has been done', () => {
  it('passes', async () => {
    const result = await verify(worldWith(CORRECT_REPORT, THIS_MACHINE_MEMINFO));

    expect(failedLabels(result.checks)).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.summary).toBe('LAB PASSED');
  });

  it('passes a report written differently but correctly', async () => {
    // Different order, extra commentary, values annotated. The lab grades the
    // findings, never the formatting — two students who investigated the same
    // way and wrote it up differently both pass.
    const verbose = [
      '# scan-01 sizing, written up at 03:40',
      'VERDICT=saturated   (load 24.00 across 8 processors)',
      'SCAN01_FULL_MOUNT=/var  — 50G, 100% used',
      'SCAN01_LOAD_PER_CPU=3',
      'SCAN01_MEM_MB=16656',
      'SCAN01_MEM_MIB=15885',
      'SCAN01_CPUS=8',
      'MEMINFO_SCOPE=host',
      'HOSTNAME=jumptotech-lab',
      '',
    ].join('\n');

    const result = await verify(worldWith(verbose, THIS_MACHINE_MEMINFO));
    expect(result.passed).toBe(true);
  });
});

// -------------------------------------------------------------- shortcuts

describe('CS-001 rejects the shortcuts', () => {
  it('rejects an empty report and an empty capture', async () => {
    const result = await verify(worldWith('', ''));

    expect(result.passed).toBe(false);
    // The files exist, so the two `file_exists` checks pass — and every check
    // that asks what is *in* them fails. Creating the artifact is not the task.
    expect(failedLabels(result.checks)).toHaveLength(9);
  });

  it('rejects copying the supplied capture in place of capturing this machine', async () => {
    // `cp /srv/kestrel/scan-01/proc-meminfo.txt ~/ops/live/meminfo`
    const result = await verify(worldWith(CORRECT_REPORT, CAPTURE_MEMINFO));

    expect(result.passed).toBe(false);
    expect(failedLabels(result.checks)).toEqual([
      "The captured file came from this machine's own kernel",
    ]);
  });

  it('rejects the load average recorded in place of the load per processor', async () => {
    // The single most likely wrong answer: copying 24.00 across instead of
    // dividing it by the processor count.
    const undivided = CORRECT_REPORT.replace('SCAN01_LOAD_PER_CPU=3', 'SCAN01_LOAD_PER_CPU=24.00');
    const result = await verify(worldWith(undivided, THIS_MACHINE_MEMINFO));

    expect(result.passed).toBe(false);
    expect(failedLabels(result.checks)).toEqual([
      "The report records scan-01's load per processor",
    ]);
  });

  it('rejects the two memory units swapped', async () => {
    // MiB and MB are the same memory counted two ways; getting them the wrong
    // way round is the misunderstanding the lab exists to correct.
    const swapped = [
      'HOSTNAME=jumptotech-lab',
      'MEMINFO_SCOPE=host',
      'SCAN01_CPUS=8',
      'SCAN01_MEM_MIB=16656',
      'SCAN01_MEM_MB=15885',
      'SCAN01_LOAD_PER_CPU=3',
      'SCAN01_FULL_MOUNT=/var',
      'VERDICT=saturated',
      '',
    ].join('\n');

    const result = await verify(worldWith(swapped, THIS_MACHINE_MEMINFO));
    expect(result.passed).toBe(false);
    expect(failedLabels(result.checks)).toEqual([
      "The report records scan-01's memory in MiB",
      'The report records the same memory in MB',
    ]);
  });

  it('rejects the capture pasted into the report instead of read', async () => {
    // `cat /srv/kestrel/scan-01/* > ~/ops/machine.txt` — every number the lab
    // asks about is somewhere in there, and not one of them is an answer.
    const pasted = [CAPTURE_MEMINFO, CAPTURE_LOADAVG, CAPTURE_DF].join('');
    const result = await verify(worldWith(pasted, THIS_MACHINE_MEMINFO));

    expect(result.passed).toBe(false);
    expect(failedLabels(result.checks)).toHaveLength(8);
  });

  it('rejects half the lab', async () => {
    const reportOnly = await verify(worldWith(CORRECT_REPORT, undefined));
    expect(reportOnly.passed).toBe(false);
    expect(failedLabels(reportOnly.checks)).toEqual([
      "This machine's memory information has been captured",
      "The captured file came from this machine's own kernel",
    ]);

    const captureOnly = await verify(worldWith(undefined, THIS_MACHINE_MEMINFO));
    expect(captureOnly.passed).toBe(false);
    expect(failedLabels(captureOnly.checks)).toHaveLength(9);
  });

  it('rejects the wrong side of the container/host question', async () => {
    const wrong = CORRECT_REPORT.replace('MEMINFO_SCOPE=host', 'MEMINFO_SCOPE=container');
    const result = await verify(worldWith(wrong, THIS_MACHINE_MEMINFO));

    expect(result.passed).toBe(false);
    expect(failedLabels(result.checks)).toEqual([
      'The report says which machine /proc/meminfo is describing',
    ]);
  });

  it('rejects a directory where a file was asked for', async () => {
    const world = initialWorld();
    world.files![REPORT] = { type: 'directory' };
    world.files![LIVE_MEMINFO] = { content: THIS_MACHINE_MEMINFO };

    const result = await verify(world);
    expect(result.passed).toBe(false);
  });
});

// --------------------------------------------------------- known properties

describe('CS-001 grading properties worth stating', () => {
  it('accepts a value that merely contains the right answer — and that is not a way in', async () => {
    // `contains` is a substring test, so `SCAN01_CPUS=80` would satisfy the
    // check for `SCAN01_CPUS=8`. This is pinned deliberately rather than left
    // as a surprise: writing a superstring of the correct answer requires
    // already knowing the correct answer, so it is a tolerance for an odd
    // write-up, not a shortcut past the work.
    const annotated = CORRECT_REPORT.replace('SCAN01_CPUS=8', 'SCAN01_CPUS=8 logical processors');
    const result = await verify(worldWith(annotated, THIS_MACHINE_MEMINFO));

    expect(result.passed).toBe(true);
  });

  it('returns to the starting verdict when the sandbox is reset', async () => {
    // Reset replaces the container and re-runs the baseline, so the world the
    // verifier sees afterwards is the world it saw at the start — including
    // for a student who had already passed.
    const solved = await verify(worldWith(CORRECT_REPORT, THIS_MACHINE_MEMINFO));
    expect(solved.passed).toBe(true);

    const afterReset = await verify(initialWorld());
    expect(afterReset.passed).toBe(false);
    expect(failedLabels(afterReset.checks)).toHaveLength((await lab()).requirements.length);
  });
});
